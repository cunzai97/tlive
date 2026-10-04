/**
 * Message renderer — collects state and coordinates flush for progress display.
 * Rendering logic delegated to ProgressContentBuilder.
 */

import { randomUUID } from 'node:crypto';
import type { StepUsage } from '../../../shared/canonical/schema.js';
import { redactSensitiveContent } from '../../../shared/utils/content-filter.js';
import { truncate } from '../../../shared/core/string.js';
import { parsePlanLike, parsePlanFromToolResult, type PlanTodo } from '../../../shared/canonical/plan-signature.js';
import type { VerboseLevel } from '../state/session-state.js';
import type { Button } from '../../../shared/ui/types.js';
import type { AgentRuntimeInfo } from '../../../shared/providers/base.js';
import type { LiveWriteProgress } from '../../../shared/formatting/message-types.js';
import { ProgressContentBuilder } from './progress-builder.js';
import type { RenderInput } from './progress-builder.js';
import type {
  ToolLogEntry,
  TimelineEntry,
  CurrentTool,
  ToolProgressSignal,
  MessageRendererState,
} from './renderer-types.js';
import { PermissionTracker } from './permission-tracker.js';
import { ProgressWatcher } from './progress-watcher.js';
import { formatToolInput } from './tool-formatter.js';
import { AdaptiveFlushController, type AdaptiveFlushOptions } from './adaptive-flush.js';
// Re-export shared types for backwards compatibility
export type { ToolLogEntry, TimelineEntry, MessageRendererState } from './renderer-types.js';

export interface MessageRendererOptions {
  shouldSplitState?: (state: MessageRendererState) => boolean;
  /** The channel owns lossless card pagination; retain the full turn state. */
  channelOwnsPagination?: boolean;
  platformLimit: number;
  throttleMs?: number;
  adaptiveFlush?: boolean | AdaptiveFlushOptions;
  cwd?: string;
  model?: string;
  sessionId?: string;
  /** Plan carried over from earlier turns of the same session. */
  initialTodos?: PlanTodo[];
  onTodosChanged?: (items: PlanTodo[]) => void;
  verboseLevel?: VerboseLevel;
  flushCallback: (
    content: string,
    isEdit: boolean,
    buttons?: Button[],
    state?: MessageRendererState,
  ) => Promise<string | undefined>;
  onPermissionTimeout?: (toolName: string, input: string, buttons: Button[]) => void;
  onPermissionReaction?: () => void;
  onPermissionReactionClear?: () => void;
  onProgressStalled?: () => void;
  onProgressResumed?: () => void;
  onFlushError?: (error: Error, context: { phase: string; contentPreview: string }) => void;
}

/** Tools silently ignored. TodoWrite is deliberately absent: the plan row is worth one line. */
const HIDDEN_TOOLS = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'TaskOutput',
  'ToolSearch',
  'TodoRead',
]);

/** Split thresholds */
const SPLIT_TOOL_THRESHOLD = 12;
const SPLIT_TIMELINE_THRESHOLD = 18;
/**
 * 单气泡内容大小阈值（字节数）。
 * 仅在没有 shouldSplitState adapter hook 时作为 fallback。
 * 有 adapter hook 时由 shouldSplitState(state) 检查实际卡片 JSON 大小。
 */
const SPLIT_CONTENT_BYTES_THRESHOLD = 10 * 1024; // 10KB fallback 阈值
const SPLIT_CONTENT_EXPANSION_FACTOR = 2.0; // JSON 膨胀系数
const SPLIT_ESTIMATED_CARD_LIMIT = 20 * 1024; // 预估卡片上限 20KB
/** Upper bound on how long turn finalization may wait out a card-edit penalty window. */
const MAX_TERMINAL_FLUSH_WAIT_MS = 15_000;

