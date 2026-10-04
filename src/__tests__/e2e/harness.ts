import { vi } from 'vitest';
import type { CanonicalEvent } from '../../shared/canonical/schema.js';
import type {
  LiveSession,
  MessagePriority,
  StreamChatResult,
  TurnParams,
} from '../../shared/providers/base.js';

type Scenario =
  | string
  | CanonicalEvent[]
  | AsyncIterable<CanonicalEvent>
  | ((prompt: string, params?: TurnParams) => Promise<CanonicalEvent[]> | CanonicalEvent[]);

class FakeLiveSession implements LiveSession {
  isAlive = true;
  isTurnActive = false;
  readonly runtimeInfo = {
    provider: 'claude' as const,
    displayName: 'Claude',
    model: 'fake-claude',
  };
  private callbacks: { onTurnComplete?: () => void } = {};

  constructor(
    private readonly scenario: Scenario,
    private readonly nextSessionId: () => string,
    private readonly onPrompt: (prompt: string) => void,
    private readonly onPriorityMessage: (text: string, priority: MessagePriority) => void,
    private readonly onInterrupt: () => void,
  ) {}

  startTurn(prompt: string, params?: TurnParams): StreamChatResult {
    this.isTurnActive = true;
    this.onPrompt(prompt);
    const stream = new ReadableStream<CanonicalEvent>({
      start: (controller) => {
        void (async () => {
          try {
            for await (const event of resolveScenarioStream(
              this.scenario,
              prompt,
              params,
              this.nextSessionId,
            )) {
              controller.enqueue(event);
            }
          } catch (error) {
            controller.enqueue({
              kind: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          } finally {
            this.isTurnActive = false;
            this.callbacks.onTurnComplete?.();
            controller.close();
          }
        })();
      },
    });
    return {
      stream,
      controls: {
        interrupt: () => this.interruptTurn(),
        stopTask: async () => {},
      },
    };
  }

  steerTurn(_text: string): void {}

  async sendWithPriority(text: string, priority: MessagePriority): Promise<void> {
    this.onPriorityMessage(text, priority);
  }

  async interruptTurn(): Promise<void> {
    this.onInterrupt();
    this.isTurnActive = false;
  }

  close(): void {
    this.isAlive = false;
  }

  setLifecycleCallbacks(callbacks: { onTurnComplete?: () => void }): void {
    this.callbacks = callbacks;
  }
}

export class FakeClaudeProvider {
  readonly kind = 'claude' as const;
  readonly displayName = 'Claude';
  readonly capabilities = {
    runtimeMode: 'interactive',
    nativeSteer: true,
    nativeQueue: true,
    drainsQueueWhenIdle: true,
    interactivePermissions: true,
    askUserQuestion: true,
    deferredTools: true,
    settingSources: true,
    sessionResume: true,
    imageInputs: true,
  };
  readonly prompts: string[] = [];
  readonly priorityMessages: Array<{ text: string; priority: MessagePriority }> = [];
  interruptCount = 0;
  readonly createSession = vi.fn((params: { workingDirectory: string; sessionId?: string }) => {
    void params;
    return this.newSession();
  });
  readonly streamChat = vi.fn((params: { prompt: string }) =>
    this.newSession().startTurn(params.prompt),
  );
  private sessionSeq = 1;

  constructor(private scenario: Scenario = 'Fake Claude response') {}

  setScenario(scenario: Scenario): void {
    this.scenario = scenario;
  }

  getDefaultSettingSources(): Array<'user' | 'project' | 'local'> {
    return ['user', 'project', 'local'];
  }

  private nextSessionId(): string {
    return `sdk-session-${this.sessionSeq++}`;
  }

  private newSession(): FakeLiveSession {
    return new FakeLiveSession(
      this.scenario,
      () => this.nextSessionId(),
      (prompt) => {
        this.prompts.push(prompt);
      },
      (text, priority) => {
        this.priorityMessages.push({ text, priority });
      },
      () => {
        this.interruptCount += 1;
      },
    );
  }
}

export async function waitFor<T>(
  probe: () => T | undefined | false | null,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for E2E condition');
}

async function* resolveScenarioStream(
  scenario: Scenario,
  prompt: string,
  params: TurnParams | undefined,
  nextSessionId: () => string,
): AsyncIterable<CanonicalEvent> {
  if (typeof scenario === 'function') {
    yield* await scenario(prompt, params);
    return;
  }
  if (isAsyncIterable(scenario)) {
    yield* scenario;
    return;
  }
  if (Array.isArray(scenario)) {
    yield* scenario;
    return;
  }
  yield { kind: 'text_delta', text: scenario };
  yield {
    kind: 'query_result',
    sessionId: nextSessionId(),
    isError: false,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<CanonicalEvent> {
  return !!value && typeof value === 'object' && Symbol.asyncIterator in value;
}
