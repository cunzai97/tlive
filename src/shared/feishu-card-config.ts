import type { ConfigValueReader } from './config.js';

export const FEISHU_SNAPSHOT_REFRESH_MS = 1000;

/** Streaming_mode makes Feishu animate deltas itself; these are the numbers driving that animation. */
export interface FeishuNativePrintSettings {
  strategy: 'delay' | 'fast';
  frequencyMs: number;
  step: number;
}

/**
 * Four characters every 10 ms is 400 characters per second. Shortening the tick further stopped paying
 * off — the client appears to clamp it — so print_step is the knob that still moves the speed, at the
 * cost of printing in groups instead of one character at a time. Falling behind the model stays an
 * accepted design: Feishu types the appended tail of each push on its own clock, so the animation never
 * needs extra page pushes. The platform validates neither number, so
 * scripts/live-feishu-print-probe.js exists to measure the real feel.
 */
export const DEFAULT_FEISHU_NATIVE_PRINT: FeishuNativePrintSettings = {
  strategy: 'delay',
  frequencyMs: 10,
  step: 4,
};

/** `print_step` characters are printed every `print_frequency_ms`, which is the whole speed knob. */
export function feishuNativePrintRatePerSecond(print: FeishuNativePrintSettings): number {
  return print.frequencyMs > 0 ? Math.floor((1000 * print.step) / print.frequencyMs) : 0;
}

/**
 * Minimum spacing between two card edits of the *same* physical message. Feishu answers anything
 * faster with code 230020 "Update the single messages too frequently", and a rejected edit leaves
 * that card frozen at its previous frame, so the render cadence and the edit cadence are separate.
 * Native pages never reach this: they update a card entity, which has its own larger quota.
 */
export const FEISHU_SNAPSHOT_PATCH_MIN_MS = 2000;

export type FeishuToolCategory = 'exploration' | 'execution' | 'edit' | 'generic';

export interface FeishuCardFlowSettings {
  mode: 'blocks' | 'legacy';
  nativeStreaming?: boolean;
  nativePrint?: FeishuNativePrintSettings;
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
  const nativeStreaming = get('TL_FS_NATIVE_STREAMING', 'true');
  if (nativeStreaming !== 'true' && nativeStreaming !== 'false') {
    throw new Error('Config error: TL_FS_NATIVE_STREAMING must be true or false');
  }
  const nativePrintStrategy = get('TL_FS_NATIVE_PRINT_STRATEGY', 'delay');
  if (nativePrintStrategy !== 'delay' && nativePrintStrategy !== 'fast') {
    throw new Error('Config error: TL_FS_NATIVE_PRINT_STRATEGY must be delay or fast');
  }
  const nativePrint: FeishuNativePrintSettings = {
    strategy: nativePrintStrategy,
    frequencyMs: readInteger(
      get,
      'TL_FS_NATIVE_PRINT_FREQ_MS',
      DEFAULT_FEISHU_NATIVE_PRINT.frequencyMs,
      1,
      1000,
    ),
    step: readInteger(get, 'TL_FS_NATIVE_PRINT_STEP', DEFAULT_FEISHU_NATIVE_PRINT.step, 1, 1000),
  };
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
    nativePrint,
    groupGapTokens: readInteger(get, 'TL_FS_TOOL_GROUP_GAP_TOKENS', 50, 0, 10_000),
    maxBytes: readInteger(get, 'TL_FS_CARD_MAX_BYTES', 24_000, 4_000, 28_000),
    maxElements: readInteger(get, 'TL_FS_CARD_MAX_ELEMENTS', 160, 10, 190),
    toolRules: Object.fromEntries(entries) as Record<string, FeishuToolCategory>,
  };
}
