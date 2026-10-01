/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { normalizeResumeSessionId } from "./params.ts";
import { collectSubagentEvent, createSubagentFlow, finishSubagentFlow, type SubagentFlow } from "./flow.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
/** Per-task timeout in ms. Override with a positive PI_SUBAGENT_TASK_TIMEOUT_MS value. */
function getTaskTimeoutMs(): number {
	const configured = process.env.PI_SUBAGENT_TASK_TIMEOUT_MS;
	if (!configured) return 600_000; // 10 min
	const parsed = Number(configured);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 600_000;
}

const TASK_TIMEOUT_MS = getTaskTimeoutMs();
/** Directory where subagent session files are persisted (enables resuming after timeout). */
const SUBAGENT_SESSION_DIR = path.join(getAgentDir(), "subagent-sessions");
/** Subagent session files older than this are deleted on extension load. */
const SUBAGENT_SESSION_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
/** Default task used when resuming a timed-out run without an explicit task. */
const DEFAULT_RESUME_TASK =
	"Continue the previous task from where it stopped. Your earlier progress is in this session's history; review it and finish the work.";
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Session id of the subagent run (persisted under SUBAGENT_SESSION_DIR for timeout resume). */
	sessionId?: string;
	/** Versioned chronological display stream; messages remain the complete model result. */
	flow: SubagentFlow;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const text = msg.content
				.filter((part): part is Extract<(typeof msg.content)[number], { type: "text" }> => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (text) return text;
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "timeout"
	);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

/**
 * Plain-text summary of the tool calls made so far, for timeout/resume messages.
 * e.g. "14 tool calls; recent: 10) bash: ls -la ... | 11) read: src/x.ts | ..."
 */
function summarizeToolCalls(messages: Message[], recentCount = 5): string {
	const calls: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall") continue;
			const args = (part.arguments ?? {}) as Record<string, any>;
			let detail = "";
			switch (part.name) {
				case "bash":
					detail = (args.command as string) || "";
					break;
				case "read":
				case "write":
				case "edit":
					detail = (args.path || args.file_path || "") as string;
					break;
				case "ls":
					detail = (args.path || ".") as string;
					break;
				case "find":
					detail = `${args.pattern ?? ""}${args.path ? ` in ${args.path}` : ""}`;
					break;
				case "grep":
					detail = `/${args.pattern ?? ""}/${args.path ? ` in ${args.path}` : ""}`;
					break;
				default: {
					try {
						detail = JSON.stringify(args);
					} catch {
						detail = "";
					}
				}
			}
			if (detail.length > 60) detail = `${detail.slice(0, 60)}...`;
			calls.push(detail ? `${part.name}: ${detail}` : part.name);
		}
	}
	if (calls.length === 0) return "no tool calls yet";
	const start = Math.max(1, calls.length - recentCount + 1);
	const recent = calls.slice(-recentCount).map((c, i) => `${start + i}) ${c}`);
	return `${calls.length} tool calls; recent: ${recent.join(" | ")}`;
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// Always use the pi CLI to start a new agent instance.
	// The subagent extension passes pi-specific flags (--mode, -p, --session-id, --session-dir)
	// that are only understood by the pi CLI, not by raw node/bun execution.
	return { command: "pi", args };
}

/** Find the persisted session file for a subagent session id (if any). */
function findSubagentSessionFile(sessionId: string): string | undefined {
	const suffix = `_${sessionId}.jsonl`;
	try {
		for (const file of fs.readdirSync(SUBAGENT_SESSION_DIR)) {
			if (file.endsWith(suffix)) return path.join(SUBAGENT_SESSION_DIR, file);
		}
	} catch {
		/* directory may not exist yet */
	}
	return undefined;
}

