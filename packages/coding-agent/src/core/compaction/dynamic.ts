// dynamic-compaction — progressively slim the context as it fills up.
// After each agent settle, if context usage exceeds a threshold, strip
// old tool traffic and condense old turns. No LLM calls — cheap to run
// every turn. The session file keeps the full trace; only the in-memory
// messages sent to the LLM are slimmed.

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface DynamicCompactionLevel {
	/** Number of turns (user+assistant pairs) to keep raw after slimming. */
	trailingTurns: number;
	/** If true, condense old assistant-only-tool-calls to stubs. */
	condenseStubs: boolean;
	/** If true, also drop old user messages (keep only assistant text). */
	dropOldUser: boolean;
}

/**
 * Compute the compaction level from context usage percentage.
 *
 *   0 (< 50%): nothing
 *   1 (50-70%): keep 6 turns, strip tool traffic
 *   2 (70-85%): keep 4 turns, condense stubs
 *   3 (> 85%): keep 2 turns, drop old user messages
 */
export function computeLevel(contextUsagePct: number): DynamicCompactionLevel | null {
	if (contextUsagePct < 0.5) return null;
	if (contextUsagePct < 0.7) return { trailingTurns: 6, condenseStubs: false, dropOldUser: false };
	if (contextUsagePct < 0.85) return { trailingTurns: 4, condenseStubs: true, dropOldUser: false };
	return { trailingTurns: 2, condenseStubs: true, dropOldUser: true };
}

/**
 * Apply dynamic slimming to the message array. Returns a new array;
 * the original is not modified. The session file keeps the full trace.
 */
export function applyDynamicSlim(messages: AgentMessage[], level: DynamicCompactionLevel): AgentMessage[] {
	if (messages.length === 0) return messages;

	// Walk from the END to find the cutoff: the Nth user message from the end.
	// Everything before that user gets slimmed; that user and after stays.
	let userCount = 0;
	let cutoffIndex = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "user") {
			userCount++;
			if (userCount === level.trailingTurns) {
				cutoffIndex = i;
				break;
			}
		}
	}

	if (cutoffIndex >= messages.length) return messages;

	const result: AgentMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (i < cutoffIndex) {
			// Slim old messages
			if (msg.role === "assistant") {
				const toolCalls = msg.content.filter((c) => c.type === "toolCall");
				const nonToolContent = msg.content.filter((c) => c.type !== "toolCall");

				if (nonToolContent.length > 0 && !level.condenseStubs) {
					result.push({ ...msg, content: nonToolContent });
				} else if (nonToolContent.length > 0 && level.condenseStubs) {
					// Keep first line as a stub
					const firstText = nonToolContent.find((c) => c.type === "text");
					const text = firstText && firstText.type === "text" ? firstText.text : "";
					const firstLine = text.split("\n")[0].slice(0, 120);
					result.push({
						...msg,
						content: [{ type: "text", text: firstLine || "[condensed]" }],
					});
				} else if (toolCalls.length > 0) {
					// All content was tool calls.
					if (level.condenseStubs) {
						// Make a stub so the context retains what was done.
						const names = toolCalls
							.map((c) => (c.type === "toolCall" ? c.name : undefined))
							.filter(Boolean)
							.join(", ");
						result.push({
							...msg,
							content: [{ type: "text", text: `[Used tools: ${names}]` }],
						});
					}
					// else: drop entirely (no useful content)
				} else {
					result.push({ ...msg, content: [{ type: "text", text: "[...]" }] });
				}
			} else if (msg.role === "toolResult") {
				// Drop old tool results entirely
			} else if (msg.role === "user") {
				if (level.dropOldUser) {
					// Drop old user messages — keep only assistant
				} else {
					result.push(msg);
				}
			} else {
				result.push(msg);
			}
		} else {
			result.push(msg);
		}
	}

	return result;
}
