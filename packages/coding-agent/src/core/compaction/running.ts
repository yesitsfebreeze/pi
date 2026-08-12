// running-compaction — after each turn, use the LLM to incrementally
// summarize the conversation, keeping the context window small. Stores
// a running summary string that gets updated with each new turn's
// messages, so the LLM doesn't re-summarize everything from scratch.
//
// This is separate from the cheap dynamic slimming (dynamic.ts) —
// running compaction pays for LLM calls but produces a high-quality
// condensed context that preserves decisions, facts, and state.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.ts";

const COMPACT_EVERY_TURNS = 2; // compact after every N new user messages

const SUMMARIZE_PROMPT = `Summarize the conversation below into a dense, structured checkpoint. Another LLM will read this summary to continue working — it must understand what happened, what was decided, what files were read or modified, what remains to be done, and any important context. Keep it under 500 words. Use bullet points.`;

const UPDATE_PROMPT = `Below is a conversation and a previous summary of earlier turns. Update the summary to incorporate the new conversation. Keep the same format — dense, structured, under 500 words, bullet points. The updated summary should be self-contained: a new LLM reading only the updated summary should understand everything it needs to continue.`;

export interface RunningCompactionState {
	/** The latest running summary (null before first compaction). */
	summary: string | null;
	/** Number of user messages processed since the last summary update. */
	turnsSinceLastSummary: number;
	/** Total user messages compacted so far. */
	totalCompacted: number;
}

/**
 * Check whether we should run a compaction now. Returns the messages to
 * compact (everything except the last user message and what follows it),
 * or null if not enough turns have passed.
 */
export function shouldCompact(messages: AgentMessage[], state: RunningCompactionState): AgentMessage[] | null {
	if (state.turnsSinceLastSummary < COMPACT_EVERY_TURNS) return null;

	// Find the last user message — that's the trailing turn we keep raw.
	// Everything before it gets compacted.
	let lastUserIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			lastUserIndex = i;
			break;
		}
	}

	if (lastUserIndex <= 0) return null;

	return messages.slice(0, lastUserIndex);
}

/**
 * Run an LLM summarization to compact the given messages into a summary.
 * If a previous summary exists, updates it incrementally.
 */
export async function runCompaction(
	messages: AgentMessage[],
	model: Model<any>,
	options: SimpleStreamOptions,
	previousSummary: string | null,
): Promise<{ summary: string; usage: { input: number; output: number } }> {
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeMessages(llmMessages);

	const prompt = previousSummary
		? `<conversation>\n${conversationText}\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${UPDATE_PROMPT}`
		: `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARIZE_PROMPT}`;

	const context: Context = {
		messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
	};

	const response = await completeSimple(model, context, {
		...options,
		cacheRetention: "none",
	});

	return {
		summary: response.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
		usage: { input: response.usage?.input ?? 0, output: response.usage?.output ?? 0 },
	};
}

function serializeMessages(messages: any[]): string {
	return messages
		.map((m) => {
			const role = m.role ?? "unknown";
			const text = (m.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			return `[${role}]: ${text}`;
		})
		.join("\n\n");
}

/**
 * Build the replacement message array: the running summary as a single user
 * message, followed by the latest un-compacted messages.
 */
export function buildCompactMessages(summary: string, trailingMessages: AgentMessage[]): AgentMessage[] {
	const summaryMsg: AgentMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: `<context-summary>\n${summary}\n</context-summary>\n\n(Above is a summary of the conversation so far. Continue from here.)`,
			},
		],
		timestamp: Date.now(),
	};
	return [summaryMsg, ...trailingMessages];
}
