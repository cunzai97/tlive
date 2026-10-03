/** The live file preview only exists while a write call has no block of its own. */
import { describe, expect, it } from 'vitest';
import type { ProgressData } from '../../shared/formatting/message-types.js';
import { codeBlockBody, markdownElement } from '../../server/channels/feishu/card-elements.js';
import {
  buildProgressContentElements,
  buildProgressTimelineElements,
} from '../../server/channels/feishu/format-progress.js';
import {
  buildProgressData,
  ProgressContentBuilder,
  type RenderInput,
} from '../../server/engine/messages/progress-builder.js';

const liveWrite = {
  name: 'write',
  path: '/home/pan/project/src/a.ts',
  contentTail: 'const first = 1;\nconst second = 2;\n',
  contentChars: 35,
  contentLines: 3,
};

function running(extra: Partial<ProgressData> = {}): ProgressData {
  return {
    phase: 'executing',
    taskSummary: 'write test',
    elapsedSeconds: 41,
    renderedText: '',
    todoItems: [],
    totalTools: 3,
    timeline: [{ kind: 'thinking', blockId: 'b1', text: '先想一下' }],
    ...extra,
  };
}

function content(data: ProgressData): string[] {
  const params = { chatId: 'chat1', data, md: markdownElement, locale: 'zh' as const };
  return [...buildProgressTimelineElements(params), ...buildProgressContentElements(params)]
    .filter((element) => element.tag === 'markdown')
    .map((element) => String(element.content ?? ''));
}

describe('write progress line', () => {
  it('names the file and counts what has been generated so far', () => {
    const [line] = content(running({ liveWrite })).filter((text) => text.includes('正在写入'));
    expect(line).toContain('src/a.ts');
    expect(line).toContain('3 行');
    expect(line).toContain('35 字符');
  });

  it('previews the file even when the turn has produced no trace yet', () => {
    const texts = content(running({ totalTools: 0, timeline: undefined, liveWrite }));
    expect(texts.some((text) => text.includes('正在写入') && text.includes('src/a.ts'))).toBe(true);
    expect(texts.some((text) => text.includes('运行时长'))).toBe(true);
  });

  it('shows the newest content of the file inside a code block, verbatim', () => {
    const bodies = content(running({ liveWrite }))
      .map((text) => codeBlockBody(text)?.body)
      .filter((body): body is string => body !== undefined);
    expect(bodies.find((body) => body.includes('const second = 2;'))?.trimEnd())
      .toBe(liveWrite.contentTail.trimEnd());
  });

  it('bounds the preview window no matter how large the tail snapshot is', () => {
    const texts = content(running({ liveWrite: { ...liveWrite, contentTail: 'a'.repeat(4_000) } }));
    const body = texts.map((text) => codeBlockBody(text)?.body).find((value) => value?.startsWith('aaa'));
    expect(body).toBeDefined();
    expect(body!.length).toBeLessThanOrEqual(1_200);
  });

  it('redacts a credential inside the preview', () => {
    const texts = content(running({
      liveWrite: { ...liveWrite, contentTail: `const key = 'sk-${'A'.repeat(24)}';` },
    }));
    const json = JSON.stringify(texts);
    expect(json).toContain('sk-[REDACTED]');
    expect(json).not.toContain(`sk-${'A'.repeat(24)}`);
  });

  it('leaves the running card untouched when no write is streaming', () => {
    expect(content(running())).toEqual(content(running({ liveWrite: null })));
  });

  it('disappears as soon as the card reaches a terminal phase', () => {
    for (const phase of ['completed', 'failed'] as const) {
      const json = JSON.stringify(content(running({ phase, errorMessage: phase === 'failed' ? 'boom' : undefined, liveWrite })));
      expect(json).not.toContain('正在写入');
      expect(json).not.toContain('const first');
    }
  });

  it('does not compete with a pending approval for the bottom of the card', () => {
    const texts = content(running({
      phase: 'waiting_permission',
      permission: { toolName: 'Bash', input: 'rm -rf cache', queueLength: 1 },
      liveWrite,
    }));
    expect(texts.some((text) => text.includes('正在写入'))).toBe(false);
    expect(texts.some((text) => text.includes('const first'))).toBe(false);
  });

  it('survives the renderer state into the card payload', () => {
    const input: RenderInput = {
      phase: 'executing',
      responseText: '',
      thinkingText: '先想一下',
      elapsedSeconds: 41,
      totalTools: 0,
      toolCounts: new Map(),
      bubbleToolCount: 0,
      currentTool: null,
      liveWrite,
      todoItems: [],
      toolLogs: [],
      timeline: [{ kind: 'thinking', blockId: 'b1', text: '先想一下' }],
      permissionQueue: [],
      permissionRequests: 0,
      completed: false,
      platformLimit: 4096,
    };
    const state = new ProgressContentBuilder().getStateSnapshot(input, '⏳ 41s');

    const data = buildProgressData(state, 'write test');
    expect(data.liveWrite).toEqual(liveWrite);
    const rendered = content(data);
    expect(rendered.some((text) => text.includes('正在写入'))).toBe(true);
    expect(rendered.some((text) => codeBlockBody(text)?.body?.includes('const first'))).toBe(true);
  });
});
