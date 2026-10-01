import { describe, expect, it } from 'vitest';
import type { ProgressData } from '../../shared/formatting/message-types.js';
import { readFeishuCardFlowSettings } from '../../shared/feishu-card-config.js';
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
  it('has explicit safe defaults and supports the legacy switch', () => {
    expect(load()).toEqual({ mode: 'blocks', nativeStreaming: false, groupGapTokens: 50, maxBytes: 24000, maxElements: 160, toolRules: {} });
    expect(load({ TL_FS_CARD_FLOW: 'legacy' }).mode).toBe('legacy');
    expect(load({ TL_FS_NATIVE_STREAMING: 'false' }).nativeStreaming).toBe(false);
    expect(load({ TL_FS_NATIVE_STREAMING: 'true' }).nativeStreaming).toBe(true);
  });
  it('does not depend on process.env and preserves user tool identifiers', () => {
    expect(load({
      TL_FS_CARD_MAX_BYTES: '8000', TL_FS_CARD_MAX_ELEMENTS: '80', TL_FS_TOOL_GROUP_GAP_TOKENS: '0',
      TL_FS_TOOL_DISPLAY_RULES: '{"grab":"exploration","MyEditor":"edit"}',
    })).toEqual({ mode: 'blocks', nativeStreaming: false, groupGapTokens: 0, maxBytes: 8000, maxElements: 80, toolRules: { grab: 'exploration', MyEditor: 'edit' } });
  });
  it.each([
    { TL_FS_CARD_MAX_BYTES: '30000' }, { TL_FS_CARD_MAX_ELEMENTS: '201' },
    { TL_FS_CARD_MAX_BYTES: 'NaN' }, { TL_FS_TOOL_GROUP_GAP_TOKENS: '-1' },
    { TL_FS_NATIVE_STREAMING: 'invalid' }, { TL_FS_CARD_FLOW: 'invalid' }, { TL_FS_TOOL_DISPLAY_RULES: '[]' },
    { TL_FS_TOOL_DISPLAY_RULES: '{"write":"invalid"}' },
  ])('rejects unsafe or malformed settings %j', (values) => { expect(() => load(values)).toThrow('Config error'); });
});
