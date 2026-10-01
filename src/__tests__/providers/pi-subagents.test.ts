import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { PiAdapter } from '../../client/providers/pi-adapter.js';
import { PiSubagentMapper } from '../../client/providers/pi-subagents.js';
import { subagentSnapshotSchema, type CanonicalEvent } from '../../shared/canonical/schema.js';
import { encodeRemoteProtocolMessage, parseRemoteProtocolMessage } from '../../shared/protocol/messages.js';
import { ConversationEngine } from '../../server/engine/conversation-engine.js';
import type { BridgeStore } from '../../server/store/interface.js';

const tasks = { tasks: [{ agent: 'worker', task: 'same task' }, { agent: 'worker', task: 'same task' }] };
const flow = (text: string, status = 'running') => ({ version: 1, status, timeline: [
  { kind: 'thinking', blockId: 'thinking', text: 'FULL_THINKING' },
  { kind: 'tool', blockId: 'tool', toolId: 'read-1', toolName: 'read', inputData: { path: '/fixture' }, status: 'completed', toolResult: 'FULL_TOOL_RESULT' },
  { kind: 'text', blockId: 'text', text },
] });
const result = (text: string, status = 'running') => ({ agent: 'worker', task: 'same task', exitCode: 0, messages: [], flow: flow(text, status) });
const payload = (results: unknown[], mode = 'parallel') => ({ content: [{ type: 'text', text: 'FULL_PARENT_TOOL_RESULT' }], details: { mode, results } });
const childEvents = (events: CanonicalEvent[]) => events.filter((event): event is Extract<CanonicalEvent, { kind: 'subagent_snapshot' }> => event.kind === 'subagent_snapshot');

