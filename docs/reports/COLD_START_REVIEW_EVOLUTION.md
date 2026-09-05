# ToolFlow v1.5.0: 冷启动审查隔离与物理 Diff 物理透传演进报告

## 1. 演进背景与问题剖析
在现存的很多 Coding Agent（包括早期 ToolFlow）中，长任务执行流通常处于同一条对话历史上下文中。在进入最后的验收/审查阶段（Wave 3 / Stage 3）时，审查 Agent 往往直接继承了编写代码阶段（Implementer）的海量上下文、辩解性说明与心智假设。这导致了严重的**“证实偏差（Confirmation Bias）”**与**“审查盲区”**：
- 审查员倾向于相信模型之前打印的解释，而非磁盘上真实的物理变更；
- 之前累积的数万 Token 噪音导致审查注意力分散，难以发现漏改、敏感配置变动或潜在回归。

借鉴 `Vibestrate` 等业界领先的分阶段自治架构设计，ToolFlow v1.5.0 正式落地了 **第二条核心演化路线：冷启动审查隔离机制（Cold-Start Review Isolation & Physical Diff Injection）**。

---

## 2. 核心设计与实现机制

### 2.1 物理级 Git Diff 快照提取 (`captureReviewDiffSnapshot`)
位于 `review_isolation.ts`。在审查阶段触发时，系统绕过概率性自然语言回忆，直接在宿主环境物理提取：
- `git rev-parse HEAD`：锁定基线提交指纹；
- `git status --porcelain`：精确跟踪修改、暂存与新增文件；
- `git diff HEAD` / `git diff`：提取高保真 Diff 代码补丁；
- **防膨胀截断保护**：对 Diff 设置 8,000 字符上限截断，杜绝大图/生成文件导致上下文爆炸。

### 2.2 零记忆客观审查契约 (`buildColdStartReviewContract`)
- **System Prompt 注入**：将审查角色重塑为 `ZERO-MEMORY INDEPENDENT CODE AUDITOR`，明示“冷启动生效，对前序实现过程无记忆无偏见”。
- **Payload 纯粹化**：仅将目标产物路径、验收命令与真实的 `DIFF AUDIT PAYLOAD` 组装为输入 Payload，剔除中间推导的废话。
- **强制客观断言**：指引审查员基于物理变更与执行退出码给出裁决，杜绝听信前序开发者叙述。

### 2.3 审查阶段运行时工具防线 (`ReviewIsolationGuard`)
- 在审查阶段动态实施只读防护，拦截 `write`、`edit` 等篡改源码的动作；
- 引导审查员使用 `read`、`bash`（运行测试命令）、`powershell` 或 L4 专用走查插件（如 `goal_complete`、浏览器插件）进行客观验收。

---

## 3. 架构集成

1. **类型定义升级 (`types.ts`)**：
   - `BlueprintStage` 新增 `isReviewStage` 与 `reviewIsolation` 配置属性。
2. **蓝图推导引擎升级 (`engine.ts`)**：
   - 在阶段 3（验收交付）自动标记 `isReviewStage: true`，启用 `diffOnlyContext` 与 `requireColdStart`。
3. **主运行时调度器升级 (`index.ts`)**：
   - 在阶段推进时检测审查标记，执行 `captureReviewDiffSnapshot`；
   - 将隔离审查契约结构化注入调度 Payload。

---

## 4. 回归验证与测试结果

- 新增 `TEST-16: 冷启动审查隔离与 Git Diff 物理透传验证`；
- 全量回归套件 `test_suite.ts` 包含 16 个大模块、90+ 项细粒度断言：
  - `16.1` 工作区 Diff 状态物理嗅探与文件列表抽取：**100% 绿灯**；
  - `16.2` 零记忆独立审计契约与冷启动 Prompt 组装：**100% 绿灯**；
  - `16.3` ReviewIsolationGuard 审查期写操作阻断防线：**100% 绿灯**；
- 全套测试集一次性全数通过，无破坏性变更。
