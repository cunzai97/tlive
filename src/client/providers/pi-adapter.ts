import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { type CanonicalEvent, canonicalEventSchema } from '../../shared/canonical/schema.js';
import { PiSubagentMapper } from './pi-subagents.js';

interface PiAdapterState {
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  startedTools: Set<string>;
  terminalEmitted: boolean;
  pendingMessages?: unknown[];
  /** When a streaming file was last snapshotted, per assistant content index. */
  liveWriteAt: Map<number, number>;
}

/** pi names its file writer `write`; the other spelling covers renamed providers. */
const LIVE_WRITE_TOOLS = new Set(['write', 'Write']);
const LIVE_WRITE_TAIL_CHARS = 4_000;
/** The card repaints every 400ms, so a faster cadence would only be discarded downstream. */
const LIVE_WRITE_MIN_INTERVAL_MS = 300;

export class PiAdapter {
  private readonly subagents = new PiSubagentMapper();
  private state: PiAdapterState = {
    startedTools: new Set(),
    terminalEmitted: false,
    liveWriteAt: new Map(),
  };

  constructor(options: { sessionId?: string; model?: string; reasoningEffort?: string } = {}) {
    this.state.sessionId = options.sessionId;
    this.state.model = options.model;
    this.state.reasoningEffort = options.reasoningEffort;
  }

  updateRuntime(options: { sessionId?: string; model?: string; reasoningEffort?: string }): void {
    this.state.sessionId = options.sessionId ?? this.state.sessionId;
    this.state.model = options.model ?? this.state.model;
    this.state.reasoningEffort = options.reasoningEffort ?? this.state.reasoningEffort;
  }

  mapEvent(event: AgentSessionEvent): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];

    switch (event.type) {
      case 'message_update':
        this.mapAssistantUpdate(event.assistantMessageEvent, events);
        break;
      case 'tool_execution_start':
        events.push({
          kind: 'tool_start',
          id: event.toolCallId,
          name: event.toolName,
          input: normalizeToolInput(event.args),
        });
        this.state.startedTools.add(event.toolCallId);
        if (event.toolName === 'subagent') {
          events.push(...this.subagents.start(event.toolCallId, event.args));
        }
        break;
      case 'tool_execution_update':
        if (!this.state.startedTools.has(event.toolCallId)) {
          events.push({
            kind: 'tool_start',
            id: event.toolCallId,
            name: event.toolName,
            input: normalizeToolInput(event.args),
          });
          this.state.startedTools.add(event.toolCallId);
        }
        if (event.toolName === 'subagent') {
          events.push(...this.subagents.update(event.toolCallId, event.args, event.partialResult));
        }
        events.push({
          kind: 'tool_result',
          toolUseId: event.toolCallId,
          content: toolResultContent(event.partialResult),
          isError: false,
          isFinal: false,
        });
        break;
      case 'tool_execution_end':
        if (!this.state.startedTools.has(event.toolCallId)) {
          events.push({
            kind: 'tool_start',
            id: event.toolCallId,
            name: event.toolName,
            input: normalizeToolInput({}),
          });
          this.state.startedTools.add(event.toolCallId);
        }
        if (event.toolName === 'subagent') {
          events.push(
            ...this.subagents.update(event.toolCallId, undefined, event.result, true, event.isError),
          );
        }
        events.push({
          kind: 'tool_result',
          toolUseId: event.toolCallId,
          content: toolResultContent(event.result),
          isError: event.isError,
          isFinal: true,
        });
        break;
      case 'agent_end':
        if (!event.willRetry) {
          this.state.pendingMessages = event.messages;
        }
        break;
      case 'auto_retry_start':
        events.push({
          kind: 'api_retry',
          attempt: event.attempt,
          maxRetries: event.maxAttempts,
          retryDelayMs: event.delayMs,
          error: event.errorMessage,
        });
        break;
      case 'compaction_start':
        events.push({
          kind: 'compact_boundary',
          trigger: event.reason === 'manual' ? 'manual' : 'auto',
          phase: 'start',
        });
        break;
      case 'compaction_end':
        events.push({
          kind: 'compact_boundary',
          trigger: event.reason === 'manual' ? 'manual' : 'auto',
          phase: 'end',
          ...(event.result ? { preTokens: event.result.tokensBefore } : {}),
          ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
        });
        break;
    }

    return events.map((e) => canonicalEventSchema.parse(e));
  }

  mapComplete(messages: unknown[] = [], contextTokens?: number): CanonicalEvent[] {
    if (this.state.terminalEmitted) return [];
    this.state.terminalEmitted = true;
    const pendingMessages = this.state.pendingMessages ?? [];
    const finalMessages = pendingMessages.length > 0 ? pendingMessages : messages;
    return [
      ...this.subagents.finish('interrupted').map((event) => canonicalEventSchema.parse(event)),
      canonicalEventSchema.parse(this.queryResult(finalMessages, false, undefined, contextTokens)),
    ];
  }

  mapError(error: unknown, interrupted = false): CanonicalEvent[] {
    if (this.state.terminalEmitted) return [];
    this.state.terminalEmitted = true;
    return [
      ...this.subagents
        .finish(interrupted ? 'interrupted' : 'failed', interrupted ? 'Interrupted' : errorMessage(error))
        .map((event) => canonicalEventSchema.parse(event)),
      canonicalEventSchema.parse(
        this.queryResult([], true, interrupted ? 'Interrupted' : errorMessage(error)),
      ),
    ];
  }

  private mapAssistantUpdate(
    event: AgentSessionEvent extends infer E
      ? E extends { type: 'message_update'; assistantMessageEvent: infer U }
        ? U
        : never
      : never,
    events: CanonicalEvent[],
  ): void {
    if (event.type === 'text_delta') {
      events.push({ kind: 'text_delta', text: event.delta });
    } else if (event.type === 'thinking_delta') {
      events.push({ kind: 'thinking_delta', text: event.delta });
    } else if (event.type === 'toolcall_delta') {
      this.mapLiveWrite(event.contentIndex, event.partial, false, events);
    } else if (event.type === 'toolcall_end') {
      this.mapLiveWrite(event.contentIndex, event.partial, true, events);
    }
  }

  /**
   * pi's write tool never reports execution progress — its `execute()` ignores the update sink —
   * so the only live view of a file being written is the model's still-streaming call arguments.
   * pi already repairs and decodes those on every delta, and sending a tail window keeps the wire
   * cost linear without an accumulator that the salvage parser could invalidate by rewriting.
   */
  private mapLiveWrite(contentIndex: number, partial: unknown, finalize: boolean, events: CanonicalEvent[]): void {
    const writing = liveWriteContent(partial, contentIndex);
    if (!writing) return;
    if (!finalize) {
      const last = this.state.liveWriteAt.get(contentIndex) ?? 0;
      if (Date.now() - last < LIVE_WRITE_MIN_INTERVAL_MS) return;
      this.state.liveWriteAt.set(contentIndex, Date.now());
    }
    events.push({
      kind: 'tool_progress',
      toolName: writing.name,
      elapsed: 0,
      ...(writing.path ? { path: writing.path } : {}),
      contentTail: writing.content.slice(-LIVE_WRITE_TAIL_CHARS),
      contentChars: writing.content.length,
      contentLines: countLines(writing.content),
    });
  }

  private queryResult(
    messages: unknown[],
    isError: boolean,
    error?: string,
    contextTokens?: number,
  ): CanonicalEvent {
    const usage = usageFromMessages(messages);
    const latestError = error ?? latestAssistantError(messages);
    return {
      kind: 'query_result',
      sessionId: this.state.sessionId ?? '',
      isError: isError || Boolean(latestError),
      usage: {
        ...usage,
        ...(contextTokens !== undefined ? { contextTokens } : {}),
      },
      ...(latestError ? { error: latestError } : {}),
    };
  }
}

