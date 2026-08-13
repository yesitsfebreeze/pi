/**
 * Running compaction tests — verify the LLM-backed incremental summarization
 * logic (unit tests only, no live LLM calls).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { buildCompactMessages, type RunningCompactionState, shouldCompact } from "../../src/core/compaction/running.ts";

function msg(role: string, text: string): AgentMessage {
	return {
		role: role as AgentMessage["role"],
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function newState(turns = 0, total = 0, summary: string | null = null): RunningCompactionState {
	return { turnsSinceLastSummary: turns, totalCompacted: total, summary };
}

describe("running compaction", () => {
	it("shouldCompact returns null when not enough turns", () => {
		const messages: AgentMessage[] = [
			msg("user", "hi"),
			msg("assistant", "hello"),
			msg("user", "help"),
			msg("assistant", "sure"),
		];
		expect(shouldCompact(messages, newState(1))).toBeNull();
	});

	it("shouldCompact returns messages to compact when enough turns", () => {
		const messages: AgentMessage[] = [
			msg("user", "turn1"),
			msg("assistant", "resp1"),
			msg("user", "turn2"),
			msg("assistant", "resp2"),
			msg("user", "turn3"),
			msg("assistant", "resp3"),
		];
		const result = shouldCompact(messages, newState(2));
		expect(result).not.toBeNull();
		// Everything before the last user message
		expect(result).toHaveLength(4);
		expect((result![0] as any).content[0]).toEqual({ type: "text", text: "turn1" });
		expect((result![3] as any).content[0]).toEqual({ type: "text", text: "resp2" });
	});

	it("shouldCompact handles single user message gracefully", () => {
		const messages: AgentMessage[] = [msg("user", "only")];
		expect(shouldCompact(messages, newState(2))).toBeNull();
	});

	it("shouldCompact returns null for empty messages", () => {
		expect(shouldCompact([], newState(2))).toBeNull();
	});

	it("buildCompactMessages prepends summary before trailing messages", () => {
		const trailing: AgentMessage[] = [msg("user", "current"), msg("assistant", "response")];
		const result = buildCompactMessages("summary text", trailing);
		expect(result).toHaveLength(3);
		expect(result[0].role).toBe("user");
		expect((result[0] as any).content[0].type).toBe("text");
		expect(((result[0] as any).content[0] as { text: string }).text).toContain("summary text");
		expect(((result[0] as any).content[0] as { text: string }).text).toContain("<context-summary>");
		expect(result[1]).toEqual(trailing[0]);
		expect(result[2]).toEqual(trailing[1]);
	});

	it("state can track turns manually", () => {
		const state = newState(0);
		const messages: AgentMessage[] = [
			msg("user", "turn1"),
			msg("assistant", "resp1"),
			msg("user", "turn2"),
			msg("assistant", "resp2"),
		];
		// First call: state.turnsSinceLastSummary is 0, not enough
		expect(shouldCompact(messages, state)).toBeNull();
		// Simulate a turn passing
		state.turnsSinceLastSummary = 2;
		const result = shouldCompact(messages, state);
		expect(result).not.toBeNull();
		expect((result![0] as any).content[0]).toEqual({ type: "text", text: "turn1" });
		expect((result![1] as any).content[0]).toEqual({ type: "text", text: "resp1" });
	});
});
