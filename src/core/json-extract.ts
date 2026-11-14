/**
 * Extracts a JSON object from LLM text output.
 *
 * Strategy:
 * 1. Prefer the first fenced ```json ... ``` (or ``` ... ```) block.
 * 2. Fall back to balanced-brace scanning across the raw text while respecting
 *    string literals and escape sequences.
 */
export function extractValidJsonObject(raw: string): Record<string, unknown> {
  if (!raw || typeof raw !== "string") {
    throw new Error("Invalid raw text for JSON extraction");
  }

  const codeBlockMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (codeBlockMatch) {
    try {
      const parsed: unknown = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to balanced-brace scanning
    }
  }

  const firstBrace = raw.indexOf("{");
  if (firstBrace === -1) {
    throw new Error("No JSON object found in text");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const parsed: unknown = JSON.parse(raw.slice(firstBrace, i + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        throw new Error("Extracted JSON root is not an object");
      }
    }
  }

  throw new Error("Unbalanced braces in JSON text");
}
