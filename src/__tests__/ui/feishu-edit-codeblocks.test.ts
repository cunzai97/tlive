import type { Client } from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureFeishuCardBudget, measureFeishuCard } from '../../server/channels/feishu/card-budget.js';
import { FeishuToolDetails } from '../../server/channels/feishu/tool-details.js';
import type { InboundMessage } from '../../server/channels/types.js';
import { redactSensitiveContent } from '../../shared/utils/content-filter.js';

interface Request {
  data: { content: string; uuid?: string };
}
interface Element {
  tag: string;
  content?: string;
  text?: { tag: string; content: string };
}
const stores: FeishuToolDetails[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); });
const signed = (text: string, sign: string) => text ? text.split('\n').map(line => sign + line).join('\n') : '';
function fixture(input: unknown, status = 'completed', maxElements = 24) {
  const details = new FeishuToolDetails({ cleanupIntervalMs: 0, pageBytes: 3000 });
  stores.push(details);
  const reply = vi.fn(async (_request: Request) => ({ code: 0, data: { message_id: 'detail', thread_id: 'thread' } }));
  const patch = vi.fn(async (_request: Request) => ({ code: 0 }));
  const del = vi.fn(async () => ({ code: 0 }));
  const create = vi.fn();
  const client = { im: { message: { reply, patch, delete: del, create } } } as unknown as Client;
  configureFeishuCardBudget(client, { maxBytes: 3000, maxElements, maxTables: 1 });
  const id = details.register('chat', { toolId: 'call', toolName: 'Edit', inputData: input, toolResult: 'result', status })!;
  expect(id).toBeTruthy();
  details.bind({ chatId: 'chat', threadId: 'thread', replyToMessageId: 'root', replyInThread: true,
    flowDetailUserId: 'owner', feishuButtons: [{ label: '详情', callbackData: `flow_detail:open:${id}` }] }, ['source']);
  const action = (verb: string, messageId = 'source') => details.handle({ channelType: 'feishu', chatId: 'chat',
    threadId: 'thread', userId: 'owner', messageId, text: '', callbackData: verb.startsWith('page:') ? `flow_detail:page:${id}:${verb.slice(5)}` : `flow_detail:${verb}:${id}` } as InboundMessage, client, true);
  return { details, id, client, reply, patch, del, create, action, maxElements };
}
function elements(request: Request): Element[] {
  return JSON.parse(request.data.content).body.elements;
}
function source(element: Element): string {
  if (element.tag !== 'markdown') return element.text?.content ?? '';
  const content = element.content!;
  const opening = /^(`{3,})diff\n/.exec(content);
  expect(opening).not.toBeNull();
  const fence = opening![1];
  expect(content.endsWith(`\n${fence}`)).toBe(true);
  const raw = content.slice(opening![0].length, -fence.length - 1);
  // An embedded marker cannot close the surrounding code block.
  for (const match of raw.matchAll(/`+/g)) expect(match[0].length).toBeLessThan(fence.length);
  return raw;
}
async function collect(mock: ReturnType<typeof fixture>) {
  expect(await mock.action('open')).toMatchObject({ toast: { type: 'success' } });
  const first = mock.reply.mock.calls.at(-1)![0];
  const total = Number(/^1 \/ (\d+)$/.exec(elements(first)[0].text!.content)![1]);
  const requests = [first];
  for (let n = 1; n < total; n++) {
    expect(await mock.action(`page:${n}`, 'detail')).toMatchObject({ toast: { type: 'success' } });
    requests.push(mock.patch.mock.calls.at(-1)![0]);
  }
  for (const request of requests) {
    const size = measureFeishuCard(request.data.content);
    expect(size.bytes).toBeLessThanOrEqual(3000);
    expect(size.requestBytes).toBeLessThanOrEqual(3000);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(3000);
    expect(size.elements).toBeLessThanOrEqual(mock.maxElements);
    expect(size.tables).toBe(0);
  }
  expect(mock.create).not.toHaveBeenCalled();
  return { requests, text: requests.flatMap(request => elements(request).slice(1).map(source)).join(''),
    diff: requests.flatMap(request => elements(request).filter(element => element.tag === 'markdown').map(source)).join('') };
}

