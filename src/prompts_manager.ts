import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { extractValidJsonObject } from "./json_extractor.js";

export interface PromptItemInfo {
  command: string;
  name: string;
  description: string;
  scope: "global" | "project" | "package";
  filePath: string;
  updatedAt: number; // 文件修改时间戳，用于将最新添加/修改的排在顶端
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

            results.push({
              command,
              name,
              description: description || "自定义提示词模板 [" + command + "]",
              scope,
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

    // 将最新添加/修改的排在顶端（按 updatedAt 降序排序）
    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results;
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
      filePath,
      updatedAt: Date.now()
    };
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
