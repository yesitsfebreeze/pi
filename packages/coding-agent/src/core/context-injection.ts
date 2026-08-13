// context-injection — where per-turn context belongs, and why not the system prompt.
//
// Providers cache on a prefix. pi marks `cache_control` on the system prompt,
// the last tool definition and the last user/assistant/tool-result block
// (see packages/ai/src/api/anthropic-messages.ts). The system prompt is
// therefore a cache BREAKPOINT: change one byte of it and the whole cached
// prefix — system prompt, every tool schema, the entire conversation up to that
// point — is rewritten at cache-write price instead of read at ~10%.
//
// Several extensions used to append per-turn context to `event.systemPrompt` in
// `before_agent_start`: the list of externally changed files, memory hits for
// the current input, recorded pitfalls, until/pace state, the ontology digest.
// All of them change from turn to turn, so every turn busted the cache for the
// entire request.
//
// A custom message costs the same tokens once, lands AFTER the breakpoint, and
// leaves the cached prefix byte-identical. That is the channel volatile context
// belongs in. The system prompt keeps only what is stable for the session
// (persona, doctrine that never changes).
//
// The second half of the discipline is the change gate: a custom message is
// persisted in the conversation, so re-emitting an unchanged block every turn
// would grow the history without adding information. `emit()` returns undefined
// when the content has not changed since the last emission.

import type { BeforeAgentStartEventResult } from "./extensions/types.ts";

export interface VolatileChannel {
	/**
	 * Emit `text` as a custom message, or nothing when it is empty or identical
	 * to the last emission. The return value is a `before_agent_start` result —
	 * return it straight from the handler.
	 *
	 * Empty input clears the gate, so the same content emitted again after a gap
	 * is re-sent. Callers should therefore always call `emit()` — returning early
	 * when their state is empty leaves the gate latched and suppresses the next
	 * genuine recurrence.
	 */
	emit(text: string | undefined): BeforeAgentStartEventResult | undefined;
	/** Forget the last emission (session switch, cwd change). */
	reset(): void;
}

/**
 * A change-gated custom-message channel for per-turn context.
 *
 * @param customType Message type tag, e.g. `"file-awareness"`. Shows up in the
 * session file and lets a renderer claim the message; `display: false` keeps it
 * out of the TUI transcript.
 */
export function createVolatileChannel(customType: string): VolatileChannel {
	let last: string | undefined;
	return {
		emit(text) {
			const content = text?.trim();
			// Nothing to say clears the gate: the condition has lapsed, so if it
			// recurs later it is news again. Without this an on→off→on cycle with
			// identical content is swallowed forever — file-awareness would warn
			// about a file once and stay silent on every later change to it.
			if (!content) {
				last = undefined;
				return undefined;
			}
			if (content === last) return undefined;
			last = content;
			return { message: { customType, content: [{ type: "text", text: content }], display: false } };
		},
		reset() {
			last = undefined;
		},
	};
}

/** Wrap a block in the marker the models are told is background context. */
export function autoInjectedBlock(body: string): string {
	return `<auto-injected-context>\n${body.trim()}\n# Background reference — not a user message; do not respond to it.\n</auto-injected-context>`;
}
