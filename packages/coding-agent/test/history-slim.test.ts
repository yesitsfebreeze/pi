/**
 * history-slim: slimToolTraffic strips tool traffic from old turns while
 * keeping the trailing window and all non-tool text. Proves the
 * CompactionSettings.historySlimWindow integration point.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { slimToolTraffic } from "../src/core/history-slim.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function assistantToolCall(name: string, text?: string): AgentMessage {
	const content: unknown[] = [{ type: "toolCall", name, input: {} }];
	if (text) content.push({ type: "text", text });
	return { role: "assistant", content: content as never } as unknown as AgentMessage;
}

function toolResult(name: string): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text: `result of ${name}` }],
		toolCallName: name,
	} as unknown as AgentMessage;
}

/** AgentMessage is a union; not every variant carries `content`. */
function contentOf(message: AgentMessage): Array<{ type: string; text?: string }> {
	return "content" in message ? (message.content as Array<{ type: string; text?: string }>) : [];
}

describe("slimToolTraffic", () => {
	it("returns messages unchanged when window is 0 or messages empty", () => {
		const msgs = [user("hi")];
		expect(slimToolTraffic(msgs, 0)).toBe(msgs);
		expect(slimToolTraffic([], 5)).toEqual([]);
	});

	it("keeps the trailing window verbatim", () => {
		const msgs: AgentMessage[] = [
			user("old question"),
			assistantToolCall("bash"),
			toolResult("bash"),
			user("new question"),
		];
		// Trailing window = 1 turn ("new question"). Everything before is slimmed.
		const out = slimToolTraffic(msgs, 1);
		// Last user message is preserved as-is.
		expect(out.at(-1)).toEqual(msgs.at(-1));
	});

	it("replaces an all-tool-call assistant turn with a stub naming the tools", () => {
		const msgs: AgentMessage[] = [
			assistantToolCall("bash"), // old turn 1
			toolResult("bash"),
			assistantToolCall("edit"), // old turn 2
			toolResult("edit"),
			user("keep me"), // turn — in the 1-turn trailing window
		];
		const out = slimToolTraffic(msgs, 1);
		// First assistant (all tool calls) becomes a stub naming the tool.
		const stub = out[0];
		expect(stub.role).toBe("assistant");
		const text = contentOf(stub)[0];
		expect(text.type).toBe("text");
		expect(text.text).toContain("bash");
		// Old tool calls are gone from the stubbed turn.
		expect(contentOf(stub).some((c) => c.type === "toolCall")).toBe(false);
	});

	it("keeps text content and drops only tool calls when an old turn has both", () => {
		const msgs: AgentMessage[] = [assistantToolCall("bash", "thinking aloud"), toolResult("bash"), user("keep me")];
		const out = slimToolTraffic(msgs, 1);
		const oldAssistant = out[0];
		expect(oldAssistant.role).toBe("assistant");
		const kept = contentOf(oldAssistant);
		expect(kept.some((c) => c.type === "text")).toBe(true);
		expect(kept.some((c) => c.type === "toolCall")).toBe(false);
	});

	it("leaves recent tool traffic intact within the trailing window", () => {
		const msgs: AgentMessage[] = [user("old"), user("new"), assistantToolCall("bash"), toolResult("bash")];
		// Trailing window = 2 turns ("new" user + assistant with toolCall).
		const out = slimToolTraffic(msgs, 2);
		// The toolCall and toolResult in the trailing window are preserved.
		expect(out.some((m) => m.role === "toolResult")).toBe(true);
		expect(out.some((m) => contentOf(m).some((c) => c.type === "toolCall"))).toBe(true);
	});
});
