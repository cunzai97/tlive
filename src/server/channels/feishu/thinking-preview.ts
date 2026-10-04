import { estimatedTokenCount } from './flow-blocks.js';

/**
 * Segments of a streamed thought. 300 estimated tokens is the size the old sliding preview already
 * allowed on screen, so a single thought costs the card no more than it did before.
 */
export const FEISHU_THINKING_SEGMENT_TOKENS = 300;

export interface ThinkingSegment {
  index: number;
  text: string;
}

/**
 * Cut from the left so a boundary that is already published never moves while the text grows. Only
 * the newest segment ever changes, and only by appending — re-cutting an older one is the rewrite
 * the client renders as the block vanishing and reprinting. A cut lands on the last line break the
 * segment contains when it has one, because heading downgrading works per line.
 */
export function thinkingSegments(
  text: string,
  tokens = FEISHU_THINKING_SEGMENT_TOKENS,
): ThinkingSegment[] {
  const budget = Number.isFinite(tokens) ? Math.floor(tokens) : 0;
  if (!text || budget <= 0) return [];
  const maxUnits = budget * 4;
  const step = (from: number): { end: number; units: number } => {
    const code = text.charCodeAt(from);
    const pair = code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(from + 1) & 0xfc00) === 0xdc00;
    return { end: from + (pair ? 2 : 1), units: code <= 0x7f ? 1 : 4 };
  };
  const segments: ThinkingSegment[] = [];
  let start = 0;
  let cursor = 0;
  let units = 0;
  let line = -1;
  while (cursor < text.length) {
    const next = step(cursor);
    if (units + next.units > maxUnits && cursor > start) {
      const cut = line > start ? line : cursor;
      segments.push({ index: segments.length, text: text.slice(start, cut) });
      start = cut;
      units = 0;
      for (let i = cut; i < cursor; i = step(i).end) units += step(i).units;
      line = -1;
      continue;
    }
    units += next.units;
    if (text[cursor] === '\n') line = next.end;
    cursor = next.end;
  }
  if (start < text.length) segments.push({ index: segments.length, text: text.slice(start) });
  return segments;
}

/**
 * Display-only estimate, matching flow grouping: ASCII / 4, other code points / 1. Only the live
 * write preview still pays this attention to size; a streamed thought is cut into whole segments
 * instead, because a tail window keeps moving text that is already on screen.
 */
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