export class MessageRenderer {
  // State collection
  private toolCounts = new Map<string, number>();
  private totalTools = 0;
  private bubbleToolCount = 0;
  private bubbleTimelineCount = 0;
  private responseText = '';
  private completed = false;
  private footerLine?: string;
  private errorMessage?: string;
  private currentTool: CurrentTool | null = null;
  private liveWrite: LiveWriteProgress | null = null;
  private todoItems: PlanTodo[] = [];
  private readonly onTodosChanged?: (items: PlanTodo[]) => void;
  private nextPlanRevision = 0;
  private acceptedPlanRevision = 0;
  private readonly toolPlanRevisions = new Map<string, number>();
  private thinkingText = '';
  private toolLogs: ToolLogEntry[] = [];
  private toolIdToLogIndex = new Map<string, number>();
  private timeline: TimelineEntry[] = [];
  private toolIdToTimelineIndex = new Map<string, number>();
  private pendingToolResults = new Map<string, { content: string; isError: boolean }>();
  private readonly turnId = randomUUID();
  private nextBlockIndex = 0;
  private segmentIndex = 0;
  private readonly sealedToolIds = new Set<string>();
  private awaitingContinuation = false;
  private flushJobs = new Set<Promise<void>>();
  private lastFlushError?: Error;
  private readonly channelOwnsPagination: boolean;
  private lastTimelineIsText = false;
  private splitPending = false;
  private sessionInfo?: {
    tools?: string[];
    mcpServers?: Array<{ name: string; status: string }>;
    skills?: string[];
  };
  private toolUseSummaryText?: string;
  private apiRetryState?: {
    attempt: number;
    maxRetries: number;
    retryDelayMs: number;
    error?: string;
  };
  private compacting = false;

  // Flush management
  private _messageId?: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private taskSummary = '';
  private elapsedSeconds = 0;
  private platformLimit: number;
  private throttleMs: number;
  private flushCallback: MessageRendererOptions['flushCallback'];
  private flushing = false;
  private pendingFlush = false;
  private cwd?: string;
  private model?: string;
  private engineName?: string;
  private reasoningEffort?: string;
  private sessionId?: string;
  private usageSummary?: string;
  private contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  private verboseLevel: VerboseLevel;
  private onFlushError?: MessageRendererOptions['onFlushError'];
  private shouldSplitState?: MessageRendererOptions['shouldSplitState'];
  private lastRenderedContent = '';
  private forceFlush = false;
  private lastFlushTime = 0;
  private elapsedUpdateInterval = 3000;
  private adaptiveFlush?: AdaptiveFlushController;

  // Extracted components
  private contentBuilder = new ProgressContentBuilder();
  private permissionTracker?: PermissionTracker;
  private progressWatcher?: ProgressWatcher;

  /** Local nonce for independently scoped child progress streams. */
  get presentationTurnId(): string { return this.turnId; }

  get messageId(): string | undefined {
    return this._messageId;
  }

  constructor(options: MessageRendererOptions) {
    this.shouldSplitState = options.shouldSplitState;
    this.channelOwnsPagination = options.channelOwnsPagination ?? false;
    this.platformLimit = options.platformLimit;
    this.throttleMs = options.throttleMs ?? 300;
    this.flushCallback = options.flushCallback;
    this.onFlushError = options.onFlushError;
    this.cwd = options.cwd;
    this.model = options.model;
    this.sessionId = options.sessionId;
    this.onTodosChanged = options.onTodosChanged;
    this.todoItems = structuredClone(options.initialTodos ?? []);
    this.verboseLevel = options.verboseLevel ?? 1;
    if (options.adaptiveFlush) {
      const adaptiveOptions = options.adaptiveFlush === true ? {} : options.adaptiveFlush;
      this.adaptiveFlush = new AdaptiveFlushController(adaptiveOptions);
    }

    // Always initialize permission tracker for queue management
    this.permissionTracker = new PermissionTracker({
      onTimeout: options.onPermissionTimeout ?? (() => {}),
      onReaction: options.onPermissionReaction ?? (() => {}),
      onReactionClear: options.onPermissionReactionClear ?? (() => {}),
    });

    // Initialize progress watcher if callbacks provided
    if (options.onProgressStalled) {
      this.progressWatcher = new ProgressWatcher({
        onStalled: options.onProgressStalled,
        onResumed: options.onProgressResumed ?? (() => {}),
      });
    }
  }

