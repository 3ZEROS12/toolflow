import * as fs from "node:fs";
import * as path from "node:path";
import { extractValidJsonObject } from "../core/json-extract.js";
import { getPiAgentDir } from "../core/agent-dir.js";
import { callExtensionLlm, type LlmModelRuntime } from "./llm-client.js";

export interface PromptItemInfo {
  command: string;
  name: string;
  description: string;
  scope: "global" | "project" | "package";
  category: "user" | "system";
  filePath: string;
  updatedAt: number;
  lastUsedAt?: number;
}

export class PromptsManager {
  private static getAgentDir(): string {
    return getPiAgentDir();
  }

  private static getMruFilePath(): string {
    return path.join(this.getAgentDir(), "toolflow_prompts_mru.json");
  }

  public static loadMruMap(): Record<string, number> {
    try {
      const file = this.getMruFilePath();
      if (!fs.existsSync(file)) return {};
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  public static recordPromptUsage(command: string): void {
    const mruMap = this.loadMruMap();
    mruMap[command] = Date.now();
    try {
      const file = this.getMruFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(mruMap, null, 2), "utf-8");
    } catch {
      // Ignore MRU persistence errors
    }
  }

  public static getRecentPrompts(prompts: PromptItemInfo[], limit: number = 5): PromptItemInfo[] {
    const sorted = [...prompts].sort((a, b) => {
      const usedA = a.lastUsedAt ?? 0;
      const usedB = b.lastUsedAt ?? 0;
      if (usedA !== usedB) return usedB - usedA;
      return b.updatedAt - a.updatedAt;
    });
    return sorted.slice(0, limit);
  }

  public static scanAllPrompts(cwd: string = process.cwd()): PromptItemInfo[] {
    const agentDir = this.getAgentDir();
    const mruMap = this.loadMruMap();
    const results: PromptItemInfo[] = [];
    const seen = new Set<string>();

    const scanDir = (dir: string, scope: PromptItemInfo["scope"], category: PromptItemInfo["category"]): void => {
      if (!fs.existsSync(dir)) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const filePath = path.join(dir, entry.name);
          const name = entry.name.replace(/\.md$/, "");
          const command = `/${name}`;
          if (seen.has(command)) continue;
          seen.add(command);

          let description = "Custom prompt template";
          let updatedAt = 0;
          try {
            const stat = fs.statSync(filePath);
            updatedAt = stat.mtimeMs;
            const content = fs.readFileSync(filePath, "utf-8");
            const frontDesc = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
            if (frontDesc && frontDesc[1]) {
              description = frontDesc[1].trim();
            } else {
              const firstLine = content
                .split(/\r?\n/)
                .find(l => l.trim().length > 0 && !l.trim().startsWith("---"));
              if (firstLine) {
                description = firstLine.replace(/^#+\s*/, "").trim().slice(0, 60);
              }
            }
          } catch {
            // Ignore unreadable prompt file
          }

          results.push({
            command,
            name,
            description,
            scope,
            category,
            filePath,
            updatedAt,
            lastUsedAt: mruMap[command],
          });
        }
      } catch {
        // Ignore unreadable prompt directory
      }
    };

    scanDir(path.join(cwd, ".pi", "prompts"), "project", "user");
    scanDir(path.join(agentDir, "prompts"), "global", "user");
    scanDir(path.join(agentDir, "packages", "prompts"), "package", "system");

    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public static addUserPrompt(name: string, description: string, content: string): PromptItemInfo {
    const cleanName = name.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || `prompt_${Date.now()}`;
    const promptsDir = path.join(this.getAgentDir(), "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    const filePath = path.join(promptsDir, `${cleanName}.md`);

    const formatted = [
      "---",
      `description: ${description.trim() || "Custom engineering prompt"}`,
      "---",
      "",
      content.trim(),
      "",
    ].join("\n");

    fs.writeFileSync(filePath, formatted, "utf-8");
    return {
      command: `/${cleanName}`,
      name: cleanName,
      description: description.trim() || "Custom engineering prompt",
      scope: "global",
      category: "user",
      filePath,
      updatedAt: Date.now(),
    };
  }

  public static deleteUserPrompt(filePath: string): boolean {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  public static getPromptPreviewLines(filePath: string, maxLines: number = 4): string[] {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const withoutFrontmatter = content.replace(/^---[\s\S]*?---\s*/, "");
      return withoutFrontmatter
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .slice(0, maxLines);
    } catch {
      return [];
    }
  }

  public static async autoTagPromptWithLLM(
    content: string,
    ctx?: LlmModelRuntime
  ): Promise<{ name: string; description: string }> {
    const words = content
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join("-")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .toLowerCase();
    const fallbackName = words || `prompt-${Date.now().toString(36).slice(-4)}`;
    const fallbackDesc = content.trim().split(/\r?\n/)[0]?.slice(0, 48) || "Custom prompt";

    try {
      const rawText = await callExtensionLlm(
        ctx,
        "Generate concise command names and descriptions for reusable developer prompts.",
        `Generate a short kebab-case command name (English lowercase letters/digits/hyphens) and a concise description (under 40 chars, matching the prompt's language) for this prompt:\n` +
          `${content.slice(0, 800)}\n` +
          `Return strict JSON: {"name":"short-name","description":"..."}`,
        150
      );
      if (!rawText) return { name: fallbackName, description: fallbackDesc };

      const parsed = extractValidJsonObject(rawText);
      const rawName = typeof parsed.name === "string" ? parsed.name : fallbackName;
      const rawDesc = typeof parsed.description === "string" ? parsed.description : fallbackDesc;
      return {
        name: rawName.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || fallbackName,
        description: rawDesc.trim() || fallbackDesc,
      };
    } catch {
      return { name: fallbackName, description: fallbackDesc };
    }
  }
}
