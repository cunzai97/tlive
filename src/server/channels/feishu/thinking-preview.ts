import { estimatedTokenCount } from './flow-blocks.js';

/** Display-only estimate, matching flow grouping: ASCII / 4, other code points / 1. */
export const FEISHU_THINKING_PREVIEW_TOKENS = 300;

export interface ThinkingPreview {
  text: string;
  tokens: number;
  omitted: boolean;
}

/** Keep a suffix without splitting a UTF-16 surrogate pair. Scan at most the preview budget. */
export function thinkingTail(
  text: string,
  maxTokens = FEISHU_THINKING_PREVIEW_TOKENS,
): ThinkingPreview {
  const budget = Number.isFinite(maxTokens) ? Math.max(0, Math.floor(maxTokens)) : 0;
  const maxUnits = budget * 4;
  let start = text.length;
  let units = 0;
  while (start > 0) {
    let previous = start - 1;
    const last = text.charCodeAt(previous);
    if (last >= 0xdc00 && last <= 0xdfff && previous > 0) {
      const high = text.charCodeAt(previous - 1);
      if (high >= 0xd800 && high <= 0xdbff) previous--;
    }
    const cost = (text.codePointAt(previous) ?? 0) <= 0x7f ? 1 : 4;
    if (units + cost > maxUnits) break;
    units += cost;
    start = previous;
  }
  const tail = text.slice(start);
  return { text: tail, tokens: estimatedTokenCount(tail), omitted: start > 0 };
}