  onThinkingDelta(text: string): void {
    if (!text || this.completed || this.errorMessage) return;
    this.awaitingContinuation = false;
    this.thinkingText += text;
    const last = this.timeline[this.timeline.length - 1];
    if (last?.kind === 'thinking') {
      last.text = (last.text || '') + text;
    } else {
      this.bubbleTimelineCount++;
      this.timeline.push({ kind: 'thinking', text, blockId: this.createBlockId() });
    }
    this.lastTimelineIsText = false;
    this.updateSplitPending();
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onToolStart(
    name: string,
    input?: Record<string, unknown>,
    toolUseId?: string,
    usage?: StepUsage,
  ): void {
    if (this.completed || this.errorMessage) return;
    // Shape decides before any name-based hiding: the same payload arrives as `todo` on pi and
    // as `TodoWrite` on Claude, and both have to feed the board.
    const plan = parsePlanLike(input);
    if (plan) {
      this.todoItems = plan;
      this.onTodosChanged?.(plan);
    }
    if (HIDDEN_TOOLS.has(name)) return;
    if (toolUseId && (this.toolIdToTimelineIndex.has(toolUseId) || this.sealedToolIds.has(toolUseId))) return;
    this.awaitingContinuation = false;
    this.onApiRetryCleared();
    const current = this.toolCounts.get(name) ?? 0;
    this.toolCounts.set(name, current + 1);
    this.totalTools++;
    this.bubbleToolCount++;

    const toolId = toolUseId || `${this.turnId}_${this.totalTools}`;
    const inputData = input ? clonePresentationInput(input) : undefined;
    const formattedInput = redactSensitiveContent(formatToolInput(name, inputData));
    this.currentTool = { name, input: formattedInput, elapsed: 0, toolId };
    // The authoritative block has arrived; the streamed preview would only duplicate it.
    this.liveWrite = null;

    const logIndex = this.toolLogs.length;
    this.toolLogs.push({ name, input: formattedInput, toolId, inputData, status: 'running' });
    this.toolIdToLogIndex.set(toolId, logIndex);

    const tlIdx = this.timeline.length;
    this.bubbleTimelineCount++;
    this.timeline.push({
      kind: 'tool',
      toolName: name,
      toolInput: formattedInput,
      blockId: this.createBlockId(),
      toolId,
      inputData,
      status: 'running',
      ...(usage ? { usage } : {}),
    });
    this.toolIdToTimelineIndex.set(toolId, tlIdx);
    this.lastTimelineIsText = false;
    const earlyResult = this.pendingToolResults.get(toolId);
    if (earlyResult) {
      this.pendingToolResults.delete(toolId);
      this.onToolResult(toolId, earlyResult.content, earlyResult.isError);
    }

    if (!this.elapsedTimer) {
      this.elapsedTimer = setInterval(() => {
        this.elapsedSeconds++;
        if (this.currentTool) this.currentTool.elapsed++;
        if (this.elapsedSeconds % 3 === 0) this.scheduleFlush();
      }, 1000);
    }

    this.progressWatcher?.resume();
    this.updateSplitPending();
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onToolProgress(data: ToolProgressSignal): void {
    if (HIDDEN_TOOLS.has(data.toolName)) return;
    if (typeof data.contentTail === 'string' && typeof data.contentChars === 'number' && typeof data.contentLines === 'number') {
      if (this.completed || this.errorMessage) return;
      this.liveWrite = {
        name: data.toolName,
        contentTail: data.contentTail,
        ...(data.path ? { path: data.path } : {}),
        contentChars: data.contentChars,
        contentLines: data.contentLines,
      };
      this.forceFlush = true;
      this.scheduleFlush();
      return;
    }
    if (this.currentTool && this.currentTool.name === data.toolName) {
      this.currentTool.elapsed = Math.floor(data.elapsed / 1000);
    }
  }

  onTodoUpdate(todos: PlanTodo[]): void {
    if (this.completed || this.errorMessage) return;
    this.acceptPlan(todos, ++this.nextPlanRevision);
    this.updateSplitPending();
    this.forceFlush = true;
    this.scheduleFlush();
  }

  private acceptPlan(todos: PlanTodo[], revision: number): void {
    if (revision < this.acceptedPlanRevision) return;
    this.acceptedPlanRevision = revision;
    this.todoItems = todos.map(item => ({ ...item, content: redactSensitiveContent(item.content) }));
    this.onTodosChanged?.(structuredClone(this.todoItems));
  }

  private acceptToolPlan(toolUseId: string, entry: TimelineEntry): void {
    if (this.completed || this.errorMessage || entry.status !== 'completed') return;
    const inputPlan = parsePlanLike(entry.inputData);
    const resultPlan = parsePlanFromToolResult(entry.toolResult, entry.toolName ?? '', inputPlan !== undefined);
    const plan = resultPlan ?? inputPlan;
    const revision = this.toolPlanRevisions.get(toolUseId);
    if (plan !== undefined && revision !== undefined) this.acceptPlan(plan, revision);
  }

  onSessionInfo(info: {
    tools?: string[];
    mcpServers?: Array<{ name: string; status: string }>;
    skills?: string[];
  }): void {
    this.sessionInfo = info;
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onToolUseSummary(summary: string): void {
    this.toolUseSummaryText = summary;
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onApiRetry(data: {
    attempt: number;
    maxRetries: number;
    retryDelayMs: number;
    error?: string;
  }): void {
    this.apiRetryState = data;
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onApiRetryCleared(): void {
    this.apiRetryState = undefined;
  }

  onCompacting(active: boolean): void {
    this.compacting = active;
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onContextUsage(data: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  }): void {
    this.contextUsage = data;
  }

  onToolComplete(toolUseId: string): void {
    if (this.sealedToolIds.has(toolUseId)) return;
    const tlIdx = this.toolIdToTimelineIndex.get(toolUseId);
    const logIdx = this.toolIdToLogIndex.get(toolUseId);
    const entry = tlIdx === undefined ? undefined : this.timeline[tlIdx];
    const log = logIdx === undefined ? undefined : this.toolLogs[logIdx];
    if (entry?.status === 'running') entry.status = 'completed';
    if (log?.status === 'running') log.status = 'completed';
    if (entry) this.acceptToolPlan(toolUseId, entry);
    if (this.currentTool?.toolId === toolUseId) this.currentTool = null;
    if (!this.completed && !this.errorMessage) {
      this.forceFlush = true;
      this.scheduleFlush();
    }
  }

  onToolResult(toolUseId: string, content: string, isError: boolean): void {
    if (this.sealedToolIds.has(toolUseId)) return;
    const tlIdx = this.toolIdToTimelineIndex.get(toolUseId);
    if (tlIdx === undefined) {
      if (this.completed || this.errorMessage) return;
      if (this.pendingToolResults.size >= 256) {
        const first = this.pendingToolResults.keys().next().value;
        if (first) this.pendingToolResults.delete(first);
      }
      this.pendingToolResults.set(toolUseId, { content, isError });
      return;
    }
    const entry = this.timeline[tlIdx];
    if (entry.toolResult !== undefined) return;
    const result = redactSensitiveContent(content);
    const terminated = entry.status === 'interrupted' || entry.status === 'failed';
    entry.toolResult = result;
    if (!terminated) {
      entry.isError = isError;
      entry.status = isError ? 'failed' : 'completed';
    }
    const logIndex = this.toolIdToLogIndex.get(toolUseId);
    if (logIndex !== undefined) {
      this.toolLogs[logIndex].result = result;
      this.toolLogs[logIndex].isError = entry.isError;
      this.toolLogs[logIndex].status = entry.status;
    }
    if (this.currentTool?.toolId === toolUseId) this.currentTool = null;
    this.acceptToolPlan(toolUseId, entry);
    if (this.completed || this.errorMessage) return;
    this.updateSplitPending();
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onPermissionNeeded(toolName: string, input: string, permId: string, buttons: Button[]): void {
    this.progressWatcher?.clear();
    this.permissionTracker?.push(toolName, input, permId, buttons);
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onPermissionResolved(permId?: string): void {
    this.permissionTracker?.resolve(permId);
    if (!this.permissionTracker || this.permissionTracker.getQueueLength() === 0) {
      this.progressWatcher?.start();
    }
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onTextDelta(text: string): void {
    if (!text || this.completed || this.errorMessage) return;
    this.awaitingContinuation = false;
    this.responseText += text;
    // Any streamed content means the retry landed, so drop the indicator.
    this.onApiRetryCleared();
    this.adaptiveFlush?.recordTextDelta(text.length);
    if (this.lastTimelineIsText) {
      const last = this.timeline[this.timeline.length - 1];
      last.text = (last.text || '') + text;
    } else {
      this.timeline.push({ kind: 'text', text, blockId: this.createBlockId() });
      this.lastTimelineIsText = true;
    }
    if (!this.taskSummary) {
      const trimmed = this.responseText.trim();
      if (trimmed.length > 20) this.taskSummary = truncate(trimmed, 100);
    }
    this.progressWatcher?.resume();
    this.updateSplitPending();
    this.scheduleFlush();
  }

  setModel(model: string | undefined): void {
    if (this.model === model) return;
    this.model = model;
  }

  setEngineName(engineName: string | undefined): void {
    if (this.engineName === engineName) return;
    this.engineName = engineName;
  }

  setUsageSummary(summary: string | undefined): void {
    if (this.usageSummary === summary) return;
    this.usageSummary = summary;
  }

  setRuntimeInfo(info: AgentRuntimeInfo | undefined): void {
    this.engineName = info?.displayName;
    this.model = info?.model;
    this.reasoningEffort = info?.reasoningEffort;
  }

  onComplete(): Promise<void> {
    if (this.awaitingContinuation && !this.errorMessage) {
      this.completed = true; this.stopTimers(); return Promise.resolve();
    }
    if (!this.errorMessage) this.completed = true;
    this.settlePendingTools(this.errorMessage === 'Interrupted' ? 'interrupted' : 'failed');
    this.forceFlush = true;
    this.footerLine = this.contentBuilder.buildFooter(this.getRenderInput());
    this.stopTimers();
    const content = this.contentBuilder.render(this.getRenderInput());
    return this.doFlush(content);
  }

  onError(error: string): Promise<void> {
    this.errorMessage = error;
    this.settlePendingTools(error === 'Interrupted' ? 'interrupted' : 'failed');
    this.forceFlush = true;
    this.stopTimers();
    const content = this.contentBuilder.render(this.getRenderInput());
    return this.doFlush(content);
  }

  getResponseText(): string {
    return this.responseText;
  }

  getDebugSnapshot(): { thinkingEntries: number; textEntries: number; toolEntries: number } {
    let thinkingEntries = 0,
      textEntries = 0,
      toolEntries = 0;
    for (const entry of this.timeline) {
      if (entry.kind === 'thinking') thinkingEntries++;
      else if (entry.kind === 'text') textEntries++;
      else if (entry.kind === 'tool') toolEntries++;
    }
    return { thinkingEntries, textEntries, toolEntries };
  }

  dispose(): void {
    this.stopTimers();
    this.permissionTracker?.dispose();
    this.progressWatcher?.dispose();
  }

  // --- Internal ---

  private createBlockId(): string {
    // Keep IDs unique across legacy bubble resets within the same turn.
    return `${this.turnId}_${this.nextBlockIndex++}`;
  }

  private getRenderInput(): RenderInput {
    const permissionQueue = this.permissionTracker?.getQueue() ?? [];
    return {
      phase:
        permissionQueue.length > 0
          ? 'waiting_permission'
          : this.completed
            ? 'completed'
            : this.errorMessage
              ? 'failed'
              : this.totalTools === 0 && !this.responseText && !this.thinkingText && this.todoItems.length === 0
                ? 'starting'
                : 'executing',
      turnId: this.turnId,
      deliveryId: this.segmentIndex ? `${this.turnId}:segment:${this.segmentIndex}` : this.turnId,
      responseText: this.responseText,
      thinkingText: this.thinkingText,
      elapsedSeconds: this.elapsedSeconds,
      totalTools: this.totalTools,
      toolCounts: this.toolCounts,
      bubbleToolCount: this.bubbleToolCount,
      currentTool: this.currentTool,
      liveWrite: this.liveWrite,
      todoItems: this.todoItems,
      toolLogs: this.toolLogs,
      timeline: this.timeline,
      permissionQueue,
      permissionRequests: this.permissionTracker?.getRequestCount() ?? 0,
      errorMessage: this.errorMessage,
      completed: this.completed,
      footerLine: this.footerLine,
      model: this.model,
      engineName: this.engineName,
      reasoningEffort: this.reasoningEffort,
      cwd: this.cwd,
      sessionId: this.sessionId,
      usageSummary: this.usageSummary,
      contextUsage: this.contextUsage,
      platformLimit: this.channelOwnsPagination ? Number.POSITIVE_INFINITY : this.platformLimit,
      sessionInfo: this.sessionInfo,
      toolUseSummaryText: this.toolUseSummaryText,
      apiRetry: this.apiRetryState,
      compacting: this.compacting,
    };
  }

  private scheduleFlush(): void {
    if (this.timer || this.awaitingContinuation) return;
    const renderInput = this.getRenderInput();
    const content = this.contentBuilder.render(renderInput);
    const delay = this.adaptiveFlush
      ? this.adaptiveFlush.nextDelay({
          fallbackMs: this.throttleMs,
          content,
          phase: renderInput.phase,
          hasMessage: !!this._messageId,
          lastFlushAt: this.lastFlushTime,
        })
      : this._messageId
        ? this.throttleMs
        : 0;
    this.timer = setTimeout(() => {
      this.timer = null;
      const content = this.contentBuilder.render(this.getRenderInput());
      this.doFlush(content);
    }, delay);
  }

  private stopTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    this.permissionTracker?.dispose();
    this.progressWatcher?.dispose();
  }

  private shouldSkipFlush(state: MessageRendererState): boolean {
    if (this.verboseLevel !== 0) return false;
    return state.phase === 'starting' || state.phase === 'executing';
  }

  private doFlush(content: string, frozen?: MessageRendererState): Promise<void> {
    const job = this.performFlush(content, frozen);
    this.flushJobs.add(job);
    void job.finally(() => this.flushJobs.delete(job)).catch(() => {});
    return job;
  }

  /** Drain old sends before changing the physical segment/message identity. */
  async flushProgress(): Promise<void> {
    if (this.awaitingContinuation) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.flushJobs.size) await Promise.all([...this.flushJobs]);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.forceFlush = true;
    await this.doFlush(this.contentBuilder.render(this.getRenderInput()));
    while (this.flushJobs.size) await Promise.all([...this.flushJobs]);
    if (this.lastFlushError) throw this.lastFlushError;
  }

  /** Explicit Feishu delegation boundary, not a whole-turn completion. */
  async sealForContinuation(): Promise<void> {
    if (this.awaitingContinuation || this.completed || this.errorMessage) return;
    if (!this.timeline.length && !this.responseText && !this.thinkingText) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.flushJobs.size) await Promise.all([...this.flushJobs]);
    if (!this._messageId) await this.flushProgress();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const input = { ...this.getRenderInput(), completed: true, phase: 'completed' as const,
      presentationBoundary: true, liveWrite: null, footerLine: undefined };
    const content = this.contentBuilder.render(input);
    const state = this.contentBuilder.getStateSnapshot(input, content);
    this.forceFlush = true;
    await this.doFlush(content, state);
    while (this.flushJobs.size) await Promise.all([...this.flushJobs]);
    if (this.lastFlushError) throw this.lastFlushError;
    if (!this._messageId) throw new Error('Main card boundary has no confirmed message ID');
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const id of this.toolIdToTimelineIndex.keys()) this.sealedToolIds.add(id);
    this.resetBubbleState();
    this.segmentIndex++;
    this.awaitingContinuation = true;
    this.currentTool = null;
    this.taskSummary = '';
    this.toolUseSummaryText = undefined;
    this.splitPending = false;
    this.pendingFlush = false;
  }

  private async performFlush(content: string, frozen?: MessageRendererState): Promise<void> {
    if (!content) return;
    const state = frozen ?? this.contentBuilder.getStateSnapshot(this.getRenderInput(), content);
    if (this.shouldSkipFlush(state)) return;

    const now = Date.now();
    if (!this.forceFlush) {
      const contentChanged = content !== this.lastRenderedContent;
      const timeSinceLastFlush = now - this.lastFlushTime;
      const elapsedOnlyUpdate =
        this.lastRenderedContent &&
        content.replace(/\d+s\)/, '') === this.lastRenderedContent.replace(/\d+s\)/, '');
      if (elapsedOnlyUpdate && timeSinceLastFlush < this.elapsedUpdateInterval) return;
      if (!contentChanged) return;
    }

    if (this.flushing) {
      this.pendingFlush = true;
      return;
    }

    this.lastRenderedContent = content;
    this.lastFlushTime = now;
    this.forceFlush = false;

    this.flushing = true;
    this.lastFlushError = undefined;
    try {
      const isEdit = !!this._messageId;
      const flushButtons = this.permissionTracker?.getHead()?.buttons;
      let result: string | undefined;
      try {
        const flushStartedAt = Date.now();
        result = await this.flushCallback(content, isEdit, flushButtons, state);
        this.adaptiveFlush?.recordFlushLatency(Date.now() - flushStartedAt);
      } catch (err: any) {
        const code = err?.code ?? '';
        const retryable =
          err?.retryable || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
        const retryAfterMs = getRateLimitRetryAfterMs(err);
        const phase = this.errorMessage
          ? 'failed'
          : this.completed
            ? 'completed'
            : (this.permissionTracker?.getQueueLength() ?? 0) > 0
              ? 'waiting_permission'
              : 'executing';
        const contentPreview = content.slice(0, 100);
        const giveUp = (error: unknown, label: string) => {
          this.lastFlushError = error instanceof Error ? error : new Error(label);
          console.error(`${label}:`, error);
          this.onFlushError?.(error as Error, { phase, contentPreview });
        };
        const retryInPlace = async (waitMs: number) => {
          await new Promise((r) => setTimeout(r, waitMs));
          const retryStartedAt = Date.now();
          result = await this.flushCallback(content, isEdit, flushButtons, state);
          this.adaptiveFlush?.recordFlushLatency(Date.now() - retryStartedAt);
          this.lastFlushError = undefined;
        };

        if (!retryable) {
          giveUp(err, '[renderer] Failed');
        } else if (retryAfterMs === undefined) {
          // A lost socket is not a frequency rejection, so keep the old immediate replay: reusing
          // the create identity on the next tick is what stops a duplicate card being sent.
          try {
            await retryInPlace(1000);
          } catch (retryErr) {
            giveUp(retryErr, '[renderer] Failed after retry');
          }
        } else if (!this.completed && !this.errorMessage) {
          // A running frame has a later flush coming, so park it behind the penalty window instead
          // of re-sending on a fixed timer: Feishu rejected 14 of 14 such immediate retries.
          this.lastFlushError = err instanceof Error ? err : new Error('Progress update failed');
          this.adaptiveFlush?.recordRateLimit(retryAfterMs);
          this.forceFlush = true;
          if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
          }
          this.scheduleFlush();
        } else {
          // The terminal frame has no successor, so it waits the window out and must get through.
          this.adaptiveFlush?.recordRateLimit(retryAfterMs);
          const waitMs = Math.min(
            MAX_TERMINAL_FLUSH_WAIT_MS,
            this.adaptiveFlush?.remainingRateLimitMs() ?? retryAfterMs,
          );
          console.warn(`[renderer] Terminal flush rejected; retrying in ${waitMs}ms:`, err);
          try {
            await retryInPlace(waitMs);
          } catch (retryErr) {
            giveUp(retryErr, '[renderer] Failed after retry');
          }
        }
      }
      if (typeof result === 'string') this._messageId = result;

      if (this.splitPending && (this.completed || this.errorMessage)) {
        this.splitPending = false;
      } else if (this.splitPending) {
        this.splitPending = false;
        console.log(
          `[renderer] Bubble split after ${this.bubbleToolCount} tools, ${this.bubbleTimelineCount} timeline entries`,
        );
        this.resetBubbleState();
        this.pendingFlush = true;
      }
    } finally {
      this.flushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        const retryContent = this.contentBuilder.render(this.getRenderInput());
        if (retryContent) {
          if (this.adaptiveFlush && this._messageId) {
            this.scheduleFlush();
          } else {
            await this.doFlush(retryContent);
          }
        }
      }
    }
  }

