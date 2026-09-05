import fs from "fs";

/**
 * 健壮提取大模型输出中的 JSON 对象：
 * 1. 优先提取 Markdown 代码块 (```json ... ```)；
 * 2. 次选基于平衡大括号算法 (Balanced Brace Counting) 提取首个最完整外层对象，
 *    精准避开贪婪匹配跨多代码块导致的 SyntaxError 崩溃。
 */
export function extractValidJsonObject(raw: string): any {
  if (!raw || typeof raw !== "string") {
    throw new Error("Invalid raw text for JSON extraction");
  }

  // 1. 尝试匹配首个围栏 Markdown json 代码块
  const codeBlockMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (_) {}
  }

  // 2. 基于平衡括号扫描首个外层完整 JSON 对象
  const firstBrace = raw.indexOf("{");
  if (firstBrace === -1) throw new Error("No JSON object found in response");

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = firstBrace; i < raw.length; i++) {
    const char = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(firstBrace, i + 1);
          return JSON.parse(candidate);
        }
      }
    }
  }

  throw new Error("Unbalanced braces in LLM response");
}