/** Read the header (first line) of a subagent session file, if it exists. */
function readSubagentSessionHeader(sessionId: string): { type?: string; id?: string; cwd?: string } | undefined {
	const file = findSubagentSessionFile(sessionId);
	if (!file) return undefined;
	try {
		const firstLine = fs.readFileSync(file, "utf-8").split("\n", 1)[0];
		const header = JSON.parse(firstLine);
		return header?.type === "session" ? header : undefined;
	} catch {
		return undefined;
	}
}

/**
 * If a subagent session ends with tool calls that have no results (the process was killed
 * mid-execution, e.g. by a timeout), append synthetic error tool results so the history is
 * well-formed for any LLM provider. Returns the number of repaired calls.
 */
function repairDanglingToolCalls(sessionId: string): number {
	const file = findSubagentSessionFile(sessionId);
	if (!file) return 0;
	try {
		const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
		const entries: Array<Record<string, any>> = [];
		for (const line of lines) {
			try {
				entries.push(JSON.parse(line));
			} catch {
				/* skip malformed lines */
			}
		}
		// Walk the session path from the last entry (leaf) back to the root.
		const byId = new Map<string, Record<string, any>>();
		for (const e of entries) if (e?.id) byId.set(e.id, e);
		const path: Record<string, any>[] = [];
		let leaf: Record<string, any> | undefined = entries[entries.length - 1];
		while (leaf) {
			path.push(leaf);
			leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
		}
		path.reverse();

		const resolved = new Set<string>();
		for (const e of path) {
			const m = e?.message;
			if (e?.type === "message" && m?.role === "toolResult" && m.toolCallId) resolved.add(m.toolCallId);
		}
		const dangling: Array<{ id: string; name: string }> = [];
		for (const e of path) {
			const m = e?.message;
			if (e?.type !== "message" || m?.role !== "assistant") continue;
			for (const part of m.content ?? []) {
				if (part?.type === "toolCall" && part.id && !resolved.has(part.id)) {
					dangling.push({ id: part.id, name: part.name ?? "tool" });
				}
			}
		}
		if (dangling.length === 0) return 0;

		const existingIds = new Set(entries.map((e) => e.id).filter(Boolean));
		const nowIso = new Date().toISOString();
		const nowMs = Date.now();
		let parentId: string | null = entries[entries.length - 1]?.id ?? null;
		for (const call of dangling) {
			let id = randomUUID().slice(0, 8);
			while (existingIds.has(id)) id = randomUUID().slice(0, 8);
			existingIds.add(id);
			const entry = {
				type: "message",
				id,
				parentId,
				timestamp: nowIso,
				message: {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [
						{
							type: "text",
							text: `Tool execution was interrupted (the subagent process was killed, e.g. by a timeout). No result was produced; re-run the tool if its outcome is still needed.`,
						},
					],
					isError: true,
					timestamp: nowMs,
				},
			};
			fs.appendFileSync(file, JSON.stringify(entry) + "\n");
			parentId = id;
		}
		return dangling.length;
	} catch {
		return 0;
	}
}