  private settlePendingTools(status: 'failed' | 'interrupted'): void {
    for (const entry of this.timeline) {
      if (entry.kind === 'tool' && entry.status === 'running') {
        entry.status = status;
        entry.isError = status === 'failed';
      }
    }
    for (const log of this.toolLogs) {
      if (log.status === 'running') {
        log.status = status;
        log.isError = status === 'failed';
      }
    }
    this.currentTool = null;
    this.liveWrite = null;
    this.pendingToolResults.clear();
  }

  private resetBubbleState(): void {
    this._messageId = undefined;
    this.timeline = [];
    this.toolLogs = [];
    this.toolIdToLogIndex.clear();
    this.toolIdToTimelineIndex.clear();
    this.thinkingText = '';
    this.responseText = '';
    this.lastTimelineIsText = false;
    this.bubbleToolCount = 0;
    this.bubbleTimelineCount = 0;
    this.liveWrite = null;
    this.lastRenderedContent = '';
  }

  private updateSplitPending(): void {
    if (!this._messageId || this.splitPending || this.completed || this.errorMessage) return;
    if (this.shouldSplitBubble()) this.splitPending = true;
  }

  private shouldSplitBubble(): boolean {
    if (this.channelOwnsPagination) return false;
    const defaultSplit =
      this.bubbleToolCount >= SPLIT_TOOL_THRESHOLD ||
      this.bubbleTimelineCount >= SPLIT_TIMELINE_THRESHOLD;

    // 基于实际卡片 JSON 大小的 split（精确，优先使用 adapter hook）。
    const content = this.contentBuilder.render(this.getRenderInput());
    if (this.shouldSplitState) {
      const state = this.contentBuilder.getStateSnapshot(this.getRenderInput(), content);
      return defaultSplit || this.shouldSplitState(state);
    }
    // No adapter hook: the card JSON size can only be estimated from the rendered text bytes.
    const contentBytes = Buffer.byteLength(content, 'utf8');
    return (
      defaultSplit ||
      contentBytes > SPLIT_CONTENT_BYTES_THRESHOLD ||
      contentBytes * SPLIT_CONTENT_EXPANSION_FACTOR > SPLIT_ESTIMATED_CARD_LIMIT
    );
  }
}

/** Clone/redact presentation data without mutating the provider's tool input. */
function clonePresentationInput(input: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown, key = ''): unknown => {
    if (/password|secret|token|api[_-]?key|private[_-]?key/i.test(key)) return '[REDACTED]';
    if (typeof value === 'string') return redactSensitiveContent(value);
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, visit(item, name)]),
      );
    }
    return value;
  };
  return visit(input) as Record<string, unknown>;
}

function getRateLimitRetryAfterMs(err: any): number | undefined {
  if (!err) return undefined;
  const retryAfterMs = Number(err.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
  if (err.name === 'RateLimitError' || err.code === 230020 || err.code === 99991400) return 2000;
  const statusCode =
    err.statusCode ?? err.status ?? err.response?.statusCode ?? err.response?.status;
  if (statusCode === 429) return 2000;
  return undefined;
}
