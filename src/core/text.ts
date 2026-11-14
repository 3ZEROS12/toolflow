/** CJK ideograph ranges used for script-aware length heuristics (no literal glyphs in source). */
export const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * True when the text is primarily written in CJK script.
 * CJK carries more meaning per character, so callers pair this with shorter length thresholds.
 */
export function isCjkText(text: string): boolean {
  return typeof text === "string" && CJK_PATTERN.test(text);
}