/** Delete stale subagent session files (called once on extension load). */
function cleanupSubagentSessions(): void {
	try {
		fs.mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true });
		const now = Date.now();
		for (const file of fs.readdirSync(SUBAGENT_SESSION_DIR)) {
			if (!file.endsWith(".jsonl")) continue;
			const filePath = path.join(SUBAGENT_SESSION_DIR, file);
			try {
				if (now - fs.statSync(filePath).mtimeMs > SUBAGENT_SESSION_MAX_AGE_MS) fs.unlinkSync(filePath);
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	sessionModel: string | undefined,
	sessionThinkingLevel: string | undefined,
	resumeSessionId?: string,
	runSessionId?: string,
): Promise<SingleResult> {
	const sessionId = resumeSessionId ?? runSessionId ?? randomUUID();
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			sessionId,
			flow: createSubagentFlow("failed").flow,
		};
	}

	// Persist the run as a pi session so a timed-out run can be resumed later
	// (re-invoke with resume: "<sessionId>", same agent and cwd).
	const effectiveCwd = path.resolve(defaultCwd, cwd ?? ".");

	if (resumeSessionId) {
		const header = readSubagentSessionHeader(resumeSessionId);
		if (!header) {
			return {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: 1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				step,
				errorMessage: `Resume failed: session "${resumeSessionId}" not found in ${SUBAGENT_SESSION_DIR} (it may have been cleaned up). Start a fresh task instead.`,
				sessionId,
				flow: createSubagentFlow("failed").flow,
			};
		}
		if (header.cwd && path.resolve(header.cwd) !== effectiveCwd) {
			return {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: 1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				step,
				errorMessage: `Resume failed: session "${resumeSessionId}" was started in cwd "${header.cwd}" but this run uses "${effectiveCwd}". Re-invoke with cwd: "${header.cwd}" to resume.`,
				sessionId,
				flow: createSubagentFlow("failed").flow,
			};
		}
		// The original run may have been killed mid tool-execution, leaving tool calls
		// without results; append synthetic error results so the history is well-formed.
		repairDanglingToolCalls(resumeSessionId);
	}

	const effectiveModel = agent.model?.trim() || sessionModel;
	const args: string[] = ["--mode", "json", "-p"];
	args.push("--session-id", sessionId, "--session-dir", SUBAGENT_SESSION_DIR, "--name", `subagent-${agentName}`);
	if (effectiveModel) args.push("--model", effectiveModel);
	if (sessionThinkingLevel) args.push("--thinking", sessionThinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	let flowState = createSubagentFlow();
	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModel,
		step,
		sessionId,
		flow: flowState.flow,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: structuredClone(makeDetails([currentResult])),
			});
		}
	};

	try {
		emitUpdate(); // Publish identity/running before prompt preparation or process startup.
		if (signal?.aborted) throw new Error("Subagent was aborted");
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		let wasTimedOut = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: effectiveCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let settled = false;
			let timeoutId: NodeJS.Timeout | null = null;
			let forceKillId: NodeJS.Timeout | null = null;
			let abortHandler: (() => void) | undefined;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				const nextFlow = collectSubagentEvent(flowState, event);
				const flowChanged = nextFlow !== flowState;
				flowState = nextFlow;
				currentResult.flow = flowState.flow;

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
				}
				if (flowChanged || event.type === "message_end" || event.type === "tool_result_end") emitUpdate();
			};

			const clearProcessGuards = () => {
				if (timeoutId) clearTimeout(timeoutId);
				if (forceKillId) clearTimeout(forceKillId);
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			};

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				clearProcessGuards();
				if (buffer.trim()) processLine(buffer);
				resolve(code);
			};

			const terminate = () => {
				if (proc.exitCode !== null || proc.signalCode !== null) return;
				try {
					proc.kill("SIGTERM");
				} catch {
					return;
				}
				forceKillId = setTimeout(() => {
					if (proc.exitCode === null && proc.signalCode === null) {
						try {
							proc.kill("SIGKILL");
						} catch {
							/* process already exited */
						}
					}
				}, 5000);
			};

			timeoutId = setTimeout(() => {
				wasTimedOut = true;
				terminate();
			}, TASK_TIMEOUT_MS);

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => finish(code ?? 1));

			proc.on("error", (error) => {
				currentResult.stderr += `${currentResult.stderr ? "\n" : ""}Failed to start subagent: ${error.message}`;
				finish(1);
			});

			if (signal) {
				abortHandler = () => {
					wasAborted = true;
					terminate();
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasTimedOut && !wasAborted) {
			const timeoutSec = TASK_TIMEOUT_MS / 1000;
			currentResult.stopReason = "timeout";
			currentResult.errorMessage = `Subagent timed out after ${timeoutSec}s. Progress so far: ${summarizeToolCalls(currentResult.messages)}. Partial session saved as ${sessionId} (cwd: ${effectiveCwd}). To continue, re-invoke with resume: "${sessionId}" using the same agent and cwd (task optional).`;
		}
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			flowState = finishSubagentFlow(flowState, "interrupted");
			currentResult.flow = flowState.flow;
			emitUpdate();
			throw new Error("Subagent was aborted");
		}
		flowState = finishSubagentFlow(flowState,
			currentResult.stopReason === "aborted" ? "interrupted" : isFailedResult(currentResult) ? "failed" : "completed");
		currentResult.flow = flowState.flow;
		emitUpdate();
		return currentResult;
	} catch (error) {
		if (currentResult.flow.status === "running") {
			currentResult.exitCode = 1;
			currentResult.stopReason = signal?.aborted ? "aborted" : "error";
			currentResult.errorMessage = error instanceof Error ? error.message : String(error);
			flowState = finishSubagentFlow(flowState, signal?.aborted ? "interrupted" : "failed");
			currentResult.flow = flowState.flow;
			emitUpdate();
		}
		throw error;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "[Single mode] Name of the agent to invoke. Required when using single mode (provide both 'agent' and 'task', do NOT also provide 'tasks' or 'chain')" })),
	task: Type.Optional(Type.String({ description: "[Single mode] Task to delegate. Required when using single mode (provide both 'agent' and 'task', do NOT also provide 'tasks' or 'chain')" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "[Parallel mode] Array of {agent, task} objects for parallel execution. Use this OR 'chain' OR (agent+task), never mix modes. Max 8 tasks, 4 concurrent." })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "[Chain mode] Array of {agent, task} objects executed sequentially. Each step's task can use {previous} to reference prior output. Use this OR 'tasks' OR (agent+task), never mix modes." })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	resume: Type.Optional(
		Type.String({
			description:
				"[Resume mode] Session ID of a previously timed-out subagent run (from its timeout error). Single mode only: provide the same agent and cwd; task is optional (defaults to 'continue the previous task').",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	cleanupSubagentSessions();
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate bounded tasks to specialized subagents with isolated context. Use when work is independently useful, can be verified from a clear handoff, and would otherwise pollute or overload the main context; skip trivial tasks and work requiring tight back-and-forth with the main agent.",
			"Agent roles: scout = internet research, source verification, codebase reconnaissance, and evidence gathering; reviewer = read-only review against stated criteria; worker = autonomous implementation or other heavy general work. Route research and reconnaissance tasks to scout, including current news and external information.",
			"By default each subagent inherits the current session's provider/model and thinking level. An agent may explicitly override only the model with `model: provider/model` in its Markdown frontmatter; there is no per-call model override.",
			"Every task must be self-contained: include the objective, relevant paths/context, constraints, expected output, and whether edits are allowed. Do not delegate fixed or associative memory operations.",
			"MUST choose exactly ONE of these three modes — never mix them:",
			"  1) Single mode: provide 'agent' (string) AND 'task' (string). Example: {agent: 'scout', task: 'find all test files'}",
			"  2) Parallel mode: provide 'tasks' (array of {agent, task}). Example: {tasks: [{agent: 'scout', task: '...'}, {agent: 'worker', task: '...'}]}. Max 8 tasks, 4 concurrent.",
			"  3) Chain mode: provide 'chain' (array of {agent, task}), executed sequentially. Use {previous} in task to pass prior output.",
			"If a run times out, its partial progress is saved in a session; the timeout error includes how many tool calls were made and the most recent ones. Re-invoke with {agent: '<same agent>', resume: '<sessionId from the timeout error>'} (same cwd, task optional) to continue where it stopped.",
			"Do NOT provide 'agent'/'task' alongside 'tasks' or 'chain'. Do NOT provide multiple modes at once.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		promptSnippet: "Delegate tasks to specialized subagents",
		promptGuidelines: [
			"Use when tasks can run isolated from main context: 'scout' for internet research, source verification, or codebase reconnaissance; 'reviewer' for read-only review; 'worker' for implementation or heavy general work. Use parallel mode for simultaneous independent tasks and chain mode for sequential pipelines with {previous} handoff.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const sessionThinkingLevel = ctx.thinkingLevel;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const resumeSessionId = normalizeResumeSessionId(params.resume);
			const hasResume = resumeSessionId !== undefined;
			const hasSingle = Boolean(params.agent && (params.task || hasResume));
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results: structuredClone(results),
				});
			const queuedResult = (agent: string, task: string, step?: number): SingleResult => ({
				agent,
				agentSource: agents.find((a) => a.name === agent)?.source ?? "unknown",
				task,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				step,
				sessionId: randomUUID(),
				flow: createSubagentFlow("queued").flow,
			});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: (() => {
							const parts = ["Invalid subagent parameters. You must provide exactly ONE mode:"];
							const provided: string[] = [];
							if (params.agent || params.task) provided.push(`agent=${JSON.stringify(params.agent)}/task=${JSON.stringify(params.task)?.slice(0, 40)}`);
							if (params.tasks?.length) provided.push(`tasks[${params.tasks.length}]`);
							if (params.chain?.length) provided.push(`chain[${params.chain.length}]`);
							parts.push(`You provided: ${provided.length ? provided.join(", ") : "nothing matching a mode"}`);
							parts.push("Pick ONE:");
							parts.push("  Single: {agent: 'name', task: 'description'}");
							parts.push("  Parallel: {tasks: [{agent: 'name', task: 'desc'}, ...]}");
							parts.push("  Chain: {chain: [{agent: 'name', task: 'desc'}, ...]}");
							parts.push("  Resume: {agent: 'name', resume: '<sessionId>'} to continue a timed-out run");
							parts.push(`Available agents: ${available}`);
							return parts.join("\n");
						})(),
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					if (!ctx.hasUI) {
						return {
							content: [
								{
									type: "text",
									text: `Canceled: project-local agents (${names}) require confirmation, but no interactive UI is available. Re-run interactively or explicitly set confirmProjectAgents=false for a trusted repository.`,
								},
							],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
							isError: true,
						};
					}
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				const allResults = params.chain.map((s, i) => queuedResult(s.agent, s.task, i + 1));
				const emitChainUpdate = (content: AgentToolResult<SubagentDetails>["content"]) =>
					onUpdate?.({ content, details: makeDetails("chain")(allResults) });
				const interruptQueued = () => {
					for (const result of allResults) {
						if (result.flow.status === "queued") result.flow = { ...result.flow, status: "interrupted" };
					}
					emitChainUpdate([{ type: "text", text: "Chain stopped." }]);
				};
				emitChainUpdate([{ type: "text", text: "Chain queued..." }]);
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									allResults[i] = currentResult;
									emitChainUpdate(partial.content);
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						sessionModel,
						sessionThinkingLevel,
						undefined,
						allResults[i].sessionId,
					).catch((error) => { interruptQueued(); throw error; });
					results.push(result);
					allResults[i] = result;
					emitChainUpdate([{ type: "text", text: getResultOutput(result) }]);

					const isError = isFailedResult(result);
					if (isError) {
						interruptQueued();
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = queuedResult(params.tasks[i].agent, params.tasks[i].task);
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				emitParallelUpdate(); // Includes tasks waiting for the concurrency limit, with stable IDs.
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						sessionModel,
						sessionThinkingLevel,
						undefined,
						allResults[index].sessionId,
					).catch((error) => {
						for (const result of allResults) {
							if (result.flow.status === "queued") result.flow = { ...result.flow, status: "interrupted" };
						}
						emitParallelUpdate();
						throw error;
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: successCount !== results.length,
				};
			}

			if (params.agent && (params.task || hasResume)) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task || DEFAULT_RESUME_TASK,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					sessionModel,
					sessionThinkingLevel,
					resumeSessionId,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode: single (agent+task), parallel (tasks[]), chain (chain[]), or resume (agent+resume). Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			if (args.resume) text += ` ${theme.fg("warning", `resume ${String(args.resume).slice(0, 8)}`)}`;
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
