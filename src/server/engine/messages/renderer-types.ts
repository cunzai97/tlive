/**
 * Shared types for message rendering — extracted to avoid circular dependency.
 */

import type { CanonicalEvent, TodoStatus } from '../../../shared/canonical/schema.js';
import type { LiveWriteProgress } from '../../../shared/formatting/message-types.js';

/** Tool call log entry for detailed display */
export type PresentationToolStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface ToolLogEntry {
  name: string;
  input: string;
  toolId?: string;
  inputData?: Record<string, unknown>;
  status?: PresentationToolStatus;
  result?: string;
  isError?: boolean;
}

/** Ordered timeline entry — interleaves text output with tool calls */
export interface TimelineEntry {
  kind: 'thinking' | 'text' | 'tool';
  blockId?: string;
  /** For thinking/text entries */
  text?: string;
  /** For tool entries */
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  toolId?: string;
  inputData?: Record<string, unknown>;
  status?: PresentationToolStatus;
  detailId?: string;
  /** Exact count supplied by the active provider tokenizer, when available. */
  tokenCount?: number;
  isError?: boolean;
}

/** Current tool execution state for progress display */
export interface CurrentTool {
  name: string;
  toolId?: string;
  input: string; // Brief description of what's being done
  elapsed: number; // Seconds
}

/**
 * A forwarded `tool_progress` event. Producers that only report elapsed time omit the write
 * fields; a producer streaming a file writer's arguments supplies all of them together.
 */
export type ToolProgressSignal = Omit<Extract<CanonicalEvent, { kind: 'tool_progress' }>, 'kind'>;

/** Renderer state snapshot for progress display */
export interface MessageRendererState {
  turnId?: string;
  /** Independent physical segment, while turn/block identity remains stable. */
  deliveryId?: string;
  presentationBoundary?: boolean;
  phase: 'starting' | 'executing' | 'waiting_permission' | 'completed' | 'failed';
  renderedText: string;
  responseText: string;
  elapsedSeconds: number;
  totalTools: number;
  toolSummary: string;
  footerLine?: string;
  errorMessage?: string;
  permissionRequests: number;
  currentTool: CurrentTool | null;
  liveWrite?: LiveWriteProgress | null;
  todoItems: Array<{ content: string; status: TodoStatus }>;
  thinkingText: string;
  toolLogs: ToolLogEntry[];
  /** Ordered interleaved timeline of text + tool calls */
  timeline: TimelineEntry[];
  permission?: {
    toolName: string;
    input: string;
    queueLength: number;
  };
  /** True after bubble split — continuation of previous task */
  isContinuation?: boolean;
  /** Session info from SDK init event */
  sessionInfo?: {
    tools?: string[];
    mcpServers?: Array<{ name: string; status: string }>;
    skills?: string[];
  };
  /** AI-generated summary of preceding tool calls */
  toolUseSummaryText?: string;
  /** Formatted usage/cost summary shown in run info. */
  usageSummary?: string;
  /** Context window usage (tokens, window size, percentage) */
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  /** API retry state */
  apiRetry?: {
    attempt: number;
    maxRetries: number;
    retryDelayMs: number;
    error?: string;
  };
  /** Context compaction indicator */
  compacting?: boolean;
}
