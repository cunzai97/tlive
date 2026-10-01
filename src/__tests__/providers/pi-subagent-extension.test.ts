import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { createSubagentResourceLoader } from '../../client/providers/pi-subagent-extension.js';
import { PiSubagentMapper } from '../../client/providers/pi-subagents.js';

interface FixtureFlow { status: string; timeline: Array<{ kind: string; text?: string; toolName?: string; toolId?: string; toolResult?: string; status?: string }> }
interface FixtureResult { content: Array<{ type: string; text?: string }>; details: { mode: string; results: Array<{ exitCode: number; messages: unknown[]; sessionId?: string; flow: FixtureFlow }> } }
let root: string;
let cwd: string;
let agentDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tlive-subagent-subprocess-fixture-'));
  cwd = join(root, 'work'); agentDir = join(root, 'agent'); const bin = join(root, 'bin');
  mkdirSync(cwd); mkdirSync(agentDir); mkdirSync(bin); mkdirSync(join(agentDir, 'agents'));
  writeFileSync(join(agentDir, 'agents', 'worker.md'), '---\nname: worker\ndescription: isolated test fixture\n---\nRead-only fixture.\n');
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  vi.stubEnv('PI_SUBAGENT_TASK_TIMEOUT_MS', '5000');
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
  const thinking = { type: 'thinking', thinking: 'EARLY_THINKING_FIXTURE' };
  const call = { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: '/fixture-only' } };
  const answer = { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: 'FINAL_FIXTURE_ANSWER' }], stopReason: 'stop', usage: { input: 1, output: 1 } };
  const toolResult = { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', isError: false, timestamp: 3, content: [{ type: 'text', text: 'TOOL_FINAL_FIXTURE' }] };
  const events = [
    { type: 'message_start', message: { role: 'assistant', timestamp: 1, content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: thinking.thinking } },
    { type: 'message_end', message: { role: 'assistant', timestamp: 1, content: [thinking, call], usage: { input: 1, output: 1 } } },
    { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: '/fixture-only' } },
    { type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'read', args: {}, partialResult: { content: [{ type: 'text', text: 'TOOL_PARTIAL_FIXTURE' }] } },
    { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: toolResult.content }, isError: false },
    { type: 'message_end', message: toolResult },
    { type: 'message_start', message: { role: 'assistant', timestamp: 2, content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'FINAL_FIXTURE_ANSWER' } },
    { type: 'message_end', message: answer },
  ];
  // A real OS subprocess, but explicitly a fixture executable: never the user's Pi CLI/model.
  writeFileSync(join(bin, 'pi'), `#!${process.execPath}\nif(!process.argv.includes('--mode') || !process.argv.includes('json')) process.exit(9);\nconst events=${JSON.stringify(events)};\nfor(const event of events){process.stdout.write(JSON.stringify(event)+'\\n');await new Promise(resolve=>setTimeout(resolve,8));}\n`, { mode: 0o700 });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function registeredTool() {
  const loader = await createSubagentResourceLoader({ file: resolve('integrations/pi-subagent/index.ts'), cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
  expect(loader.getExtensions().errors).toEqual([]);
  const extension = loader.getExtensions().extensions.find(value => value.tools.has('subagent'))!;
  return extension.tools.get('subagent')!.definition;
}

describe('actual staged Pi extension with an isolated JSON subprocess fixture', () => {
  it('forwards thinking and tool updates before completion without duplicating finalized messages', async () => {
    const tool = await registeredTool(); const updates: FixtureResult[] = []; let settled = false;
    const early: boolean[] = [];
    const running = tool.execute('parent', { agent: 'worker', task: 'fixture only' }, undefined, value => {
      const snapshot = structuredClone(value) as FixtureResult;
      updates.push(snapshot);
      if (snapshot.details.results[0].flow.timeline.some(entry => entry.kind === 'thinking' && entry.text === 'EARLY_THINKING_FIXTURE')) early.push(!settled);
    }, { cwd, hasUI: false } as Parameters<typeof tool.execute>[4]);
    const final = await running as FixtureResult; settled = true;
    expect(early.length).toBeGreaterThan(0); expect(early.every(Boolean)).toBe(true);
    expect(final.content).toEqual([{ type: 'text', text: 'FINAL_FIXTURE_ANSWER' }]);
    const child = final.details.results[0];
    expect(child.exitCode).toBe(0); expect(child.sessionId).toBeTypeOf('string');
    expect(child.flow.status).toBe('completed');
    expect(child.flow.timeline.filter(entry => entry.kind === 'thinking')).toHaveLength(1);
    expect(child.flow.timeline.filter(entry => entry.kind === 'tool')).toHaveLength(1);
    expect(child.flow.timeline.find(entry => entry.kind === 'tool')).toMatchObject({ toolName: 'read', status: 'completed', toolResult: 'TOOL_FINAL_FIXTURE' });
    expect(child.flow.timeline.filter(entry => entry.kind === 'text')).toHaveLength(1);
    expect(updates.some(value => value.details.results[0].flow.timeline.some(entry => entry.toolResult === 'TOOL_PARTIAL_FIXTURE'))).toBe(true);
    expect(child.messages).toHaveLength(3);
    expect(updates.find(value => value.details.results[0].flow.timeline.some(entry => entry.kind === 'thinking'))!.details.results[0].flow.status).toBe('running');
  });
  it('keeps simultaneous identical agents in separate slots and publishes final status for each', async () => {
    const tool = await registeredTool(); const updates: FixtureResult[] = [];
    const params = { tasks: [{ agent: 'worker', task: 'same' }, { agent: 'worker', task: 'same' }] };
    const final = await tool.execute('parent', params, undefined, value => updates.push(structuredClone(value) as FixtureResult), { cwd, hasUI: false } as Parameters<typeof tool.execute>[4]) as FixtureResult;
    expect(final.details.results).toHaveLength(2);
    expect(new Set(final.details.results.map(child => child.sessionId)).size).toBe(2);
    expect(final.details.results.every(child => child.flow.status === 'completed')).toBe(true);
    const mapper = new PiSubagentMapper(); const seeded = mapper.start('parent', params);
    const trace = updates.flatMap(value => mapper.update('parent', params, value));
    trace.push(...mapper.update('parent', params, final, true));
    expect(new Set(trace.map(event => event.childId)).size).toBe(seeded.length);
    for (const child of seeded) {
      const latest = [...trace].reverse().find(event => event.childId === child.childId)!;
      expect(latest.status).toBe('completed');
      expect(latest.timeline.find(entry => entry.kind === 'thinking')?.text).toBe('EARLY_THINKING_FIXTURE');
    }
    expect(final.content[0].text).toContain('Parallel: 2/2 succeeded');
  });
});