describe('Pi subagent event and protocol routing', () => {
  it('isolates same-name same-task slots and separate simultaneous parent calls', () => {
    const mapper = new PiSubagentMapper();
    const first = mapper.start('parent-1', tasks);
    const second = mapper.start('parent-2', tasks);
    expect(new Set([...first, ...second].map(event => event.childId)).size).toBe(4);
    const updated = mapper.update('parent-1', tasks, payload([result('one'), result('two')]));
    expect(updated.map(event => event.timeline.at(-1)?.text)).toEqual(['one', 'two']);
    expect(updated.every(event => event.parentToolUseId === 'parent-1')).toBe(true);
    expect(new Set(updated.map(event => event.timeline[1].toolId)).size).toBe(2);
    expect(updated.map(event => event.childId)).toEqual(first.map(event => event.childId));
    for (const event of updated) expect(subagentSnapshotSchema.parse(event)).toEqual(event);
  });
  it('publishes only changed complete snapshots with stable IDs and no mutable provider aliases', () => {
    const mapper = new PiSubagentMapper(); mapper.start('parent', tasks);
    const before = result('before');
    const raw = payload([before, result('other')]);
    const first = mapper.update('parent', tasks, raw);
    expect(mapper.update('parent', tasks, raw)).toEqual([]);
    before.flow.timeline[2].text = 'after';
    const changed = mapper.update('parent', tasks, raw);
    expect(changed).toHaveLength(1);
    expect(changed[0].timeline.at(-1)?.text).toBe('after');
    expect(changed[0].timeline.map(entry => entry.blockId)).toEqual(first[0].timeline.map(entry => entry.blockId));
    expect(first[0].timeline.at(-1)?.text).toBe('before');
  });
  it('does not mistake old single-mode exitCode=0 partials for completed children', () => {
    const mapper = new PiSubagentMapper(); const args = { agent: 'worker', task: 'fixture' };
    mapper.start('parent', args);
    const legacy = { agent: 'worker', task: 'fixture', exitCode: 0, messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'legacy thinking' }, { type: 'toolCall', id: 't', name: 'read', arguments: { path: '/x' } },
    ] }, { role: 'toolResult', toolCallId: 't', toolName: 'read', content: [{ type: 'text', text: 'complete result' }] }] };
    const partial = mapper.update('parent', args, payload([legacy], 'single'));
    expect(partial[0].status).toBe('running');
    expect(partial[0].timeline.filter(entry => entry.kind === 'tool')).toHaveLength(1);
    expect(partial[0].timeline[1]).toMatchObject({ status: 'completed', toolResult: 'complete result' });
    const final = mapper.update('parent', args, payload([legacy], 'single'), true);
    expect(final[0].status).toBe('completed');
    expect(mapper.update('parent', args, payload([result('late')], 'single'))).toEqual([]);
  });
  it('settles a failed chain and queued unexecuted slots without claiming success', () => {
    const mapper = new PiSubagentMapper();
    const args = { chain: [...tasks.tasks, { agent: 'worker', task: 'third' }] };
    mapper.start('chain', args);
    const final = mapper.update('chain', args, payload([result('first', 'completed'), { ...result('error', 'failed'), errorMessage: 'fixture failure' }], 'chain'), true, true);
    expect(final.map(event => event.status)).toEqual(['completed', 'failed', 'interrupted']);
    expect(final[1].error).toBe('fixture failure');
  });
  it('keys resume tasks by invocation and rejects over-limit/invalid parallel declarations', () => {
    const mapper = new PiSubagentMapper();
    const resume = { agent: 'worker', resume: 'session-shared' };
    expect(mapper.start('a', resume)[0].childId).not.toBe(mapper.start('b', resume)[0].childId);
    expect(mapper.start('too-many', { tasks: Array.from({ length: 9 }, () => tasks.tasks[0]) })).toEqual([]);
    expect(mapper.start('invalid', { agent: 'worker', task: 'x', tasks: tasks.tasks })).toEqual([]);
    expect(mapper.update('invalid-payload', {}, null)).toEqual([]);
  });
  it('normalizes out-of-order tool results once and preserves failure during late fill-in', () => {
    const mapper = new PiSubagentMapper(); const args = { agent: 'worker', task: 'fixture' };
    mapper.start('call', args);
    const messages = [
      { role: 'toolResult', toolCallId: 't', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'bad' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'bash', arguments: { command: 'fixture' } }] },
    ];
    const events = mapper.update('call', args, payload([{ exitCode: 0, messages }], 'single'));
    expect(events[0].timeline).toHaveLength(1);
    expect(events[0].timeline[0]).toMatchObject({ status: 'failed', toolResult: 'bad', inputData: { command: 'fixture' } });
  });
  it('routes child snapshots before tool results while preserving the complete model result', () => {
    const adapter = new PiAdapter();
    const end = adapter.mapEvent({ type: 'tool_execution_end', toolCallId: 'late', toolName: 'subagent', result: payload([result('latest', 'completed')], 'single'), isError: false } as unknown as AgentSessionEvent);
    expect(end.findIndex(event => event.kind === 'subagent_snapshot')).toBeLessThan(end.findIndex(event => event.kind === 'tool_result'));
    expect(end.find(event => event.kind === 'tool_result')).toMatchObject({ content: 'FULL_PARENT_TOOL_RESULT', isFinal: true });
    const child = childEvents(end)[0];
    const encoded = encodeRemoteProtocolMessage({ type: 'turn.event', turnId: 'turn', event: child });
    expect(parseRemoteProtocolMessage(JSON.parse(encoded))).toEqual({ type: 'turn.event', turnId: 'turn', event: child });
  });
  it('forwards child snapshots through ConversationEngine without injecting child output into parent text', async () => {
    const adapter = new PiAdapter();
    const started = adapter.mapEvent({ type: 'tool_execution_start', toolCallId: 'parent', toolName: 'subagent', args: tasks } as unknown as AgentSessionEvent);
    const changed = adapter.mapEvent({ type: 'tool_execution_update', toolCallId: 'parent', toolName: 'subagent', args: tasks, partialResult: payload([result('child-only-1'), result('child-only-2')]) } as unknown as AgentSessionEvent);
    const events: CanonicalEvent[] = [...started, ...changed, { kind: 'text_delta', text: 'PARENT_ONLY' }, ...adapter.mapComplete()];
    const stream = new ReadableStream<CanonicalEvent>({ start(controller) { events.forEach(event => controller.enqueue(event)); controller.close(); } });
    const store = { acquireLock: vi.fn(async () => true), releaseLock: vi.fn(async () => {}) } as unknown as BridgeStore;
    const engine = new ConversationEngine(store); const snapshots = vi.fn(); const tools = vi.fn(); const text = vi.fn();
    await engine.processMessage({ provider: {} as Parameters<ConversationEngine['processMessage']>[0]['provider'], text: 'fixture', workingDirectory: '/tmp', streamResult: { stream }, onSubagentSnapshot: snapshots, onToolResult: tools, onTextDelta: text });
    expect(snapshots).toHaveBeenCalledTimes(childEvents(events).length);
    expect(tools).toHaveBeenCalledWith(expect.objectContaining({ content: 'FULL_PARENT_TOOL_RESULT' }));
    expect(text.mock.calls).toEqual([['PARENT_ONLY']]);
    expect(store.releaseLock).toHaveBeenCalledOnce();
  });
});
