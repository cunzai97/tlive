import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSnapshot } from '../../shared/canonical/schema.js';

const sdk = vi.hoisted(() => ({
  handlers: new Map<string, (data: unknown) => unknown>(),
  reply: vi.fn(), create: vi.fn(), patch: vi.fn(), remove: vi.fn(),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'self' }, Domain: { Feishu: 'feishu' }, LoggerLevel: { error: 'error' },
  Client: class { im = { message: { reply: sdk.reply, create: sdk.create, patch: sdk.patch, delete: sdk.remove }, messageReaction: { create: vi.fn(), delete: vi.fn() } }; },
  EventDispatcher: class { register(value: Record<string, (data: unknown) => unknown>) { Object.entries(value).forEach(([key, handler]) => sdk.handlers.set(key, handler)); return this; } },
  WSClient: class { start = vi.fn(); close = vi.fn(); },
}));
import { FeishuAdapter } from '../../server/channels/feishu/adapter.js';
import { fitsFeishuCard, measureFeishuCard } from '../../server/channels/feishu/card-budget.js';
import { SubagentFlowPresenter } from '../../server/presentation/subagent-presenter.js';

interface Request { path?: { message_id: string }; data: { content: string; uuid?: string; reply_in_thread?: boolean } }
let adapter: FeishuAdapter;
let presenter: SubagentFlowPresenter;
const remote = new Map<string, string>();
const uuids = new Map<string, string>();
const observed: Request[] = [];
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(0); vi.clearAllMocks(); sdk.handlers.clear(); remote.clear(); uuids.clear(); observed.length = 0;
  const send = async (request: Request) => {
    observed.push(structuredClone(request));
    const existing = uuids.get(request.data.uuid!);
    if (existing) return { code: 0, data: { message_id: existing, thread_id: 'topic' } };
    const messageId = `child-${remote.size + 1}`;
    uuids.set(request.data.uuid!, messageId); remote.set(messageId, request.data.content);
    return { code: 0, data: { message_id: messageId, thread_id: 'topic' } };
  };
  sdk.reply.mockImplementation(send); sdk.create.mockImplementation(send);
  sdk.patch.mockImplementation(async (request: Request) => { observed.push(structuredClone(request)); remote.set(request.path!.message_id, request.data.content); return { code: 0 }; });
  sdk.remove.mockImplementation(async ({ path }: { path: { message_id: string } }) => { remote.delete(path.message_id); return { code: 0 }; });
  adapter = new FeishuAdapter({ appId: 'fixture-app', appSecret: 'fixture-secret', verificationToken: '', encryptKey: '', allowedUsers: ['owner'] }, {
    botOpenId: 'fixture-bot', botName: 'fixture',
    cardFlow: { mode: 'blocks', groupGapTokens: 50, maxBytes: 4000, maxElements: 30, toolRules: {} },
  });
  await adapter.start();
  presenter = new SubagentFlowPresenter({ adapter, parentTurnId: 'local-parent-nonce', inbound: { channelType: 'feishu', chatId: 'chat', threadId: 'topic', messageId: 'parent', replyTargetMessageId: 'root', replyInThread: true, userId: 'owner', text: 'fixture' } });
});
afterEach(async () => { await presenter?.dispose(); await adapter?.stop(); vi.useRealTimers(); });

function snapshot(childId: string, final = false): SubagentSnapshot {
  const timeline: SubagentSnapshot['timeline'] = [{ kind: 'thinking', blockId: 'same-thinking-id', text: '思考'.repeat(800) + `THINK_REMOVE_${childId}` }];
  if (final) {
    for (let index = 0; index < 12; index++) timeline.push({ kind: 'tool', blockId: `tool-${index}`, toolId: `same-call-${index}`, toolName: 'bash', inputData: { command: 'OLD_ARGUMENT_MARKER' + '冗长参数'.repeat(500) }, toolResult: 'OLD_RESULT_MARKER' + '冗长结果'.repeat(500), status: 'completed' });
    timeline.push({ kind: 'text', blockId: 'answer', text: '旧输出'.repeat(1800) + `RUN_${childId}_END` });
  }
  return { kind: 'subagent_snapshot', parentToolUseId: 'same-parent-call', childId, agentName: 'same-agent', task: `task ${childId}`, status: final ? childId === 'C' ? 'failed' : 'completed' : 'running', timeline, ...(final && childId === 'C' ? { error: 'FAIL_C' } : {}) };
}

describe('real Feishu adapter/sender wiring for simultaneous compact child cards', () => {
  it('updates four independent physical cards, degrades old content, and handles platform capacity rejection without overflow', async () => {
    const children = ['A', 'B', 'C', 'D'];
    children.forEach(child => presenter.update(snapshot(child)));
    await vi.advanceTimersByTimeAsync(0);
    expect(remote.size).toBe(children.length);
    const identities = [...remote.keys()];
    // A definite platform capacity refusal must reduce/retry that same card, not send a sibling.
    sdk.patch.mockImplementationOnce(async () => ({ code: 230025, msg: 'fixture card size exceeded' }));
    const finals = children.map(child => snapshot(child, true)); const original = JSON.stringify(finals);
    finals.forEach(value => presenter.update(value));
    const finished = presenter.finish();
    await vi.advanceTimersByTimeAsync(2000); await finished;
    expect(remote.size).toBe(children.length);
    expect([...remote.keys()]).toEqual(identities);
    expect(sdk.reply).toHaveBeenCalledTimes(children.length);
    expect(sdk.create).not.toHaveBeenCalled(); expect(sdk.remove).not.toHaveBeenCalled();
    expect(JSON.stringify(finals)).toBe(original);
    for (const [index, child] of children.entries()) {
      const json = remote.get(identities[index])!;
      // Literal downgrade escapes Markdown underscores; compare displayed text, not markup.
      const visible = JSON.stringify(JSON.parse(json), (_key, value) => typeof value === 'string' ? value.replace(/\\_/g, '_') : value);
      expect(visible).toContain(`RUN_${child}_END`);
      expect(visible).not.toContain(`THINK_REMOVE_${child}`);
      expect(visible).not.toContain('OLD_ARGUMENT_MARKER'); expect(visible).not.toContain('OLD_RESULT_MARKER');
      expect(json).not.toContain('feishuSubagentCard');
      expect(fitsFeishuCard(json, { maxBytes: 4000, maxElements: 30, maxTables: 4 })).toBe(true);
      for (const other of children.filter(value => value !== child)) expect(visible).not.toContain(`RUN_${other}_END`);
    }
    expect(JSON.parse(remote.get(identities[2])!).header.template).toBe('red');
    expect(remote.get(identities[2])).toContain('FAIL_C');
    expect(Math.max(measureFeishuCard(remote.get(identities[0])!).bytes, measureFeishuCard(remote.get(identities[0])!).requestBytes)).toBeLessThanOrEqual(3000);
    for (const request of observed) expect(measureFeishuCard(request.data.content).requestBytes).toBeLessThanOrEqual(4000);
    for (const [request] of sdk.reply.mock.calls) { expect(request.path.message_id).toBe('root'); expect(request.data.reply_in_thread).toBe(true); }
  });
});
