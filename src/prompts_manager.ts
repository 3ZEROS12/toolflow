import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { extractValidJsonObject } from "./json_extractor.js";

export interface PromptItemInfo {
  command: string;
  name: string;
  description: string;
  scope: "global" | "project" | "package";
  category: "user" | "system"; // 分组：用户自定义（global/project） vs 系统内置（package）
  filePath: string;
  updatedAt: number; // 文件修改时间戳，用于将最新添加/修改的排在顶端
  lastUsedAt?: number; // 最近使用时间戳（MRU）
}

export class PromptsManager {
  public static scanAllPrompts(cwd: string = process.cwd()): PromptItemInfo[] {
    const results: PromptItemInfo[] = [];
    const seen = new Set<string>();

    const checkDir = (dir: string, scope: "global" | "project" | "package") => {
      if (!fs.existsSync(dir)) return;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith(".md")) {
            const name = file.replace(/.md$/, "");
            const command = "/" + name;
            if (seen.has(command)) continue;
            seen.add(command);

            const filePath = path.join(dir, file);
            let description = "";
            try {
              const content = fs.readFileSync(filePath, "utf8");
              const parts = content.split("description:");
              if (parts.length > 1) {
                description = parts[1].split("\n")[0].trim();
              }
            } catch (_) {}

            let updatedAt = 0;
            try {
              updatedAt = fs.statSync(filePath).mtimeMs;
            } catch (_) {}

            const category: "user" | "system" = scope === "package" ? "system" : "user";

            results.push({
              command,
              name,
              description: description || "自定义提示词模板 [" + command + "]",
              scope,
              category,
              filePath,
              updatedAt
            });
          }
        }
      } catch (_) {}
    };

    const projectDir = path.join(cwd, ".pi", "prompts");
    checkDir(projectDir, "project");

    const piAgentBase = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const globalDir = path.join(piAgentBase, "prompts");
    checkDir(globalDir, "global");

    const pkgDir = path.join(piAgentBase, "npm", "node_modules");
    if (fs.existsSync(pkgDir)) {
      try {
        const scanPkgs = (base: string, depth = 0) => {
          if (depth > 2) return;
          const items = fs.readdirSync(base);
          for (const item of items) {
            const full = path.join(base, item);
            if (item === "prompts") {
              checkDir(full, "package");
            } else if (fs.statSync(full).isDirectory() && !item.startsWith(".")) {
              scanPkgs(full, depth + 1);
            }
          }
        };
        scanPkgs(pkgDir);
      } catch (_) {}
    }

    // 读取最近使用时间戳（MRU）
    const mruMap = this.loadMruMap();
    for (const item of results) {
      if (mruMap[item.command]) {
        item.lastUsedAt = mruMap[item.command];
      }
    }

    // 默认按照最后修改时间排序
    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results;
  }

  private static getMruFilePath(): string {
    const piAgentBase = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    return path.join(piAgentBase, "toolflow_prompts_mru.json");
  }

  private static loadMruMap(): Record<string, number> {
    const file = this.getMruFilePath();
    if (!fs.existsSync(file)) return {};
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
      return {};
    }
  }

  /**
   * 记录提示词被调用/选中，更新 MRU 时间戳
   */
  public static recordPromptUsage(command: string): void {
    const mruMap = this.loadMruMap();
    mruMap[command] = Date.now();
    try {
      const file = this.getMruFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(mruMap, null, 2), "utf8");
    } catch (_) {}
  }

  /**
   * 获取最近使用的提示词列表（Top N），若无使用记录则回退为按最新添加时间排序
   */
  public static getRecentPrompts(prompts: PromptItemInfo[], limit: number = 5): PromptItemInfo[] {
    const mruMap = this.loadMruMap();
    const withUsage = prompts.filter(p => mruMap[p.command] !== undefined);
    if (withUsage.length > 0) {
      withUsage.sort((a, b) => (mruMap[b.command] || 0) - (mruMap[a.command] || 0));
      return withUsage.slice(0, limit);
    }
    // 回退展示按更新时间排序的前 N 个
    return [...prompts].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /**
   * 提取指定提示词文件的正文前 N 行用于即时预览（自动剥离 frontmatter 头部）
   */
  public static getPromptPreviewLines(item: PromptItemInfo, maxLines: number = 3): string[] {
    const body = this.getPromptContent(item);
    if (!body) return [];
    return body
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .slice(0, maxLines);
  }

  public static createPrompt(name: string, description: string, content: string, scope: "global" | "project" = "global", cwd: string = process.cwd()): PromptItemInfo {
    const cleanName = name.replace(/^\/+/, "").trim();
    const piAgentBase = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const targetDir = scope === "project"
      ? path.join(cwd, ".pi", "prompts")
      : path.join(piAgentBase, "prompts");

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const filePath = path.join(targetDir, cleanName + ".md");
    const fileBody = [
      "---",
      "description: " + description.trim(),
      "---",
      "",
      content.trim(),
      ""
    ].join("\n");

    fs.writeFileSync(filePath, fileBody, "utf8");

    return {
      command: "/" + cleanName,
      name: cleanName,
      description: description.trim(),
      scope,
      category: "user",
      filePath,
      updatedAt: Date.now()
    };
  }

  public static getPromptContent(item: PromptItemInfo): string {
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      return "";
    }
    try {
      const raw = fs.readFileSync(item.filePath, "utf8");
      if (raw.startsWith("---")) {
        const parts = raw.split("---");
        if (parts.length >= 3) {
          return parts.slice(2).join("---").trim();
        }
      }
      return raw.trim();
    } catch (_) {
      return "";
    }
  }

  public static deletePrompt(item: PromptItemInfo): boolean {
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      return false;
    }
    try {
      fs.unlinkSync(item.filePath);
      return true;
    } catch (_) {
      return false;
    }
  }

  public static async autoSummarizeTagWithLLM(content: string, ctx?: any): Promise<{ name: string; description: string }> {
    const fallbackName = "my-prompt";
    const fallbackDesc = content.slice(0, 30).replace(/\r?\n/g, " ");

    if (!ctx || !(ctx as any).modelRegistry || !(ctx as any).model) {
      return { name: fallbackName, description: fallbackDesc };
    }

    try {
      const mr = (ctx as any).modelRegistry;
      const model = (ctx as any).model;
      const prompt = `请为以下这段用于 AI 编程的 Prompt 模版生成一个极简短的命令名称和一个精练的中文说明。

[PROMPT 内容]:
${content.slice(0, 1500)}

严格按 JSON 输出:
{
  "name": "极简英文命令名（如 wechat-test, code-review, rust-api 等，纯小写字母与连字符）",
  "description": "一句话大白话精炼说明（20字以内，讲清楚它的作用）"
}`;

      const resp = await mr.complete(model, {
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        options: { temperature: 0.2 }
      });

      const raw = resp.content?.[0]?.type === "text" ? resp.content[0].text : "";
      // 稳健提取 JSON 块，剥离 Markdown 围栏并支持平衡括号防崩溃
      const parsed = extractValidJsonObject(raw);

      return {
        name: (parsed.name || fallbackName).replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase(),
        description: parsed.description || fallbackDesc
      };
    } catch (_) {
      return { name: fallbackName, description: fallbackDesc };
    }
  }

}
