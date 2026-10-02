import type { TodoStatus } from './schema.js';

/** A complete plan snapshot; undefined means unrecognised/not ready, [] explicitly clears it. */
export interface PlanTodo {
  content: string;
  status: TodoStatus;
}

/** Shared by every surface so cancelled or blocked work never looks finished. */
export const TODO_MARKERS: Record<TodoStatus, string> = {
  pending: '⬜',
  in_progress: '🔧',
  completed: '✅',
  cancelled: '⛔',
  blocked: '🚧',
};

const MAX_JSON_LENGTH = 16_000;
const MAX_WRAPPER_DEPTH = 4;
const LIST_FIELDS = new Set([
  'todos',
  'todo',
  'todolist',
  'tasks',
  'tasklist',
  'subtasks',
  'plan',
  'plans',
  'planitems',
  'steps',
  'checklist',
]);
// Only explicit transport envelopes are traversed, never file content or arbitrary objects.
const WRAPPER_FIELDS = new Set([
  'input',
  'arguments',
  'args',
  'parameters',
  'params',
  'data',
  'payload',
  'result',
  'output',
]);
const STATUS_FIELDS = new Set(['status', 'state']);
// This priority is independent of JSON property order; Codex uses `step`.
const TEXT_FIELDS = [
  'content',
  'step',
  'subject',
  'title',
  'description',
  'text',
  'task',
  'summary',
  'name',
];
const STATUSES = new Map<string, TodoStatus>([
  ['pending', 'pending'],
  ['todo', 'pending'],
  ['notstarted', 'pending'],
  ['open', 'pending'],
  ['waiting', 'pending'],
  ['queued', 'pending'],
  ['blocked', 'blocked'],
  ['inprogress', 'in_progress'],
  ['doing', 'in_progress'],
  ['active', 'in_progress'],
  ['running', 'in_progress'],
  ['ongoing', 'in_progress'],
  ['completed', 'completed'],
  ['complete', 'completed'],
  ['done', 'completed'],
  ['finished', 'completed'],
  ['success', 'completed'],
  ['closed', 'completed'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled'],
  ['skipped', 'cancelled'],
  ['abandoned', 'cancelled'],
]);
const PLAN_TOOL_NAMES = new Set([
  'todo',
  'todos',
  'todolist',
  'todowrite',
  'writetodo',
  'writetodos',
  'updatetodo',
  'updatetodos',
  'updatetodolist',
  'settodo',
  'settodos',
  'plan',
  'plans',
  'updateplan',
  'writeplan',
  'setplan',
  'tasks',
  'tasklist',
  'updatetasklist',
  'writetasklist',
  'checklist',
  'updatechecklist',
  'writechecklist',
]);
const INVALID_PLAN = Symbol('invalid plan');
type Candidate = PlanTodo[] | typeof INVALID_PLAN | undefined;

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[_\s-]+/g, '');
}

function normalizeStatus(value: unknown): TodoStatus | undefined {
  return typeof value === 'string' ? STATUSES.get(normalizeKey(value)) : undefined;
}

function textOf(item: Record<string, unknown>): string | undefined {
  const fields = Object.entries(item).map(([key, value]) => [normalizeKey(key), value] as const);
  for (const field of TEXT_FIELDS) {
    const match = fields.find(
      ([key, value]) => key === field && typeof value === 'string' && value.trim(),
    );
    if (match) return (match[1] as string).trim();
  }
  return undefined;
}

