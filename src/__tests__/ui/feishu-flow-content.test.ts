import { describe, expect, it } from 'vitest';
import type { ProgressData } from '../../shared/formatting/message-types.js';
import {
  DEFAULT_FEISHU_NATIVE_PRINT,
  feishuNativePrintRatePerSecond,
  readFeishuCardFlowSettings,
} from '../../shared/feishu-card-config.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';

const progress = (extra: Partial<ProgressData> = {}): ProgressData => ({
  phase: 'executing', taskSummary: '测试', elapsedSeconds: 1, renderedText: '', totalTools: 0,
  todoItems: [], actionButtons: [], ...extra,
});

describe('complete safety-relevant block content', () => {
  it('retains the full failure result of an exploration tool while keeping its error summary visible', () => {
    const failure = '错误详情'.repeat(300) + 'ERROR_END';
    const message = new FeishuFormatter('zh').formatProgress('chat', progress({
      phase: 'failed', totalTools: 1,
      timeline: [{ kind: 'tool', toolId: 'failed-read', toolName: 'Read', toolInput: 'path',
        status: 'failed', isError: true, toolResult: failure }],
    }));
    const json = JSON.stringify(message.feishuElements);
    expect(json).toContain(failure);
    expect(message.feishuElements?.some((element) => element.tag === 'markdown' && String(element.content).includes('Read'))).toBe(true);
  });

  it('does not truncate a long command that is awaiting approval', () => {
    const command = 'verify '.repeat(1000) + 'APPROVAL_END';
    const json = JSON.stringify(new FeishuFormatter('zh').formatProgress('chat', progress({
      phase: 'waiting_permission', permission: { toolName: 'Bash', input: command, queueLength: 1 },
    })));
    expect(json).toContain(command);
  });

  it('retains every todo instead of silently dropping items after five', () => {
    const json = JSON.stringify(new FeishuFormatter('zh').formatProgress('chat', progress({
      todoItems: Array.from({ length: 20 }, (_, index) => ({ content: `TODO_${index}_END`, status: 'pending' })),
    })));
    for (let index = 0; index < 20; index++) expect(json).toContain(`TODO_${index}_END`);
  });
});

describe('Feishu card settings read from the supplied config reader', () => {
  const load = (values: Record<string, string | undefined> = {}) => readFeishuCardFlowSettings((name, fallback) => values[name] ?? fallback ?? '');
  const defaults = { strategy: 'delay', frequencyMs: 10, step: 4 };
  it('has explicit safe defaults and supports the legacy switch', () => {
    expect(load()).toEqual({
      mode: 'blocks', nativeStreaming: true, nativePrint: defaults,
      groupGapTokens: 50, maxBytes: 24000, maxElements: 160, toolRules: {},
    });
    expect(load({ TL_FS_CARD_FLOW: 'legacy' }).mode).toBe('legacy');
    expect(load({ TL_FS_NATIVE_STREAMING: 'false' }).nativeStreaming).toBe(false);
    expect(load({ TL_FS_NATIVE_STREAMING: 'true' }).nativeStreaming).toBe(true);
  });
  it('reads the print animation knobs, which is the only place the speed is set', () => {
    expect(load({
      TL_FS_NATIVE_PRINT_STRATEGY: 'fast', TL_FS_NATIVE_PRINT_FREQ_MS: '50', TL_FS_NATIVE_PRINT_STEP: '60',
    }).nativePrint).toEqual({ strategy: 'fast', frequencyMs: 50, step: 60 });
  });
  it('does not depend on process.env and preserves user tool identifiers', () => {
    expect(load({
      TL_FS_CARD_MAX_BYTES: '8000', TL_FS_CARD_MAX_ELEMENTS: '80', TL_FS_TOOL_GROUP_GAP_TOKENS: '0',
      TL_FS_TOOL_DISPLAY_RULES: '{"grab":"exploration","MyEditor":"edit"}',
    })).toEqual({
      mode: 'blocks', nativeStreaming: true, nativePrint: defaults,
      groupGapTokens: 0, maxBytes: 8000, maxElements: 80,
      toolRules: { grab: 'exploration', MyEditor: 'edit' },
    });
  });
  it.each([
    { TL_FS_CARD_MAX_BYTES: '30000' }, { TL_FS_CARD_MAX_ELEMENTS: '201' },
    { TL_FS_CARD_MAX_BYTES: 'NaN' }, { TL_FS_TOOL_GROUP_GAP_TOKENS: '-1' },
    { TL_FS_NATIVE_STREAMING: 'invalid' }, { TL_FS_CARD_FLOW: 'invalid' }, { TL_FS_TOOL_DISPLAY_RULES: '[]' },
    { TL_FS_TOOL_DISPLAY_RULES: '{"write":"invalid"}' },
    { TL_FS_NATIVE_PRINT_STRATEGY: 'instant' }, { TL_FS_NATIVE_PRINT_STEP: '0' },
    { TL_FS_NATIVE_PRINT_FREQ_MS: '0' }, { TL_FS_NATIVE_PRINT_STEP: '1001' }, { TL_FS_NATIVE_PRINT_FREQ_MS: '1.5' },
  ])('rejects unsafe or malformed settings %j', (values) => { expect(() => load(values)).toThrow('Config error'); });
});

describe('native print speed', () => {
  it('defaults to four characters per tick at the user-chosen speed', () => {
    // The client stops responding to a shorter tick, so print_step is the knob that still buys speed.
    // 400 char/s prints in groups of four; trailing a faster model remains accepted behaviour.
    expect(DEFAULT_FEISHU_NATIVE_PRINT.step).toBe(4);
    expect(DEFAULT_FEISHU_NATIVE_PRINT.frequencyMs).toBe(10);
    expect(feishuNativePrintRatePerSecond(DEFAULT_FEISHU_NATIVE_PRINT)).toBe(400);
  });
  it('derives characters per second from the two numbers Feishu animates with', () => {
    expect(feishuNativePrintRatePerSecond({ strategy: 'delay', frequencyMs: 70, step: 1 })).toBe(14);
    expect(feishuNativePrintRatePerSecond({ strategy: 'delay', frequencyMs: 20, step: 1 })).toBe(50);
    expect(feishuNativePrintRatePerSecond({ strategy: 'delay', frequencyMs: 10, step: 1 })).toBe(100);
    expect(feishuNativePrintRatePerSecond({ strategy: 'delay', frequencyMs: 10, step: 4 })).toBe(400);
    expect(feishuNativePrintRatePerSecond({ strategy: 'delay', frequencyMs: 20, step: 20 })).toBe(1000);
  });
});