describe('compact edit detail code blocks', () => {
  it('preserves complete hostile snippets including CRLF, fences, labels, tables, HTML and emoji', async () => {
    const old = '文件：/spoof\r\n替换片段：\n```diff\n-raw\n```\n~~~\n|a|b|\n|-|-|\n<b>😀🐾</b> `x`\n\n'.repeat(60);
    const next = '新\r\n``````\n<at id="all">@all</at>\n|a|b|\n|---|---|\n# 标题😀\n'.repeat(60);
    const input = { path: '/real', oldText: old, newText: next };
    const mock = fixture(input);
    input.oldText = 'mutated'; input.newText = 'mutated';
    const result = await collect(mock);
    const diff = `${signed(old, '-')}\n${signed(next, '+')}`;
    expect(result.diff).toBe(diff);
    expect(result.text).toBe(`工具执行成功 · 本次改动\n工具：Edit\n\n文件：/real\n替换片段：\n${diff}\n\n工具结果快照：\nresult`);
    expect(result.requests.length).toBeGreaterThan(2);
    expect(result.text).not.toMatch(/未提供旧文件全文|不是完整文件差异|不据此断言/);
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(mock.patch).toHaveBeenCalledTimes(result.requests.length - 1);
    expect(await mock.action('close', 'detail')).toMatchObject({ toast: { type: 'success' } });
    expect(await mock.action('open')).toMatchObject({ toast: { type: 'success' } });
    expect(mock.reply).toHaveBeenCalledTimes(2);
    expect(elements(mock.reply.mock.calls[1][0]).slice(1).map(source).join('')).toBe(elements(result.requests[0]).slice(1).map(source).join(''));
  });

  it('shrinks actual rendered pages for very long generated fences without losing boundaries', async () => {
    const content = '`'.repeat(10000) + '\r\n😀\n';
    const result = await collect(fixture({ path: '/ticks', content }));
    expect(result.diff).toBe(signed(content, '+'));
    expect(result.text).toBe(`工具执行成功 · 本次改动\n工具：Edit\n\n文件：/ticks\n写入：\n${signed(content, '+')}\n\n工具结果快照：\nresult`);
    expect(result.requests.length).toBeGreaterThan(10);
  });

  it('uses trusted redacted offsets, not file labels in arbitrary source, and keeps missing snippets plain', async () => {
    const path = '/sk-proj-' + 'a'.repeat(80);
    const content = 'API_TOKEN=' + 'b'.repeat(80) + '\n文件：/spoof\n写入：\n```\n😀\r\n';
    const mock = fixture({ files: [{ path, newText: content }, { path: '/second', oldText: 'old', newText: 'new' }] });
    const result = await collect(mock);
    expect(result.text).toBe('工具执行成功 · 本次改动\n工具：Edit\n\n' +
      `文件：${redactSensitiveContent(path)}\n替换片段：\n${signed(redactSensitiveContent(content), '+')}\n\n` +
      '文件：/second\n替换片段：\n-old\n+new\n\n工具结果快照：\nresult');
    expect(result.diff).toBe(signed(redactSensitiveContent(content), '+') + '-old\n+new');
    for (const request of result.requests) for (const element of elements(request)) {
      if (element.tag === 'markdown') expect(source(element)).not.toContain('（未提供旧片段）');
    }
  });

  it('shrinks multi-file pages to meet component budgets rather than dropping sections', async () => {
    const files = Array.from({ length: 50 }, (_, n) => ({ path: `/file-${n}`, content: `line-${n}\n` }));
    const result = await collect(fixture({ files }, 'completed', 18));
    expect(result.diff).toBe(files.map(file => signed(file.content, '+')).join(''));
    expect(result.text).toBe('工具执行成功 · 本次改动\n工具：Edit\n\n' + files.map(file =>
      `文件：${file.path}\n写入：\n${signed(file.content, '+')}`).join('\n\n') + '\n\n工具结果快照：\nresult');
    expect(result.requests.length).toBeGreaterThan(2);
  });

  it.each([['failed', '工具执行失败'], ['interrupted', '工具执行中断']])('retains honest %s state without repeated disclaimers', async (status, label) => {
    const result = await collect(fixture({ path: '/x', content: 'x' }, status));
    expect(result.text).toContain(label);
    expect(result.text).not.toContain('工具执行成功');
    expect(result.text).not.toContain('不代表');
  });

  it('retries an unknown response with identical UUID and request, but rotates after a confirmed close', async () => {
    const mock = fixture({ path: '/x', content: '```\nx\n```' });
    mock.reply.mockRejectedValueOnce(new Error('response lost'));
    expect(await mock.action('open')).toMatchObject({ toast: { type: 'error' } });
    expect(await mock.action('open')).toMatchObject({ toast: { type: 'success' } });
    expect(mock.reply.mock.calls[0][0]).toEqual(mock.reply.mock.calls[1][0]);
    expect(mock.reply.mock.calls[0][0].data.uuid).toBeTruthy();
    expect(await mock.action('close', 'detail')).toMatchObject({ toast: { type: 'success' } });
    expect(await mock.action('open')).toMatchObject({ toast: { type: 'success' } });
    expect(mock.reply.mock.calls[2][0].data.uuid).not.toBe(mock.reply.mock.calls[0][0].data.uuid);
  });
});