function statusOf(item: Record<string, unknown>): TodoStatus | undefined {
  let found: TodoStatus | undefined;
  for (const [key, value] of Object.entries(item)) {
    if (!STATUS_FIELDS.has(normalizeKey(key))) continue;
    const status = normalizeStatus(value);
    // An unknown/conflicting status must not be bypassed by another status field.
    if (!status || (found !== undefined && found !== status)) return undefined;
    found = status;
  }
  return found;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseItems(value: unknown[]): PlanTodo[] | undefined {
  const items: PlanTodo[] = [];
  for (const raw of value) {
    if (!isPlainObject(raw)) return undefined;
    const content = textOf(raw);
    const status = statusOf(raw);
    // One malformed item invalidates the snapshot; never render half a list.
    if (!content || !status) return undefined;
    items.push({ content, status });
  }
  return items;
}

function parseJson(raw: string): unknown {
  if (raw.length > MAX_JSON_LENGTH) return undefined;
  const text = raw.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function mergeCandidates(current: Candidate, next: Candidate): Candidate {
  if (current === INVALID_PLAN || next === INVALID_PLAN) return INVALID_PLAN;
  if (next === undefined) return current;
  if (current === undefined) return next;
  // Duplicate envelopes are harmless; different lists are ambiguous, not a partial update.
  if (
    current.length !== next.length ||
    current.some((item, index) => {
      const other = next[index];
      return item.content !== other.content || item.status !== other.status;
    })
  ) {
    return INVALID_PLAN;
  }
  return current;
}

function candidatePlan(root: unknown, depth = 0, insidePlan = false): Candidate {
  if (!isPlainObject(root) || depth > MAX_WRAPPER_DEPTH) return undefined;
  let found: Candidate;
  for (const [key, value] of Object.entries(root)) {
    const field = normalizeKey(key);
    let next: Candidate;
    if (LIST_FIELDS.has(field) || (insidePlan && field === 'items')) {
      if (Array.isArray(value)) next = parseItems(value) ?? INVALID_PLAN;
      else if (isPlainObject(value) && LIST_FIELDS.has(field)) {
        next = candidatePlan(value, depth + 1, true) ?? INVALID_PLAN;
      } else next = INVALID_PLAN;
    } else if (WRAPPER_FIELDS.has(field)) {
      next = candidatePlan(typeof value === 'string' ? parseJson(value) : value, depth + 1, insidePlan);
    }
    found = mergeCandidates(found, next);
    if (found === INVALID_PLAN) return found;
  }
  return found;
}

/** Recognise strong list fields regardless of the tool name, without walking file/source content. */
export function parsePlanLike(payload: unknown): PlanTodo[] | undefined {
  const plan = candidatePlan(payload);
  return plan === INVALID_PLAN ? undefined : plan;
}

/** Parsed input is authoritative and is never silently truncated by the raw JSON size limit. */
export function parsePlanFromToolCall(
  inputData: Record<string, unknown> | undefined,
  toolInput?: string,
): PlanTodo[] | undefined {
  if (inputData) return parsePlanLike(inputData);
  return toolInput === undefined ? undefined : parsePlanLike(parseJson(toolInput));
}

function hasPlanToolName(toolName: string): boolean {
  // Match the actual name (including common MCP namespaces), not substrings like `read_plan`.
  const name = toolName.split(/__|[.:/]/).at(-1) ?? '';
  return PLAN_TOOL_NAMES.has(normalizeKey(name));
}

function parseCheckboxes(text: string): PlanTodo[] | undefined {
  const todos: PlanTodo[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(?:(?:[-*+]|\d+[.)])[ \t]+)?\[([ >xX])\][ \t]*(\S.*)$/);
    if (!match) return undefined;
    const status: TodoStatus =
      match[1] === '>' ? 'in_progress' : match[1].toLowerCase() === 'x' ? 'completed' : 'pending';
    todos.push({ content: match[2].trim(), status });
  }
  return todos.length ? todos : undefined;
}

/**
 * Results are trusted only with prior input evidence or an unmistakable plan tool name. Otherwise
 * read/bash/search output containing a file/API's plan-shaped JSON must remain ordinary output.
 * Only whole JSON, one closed JSON fence, or an entirely checkbox-formatted snapshot is accepted.
 */
export function parsePlanFromToolResult(
  toolResult: string | undefined,
  toolName: string,
  knownPlan = false,
): PlanTodo[] | undefined {
  if (!knownPlan && !hasPlanToolName(toolName)) return undefined;
  if (toolResult === undefined || toolResult.length > MAX_JSON_LENGTH) return undefined;
  const text = toolResult.trim();
  let jsonText: string | undefined;
  if (text.startsWith('{') || text.startsWith('[')) {
    // Checkbox snapshots also start with `[`, but may not be mistaken for a JSON fragment.
    if (/^\[[ >xX]\]/.test(text)) return parseCheckboxes(text);
    jsonText = text;
  } else {
    const fences = [
      ...text.matchAll(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?$)/gim),
    ];
    if (fences.length > 1) return undefined;
    if (fences.length === 1) jsonText = fences[0][1];
  }
  if (jsonText !== undefined) {
    const payload = parseJson(jsonText);
    // A bare array is meaningful only here, after the tool/context gate, not in arbitrary input.
    return Array.isArray(payload) ? parseItems(payload) : parsePlanLike(payload);
  }
  return parseCheckboxes(text);
}
