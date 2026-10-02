import { describe, expect, it } from 'vitest';
import { parsePlanFromToolCall, parsePlanLike } from '../../shared/canonical/plan-signature.js';

describe('plan-like tool payload recognition', () => {
  it('reads the pi todo shape', () => {
    expect(
      parsePlanLike({
        todos: [
          { content: '确认 7900 XTX 上 ComfyUI 服务状态', status: 'in_progress' },
          { content: '提交生成任务', status: 'pending' },
          { content: '检查生成图后发给你', status: 'pending' },
        ],
      }),
    ).toEqual([
      { content: '确认 7900 XTX 上 ComfyUI 服务状态', status: 'in_progress' },
      { content: '提交生成任务', status: 'pending' },
      { content: '检查生成图后发给你', status: 'pending' },
    ]);
  });

  it('accepts the same list under other names and other item vocabularies', () => {
    const cases: unknown[] = [
      { todos: [{ content: 'a', status: 'completed' }] },
      { tasks: [{ subject: 'a', state: 'done' }] },
      { plan: [{ title: 'b', status: 'NOT_STARTED' }] },
      { steps: [{ description: 'c', status: 'in progress' }] },
      { checklist: [{ name: 'd', status: 'IN-PROGRESS' }] },
      { subtasks: [{ text: 'e', status: 'canceled' }] },
    ];
    expect(cases.map((payload) => parsePlanLike(payload)?.[0])).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'in_progress' },
      { content: 'e', status: 'cancelled' },
    ]);
  });

  it('keeps cancelled and blocked work distinguishable from work not started', () => {
    expect(
      parsePlanLike({
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'cancelled' },
          { content: 'c', status: 'in_progress' },
          { content: 'd', status: 'blocked' },
        ],
      }),
    ).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'cancelled' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'blocked' },
    ]);
  });

  it('reads an empty list as an explicit clear, not as an unrecognised payload', () => {
    expect(parsePlanLike({ todos: [] })).toEqual([]);
  });

  it('finds the list one level below a wrapper object', () => {
    expect(parsePlanLike({ input: { todos: [{ content: 'a', status: 'pending' }] } })).toEqual([
      { content: 'a', status: 'pending' },
    ]);
  });

  it.each([
    ['single-item task tools have no list at all', { subject: 'a', description: 'b', status: 'pending' }],
    ['file lists carry no status', { files: [{ path: '/a', content: 'b' }] }],
    ['unlisted array field names are not plans', { results: [{ status: 'success', name: 'a' }] }],
    ['items without a status', { todos: [{ content: 'a' }] }],
    ['items without any text', { todos: [{ status: 'pending' }] }],
    ['blank text is not a task', { todos: [{ content: '   ', status: 'pending' }] }],
    ['unknown status vocabulary', { todos: [{ content: 'a', status: 'frobnicated' }] }],
    ['one bad item invalidates the batch', { todos: [{ content: 'a', status: 'pending' }, { content: 'b' }] }],
    ['arrays are not payloads', [{ content: 'a', status: 'pending' }]],
    ['strings are not payloads', 'todos'],
  ])('rejects %s', (_label, payload) => {
    expect(parsePlanLike(payload)).toBeUndefined();
  });

  describe('streaming input', () => {
    const todos = { todos: [{ content: 'a', status: 'pending' }] };

    it('parses a complete JSON string when no parsed object is supplied', () => {
      expect(parsePlanFromToolCall(undefined, JSON.stringify(todos))).toEqual([
        { content: 'a', status: 'pending' },
      ]);
    });

    it('treats a half-written JSON string as not-ready rather than empty', () => {
      expect(parsePlanFromToolCall(undefined, '{"todos":[{"content":"a","stat')).toBeUndefined();
    });

    it('ignores non-JSON tool input', () => {
      expect(parsePlanFromToolCall(undefined, 'npm run build')).toBeUndefined();
    });

    it('skips oversized JSON instead of parsing megabytes per frame', () => {
      const huge = JSON.stringify({ todos: [{ content: 'x'.repeat(20_000), status: 'pending' }] });
      expect(parsePlanFromToolCall(undefined, huge)).toBeUndefined();
    });

    it('prefers the parsed object over a stale string', () => {
      expect(parsePlanFromToolCall(todos, 'not json at all')).toEqual([
        { content: 'a', status: 'pending' },
      ]);
    });
  });

  describe('provider payload shapes', () => {
    it('reads the Claude TodoWrite shape and ignores its activeForm field', () => {
      expect(
        parsePlanLike({
          todos: [
            { content: '定位过滤逻辑', status: 'in_progress', activeForm: 'Locating the filter' },
            { content: '改 adapter', status: 'pending', activeForm: 'Editing the adapter' },
          ],
        }),
      ).toEqual([
        { content: '定位过滤逻辑', status: 'in_progress' },
        { content: '改 adapter', status: 'pending' },
      ]);
    });

    it('reads the Codex plan shape: step entries, camelCase status', () => {
      expect(
        parsePlanLike({
          plan: [
            { step: '复现问题', status: 'completed' },
            { step: '写回归测试', status: 'inProgress' },
          ],
        }),
      ).toEqual([
        { content: '复现问题', status: 'completed' },
        { content: '写回归测试', status: 'in_progress' },
      ]);
    });
  });
});
