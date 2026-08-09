import { describe, expect, it, vi, beforeEach } from 'vitest';

const piSdkMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  authStorageCreate: vi.fn(),
  modelRegistryCreate: vi.fn(),
  sessionManagerCreate: vi.fn(),
  sessionManagerOpen: vi.fn(),
  sessionManagerInMemory: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  VERSION: '0.78.0',
  getAgentDir: () => '/home/testuser/.pi/agent',
  AuthStorage: {
    create: piSdkMocks.authStorageCreate,
  },
  ModelRegistry: {
    create: piSdkMocks.modelRegistryCreate,
  },
  SessionManager: {
    create: piSdkMocks.sessionManagerCreate,
    open: piSdkMocks.sessionManagerOpen,
    inMemory: piSdkMocks.sessionManagerInMemory,
  },
  createAgentSession: piSdkMocks.createAgentSession,
}));

import { PiLiveSession } from '../../client/providers/pi-live-session.js';

describe('PiLiveSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    piSdkMocks.authStorageCreate.mockReturnValue({ auth: true });
    piSdkMocks.modelRegistryCreate.mockReturnValue({
      getAll: () => [],
      getAvailable: () => [],
      find: () => undefined,
    });
    piSdkMocks.sessionManagerCreate.mockReturnValue({ mode: 'create' });
    piSdkMocks.sessionManagerOpen.mockReturnValue({ mode: 'open' });
    piSdkMocks.sessionManagerInMemory.mockReturnValue({ mode: 'memory' });
  });

  it('creates a Pi SDK session and streams canonical events', async () => {
    const finalMessage = {
      role: 'assistant',
      usage: {
        input: 3,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.001 },
      },
    };
    const messages: unknown[] = [];
    const listeners: Array<(event: any) => void> = [];
    const session = {
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-id',
      model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
      thinkingLevel: 'high',
      messages,
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener);
        return () => {};
      }),
      bindExtensions: vi.fn(),
      prompt: vi.fn(async () => {
        for (const listener of listeners) {
          listener({
            type: 'message_update',
            message: {},
            assistantMessageEvent: { type: 'text_delta', delta: 'done' },
          });
        }
        for (const listener of listeners) {
          listener({ type: 'agent_end', messages: [], willRetry: false });
        }
        messages.push(finalMessage);
      }),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
      getContextUsage: vi.fn(() => ({
        tokens: 5,
        contextWindow: 128000,
        percent: (5 / 128000) * 100,
      })),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo', effort: 'high' });
    const result = live.startTurn('hello');
    const events = await collect(result.stream);

    expect(piSdkMocks.sessionManagerCreate).toHaveBeenCalledWith('/repo', undefined);
    expect(piSdkMocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo',
        thinkingLevel: 'high',
      }),
    );
    expect(session.prompt).toHaveBeenCalledWith('hello', {
      expandPromptTemplates: true,
    });
    expect(events).toEqual([
      {
        kind: 'status',
        sessionId: '/tmp/pi-session.jsonl',
        model: 'anthropic/claude-sonnet-4-5',
      },
      { kind: 'text_delta', text: 'done' },
      {
        kind: 'context_usage',
        tokens: 5,
        contextWindow: 128000,
        percent: (5 / 128000) * 100,
      },
      {
        kind: 'query_result',
        sessionId: '/tmp/pi-session.jsonl',
        isError: false,
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          contextTokens: 5,
          costUsd: 0.001,
        },
      },
    ]);
  });

  it('uses Pi steer and follow-up APIs for native priority messages', async () => {
    const session = {
      sessionFile: undefined,
      sessionId: 'pi-session-id',
      model: undefined,
      thinkingLevel: 'off',
      messages: [],
      subscribe: vi.fn(() => () => {}),
      bindExtensions: vi.fn(),
      prompt: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    await live.sendWithPriority('now', 'now');
    await live.sendWithPriority('later', 'later');

    expect(session.steer).toHaveBeenCalledWith('now');
    expect(session.followUp).toHaveBeenCalledWith('later');
  });

  it('handles /model provider/model by switching the Pi session without prompting the LLM', async () => {
    const currentModel = { provider: 'jdy', id: 'Kimi-K2.5' };
    const targetModel = { provider: 'openai', id: 'gpt-5.2' };
    const modelRegistry = {
      getAll: vi.fn(() => [currentModel, targetModel]),
      getAvailable: vi.fn(() => [currentModel, targetModel]),
      find: vi.fn((provider: string, modelId: string) =>
        provider === targetModel.provider && modelId === targetModel.id ? targetModel : undefined,
      ),
    };
    const session: any = {
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-id',
      model: currentModel,
      modelRegistry,
      thinkingLevel: 'high',
      messages: [],
      subscribe: vi.fn(() => () => {}),
      bindExtensions: vi.fn(),
      prompt: vi.fn(),
      setModel: vi.fn(async (model: unknown) => {
        session.model = model;
      }),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
      getContextUsage: vi.fn(() => ({
        tokens: 1234,
        contextWindow: 256000,
        percent: (1234 / 256000) * 100,
      })),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const events = await collect(live.startTurn('/model openai/gpt-5.2').stream);

    expect(modelRegistry.find).toHaveBeenCalledWith('openai', 'gpt-5.2');
    expect(session.setModel).toHaveBeenCalledWith(targetModel);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(live.runtimeInfo.model).toBe('openai/gpt-5.2');
    expect(events).toEqual([
      {
        kind: 'status',
        sessionId: '/tmp/pi-session.jsonl',
        model: 'jdy/Kimi-K2.5',
      },
      {
        kind: 'status',
        sessionId: '/tmp/pi-session.jsonl',
        model: 'openai/gpt-5.2',
      },
      { kind: 'text_delta', text: 'Model switched to openai/gpt-5.2' },
      {
        kind: 'context_usage',
        tokens: 1234,
        contextWindow: 256000,
        percent: (1234 / 256000) * 100,
      },
      {
        kind: 'query_result',
        sessionId: '/tmp/pi-session.jsonl',
        isError: false,
        usage: { inputTokens: 0, outputTokens: 0, contextTokens: 1234 },
      },
    ]);
  });

  it('rejects /model without a provider/model argument instead of prompting the LLM', async () => {
    const session = {
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-id',
      model: { provider: 'jdy', id: 'Kimi-K2.5' },
      modelRegistry: { getAll: () => [], getAvailable: () => [], find: vi.fn() },
      thinkingLevel: 'high',
      messages: [],
      subscribe: vi.fn(() => () => {}),
      bindExtensions: vi.fn(),
      prompt: vi.fn(),
      setModel: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
      getContextUsage: vi.fn(),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const events = await collect(live.startTurn('/model').stream);

    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      kind: 'query_result',
      sessionId: '/tmp/pi-session.jsonl',
      isError: true,
      usage: { inputTokens: 0, outputTokens: 0 },
      error: 'Usage: /model <provider/model>',
    });
  });

  it('uses TL_PI_PROVIDER to select a provider model when no explicit model is set', async () => {
    const anthropicModel = { provider: 'anthropic', id: 'claude-sonnet-4-5' };
    piSdkMocks.modelRegistryCreate.mockReturnValue({
      getAll: () => [{ provider: 'openai', id: 'gpt-5.1-codex' }, anthropicModel],
      getAvailable: () => [anthropicModel],
      find: () => undefined,
    });
    const session = {
      sessionFile: undefined,
      sessionId: 'pi-session-id',
      model: anthropicModel,
      thinkingLevel: 'off',
      messages: [],
      subscribe: vi.fn(() => () => {}),
      bindExtensions: vi.fn(),
      prompt: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo', provider: 'anthropic' });
    await live.sendWithPriority('now', 'now');

    expect(piSdkMocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: anthropicModel }),
    );
  });
});

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const events: T[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return events;
    events.push(value);
  }
}
