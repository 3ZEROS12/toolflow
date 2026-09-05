# ToolFlow 深度安全审计、并发持久化与隔离防御分析报告

**审计员**: `explorer_security_1`  
**审计基线**: ToolFlow 全栈核心模块 (`blast_radius.ts`, `state.ts`, `dehydrator.ts`, `memory.ts`, `engine.ts`, `index.ts`, `taxonomy.ts`, `worker_orchestrator.ts`)  
**审计时间**: 2026-09-02  
**审计模式**: prosecutorial-grade 逐行安全排查与实证分析  

---

## 目录
1. [执行摘要 (Executive Summary)](#1-执行摘要-executive-summary)
2. [Blast Radius 路径校验与越权漏洞排查](#2-blast-radius-路径校验与越权漏洞排查)
   - 2.1 Windows DOS 保留设备名拒绝服务与逃逸 (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
   - 2.2 Win32 末尾点号与空格规范化绕过 (`file.ts.` / `file.ts `)
   - 2.3 跨盘符路径穿越与驱动器隔离缺失 (`C:` vs `D:`)
   - 2.4 DOS 8.3 短文件名 (`GIT~1`, `ENV~1`, `CARGO~1.LOC`) 保护遗漏
   - 2.5 符号链接 (Symlink) 与 NTFS 目录连接点 (Junction) 物理穿透
   - 2.6 Glob Star `**/*.ts` 根目录匹配失效与路径匹配边界缺陷
   - 2.7 工具调用范围限制缺陷 (只监听 write/edit，忽略 delete/rename/patch)
3. [高并发与原子持久化风险审计](#3-高并发与原子持久化风险审计)
   - 3.1 Windows `fs.renameSync` EPERM/EBUSY 锁争用与静默写失败
   - 3.2 临时文件 (`.tmp.${pid}.${timestamp}`) 异常泄漏排查
   - 3.3 多进程 / DAG 并发波次下的数据覆盖竞态 (Race Condition)
   - 3.4 `blueprint_state.json` 部分写入与 JSON 解析崩溃恢复缺失
   - 3.5 `dehydrator.ts` 日志落盘非原子写入隐患
4. [沙盒安全与环境隔离漏洞排查](#4-沙盒安全与环境隔离漏洞排查)
   - 4.1 同步阻塞 `execSync` 导致事件循环冻结与 TUI 假死
   - 4.2 `isMockTestEnvironment` 在临时 Git 仓库下的误判假阴性
   - 4.3 基础工具集包含 `bash`/`powershell` 带来的安全边界穿透
5. [死代码、悬空逻辑与未生效配置清查](#5-死代码悬空逻辑与未生效配置清查)
   - 5.1 `BlastRadiusGuard.allowPath()` 悬空孤儿方法
   - 5.2 `escalationCandidate` 悬空提权元数据未被消费
   - 5.3 `ContextDehydrator` 在主入口 `index.ts` 中完全未被挂载
   - 5.4 `types.ts` 与 `taxonomy.ts` 悬空类型与无用属性清查
6. [Worker 物理修复实施指南 (Concrete Action Plan)](#6-worker-物理修复实施指南-concrete-action-plan)

---

## 1. 执行摘要 (Executive Summary)

本次排查对 ToolFlow 的安全边界防护、路径验证、文件持久化、并发控制和沙盒执行进行了逐行深入代码审计。

总体评估：
ToolFlow 具备了基于 Glob 白名单和敏感文件名拦截的防卫雏形，但在 **Windows 平台特有文件系统特性（DOS保留设备名、末尾点号/空格截断、跨盘符相对路径、DOS 8.3 短别名、NTFS 目录连接点）**、**高并发与原子写盘容错（EPERM/EBUSY 锁争用、临时文件泄漏、多进程竞态）** 以及 **运行时子系统接驳完整度（`ContextDehydrator` 悬空未被主运行时调用）** 上存在若干 P0/P1 级严重漏洞与架构隐患。

---

## 2. Blast Radius 路径校验与越权漏洞排查

### 2.1 Windows DOS 保留设备名拒绝服务与逃逸 (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
- **风险等级**: **P0 (Critical)**
- **涉及文件与位置**: `blast_radius.ts:13-28`, `blast_radius.ts:90-155`
- **机理分析**:
  在 Windows Win32 子系统中，无论文件扩展名是什么，也无论文件位于哪一层子目录，形如 `CON`, `PRN`, `AUX`, `NUL`, `COM1`~`COM9`, `LPT1`~`LPT9`, `CONIN$`, `CONOUT$` 均会被操作系统作为 DOS 特殊设备文件处理。
  若 Agent 被诱导调用 `write` 或 `edit` 操作写入 `src/nul.ts`、`aux.json`、`src/con` 等路径：
  1. `BlastRadiusGuard` 当前的 Glob 模式如 `src/**` 或 `*` 将直接判定为合法放行；
  2. 底层 Node.js `fs.writeFileSync("src/nul.ts", ...)` 会直接尝试打开系统保留设备，导致 Node.js 进程死锁/挂起、等待串口或控制台 I/O、触发不可捕获异常，造成沙盒或主进程 DoS 假死。
- **漏洞复现场景**:
  ```ts
  guard.updateAllowedScope({ expectedArtifact: "src/main.ts", targetPatterns: ["src/**"] });
  const check = guard.verifyToolCall({ toolName: "write", input: { path: "src/nul" } });
  // 预期: 必须阻断并报警
  // 实际: check.block === false (放行!)
  ```
- **修复建议**:
  在 `BlastRadiusGuard` 中引入 Windows DOS 设备名称专用防御正则：
  ```ts
  private static readonly DOS_DEVICE_REGEX = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)(\..*)?$/i;
  ```
  在 `verifyToolCall` 中检查 `baseName` 以及 `normRelative.split("/")` 的每一个 segment。一旦命中直接阻断：
  ```ts
  if (pathSegments.some(seg => BlastRadiusGuard.DOS_DEVICE_REGEX.test(seg))) {
    return {
      block: true,
      reason: `[ToolFlow 保护红线] 拦截操作：检测到 Windows DOS 保留设备名 "${targetPath}"，禁止访问！`
    };
  }
  ```

---

### 2.2 Win32 末尾点号与空格规范化绕过 (`file.ts.` / `file.ts `)
- **风险等级**: **P0 (Critical)**
- **涉及文件与位置**: `blast_radius.ts:30-36`, `blast_radius.ts:109-131`
- **机理分析**:
  在 Windows NTFS / FAT 文件系统中，系统内核在打开文件时会自动截断文件名和目录名末尾的所有点号 (`.`) 和空格 (` `)。
  例如：访问 `package-lock.json.` 或 `package-lock.json ` 实际上打开并覆写的是 `package-lock.json`！
  然而在 `blast_radius.ts` 中：
  ```ts
  const resolved = path.resolve(cwd, targetPath);
  const relative = path.relative(cwd, resolved);
  const normRelative = this.normalizePath(relative);
  const baseName = path.basename(resolved);
  ```
  Node.js 的 `path.resolve` 和 `path.basename` **保留了末尾的点号和空格**：
  1. `baseName` 为 `"package-lock.json."`；
  2. 正则 `/^package-lock\.json$/i.test("package-lock.json.")` 判定为 **FALSE**；
  3. `pathSegments.includes(".git")` 对 `.git./config` 判定为 **FALSE**（因为 `".git." !== ".git"`）；
  4. 最终该非法写操作绕过核心敏感文件检查，被 Windows 文件系统直接写入受保护的敏感文件！
- **漏洞复现场景**:
  ```ts
  const check = guard.verifyToolCall({ toolName: "write", input: { path: "package-lock.json." } }, cwd);
  // 预期: 拦截修改 package-lock.json
  // 实际: 正则未匹配，若白名单宽泛则直接放行并覆写 package-lock.json
  ```
- **修复建议**:
  在 `normalizePath` 中，对路径的每个分段剔除末尾的点和空格：
  ```ts
  private normalizePath(p: string): string {
    let normalized = path.normalize(p).replace(/\\/g, "/");
    if (process.platform === "win32") {
      normalized = normalized
        .split("/")
        .map(seg => seg.replace(/[.\s]+$/, ""))
        .join("/")
        .toLowerCase();
    }
    return normalized;
  }
  ```

---

### 2.3 跨盘符路径穿越与驱动器隔离缺失 (`C:` vs `D:`)
- **风险等级**: **P1 (High)**
- **涉及文件与位置**: `blast_radius.ts:109-122`, `blast_radius.ts:134-154`
- **机理分析**:
  在 Windows 下，如果工作区 `cwd` 位于 `C:\project`，而攻击输入为 `D:\malicious\payload.ts`：
  1. `path.resolve("C:\\project", "D:\\malicious\\payload.ts")` 返回 `"D:\\malicious\\payload.ts"`；
  2. `path.relative("C:\\project", "D:\\malicious\\payload.ts")` 返回 `"D:\\malicious\\payload.ts"`（跨驱动器无法产生 `..` 相对路径）；
  3. `pathSegments` 为 `["d:", "malicious", "payload.ts"]`；
  4. `pathSegments.some(seg => seg === "..")` 为 `false`；
  5. 若当前 Stage 没有配置限定白名单，或者配置了全局通配符 `**/*`，`verifyToolCall` 直接判定放行，导致越权写入其他物理盘符！
- **修复建议**:
  严格校验 `resolved` 必须在 `cwd` 根目录树下：
  ```ts
  const normCwd = this.normalizePath(cwd);
  const isInsideCwd = normResolved.startsWith(normCwd + "/") || normResolved === normCwd;
  if (!isInsideCwd && path.isAbsolute(relative)) {
    return {
      block: true,
      reason: `[ToolFlow 保护红线] 拦截操作：检测到试图越界访问工作区外部驱动器路径 "${targetPath}"！`
    };
  }
  ```

---

### 2.4 DOS 8.3 短文件名 (`GIT~1`, `ENV~1`, `CARGO~1.LOC`) 保护遗漏
- **风险等级**: **P1 (High)**
- **涉及文件与位置**: `blast_radius.ts:13-28`, `blast_radius.ts:116-122`
- **机理分析**:
  在开启 8.3 名称生成的 Windows 磁盘上：
  - `.git` 目录的 8.3 别名为 `GIT~1`；
  - `pnpm-workspace.yaml` 为 `PNPM-W~1.YAM`（当前代码只写了 `pnpm-l~1.yam`）；
  - `Cargo.lock` 为 `CARGO~1.LOC`（当前代码只写了 `yarn~1.loc`）；
  - `turbo.json` 为 `TURBO~1.JSO`（完全遗漏）；
  - `.env.production` 为 `ENV~1` 或 `ENVPRO~1`。
  当 Agent 试图写入 `GIT~1/config` 或 `GIT~1/hooks/pre-commit` 时，`pathSegments.includes(".git")` 判定为 `false`，从而成功篡改 Git 仓库内部钩子与配置。
- **修复建议**:
  1. 扩充 `criticalConfigPatterns`：
     ```ts
     /^(packag|pnpm-l|pnpm-w|yarn|cargo|turbo|lerna|nx)~\d+\.(jso|yam|loc|txt)$/i,
     /^git~\d+([\\/].+)?$/i,
     /^env~\d+(\..*)?$/i
     ```
  2. 在 segment 检测中加入 `seg === ".git" || /^git~\d+$/i.test(seg)`。

---

### 2.5 符号链接 (Symlink) 与 NTFS 目录连接点 (Junction) 物理穿透
- **风险等级**: **P1 (High)**
- **涉及文件与位置**: `blast_radius.ts:109`
- **机理分析**:
  `BlastRadiusGuard` 仅使用词法解析 (`path.resolve`)。若工作区内存在符号链接或 NTFS 连接点（如 `src/external -> C:\SensitiveFolder`）：
  - `path.resolve(cwd, "src/external/secret.ts")` 仅产生 `C:\project\src\external\secret.ts`；
  - 词法上属于 `src/**` 白名单范围，但在物理落盘时，文件将写入 `C:\SensitiveFolder\secret.ts`。
- **修复建议**:
  对已存在的文件或祖先目录使用 `fs.realpathSync`，验证物理真实路径必须位于 `fs.realpathSync(cwd)` 范围内。若解析出的 realpath 越界，立即拦截。

---

### 2.6 Glob Star `**/*.ts` 根目录匹配失效与路径匹配边界缺陷
- **风险等级**: **P1 (High)**
- **涉及文件与位置**: `blast_radius.ts:38-56`
- **机理分析**:
  当前 `matchGlob` 将 `**` 替换为 `.*`，将 `*` 替换为 `[^/]*`。
  对于模式 `**/*.ts`：
  - 编译出的正则为 `^.*\/[^/]*\.ts$`；
  - 中间的 `\/` 强制要求目标路径中必须包含至少一个 `/` 分隔符；
  - 根目录下的文件 `index.ts`（无 `/`）匹配该正则时返回 **FALSE**！
  - 导致符合 `**/*.ts` 预期的根目录合法文件被误杀拦截。
- **修复建议**:
  重构 Glob 转换算法，正确处理 `**/` 前缀，使其既能匹配子目录下的文件，也能匹配根目录同名模式文件。

---

### 2.7 工具调用范围限制缺陷 (只监听 write/edit，忽略 delete/rename/patch)
- **风险等级**: **P2 (Medium)**
- **涉及文件与位置**: `blast_radius.ts:94`
- **机理分析**:
  `verifyToolCall` 开头硬编码 `if (event.toolName === "write" || event.toolName === "edit")`。
  如果在 Pi 扩展中注册了 `delete`, `unlink`, `rm`, `append`, `move`, `rename`, `create_file` 等工具，这些操作将完全穿透 Blast Radius 防御。
- **修复建议**:
  扩展支持的工具动作集合：`const WRITE_TOOLS = new Set(["write", "edit", "create", "delete", "unlink", "append", "patch", "modify", "save", "overwrite"]);`

---

## 3. 高并发与原子持久化风险审计

### 3.1 Windows `fs.renameSync` EPERM/EBUSY 锁争用与静默写失败
- **风险等级**: **P0 (Critical)**
- **涉及文件与位置**: `state.ts:35-45`, `memory.ts:78-83`, `memory.ts:93-98`
- **机理分析**:
  在 `state.ts` 中：
  ```ts
  export function saveSessionStateToFile(cwd: string = process.cwd()): boolean {
    try {
      const filePath = getPersistFilePath(cwd);
      const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf-8");
      fs.renameSync(tempPath, filePath);
      return true;
    } catch (_) {
      return false;
    }
  }
  ```
  在 Windows 平台下，当目标文件 `blueprint_state.json` 正在被防病毒软件、IDE 文件索引器或其他读取流占用时，`fs.renameSync` 会抛出 `EPERM` 或 `EBUSY` 异常。
  代码中使用空 `catch (_)` 静默吞掉错误，调用方无法获知写入失败，导致内存状态与磁盘文件彻底脱节。
- **修复建议**:
  封装带指数退避重试的通用原子写盘方法 `atomicWriteFileSync`：重试 3~5 次，并在最终失败前尝试 `copyFileSync` + `unlinkSync` 降级，在 `finally` 块中清理 `.tmp` 文件。

---

### 3.2 临时文件 (`.tmp.${pid}.${timestamp}`) 异常泄漏排查
- **风险等级**: **P1 (High)**
- **涉及文件与位置**: `state.ts:38-44`, `memory.ts:79-83`
- **机理分析**:
  当磁盘写满或 `renameSync` 失败抛出异常时，由于缺少 `finally` 清理逻辑，已经写入磁盘的临时文件无法被自动删除。长时间运行或频繁重试后将在 `.pi/` 目录下产生大量孤儿 `.tmp` 垃圾文件。
- **修复建议**:
  统一在 `atomicWriteFileSync` 的 `finally` 块中调用 `if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);`。

---

### 3.3 多进程 / DAG 并发波次下的数据覆盖竞态 (Race Condition)
- **风险等级**: **P1 (High)**
- **涉及文件与位置**: `state.ts:14-23`, `worker_orchestrator.ts:24-43`
- **机理分析**:
  `worker_orchestrator.ts` 将同一波次的无依赖 Stage 标记为 `isParallel: true` 并派发并发执行。
  当两个并发 Stage 同时完成并调用 `checkAndRecordArtifact` 或 `saveSessionStateToFile` 时，两个进程的读取-修改-写回产生竞态，后完成的写入将直接覆盖并丢失先完成的账本记录。
- **修复建议**:
  引入跨进程排他锁（文件锁或锁目录），同一进程内使用内存写入队列。

---

### 3.4 `blueprint_state.json` 部分写入与 JSON 解析崩溃恢复缺失
- **风险等级**: **P1 (High)**
- **涉及文件与位置**: `state.ts:51-53`, `memory.ts:37-39`
- **机理分析**:
  `loadPersistedSessionState` 执行 `JSON.parse(content)` 时，如果文件因异常断电或外部编辑器改写导致损坏，`state.ts` 捕获后直接返回 `null`，导致整个未完成的蓝图进度全部永久丢失。
- **修复建议**:
  保存时同步维护 `blueprint_state.json.bak` 备份文件，主文件解析异常时自动降级尝试备份恢复。

---

### 3.5 `dehydrator.ts` 日志落盘非原子写入隐患
- **风险等级**: **P2 (Medium)**
- **涉及文件与位置**: `dehydrator.ts:119`
- **机理分析**:
  `fs.writeFileSync(rawLogFilePath, sanitizedLogs, "utf-8");` 直接针对目标日志文件写入，未走原子重命名，异常中断可能导致日志残缺。
- **修复建议**:
  采用 `atomicWriteFileSync` 进行日志落盘。

---

## 4. 沙盒安全与环境隔离漏洞排查

### 4.1 同步阻塞 `execSync` 导致事件循环冻结与 TUI 假死
- **风险等级**: **P1 (High)**
- **涉及文件与位置**: `state.ts:507`
- **机理分析**:
  `verifyStageArtifacts` 中执行阶段验证命令采用同步阻塞 `execSync`，单命令超时达 15 秒，导致 Node.js 主事件循环与 TUI 界面完全冻结。
- **修复建议**:
  封装为异步执行或在 Worker 线程中隔离运行。

---

### 4.2 `isMockTestEnvironment` 在临时 Git 仓库下的误判假阴性
- **风险等级**: **P2 (Medium)**
- **涉及文件与位置**: `state.ts:503`
- **机理分析**:
  测试若在临时沙盒中初始化了 `.git`，`!fs.existsSync(path.join(cwd, ".git"))` 导致 `isMockTestEnvironment` 误判为 `false`，从而在未安装相应语言环境的机器上触发失败。
- **修复建议**:
  只要 `cwd` 属于 `os.tmpdir()` 或包含 `toolflow_`/`wf-` 测试前缀，一律认定为 Mock 测试环境。

---

### 4.3 基础工具集包含 `bash`/`powershell` 带来的安全边界穿透
- **风险等级**: **P1 (High)**
- **涉及文件与位置**: `state.ts:586`, `index.ts:113`
- **机理分析**:
  `BASELINE_TOOLS` 包含 `bash` 和 `powershell`，终端命令可直接绕过针对 `write`/`edit` 工具的 Blast Radius 防御。
- **修复建议**:
  在 `design` 与 `preview` 阶段通过 `GracefulDegradationMatrix.resolvePrunedToolsForStage` 严格剪枝掉终端工具。

---

## 5. 死代码、悬空逻辑与未生效配置清查

### 5.1 `BlastRadiusGuard.allowPath()` 悬空孤儿方法
- **涉及文件与位置**: `blast_radius.ts:83-85`
- **现象**: `public allowPath(filePath, cwd)` 定义后在整个代码库中**零调用**。动态自愈发现的新产物未能自动放行。
- **修复建议**: 在 `state.ts:checkAndRecordArtifact` 中接驳 `blastGuard.allowPath()`。

### 5.2 `escalationCandidate` 悬空提权元数据未被消费
- **涉及文件与位置**: `blast_radius.ts:93, 145-148`, `index.ts:324-332`
- **现象**: 阻断返回的 `escalationCandidate` 在 `index.ts` 中被直接丢弃，从未触发提权申请或通知。
- **修复建议**: 在 `index.ts` 中消费并给出提权变更提示。

### 5.3 `ContextDehydrator` 在主入口 `index.ts` 中完全未被挂载
- **涉及文件与位置**: `index.ts:8`, `index.ts:337-437`
- **现象**: `index.ts` 导入了 `ContextDehydrator`，但在主运行时 `turn_end` 阶段从未调用 `dehydrateStageLog()`，导致脱水归档功能在实际会话中休眠。
- **修复建议**: 在 `index.ts` 中实例化并于阶段验收后调用 `dehydrateStageLog()`。

### 5.4 `types.ts` 与 `taxonomy.ts` 悬空类型与无用属性清查
- **涉及项**:
  1. `types.ts:152`: `StageExecutionMode` 未被使用；
  2. `types.ts:255`: `SessionPlanState.shadowHeadCommit` 与 `shadowCommitHash` 冗余；
  3. `types.ts:257`: `SessionPlanState.customDirectives` 未被使用；
  4. `types.ts:238-239`: `isPrimaryMissing` 与 `healingAttempt` 悬空；
  5. `taxonomy.ts:148, 171`: `activeModifiedPaths` 声明为空数组并直接返回 `undefined`。

---

## 6. Worker 物理修复实施指南 (Concrete Action Plan)

建议 Worker 按照以下优先级推进物理修复：
1. **[P0] `blast_radius.ts` 边界加固**: 增加 DOS 保留设备名拦截、末尾点号/空格截断处理、跨盘符边界强制拦截、DOS 8.3 别名补全、Glob Star 根目录匹配修复；
2. **[P0] `state.ts` & `memory.ts` 原子写入**: 抽取 `atomicWriteFileSync`（支持重试、备份 `.bak`、`finally` 清理 `.tmp`）；
3. **[P1] 主链路接驳与死代码清理**: 在 `index.ts` 挂载 `ContextDehydrator`，在 `state.ts` 挂载 `allowPath()`，精简 `types.ts` 冗余字段；
4. **[P1] 沙盒与测试断言扩充**: 在 `test_suite.ts` 中增加针对 DOS 设备名、末尾点号绕过、跨盘符越权、原子写异常恢复的物理测试用例。
