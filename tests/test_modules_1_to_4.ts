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

  console.log("\n[TEST-30] 验证 openArchitectNavigator 基于官方 Editor 组件的无右边框渲染与退格防重影...");
  {
    const { openArchitectNavigator } = await import("../src/ui.js");
    const { visibleWidth, CURSOR_MARKER } = await import("@earendil-works/pi-tui");
    const mockTheme = {
      fg: (_c: string, s: string) => s,
      bg: (_c: string, s: string) => s,
      bold: (s: string) => s
    };

    let capturedComp: any = null;
    const mockUi = {
      custom: (factory: any) => {
        capturedComp = factory(
          { requestRender: () => {} },
          mockTheme,
          {},
          () => {}
        );
        return Promise.resolve(null);
      }
    };

    void openArchitectNavigator(mockUi, {
      updatedAt: new Date().toISOString(),
      extensions: [],
      skills: [],
      prompts: []
    } as any, "想要完全检查一下我现在 D:\\Workspace");

    assert(capturedComp, "30.1 成功挂载自定义 TUI 组件");
    capturedComp.handleInput("文件还");
    capturedComp.handleInput("\x7f");
    capturedComp.handleInput("\x7f");

    const lines: string[] = capturedComp.render(80);
    for (const l of lines) {
      const cleanLine = l.replace(CURSOR_MARKER, "");
      assert(visibleWidth(cleanLine) <= 80, `30.2 任意渲染行宽度不得超过终端宽度 80 (实际: ${visibleWidth(cleanLine)})`);
      assert(!cleanLine.endsWith("│"), "30.3 严禁使用会导致 CJK 终端折行错位的右侧竖线边框");
    }
    const joined = lines.join("\n");
    assert(joined.includes("Task Objective"), "30.4 界面外壳采用极简通用英文标签");
    assert(joined.includes("想要完全检查一下我现在 D:\\Workspace文"), "30.5 中文追加与连续退格精确无误");

    console.log("  [OK] 30.1 - 30.5 官方 Editor 输入组件与英文无边框布局 100% 验证通过！");
  }

  console.log("\n[TEST-31] 验证 LLM 母语动态选项生成、网页游戏产物识别 (index.html) 与工具列表压缩...");
  {
    const { diagnoseTaskRequirements, synthesizeBlueprintPlanWithLLM, synthesizeBlueprint } = await import("../src/engine.js");
    const { renderBlueprintSummary } = await import("../src/ui.js");

    const tax: any = {
      updatedAt: new Date().toISOString(),
      extensions: [],
      skills: [],
      prompts: [],
      tools: Array.from({ length: 40 }, (_, i) => ({
        name: `browser_tool_${i}`,
        type: "tool" as const,
        layer: "L1_UTILITY" as const,
        source: "test",
        digest: "test"
      })),
      availableToolNames: Array.from({ length: 40 }, (_, i) => `browser_tool_${i}`)
    };

    const mockCtx: any = {
      model: { id: "mock-model" },
      modelRegistry: {
        complete: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                researchSummary: "针对儿童坦克大战网页游戏的定制推导",
                requirementSlots: [
                  {
                    slotId: "domain_feature_preference",
                    title: "1. 玩法与关卡设计",
                    category: "scope",
                    question: "请选择适合孩子的坦克大战玩法：",
                    options: [
                      {
                        id: "opt_coop",
                        label: "[双人同屏护基地] 家长与孩子协作闯关",
                        description: "支持双人键盘同屏操作，难度温和有趣",
                        isRecommended: true,
                        recommendedEcosystem: { extensions: ["@plannotator/pi-extension"], reason: "浏览器预览" }
                      }
                    ]
                  },
                  {
                    slotId: "visual_style_preference",
                    title: "2. 画面风格",
                    category: "design",
                    question: "请选择视觉画风：",
                    options: [
                      {
                        id: "opt_cartoon",
                        label: "[儿童卡通像素风] 明亮色彩与趣味音效",
                        description: "护眼明亮配色",
                        isRecommended: true,
                        recommendedEcosystem: { extensions: [], reason: "Canvas 原生绘制" }
                      }
                    ]
                  }
                ],
                architectSparks: [
                  {
                    id: "spark_kids",
                    title: "儿童防误触与无限生命开关",
                    description: "内置护盾与友军免伤模式",
                    impact: "儿童友好度提升",
                    isAcceptedByDefault: true
                  }
                ],
                dynamicGoals: ["构建可玩的坦克大战 index.html"]
              })
            }
          ]
        })
      }
    };

    const task = "我想要做一个坦克大战网页版游戏给孩子玩";
    const diag = await diagnoseTaskRequirements(task, tax, mockCtx);
    assert.strictEqual(diag.requirementSlots.length, 2, "31.1 LLM 动态返回 2 个贴合坦克大战的母语决策维度");
    assert(diag.requirementSlots[0].title.includes("玩法与关卡设计"), "31.2 选项完全跟随用户输入母语生成");

    const plan = await synthesizeBlueprintPlanWithLLM(task, diag, {}, tax);
    assert.strictEqual(plan.primaryArtifact, "index.html", "31.3 网页版游戏自动推导产物为 index.html 而非 src/index.js");
    assert.strictEqual(plan.isFrontend, true, "31.4 正确识别为前端/网页交互应用");

    const bp = synthesizeBlueprint(task, diag, {}, tax, "B", undefined, plan);
    const summaryMd = renderBlueprintSummary(bp);
    assert(!summaryMd.includes("@@plannotator"), "31.5 消除 @@ 双重前缀 Bug");
    assert(summaryMd.includes("(+"), "31.6 40+ 工具列表自动折叠为 (+N more) 杜绝刷屏");

    console.log("  [OK] 31.1 - 31.6 LLM 母语自适应、index.html 推导与工具列表折叠 100% 验证通过！");
  }

  console.log("\n================================================================================");
  console.log("[ALL-EXTENDED-PASSED] Module 1 ~ 4 新增专项断言 100% 全部绿灯通过！");
  console.log("================================================================================\n");
}

run().catch(err => {
  console.error("测试异常:", err);
  process.exit(1);
});
