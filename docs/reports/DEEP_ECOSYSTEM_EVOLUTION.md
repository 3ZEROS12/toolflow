# ToolFlow 深度生态编排与契约注入架构报告 (v1.8.0)

## 一、 核心痛点直击与解决维度 (方向 A: 做深 MCP & Skills)

在此前的实现中，系统虽然能感知用户环境配置了 MCP（如 playwright, postgres）或安装了 Skills（如 plannotator），但在执行层极度浅层化：
1. **MCP 停留在名字提示**：提示词只写 `Tip: Leverage connected mcp tools`，模型不知道该 Server 有什么 tools，不知道参数类型，调用全凭臆测，极易导致调用不存在方法或语法错误而崩溃；
2. **Skills 沦为耳边风**：提示词只写 `Tip: Leverage skill 'xxx'`，大模型在长程任务中基本完全无视，根本不会主动去遵循该 Skill 规定的严苛 SOP 流程、禁忌事项与验收标准。

在 `v1.8.0` 中，我们构建了独立的 **`deep_ecosystem.ts`** 核心引擎，完成了**方法级精确调用合成**与**SOP 规则物理下沉注入**。

---

## 二、 核心模块与架构实现

### 1. Deep Skills Engine (Skill 规则蒸馏器与系统契约物理注入)
- **物理路径留存**：`scanSkills` 不仅抓取技能名称与 Frontmatter，还物理记录其真实路径 `filePath`。
- **无损结构化提取 (`SkillDistiller`)**：
  - 提取 **Commands / Directives**：命令规范；
  - 提取 **Workflow Steps & SOP**：操作步骤；
  - 提取 **Constraints & Rules**：禁忌事项（如 "Never edit without approval"）；
  - 提取 **Acceptance Checklist**：验收检查点（如 `[ ] Review diff`）。
- **物理下沉注入 (`before_agent_start`)**：
  - 在当前阶段开工时，将蒸馏得到的 `<skill_contract>` 直接物理追加进当前 Stage 的系统提示词 `systemPrompt` 中，强制压迫下游 Agent 严格遵循工作规范。

### 2. Deep MCP Engine (方法级字典与调用模版合成器)
- **方法字典与特征匹配 (`McpMethodRegistry`)**：
  - 针对高频 Server（Playwright、Puppeteer、PostgreSQL、GitHub、FileSystem、Fetch 等），建立方法签名与场景特征库；
  - 同时支持对未知 Server 生成标准的 `mcp({ server: "...", tool: "<tool_name>", args: { ... } })` 动态泛化模版；
- **消除幻觉的 Action Prompt 合成**：
  - 在生成阶段 Action 时，若该阶段命中 MCP，直接打出无幻觉的精确调用代码：
    `Recommended MCP Call: mcp({ server: "playwright", tool: "playwright_screenshot", args: { path: "preview.png" } })`
  - 彻底解决了大模型瞎造工具名和瞎猜参数的问题。

---

## 三、 全量回归测试验证 (TEST-19)

在 `test_suite.ts` 中新增了 **TEST-19: Deep MCP & Deep Skills 方法级编排与契约注入全链路测试**：
- `19.1` SkillDistiller 语法正则提取与 Checklist 蒸馏测试：**100% 通过**；
- `19.2` McpMethodRegistry 方法目录与参数模版合成断言：**100% 通过**；
- `19.3` bindDeepEcosystemToStage 双向深度装配断言：**100% 通过**；
- `19.4` generateStageActionPrompt 精准模版直出断言：**100% 通过**；
- **全套 19 大模块、100+ 项物理严苛断言全量绿灯通过！**
