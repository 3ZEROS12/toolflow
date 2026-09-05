# ToolFlow ⌬

> Pi 的任务阶段运行器与本地 Prompt 模板库。

[English](README.md) | [简体中文](README_zh.md)

ToolFlow 是一个轻量级 Pi 扩展，核心做两件事：
1. **任务分阶段执行**：根据你的任务自动拆分执行阶段，按阶段限制工具范围，并在每个阶段核对交付文件，支持一键撤销（回滚）。
2. **Prompt 模板管理**：在终端里直接浏览、查找、预填和新建本地 prompt 模板（基于 `prompts/*.md`）。

---

## 安装

在终端中运行：

```bash
# 从 GitHub 直接安装
pi install git:github.com/3ZEROS12/toolflow
```

---

## 核心功能

### 1. 阶段化任务执行
- **自动分阶段**：根据你的具体任务（如后端 API、Python 脚本或 CLI 工具）拆出合理的开发阶段与目标文件（例如 `src/index.ts` 或 `main.py`），杜绝不合时宜地生成 `index.html`。
- **阶段产物检查**：每个阶段完成后，自动检查目标文件是否存在并记录 Git 快照。
- **一键回退**：若某个阶段生成的代码不满意，运行 `/toolflow rollback` 即可立刻恢复到该阶段开始前的状态。

### 2. Prompt 模板库
直接输入 `/toolflow` 即可打开模板浏览界面：
- **查看与检索**：自动读取项目内与全局的 `prompts/*.md` 模板文件，按修改时间倒序排列。
- **一键预填**：选中模板后按 `[p]`，直接填入底部输入框。
- **快速新建**：按 `[c]` 即可就地新建模板文件，按 `[Ctrl+L]` 还能自动生成命令名和简要描述。

---

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `/toolflow` | 打开 Prompt 模板库与任务输入界面 |
| `/toolflow <任务内容>` | 直接为指定任务创建并执行阶段计划 |
| `/toolflow rollback` | 撤销当前阶段的修改，回退到阶段开始前的快照 |
| `/toolflow reset` | 清除当前任务状态与临时缓存 |
| `/toolflow export` | 将执行计划导出为 `BLUEPRINT.md` |

---

## 界面快捷键

- `[Enter]`：输入任务并开始拆解
- `[p]`：将光标所在的 Prompt 模板填入输入框
- `[c]`：新建 Prompt 模板
- `[1-4]` / `[←/→]`：在方案选择时切换选项
- `[Esc]`：退出界面

---

## License

MIT © [Jason](https://github.com/3ZEROS12)
