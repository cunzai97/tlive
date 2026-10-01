/** Normalize nullable/blank values introduced by strict JSON-schema tool calls. */
export function normalizeResumeSessionId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
