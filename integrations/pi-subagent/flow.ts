/** Pure JSON-event collector. No SDK, process, clock, or filesystem dependencies. */
export type SubagentFlowStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

export interface SubagentFlowEntry {
  kind: 'thinking' | 'text' | 'tool';
  blockId: string;
  text?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: string;
  inputData?: Record<string, unknown>;
  toolResult?: string;
  status?: Exclude<SubagentFlowStatus, 'queued'>;
}

export interface SubagentFlow {
  version: 1;
  status: SubagentFlowStatus;
  timeline: SubagentFlowEntry[];
}

export interface SubagentFlowState {
  flow: SubagentFlow;
  messageSequence: number;
  activeMessage?: string;
  messageKeys: Record<string, string>;
  blocks: Record<string, number>;
}

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function createSubagentFlow(status: SubagentFlowStatus = 'running'): SubagentFlowState {
  return {
    flow: { version: 1, status, timeline: [] },
    messageSequence: 0,
    messageKeys: {},
    blocks: {},
  };
}

/** Finalize unfinished tools without inventing results or changing settled failures. */
export function finishSubagentFlow(
  state: SubagentFlowState,
  status: SubagentFlowStatus,
): SubagentFlowState {
  return {
    ...state,
    flow: {
      ...state.flow,
      status,
      timeline: state.flow.timeline.map((entry) =>
        entry.kind === 'tool' && entry.status === 'running' && status !== 'running' && status !== 'queued'
          ? { ...entry, status: status === 'failed' ? 'failed' : 'interrupted' }
          : entry,
      ),
    },
  };
}

function resultText(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  const content = record(result)?.content;
  if (Array.isArray(content)) {
    return content.map((part: unknown) => {
      const item = record(part);
      return item?.type === 'text' && typeof item.text === 'string'
        ? item.text
        : JSON.stringify(part);
    }).join('\n');
  }
  return result === undefined ? undefined : JSON.stringify(result);
}

/**
 * Upsert cumulative partial/final messages; append deltas only on snapshot-free wire events.
 * First observation determines order, while message/content indexes and call IDs determine identity.
 * Input and prior states are never mutated, including nested tool arguments.
 */
export function collectSubagentEvent(state: SubagentFlowState, value: unknown): SubagentFlowState {
  const event = record(value);
  if (!event || typeof event.type !== 'string') return state;
  const supported = [
    'message_start', 'message_update', 'message_end', 'tool_result_end',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  ];
  if (!supported.includes(event.type)) return state;
  const next: SubagentFlowState = {
    ...state,
    flow: { ...state.flow, timeline: [...state.flow.timeline] },
    messageKeys: { ...state.messageKeys },
    blocks: { ...state.blocks },
  };

  const upsert = (key: string, patch: Omit<SubagentFlowEntry, 'blockId'>) => {
    const index = next.blocks[key];
    if (index === undefined) {
      next.blocks[key] = next.flow.timeline.length;
      next.flow.timeline.push({ ...patch, blockId: `block-${next.flow.timeline.length + 1}` });
    } else {
      const previous = next.flow.timeline[index];
      // Late results can fill a failed/interrupted tool, but cannot resurrect it.
      if (previous.status === 'failed' || previous.status === 'interrupted') {
        patch.status = previous.status;
      } else if (previous.status === 'completed' && patch.status === 'running') {
        patch.status = previous.status;
      }
      next.flow.timeline[index] = { ...previous, ...patch };
    }
  };
  const tool = (id: unknown, name: unknown, args?: unknown, result?: unknown, status = 'running') => {
    if (typeof id !== 'string' || !id) return;
    const patch: Omit<SubagentFlowEntry, 'blockId'> = {
      kind: 'tool', toolId: id, status: status as SubagentFlowEntry['status'],
    };
    if (typeof name === 'string') patch.toolName = name;
    const input = record(args);
    if (input) {
      patch.inputData = structuredClone(input);
      patch.toolInput = JSON.stringify(input);
    }
    const text = resultText(result);
    if (text !== undefined) patch.toolResult = text;
    upsert(`tool:${id}`, patch);
  };

  const message = record(event.message);
  if (message?.role === 'toolResult') {
    if (event.type === 'message_end' || event.type === 'tool_result_end') {
      tool(message.toolCallId, message.toolName, undefined, message,
        message.isError ? 'failed' : 'completed');
    }
    return next;
  }
  if (event.type.startsWith('tool_execution_')) {
    tool(event.toolCallId, event.toolName, event.args,
      event.type === 'tool_execution_update' ? event.partialResult : event.result,
      event.type === 'tool_execution_end' ? (event.isError ? 'failed' : 'completed') : 'running');
    return next;
  }

  const update = record(event.assistantMessageEvent);
  const snapshot = record(update?.partial) ?? message ?? record(update?.message) ?? record(update?.error);
  if (snapshot && snapshot.role !== 'assistant') return state;
  if (!snapshot && event.type !== 'message_update') return state;

  const identity = snapshot?.id ?? snapshot?.timestamp;
  const messageKey = identity === undefined ? undefined : String(identity);
  if (event.type === 'message_start' || !next.activeMessage) {
    next.activeMessage = event.type !== 'message_start' && messageKey !== undefined
      ? next.messageKeys[messageKey]
      : undefined;
    if (!next.activeMessage) next.activeMessage = `message-${++next.messageSequence}`;
  }
  const prefix = next.activeMessage;
  if (messageKey !== undefined) next.messageKeys[messageKey] = prefix;

  const content = Array.isArray(snapshot?.content) ? snapshot.content : [];
  for (let index = 0; index < content.length; index++) {
    const part = record(content[index]);
    if (part?.type === 'text' && typeof part.text === 'string') {
      upsert(`${prefix}:${index}:text`, { kind: 'text', text: part.text });
    } else if (part?.type === 'thinking' && typeof part.thinking === 'string') {
      upsert(`${prefix}:${index}:thinking`, { kind: 'thinking', text: part.thinking });
    } else if (part?.type === 'toolCall') {
      tool(part.id, part.name, part.arguments);
    }
  }

  if (update && typeof update.type === 'string') {
    const kind = update.type.startsWith('thinking_') ? 'thinking' : 'text';
    const index = typeof update.contentIndex === 'number' ? update.contentIndex : 0;
    const key = `${prefix}:${index}:${kind}`;
    const part = record(content[index]);
    const cumulative = part?.type === kind && typeof part[kind === 'text' ? 'text' : 'thinking'] === 'string';
    if (/^(text|thinking)_(start|delta|end)$/.test(update.type) && !cumulative) {
      const previous = next.flow.timeline[next.blocks[key]]?.text ?? '';
      const text = typeof update.content === 'string' ? update.content
        : previous + (typeof update.delta === 'string' ? update.delta : '');
      upsert(key, { kind, text });
    }
    if (update.type === 'toolcall_start') tool(update.id, update.toolName);
    if (update.type === 'toolcall_end') {
      const call = record(update.toolCall);
      if (call) tool(call.id, call.name, call.arguments);
    }
  }
  if (event.type === 'message_end') next.activeMessage = undefined;
  return next;
}
