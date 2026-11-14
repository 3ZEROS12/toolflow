/**
 * Unified LLM call bridge for Pi extensions.
 * Uses `ctx.modelRegistry.streamSimple(ctx.model, ...)` in real Pi hosts,
 * and falls back to `ctx.complete(...)` when provided by test doubles.
 */
export interface LlmModelRuntime {
  model?: unknown;
  modelRegistry?: {
    streamSimple?: (
      model: unknown,
      payload: {
        systemPrompt?: string;
        messages: Array<{
          role: "user";
          content: Array<{ type: "text"; text: string }>;
          timestamp: number;
        }>;
      },
      options?: Record<string, unknown>
    ) => AsyncIterable<unknown> & { result?: () => Promise<unknown> };
  };
  complete?: (model: unknown, prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;
}

function extractTextFromResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  if ("text" in result && typeof result.text === "string") return result.text;
  if ("content" in result && Array.isArray(result.content)) {
    const parts: string[] = [];
    for (const item of result.content) {
      if (item && typeof item === "object" && "type" in item && "text" in item) {
        const block = item as { type?: unknown; text?: unknown };
        if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

export async function callExtensionLlm(
  ctx: LlmModelRuntime | undefined,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 1000,
  timeoutMs: number = 15000
): Promise<string | null> {
  if (!ctx?.model) return null;

  if (typeof ctx.complete === "function") {
    try {
      const response = await ctx.complete(ctx.model, `${systemPrompt}\n\n${userPrompt}`, { maxTokens });
      const text = extractTextFromResult(response).trim();
      return text || null;
    } catch {
      return null;
    }
  }

  const streamSimple = ctx.modelRegistry?.streamSimple;
  if (typeof streamSimple !== "function") return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const stream = streamSimple.call(
      ctx.modelRegistry,
      ctx.model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }],
            timestamp: Date.now(),
          },
        ],
      },
      { maxTokens: Math.max(maxTokens, 2000), reasoning: "minimal", signal: controller.signal }
    ) as AsyncIterable<unknown> & { result?: () => Promise<unknown>; abort?: () => void };
    const runStream = async (): Promise<string | null> => {
      if (stream && typeof stream.result === "function") {
        const finalMsg = await stream.result();
        const extracted = extractTextFromResult(finalMsg).trim();
        if (extracted) return extracted;
      }
      let buffer = "";
      if (stream && typeof stream[Symbol.asyncIterator] === "function") {
        for await (const ev of stream) {
          if (
            ev &&
            typeof ev === "object" &&
            "type" in ev &&
            ev.type === "text_delta" &&
            "delta" in ev &&
            typeof ev.delta === "string"
          ) {
            buffer += ev.delta;
          }
        }
      }
      return buffer.trim() || null;
    };

    const timeout = Promise.withResolvers<null>();
    timer = setTimeout(() => {
      controller.abort();
      try {
        stream?.abort?.();
      } catch {}
      timeout.resolve(null);
    }, timeoutMs);

    return await Promise.race([runStream(), timeout.promise]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
