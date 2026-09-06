import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import assert from "assert";

console.log("\n================================================================================");
console.log("[TOOLFLOW] Module 1 ~ 4 新增专项自动化断言测试 (TEST-26 ~ TEST-29)");
console.log("================================================================================");

async function run() {
  console.log("\n[TEST-26] 验证 ReadCache 穿透门禁与极速代码骨架索引...");
  {
    const { ReadCacheManager } = await import("../src/dehydrator.js");
    const cacheMgr = new ReadCacheManager();
    const tmpTs = path.join(os.tmpdir(), "toolflow_skeleton_test.ts");
    const tsCode = [
      'import { foo } from "bar";',
      "export interface MyConfig { name: string; }",
      "export class WorkManager {",
      "  public doJob(): void {}",
      "}",
      "// 填充行至 85 行",
      ...Array(80).fill("const x = 1;")
    ].join("\n");
    fs.writeFileSync(tmpTs, tsCode, "utf8");

    // 1. 带有 offset/limit 时必须穿透
    const sliceHit = cacheMgr.checkOrUpdate(tmpTs, tsCode, 1, { path: tmpTs, offset: 10, limit: 20 });
    assert.strictEqual(sliceHit.isDuplicate, false, "26.1 slice 读取必须强制穿透");

    // 2. 首次全量读取建立缓存
    cacheMgr.checkOrUpdate(tmpTs, tsCode, 1);

    // 3. 再次读取输出缓存提示
    const repeatHit = cacheMgr.checkOrUpdate(tmpTs, tsCode, 2);
    assert.strictEqual(repeatHit.isDuplicate, true, "26.2 重复读取命中缓存");
    assert(repeatHit.notice && repeatHit.notice.includes("ToolFlow Read Cache"), "26.3 必须输出极简缓存提示头部");
    assert(repeatHit.notice && repeatHit.notice.includes("offset"), "26.4 提示必须引导使用 offset/limit 局部读取");

    // 4. 模拟 edit 失败记录，下一次读取必须强制穿透
    cacheMgr.recordEditFailure(tmpTs, 3);
    const retryHit = cacheMgr.checkOrUpdate(tmpTs, tsCode, 3);
    assert.strictEqual(retryHit.isDuplicate, false, "26.5 edit 失败后重读必须 100% 穿透");
    fs.rmSync(tmpTs, { force: true });
    console.log("  [OK] 26.1 - 26.5 ReadCache 穿透门禁 100% 验证通过！");
  }

  console.log("\n[TEST-27] 验证产物物理非空与内容门禁...");
  {
    const { verifyArtifactHeuristics } = await import("../src/state.js");

    // 1. 0 字节拦截
    const emptyRes = verifyArtifactHeuristics("a.ts", "");
    assert.strictEqual(emptyRes.valid, false, "27.1 0 字节文件必须被拦截");

    // 2. 纯空白字符拦截
    const blankRes = verifyArtifactHeuristics("a.ts", "   \n\n\t  ");
    assert.strictEqual(blankRes.valid, false, "27.2 纯空白字符必须被拦截");

    // 3. 合法代码通过
    const validRes = verifyArtifactHeuristics("src/version.ts", 'export const VERSION = "1.0.0";\n');
    assert.strictEqual(validRes.valid, true, "27.3 合法有效代码通过");

    console.log("  [OK] 27.1 - 27.3 产物物理非空门禁 100% 验证通过！");
  }

  console.log("\n[TEST-28] 验证双模路由意图判断器 (Fast-Track vs Blueprint)...");
  {
    const { diagnoseTaskExecutionMode } = await import("../src/engine.js");

    const fast1 = diagnoseTaskExecutionMode("修复 ui.ts 中的拼写错误");
    assert.strictEqual(fast1.mode, "FAST_TRACK", "28.1 单文件局部修复走 Fast-Track");

    const fast2 = diagnoseTaskExecutionMode("改一下第 15 行的背景颜色");
    assert.strictEqual(fast2.mode, "FAST_TRACK", "28.2 具体行号修改走 Fast-Track");

    const bp1 = diagnoseTaskExecutionMode("重构系统认证模块并搭建全套端到端测试");
    assert.strictEqual(bp1.mode, "BLUEPRINT", "28.3 全局重构强制走 Blueprint");

    console.log("  [OK] 28.1 - 28.3 任务双模路由判断 100% 验证通过！");
  }

  console.log("\n[TEST-29] 验证 TUI CJK 宽字符滑动视口与列宽断言...");
  {
    const { renderCJKSafeInputBox } = await import("../src/ui.js");
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    const mockTheme = { fg: (_c: string, s: string) => s };

    // 输入超长汉字（30 个汉字 = 60 列宽），视口窗口限定为 20 列
    const cjkText = "这是一段非常非常长的中文任务输入目标用于测试视口滑动";
    const rendered = renderCJKSafeInputBox("> ", cjkText, 20, mockTheme, true);
    const width = visibleWidth(rendered);
    assert.strictEqual(width, 20, "29.1 超长中文输入下物理列宽必须恒等于 windowWidth (20)");

    console.log("  [OK] 29.1 TUI CJK 滑动视口列宽稳定性 100% 验证通过！");
  }

  console.log("\n================================================================================");
  console.log("[ALL-EXTENDED-PASSED] Module 1 ~ 4 新增专项断言 100% 全部绿灯通过！");
  console.log("================================================================================\n");
}

run().catch(err => {
  console.error("测试异常:", err);
  process.exit(1);
});