function liveWriteContent(
  partial: unknown,
  contentIndex: number,
): { name: string; path?: string; content: string } | undefined {
  const blocks = (partial as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(blocks)) return undefined;
  const block = blocks[contentIndex] as Record<string, unknown> | undefined;
  if (!block || block.type !== 'toolCall') return undefined;
  // The provider may not have named the call yet, and nothing can be gated on an unknown tool.
  if (!LIVE_WRITE_TOOLS.has(String(block.name ?? ''))) return undefined;
  const args = block.arguments as Record<string, unknown> | undefined;
  const content = typeof args?.content === 'string' ? args.content : '';
  if (!content || typeof block.id !== 'string' || !block.id) return undefined;
  const path = typeof args?.path === 'string' && args.path ? args.path : undefined;
  return { name: String(block.name), path, content };
}

function countLines(text: string): number {
  let lines = 1;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lines++;
  return lines;
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { input };
}

function toolResultContent(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    const text = messageContentText(content);
    if (text) return text;
  }
  return stringifyUnknown(result);
}

function usageFromMessages(messages: unknown[]): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
} {
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let costUsd = 0;

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const typed = message as {
      role?: unknown;
      usage?: {
        input?: unknown;
        output?: unknown;
        cacheRead?: unknown;
        cacheWrite?: unknown;
        cost?: { total?: unknown };
      };
    };
    if (typed.role !== 'assistant' || !typed.usage) continue;
    uncachedInputTokens += numberValue(typed.usage.input);
    outputTokens += numberValue(typed.usage.output);
    cachedInputTokens += numberValue(typed.usage.cacheRead);
    cacheWriteInputTokens += numberValue(typed.usage.cacheWrite);
    costUsd += numberValue(typed.usage.cost?.total);
  }

  console.log(
    `[pi-adapter] usageFromMessages: uncached=${uncachedInputTokens + cacheWriteInputTokens} output=${outputTokens} cached=${cachedInputTokens} cost=${costUsd.toFixed(4)}$`,
  );

  return {
    inputTokens: uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens,
    outputTokens,
    ...(cachedInputTokens ? { cachedInputTokens } : {}),
    ...(costUsd ? { costUsd } : {}),
  };
}

function latestAssistantError(messages: unknown[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== 'object') continue;
    const typed = message as { role?: unknown; errorMessage?: unknown; stopReason?: unknown };
    if (typed.role !== 'assistant') continue;
    if (typeof typed.errorMessage === 'string' && typed.errorMessage.trim()) {
      return typed.errorMessage;
    }
    if (typed.stopReason === 'error') return 'Pi provider returned an error';
    if (typed.stopReason === 'aborted') return 'Interrupted';
  }
  return undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (!block || typeof block !== 'object') return '';
      const typed = block as { type?: unknown; text?: unknown; data?: unknown };
      if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
      if (typed.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
