/**
 * Dynamic compaction tests — verify slimming scales with context pressure.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { applyDynamicSlim, computeLevel } from "../../src/core/compaction/dynamic.ts";

function msg(role: string, text: string): AgentMessage {
	return {
		role: role as AgentMessage["role"],
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function toolCall(name: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name, id: "1", arguments: {} }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function toolResult(text: string): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		toolCallId: "1",
	} as AgentMessage;
}

describe("dynamic compaction", () => {
	it("computeLevel returns null below 50%", () => {
		expect(computeLevel(0)).toBeNull();
		expect(computeLevel(0.49)).toBeNull();
		expect(computeLevel(0.5)).not.toBeNull();
	});

	it("computeLevel returns correct levels at boundaries", () => {
		expect(computeLevel(0.5)!.trailingTurns).toBe(6);
		expect(computeLevel(0.6)!.trailingTurns).toBe(6);
		expect(computeLevel(0.7)!.trailingTurns).toBe(4);
		expect(computeLevel(0.8)!.trailingTurns).toBe(4);
		expect(computeLevel(0.85)!.trailingTurns).toBe(2);
		expect(computeLevel(0.95)!.trailingTurns).toBe(2);
	});

	it("keeps trailing turns intact", () => {
		const messages: AgentMessage[] = [
			msg("user", "hi"),
			msg("assistant", "hello"),
			msg("user", "help"),
			msg("assistant", "sure"),
			msg("user", "more"),
			msg("assistant", "done"),
		];
		const result = applyDynamicSlim(messages, { trailingTurns: 3, condenseStubs: false, dropOldUser: false });
		// 3 trailing turns with 3 users = nothing slimmed
		expect(result).toEqual(messages);
	});

	it("strips tool calls from old messages", () => {
		const messages: AgentMessage[] = [
			msg("user", "do x"),
			toolCall("read"),
			toolResult("file content"),
			msg("assistant", "I read the file"),
			msg("user", "now do y"),
			msg("assistant", "done"),
		];
		const result = applyDynamicSlim(messages, { trailingTurns: 1, condenseStubs: false, dropOldUser: false });
		// Last user is "now do y" at index 4. Old: 0-3, kept: 4-5.
		// User "do x" stays, toolCall dropped, toolResult dropped,
		// assistant "I read the file" stays (has non-tool content).
		expect(result).toHaveLength(4);
		expect(result[0].role).toBe("user");
		expect((result[0] as any).content[0]).toEqual({ type: "text", text: "do x" });
		expect(result[1].role).toBe("assistant");
		expect((result[1] as any).content[0]).toEqual({ type: "text", text: "I read the file" });
		expect(result[2]).toEqual(messages[4]);
		expect(result[3]).toEqual(messages[5]);
	});

	it("condenses old assistant messages to first line when condenseStubs is true", () => {
		const messages: AgentMessage[] = [
			msg("user", "do x"),
			msg("assistant", "first line\nsecond line\nthird"),
			msg("user", "now do y"),
			msg("assistant", "done"),
		];
		const result = applyDynamicSlim(messages, { trailingTurns: 1, condenseStubs: true, dropOldUser: false });
		// Last user is "now do y" at index 2. Old: 0-1, kept: 2-3.
		// Index 1 is the assistant "first line\nsecond line\nthird" — condensed to first line.
		expect(result).toHaveLength(4);
		expect(result[0].role).toBe("user");
		expect((result[0] as any).content[0]).toEqual({ type: "text", text: "do x" });
		expect(result[1].role).toBe("assistant");
		expect((result[1] as any).content[0]).toEqual({ type: "text", text: "first line" });
		expect(result[2]).toEqual(messages[2]);
		expect(result[3]).toEqual(messages[3]);
	});

	it("replaces tool-only messages with a stub", () => {
		const messages: AgentMessage[] = [
			msg("user", "read file"),
			toolCall("read"),
			toolCall("grep"),
			toolResult("result"),
			msg("assistant", "I used read and grep"),
			msg("user", "now do y"),
			msg("assistant", "done"),
		];
		const result = applyDynamicSlim(messages, { trailingTurns: 1, condenseStubs: false, dropOldUser: false });
		// Last user is "now do y" at index 5. Old: 0-4, kept: 5-6.
		// Indices 1-2 are toolCalls (dropped), 3 is toolResult (dropped), 4 is assistant with text (kept).
		// Index 0 is user (kept).
		// Result: user "read file", assistant "I used read and grep", user "now do y", assistant "done"
		expect(result).toHaveLength(4);
		expect(result[0].role).toBe("user");
		expect(result[1].role).toBe("assistant");
		expect((result[1] as any).content[0]).toEqual({ type: "text", text: "I used read and grep" });
		expect(result[2]).toEqual(messages[5]);
		expect(result[3]).toEqual(messages[6]);
	});

	it("drops old user messages when dropOldUser is true", () => {
		const messages: AgentMessage[] = [
			msg("user", "old question"),
			msg("assistant", "old answer"),
			msg("user", "another old"),
			msg("assistant", "another answer"),
			msg("user", "current"),
			msg("assistant", "current response"),
		];
		const result = applyDynamicSlim(messages, { trailingTurns: 1, condenseStubs: true, dropOldUser: true });
		// Last user is "current" at index 4. Old: 0-3, kept: 4-5.
		// Old users dropped, old assistants condensed to first line.
		expect(result).toHaveLength(4);
		expect(result[0].role).toBe("assistant"); // condensed "old answer"
		expect(result[1].role).toBe("assistant"); // condensed "another answer"
		expect(result[2]).toEqual(messages[4]); // "current"
		expect(result[3]).toEqual(messages[5]); // "current response"
	});

	it("empty messages array is a no-op", () => {
		const result = applyDynamicSlim([], { trailingTurns: 2, condenseStubs: false, dropOldUser: false });
		expect(result).toEqual([]);
	});

	it("returns original array when trailing window covers everything", () => {
		const messages: AgentMessage[] = [msg("user", "hi"), msg("assistant", "hello")];
		const result = applyDynamicSlim(messages, { trailingTurns: 3, condenseStubs: false, dropOldUser: false });
		expect(result).toEqual(messages);
	});
});
