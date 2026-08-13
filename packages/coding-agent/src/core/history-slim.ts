/**
 * History slim: drop old tool traffic from the context window.
 *
 * For turns older than the trailing window, tool calls and their results
 * are stripped from the message array that goes to the LLM. The session
 * file keeps the full trace unchanged.
 *
 * An assistant message that becomes empty after stripping is replaced with
 * a stub naming the tools it ran.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Strip tool traffic from messages older than `trailingWindow` turns.
 * A "turn" is a user or assistant message (not tool results).
 * Returns a new array; the original is not modified.
 */
export function slimToolTraffic(messages: AgentMessage[], trailingWindow: number): AgentMessage[] {
	if (trailingWindow <= 0 || messages.length === 0) return messages;

	// Walk from the END to count turns and determine the cutoff.
	let userAssistantCount = 0;
	let cutoffIndex = messages.length;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "user" || msg.role === "assistant") {
			userAssistantCount++;
			if (userAssistantCount > trailingWindow) {
				cutoffIndex = i + 1;
				break;
			}
		}
	}

	if (cutoffIndex >= messages.length) return messages;

	// Build the slimmed array. Everything before cutoffIndex gets tool
	// traffic stripped. Everything at or after cutoffIndex stays as-is.
	const result: AgentMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (i < cutoffIndex) {
			// Strip tool traffic from old turns
			if (msg.role === "assistant") {
				const toolCalls = msg.content.filter((c) => c.type === "toolCall");
				const nonToolContent = msg.content.filter((c) => c.type !== "toolCall");

				if (nonToolContent.length > 0 || toolCalls.length === 0) {
					// Keep text content, drop tool calls
					result.push({ ...msg, content: nonToolContent });
				} else {
					// All content was tool calls — make a stub
					const names = toolCalls
						.map((c) => (c.type === "toolCall" ? c.name : undefined))
						.filter(Boolean)
						.join(", ");
					result.push({
						...msg,
						content: [
							{
								type: "text",
								text: `[Used tools: ${names}]`,
							},
						],
					});
				}
			} else if (msg.role === "toolResult") {
			} else {
				result.push(msg);
			}
		} else {
			result.push(msg);
		}
	}

	return result;
}
