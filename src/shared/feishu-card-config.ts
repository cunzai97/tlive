import type { ConfigValueReader } from './config.js';

export const FEISHU_SNAPSHOT_REFRESH_MS = 1000;

export type FeishuToolCategory = 'exploration' | 'execution' | 'edit' | 'generic';

export interface FeishuCardFlowSettings {
  mode: 'blocks' | 'legacy';
  nativeStreaming?: boolean;
  groupGapTokens: number;
  maxBytes: number;
  maxElements: number;
  toolRules: Record<string, FeishuToolCategory>;
}

function readInteger(
  get: ConfigValueReader,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const text = get(key, String(fallback));
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Config error: ${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Role-specific configuration; do not rely on TL_* being copied into process.env. */
export function readFeishuCardFlowSettings(get: ConfigValueReader): FeishuCardFlowSettings {
  const mode = get('TL_FS_CARD_FLOW', 'blocks');
  if (mode !== 'blocks' && mode !== 'legacy') {
    throw new Error('Config error: TL_FS_CARD_FLOW must be blocks or legacy');
  }
  const nativeStreaming = get('TL_FS_NATIVE_STREAMING', 'false');
  if (nativeStreaming !== 'true' && nativeStreaming !== 'false') {
    throw new Error('Config error: TL_FS_NATIVE_STREAMING must be true or false');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(get('TL_FS_TOOL_DISPLAY_RULES', '{}'));
  } catch {
    throw new Error('Config error: TL_FS_TOOL_DISPLAY_RULES must be a JSON object');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Config error: TL_FS_TOOL_DISPLAY_RULES must be a JSON object');
  }
  const entries = Object.entries(decoded);
  const categories: readonly string[] = ['exploration', 'execution', 'edit', 'generic'];
  for (const [name, category] of entries) {
    if (!name || typeof category !== 'string' || !categories.includes(category)) {
      throw new Error(`Config error: invalid tool display rule for ${name || '(empty name)'}`);
    }
  }
  return {
    mode,
    nativeStreaming: nativeStreaming === 'true',
    groupGapTokens: readInteger(get, 'TL_FS_TOOL_GROUP_GAP_TOKENS', 50, 0, 10_000),
    maxBytes: readInteger(get, 'TL_FS_CARD_MAX_BYTES', 24_000, 4_000, 28_000),
    maxElements: readInteger(get, 'TL_FS_CARD_MAX_ELEMENTS', 160, 10, 190),
    toolRules: Object.fromEntries(entries) as Record<string, FeishuToolCategory>,
  };
}
