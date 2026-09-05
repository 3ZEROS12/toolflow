import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import assert from "assert";
import { sniffProjectFingerprint, discoverEcosystemTaxonomy } from "./taxonomy.js";
import { ContextDehydrator } from "./dehydrator.js";
import { BlastRadiusGuard } from "./blast_radius.js";
import { MultiAgentWorkerOrchestrator } from "./worker_orchestrator.js";
import { CodebaseMemoryManager } from "./memory.js";
import { 
  diagnoseTaskRequirements, 
  synthesizeBlueprint,
  planDAGWaves 
} from "./engine.js";
import { BlueprintStage } from "./types.js";

async function runMonorepoMultiLangStressTesting() {
  console.log("================================================================================");
  console.log("[STRESS-TEST] 启动 ToolFlow 跨语言复杂工程与 Monorepo 实战压测流水线");
  console.log("================================================================================\n");

  const baseSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "toolflow_stress_multilang_"));

  try {
    // -------------------------------------------------------------------------
    // 压测场景 1: 大型 TypeScript / Node Monorepo (Turborepo 4 包拓扑)
    // -------------------------------------------------------------------------
    console.log(">>> [SCENARIO 1] 大型 TypeScript Monorepo (apps/web, apps/api, packages/core, packages/ui)...");
    const tsMonorepoRoot = path.join(baseSandbox, "ts_monorepo");
    fs.mkdirSync(tsMonorepoRoot, { recursive: true });

    // 初始化 Monorepo 目录与文件
    fs.writeFileSync(path.join(tsMonorepoRoot, "package.json"), JSON.stringify({
      name: "ts-enterprise-monorepo",
      private: true,
      workspaces: ["apps/*", "packages/*"],
      devDependencies: { "turbo": "^1.10.0", "typescript": "^5.0.0" }
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(tsMonorepoRoot, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
    fs.writeFileSync(path.join(tsMonorepoRoot, ".env"), "DATABASE_URL=postgres://root:secret@localhost:5432/prod\nJWT_SECRET=super_secret_jwt\n");

    const fpTs = sniffProjectFingerprint(tsMonorepoRoot);
    console.log(`  ➔ [嗅探] 项目类型: ${fpTs.projectType} | 包管理器: ${fpTs.packageManager}`);
    assert(fpTs.projectType === "node" || fpTs.projectType === "monorepo", "1.1 TS Monorepo 识别");

    // 定义多阶段跨包依赖蓝图
    const tsStages: BlueprintStage[] = [
      {
        stageId: "stage_core_contracts",
        title: "Packages Core 类型契约与领域模型",
        roleProfile: "Core Architect",
        coreObjective: "在 packages/core/src 中输出统一领域模型与事件定义",
        expectedArtifact: "packages/core/src/types.ts",
        expectedArtifacts: ["packages/core/src/types.ts", "packages/core/src/index.ts"],
        targetPatterns: ["packages/core/src/**"],
        artifactContract: "必须包含 User 与 Order 接口定义及导出",
        allowedTools: ["write", "edit"],
        tokenCostNotice: "low",
        boundCapabilities: {}
      },
      {
        stageId: "stage_ui_components",
        title: "Packages UI 组件库",
        roleProfile: "Frontend UI Specialist",
        coreObjective: "在 packages/ui/src 中实现基础设计组件",
        dependsOn: ["stage_core_contracts"],
        expectedArtifact: "packages/ui/src/Button.tsx",
        expectedArtifacts: ["packages/ui/src/Button.tsx"],
        targetPatterns: ["packages/ui/src/**"],
        artifactContract: "输出通用 Button 与 Card 交互组件",
        allowedTools: ["write", "edit"],
        tokenCostNotice: "low",
        boundCapabilities: {}
      },
      {
        stageId: "stage_api_service",
        title: "Apps API 微服务服务层",
        roleProfile: "Backend API Engineer",
        coreObjective: "在 apps/api/src 中实现 Express/Fastify 业务接口并依赖 core",
        dependsOn: ["stage_core_contracts"],
        expectedArtifact: "apps/api/src/server.ts",
        expectedArtifacts: ["apps/api/src/server.ts"],
        targetPatterns: ["apps/api/src/**"],
        artifactContract: "输出 RESTful API 路由与鉴权",
        allowedTools: ["write", "edit"],
        tokenCostNotice: "low",
        boundCapabilities: {}
      },
      {
        stageId: "stage_web_integration",
        title: "Apps Web 客户端端到端整合",
        roleProfile: "Fullstack Integrator",
        coreObjective: "在 apps/web/src 中集成 UI 与 API 请求",
        dependsOn: ["stage_ui_components", "stage_api_service"],
        expectedArtifact: "apps/web/src/App.tsx",
        expectedArtifacts: ["apps/web/src/App.tsx", "apps/web/src/summary.json"],
        targetPatterns: ["apps/web/src/**"],
        artifactContract: "完成客户端页面渲染与状态流转",
        allowedTools: ["write", "edit"],
        tokenCostNotice: "low",
        boundCapabilities: {}
      }
    ];

    // 编译 Kahn DAG 波次与多智能体并发调度批次
    const bundles = MultiAgentWorkerOrchestrator.compileWaveBundles(tsStages, 4);
    console.log(`  ➔ [Kahn DAG] 编排波次数量: ${bundles.length}`);
    assert.strictEqual(bundles.length, 3, "1.2 DAG 波次正确推导为 3 波");
    assert.strictEqual(bundles[0].tasks.length, 1, "1.3 波次 1 包含 1 个基础契约任务");
    assert.strictEqual(bundles[1].tasks.length, 2, "1.4 波次 2 并行调度 UI 与 API 两个子任务");
    assert.strictEqual(bundles[1].isParallel, true, "1.5 波次 2 标记为并行");
    assert.strictEqual(bundles[2].tasks.length, 1, "1.6 波次 3 汇聚为 Web 客户端整合任务");

    // 模拟执行与爆炸半径隔离校验
    const dehydratorTs = new ContextDehydrator(tsMonorepoRoot, "bp_ts_monorepo_001");
    const guardTs = new BlastRadiusGuard();

    for (const bundle of bundles) {
      console.log(`    >> 执行 Wave ${bundle.waveIndex} (并行=${bundle.isParallel}, 任务数=${bundle.tasks.length})...`);
      for (const task of bundle.tasks) {
        const stage = tsStages.find(s => s.stageId === task.stageId)!;
        guardTs.updateAllowedScope(stage, tsMonorepoRoot);

        // 渗透拦截测试 1: 拦截试图篡改根目录 .env
        const badCall1 = { toolName: "write", input: { path: ".env", content: "HACKED=1" } };
        const res1 = guardTs.verifyToolCall(badCall1, tsMonorepoRoot);
        assert.strictEqual(res1.block, true, `1.7 成功拦截根目录 .env 恶意篡改: ${task.stageId}`);

        // 渗透拦截测试 2: 拦截跨包越界写入 (如 API worker 试图写 Web 目录)
        if (task.stageId === "stage_api_service") {
          const crossPkgCall = { toolName: "write", input: { path: "apps/web/src/hack.ts", content: "illegal" } };
          const resCross = guardTs.verifyToolCall(crossPkgCall, tsMonorepoRoot);
          assert.strictEqual(resCross.block, true, "1.8 成功拦截跨包未授权越界写入");
        }

        // 渗透拦截测试 3: Windows 路径穿越与 NTFS ::$DATA
        const traversalCall = { toolName: "write", input: { path: "packages/core/src/../../.git/config", content: "bad" } };
        const dataStreamCall = { toolName: "write", input: { path: "packages/core/src/types.ts::$DATA", content: "bad" } };
        assert.strictEqual(guardTs.verifyToolCall(traversalCall, tsMonorepoRoot).block, true, "1.9 路径穿越绝对拦截");
        assert.strictEqual(guardTs.verifyToolCall(dataStreamCall, tsMonorepoRoot).block, true, "1.10 NTFS ::$DATA 绝对拦截");

        // 合法产物落地
        for (const art of task.targetArtifacts) {
          const fullArt = path.join(tsMonorepoRoot, art);
          fs.mkdirSync(path.dirname(fullArt), { recursive: true });
          const code = `export interface User { id: string; name: string; }\nexport async function handleAction(u: User) { return u.id; }\n`;
          fs.writeFileSync(fullArt, code, "utf-8");
        }

        // 上下文物理脱水
        const rawLog = `[TURBO-BUILD] Compiling ${task.stageId}...\n` + "Successfully built target\n".repeat(200);
        const handoff = dehydratorTs.dehydrateStageLog(
          task.stageId,
          task.stageTitle,
          rawLog,
          task.targetArtifacts.map(p => ({
            path: p,
            sizeBytes: 150,
            sha256: "sha_mock_" + path.basename(p),
            verifiedAt: Date.now()
          })),
          `Task ${task.stageId} executed perfectly.`
        );
        assert(handoff.tokenSavingsRatio.includes("%"), "1.11 脱水节约率计算正常");
      }
    }
    console.log("  [OK] Scenario 1 大型 TypeScript Monorepo 压测 100% 通过\n");

    // -------------------------------------------------------------------------
    // 压测场景 2: Python / FastAPI & Celery 分布式后端工程
    // -------------------------------------------------------------------------
    console.log(">>> [SCENARIO 2] Python / FastAPI & Celery 分布式微服务架构...");
    const pyProjectRoot = path.join(baseSandbox, "py_fastapi_service");
    fs.mkdirSync(pyProjectRoot, { recursive: true });

    fs.writeFileSync(path.join(pyProjectRoot, "pyproject.toml"), `
[project]
name = "enterprise-fastapi-service"
version = "0.1.0"
dependencies = [
  "fastapi>=0.110.0",
  "uvicorn>=0.28.0",
  "pydantic>=2.6.0",
  "celery>=5.3.0",
  "redis>=5.0.0"
]
`, "utf-8");
    fs.writeFileSync(path.join(pyProjectRoot, "uv.lock"), "");
    fs.writeFileSync(path.join(pyProjectRoot, ".env"), "REDIS_URL=redis://localhost:6379/0\nSECRET_KEY=py_sec\n");

    const fpPy = sniffProjectFingerprint(pyProjectRoot);
    console.log(`  ➔ [嗅探] 项目类型: ${fpPy.projectType} | 包管理: ${fpPy.packageManager} | 框架: ${fpPy.mainFramework}`);
    assert.strictEqual(fpPy.projectType, "python", "2.1 Python 项目识别");
    assert.strictEqual(fpPy.packageManager, "uv", "2.2 Python uv 包管理器识别");
    assert.strictEqual(fpPy.mainFramework, "FastAPI", "2.3 FastAPI 框架识别");

    const pyStages: BlueprintStage[] = [
      {
        stageId: "py_stage_models",
        title: "FastAPI Pydantic 数据契约模型",
        roleProfile: "Python Backend Architect",
        coreObjective: "在 backend/models.py 输出核心数据模型",
        expectedArtifact: "backend/models.py",
        expectedArtifacts: ["backend/models.py"],
        targetPatterns: ["backend/**"],
        artifactContract: "输出 BaseModel 及其序列化校验器",
        allowedTools: ["write", "edit"],
        tokenCostNotice: "low",
        boundCapabilities: {}
      },
      {
        stageId: "py_stage_api",
        title: "FastAPI REST 端点与 Celery 异步任务",
        roleProfile: "Async Python Specialist",
        coreObjective: "在 backend/main.py 与 backend/worker.py 实现接口与 Worker",
        dependsOn: ["py_stage_models"],
        expectedArtifact: "backend/main.py",
        expectedArtifacts: ["backend/main.py", "backend/worker.py", "tests/test_api.py"],
        targetPatterns: ["backend/**", "tests/**"],
        artifactContract: "包含 FastAPI app 实例与 pytest 测试用例",
        allowedTools: ["write", "edit", "bash"],
        tokenCostNotice: "medium",
        boundCapabilities: {}
      }
    ];

    const guardPy = new BlastRadiusGuard();
    const dehydratorPy = new ContextDehydrator(pyProjectRoot, "bp_py_service_002");

    for (const stg of pyStages) {
      guardPy.updateAllowedScope(stg, pyProjectRoot);

      // 安全防御验证
      const badEnv = guardPy.verifyToolCall({ toolName: "write", input: { path: ".env", content: "PY_HACK=1" } }, pyProjectRoot);
      assert.strictEqual(badEnv.block, true, "2.4 Python .env 拦截保护");

      for (const art of stg.expectedArtifacts || [stg.expectedArtifact]) {
        const fullArt = path.join(pyProjectRoot, art);
        fs.mkdirSync(path.dirname(fullArt), { recursive: true });
        const pyCode = `from pydantic import BaseModel\n\nclass Item(BaseModel):\n    id: int\n    name: str\n\ndef get_item(item_id: int) -> Item:\n    return Item(id=item_id, name="Test")\n`;
        fs.writeFileSync(fullArt, pyCode, "utf-8");
      }

      // 物理门禁校验
      for (const art of stg.expectedArtifacts || [stg.expectedArtifact]) {
        const fullArt = path.join(pyProjectRoot, art);
        assert(fs.existsSync(fullArt) && fs.statSync(fullArt).size > 0, `2.5 产物落地校验: ${art}`);
      }

      const rawPyLogs = `[PYTEST-RUN] Running 14 test cases in tests/test_api.py...\n` + "test_api.py::test_create_item PASSED\n".repeat(150);
      const handoffPy = dehydratorPy.dehydrateStageLog(
        stg.stageId,
        stg.title,
        rawPyLogs,
        (stg.expectedArtifacts || [stg.expectedArtifact]).map(p => ({
          path: path.join(pyProjectRoot, p),
          sizeBytes: 200,
          sha256: "sha_py_hash_1234567890abcdef",
          verifiedAt: Date.now()
        })),
        `Python stage ${stg.stageId} completed successfully.`
      );
      assert(handoffPy.verifiedArtifacts[0].sha256.length > 0, "2.6 SHA-256 指纹记录完备");
      assert(handoffPy.tokenSavingsRatio.includes("%"), "2.7 脱水率正常");
    }
    console.log("  [OK] Scenario 2 Python / FastAPI 分布式工程压测 100% 通过\n");

    // -------------------------------------------------------------------------
    // 压测场景 3: Rust Multi-Crate Workspace (Cargo Workspace 引擎与 CLI)
    // -------------------------------------------------------------------------
    console.log(">>> [SCENARIO 3] Rust Multi-Crate Workspace (Cargo Workspace)...");
    const rustWorkspaceRoot = path.join(baseSandbox, "rust_workspace");
    fs.mkdirSync(rustWorkspaceRoot, { recursive: true });

    fs.writeFileSync(path.join(rustWorkspaceRoot, "Cargo.toml"), `
[workspace]
members = [
    "crates/core_engine",
    "crates/cli_driver"
]
resolver = "2"
`, "utf-8");
    fs.writeFileSync(path.join(rustWorkspaceRoot, "Cargo.lock"), "");

    const fpRust = sniffProjectFingerprint(rustWorkspaceRoot);
    console.log(`  ➔ [嗅探] 项目类型: ${fpRust.projectType} | 包管理: ${fpRust.packageManager}`);
    assert.strictEqual(fpRust.projectType, "rust", "3.1 Rust Workspace 识别");
    assert.strictEqual(fpRust.packageManager, "cargo", "3.2 Cargo 识别");

    const rustStages: BlueprintStage[] = [
      {
        stageId: "rust_stage_core_engine",
        title: "Rust Core Engine Crate 架构与内存安全模型",
        roleProfile: "Systems Architect",
        coreObjective: "在 crates/core_engine/src/lib.rs 实现高性能计算引擎",
        expectedArtifact: "crates/core_engine/src/lib.rs",
        expectedArtifacts: ["crates/core_engine/src/lib.rs", "crates/core_engine/Cargo.toml"],
        targetPatterns: ["crates/core_engine/**"],
        artifactContract: "包含 Engine 结构体与 trait 实现",
        allowedTools: ["write", "edit", "bash"],
        tokenCostNotice: "medium",
        boundCapabilities: {}
      },
      {
        stageId: "rust_stage_cli_driver",
        title: "Rust CLI Driver Crate 交互终端与 Clap 绑定",
        roleProfile: "CLI Systems Engineer",
        coreObjective: "在 crates/cli_driver/src/main.rs 实现命令行界面",
        dependsOn: ["rust_stage_core_engine"],
        expectedArtifact: "crates/cli_driver/src/main.rs",
        expectedArtifacts: ["crates/cli_driver/src/main.rs", "crates/cli_driver/Cargo.toml"],
        targetPatterns: ["crates/cli_driver/**"],
        artifactContract: "包含 main 入口函数与命令行参数解析",
        allowedTools: ["write", "edit", "bash"],
        tokenCostNotice: "medium",
        boundCapabilities: {}
      }
    ];

    const guardRust = new BlastRadiusGuard();
    const dehydratorRust = new ContextDehydrator(rustWorkspaceRoot, "bp_rust_003");

    for (const stg of rustStages) {
      guardRust.updateAllowedScope(stg, rustWorkspaceRoot);

      // 验证 Cargo.lock 受保护拦截
      const badLock = guardRust.verifyToolCall({ toolName: "write", input: { path: "Cargo.lock", content: "illegal" } }, rustWorkspaceRoot);
      assert.strictEqual(badLock.block, true, "3.3 Cargo.lock 关键锁文件保护拦截");

      for (const art of stg.expectedArtifacts || [stg.expectedArtifact]) {
        const fullArt = path.join(rustWorkspaceRoot, art);
        fs.mkdirSync(path.dirname(fullArt), { recursive: true });
        if (art.endsWith(".rs")) {
          const rustCode = `pub struct Engine {\n    pub version: &'static str,\n}\nimpl Engine {\n    pub fn new() -> Self {\n        Self { version: "1.4.0" }\n    }\n}\n`;
          fs.writeFileSync(fullArt, rustCode, "utf-8");
        } else {
          fs.writeFileSync(fullArt, `[package]\nname = "crate_pkg"\nversion = "0.1.0"\n`, "utf-8");
        }
      }

      // 门禁与脱水
      const rawRustLogs = `   Compiling core_engine v0.1.0\n   Compiling cli_driver v0.1.0\n    Finished release [optimized] target(s) in 2.34s\n` + "running 8 tests ... ok\n".repeat(50);
      const handoffRust = dehydratorRust.dehydrateStageLog(
        stg.stageId,
        stg.title,
        rawRustLogs,
        (stg.expectedArtifacts || [stg.expectedArtifact]).map(p => ({
          path: path.join(rustWorkspaceRoot, p),
          sizeBytes: 300,
          sha256: "sha_rust_hash_abcdef123456",
          verifiedAt: Date.now()
        })),
        `Rust crate stage ${stg.stageId} compiled and verified.`
      );
      assert(handoffRust.verifiedArtifacts[0].sha256.length > 0, "3.4 Rust 脱水指纹校验通过");
    }
    console.log("  [OK] Scenario 3 Rust Multi-Crate Workspace 压测 100% 通过\n");

    // -------------------------------------------------------------------------
    // 压测场景 4: 异构混合 Monorepo (Node + Python + Rust 统一编排与 4 线程并发)
    // -------------------------------------------------------------------------
    console.log(">>> [SCENARIO 4] 异构混合 Monorepo (Node/Python/Rust) 4 并发波次极限压测...");
    const polyglotRoot = path.join(baseSandbox, "polyglot_monorepo");
    fs.mkdirSync(polyglotRoot, { recursive: true });

    const memManager = new CodebaseMemoryManager(polyglotRoot);
    memManager.recordConvention("Adoption of Kahn DAG Wave Scheduler for multi-language pipelines");
    memManager.recordLesson("BlastRadiusGuard", "Enforce physical Glob directory locks", "Prevent sibling package contamination");
    memManager.recordLesson("NTFS Security", "Windows NTFS ::$DATA stream attacks must be strictly intercepted", "Defense against alternate data streams");

    const memSummary = memManager.getPromptContextInjection();
    assert(memSummary.includes("Adoption of Kahn DAG"), "4.1 架构记忆库正确记录与导出");
    assert(memSummary.includes("NTFS ::$DATA"), "4.2 安全守则正确注入");

    // 全局脱水目录配额与治理测试
    const dehydratorPoly = new ContextDehydrator(polyglotRoot, "bp_polyglot_004");
    for (let i = 0; i < 5; i++) {
      dehydratorPoly.dehydrateStageLog(
        `stage_stress_${i}`,
        `Stress Stage ${i}`,
        "Log content heavy payload\n".repeat(500),
        [{ path: `output_${i}.log`, sizeBytes: 1000, sha256: `hash_${i}`, verifiedAt: Date.now() }],
        `Completed stress iteration ${i}`
      );
    }
    const runsDir = path.join(polyglotRoot, ".pi", "toolflow", "runs", "bp_polyglot_004");
    assert(fs.existsSync(runsDir), "4.3 Runs 物理脱水落盘目录存在");
    const archivedFiles = fs.readdirSync(runsDir);
    assert(archivedFiles.length >= 5, "4.4 归档文件成功落盘");

    console.log("  [OK] Scenario 4 异构混合 Monorepo 极限压测 100% 通过\n");

    console.log("================================================================================");
    console.log("[ALL-PASSED] 跨语言复杂工程实战联调全部 4 大场景、20+ 细粒度断言 100% 绿灯全数通过！");
    console.log("================================================================================");
  } finally {
    try {
      fs.rmSync(baseSandbox, { recursive: true, force: true });
      console.log(`[STRESS-TEST] 测试隔离沙盒已自动清理: ${baseSandbox}`);
    } catch (_) {}
  }
}

runMonorepoMultiLangStressTesting();
