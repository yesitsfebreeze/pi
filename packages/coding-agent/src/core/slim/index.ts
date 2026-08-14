// slim — the window leaves a trace: every tool-using turn is distilled to ONE
// line and stored, so "how did we do X" stays fetchable after the context
// window (and compaction) moves on.
//
// Ported from reflex's slim module. Core already compacts history away; slim
// is the retention half — at turn_end, the tool names and the assistant's
// closing line become a single observation in the memory store (kern), keyed
// `slim turn N`, retrievable with `kern_query slim`. No tools, no commands,
// no status: pure hook + one store call, fail-open when kern is absent and
// off-switchable with PI_SLIM_OFF=1.

import type { ExtensionAPI, InlineExtension, TurnEndEvent } from "../extensions/types.ts";

const OUTCOME_MAX = 120;
const MAX_TOOLS = 8;

function slimDisabled(): boolean {
	return process.env.PI_SLIM_OFF === "1" || process.env.PI_SLIM_OFF === "true";
}

/** The assistant's last text block, flattened — the "outcome" of the turn. */
function lastOutcome(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	for (let i = content.length - 1; i >= 0; i--) {
		const b = content[i] as { type?: string; text?: string } | undefined;
		if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
			const flat = b.text.replace(/\s+/g, " ").trim();
			if (!flat) continue;
			return flat.length > OUTCOME_MAX ? `${flat.slice(0, OUTCOME_MAX - 1)}…` : flat;
		}
	}
	return null;
}

export function createSlimInlineExtension(): InlineExtension {
	return {
		name: "slim",
		hidden: true,
		factory(pi: ExtensionAPI) {
			pi.on("turn_end", (event: TurnEndEvent) => {
				if (slimDisabled()) return;
				const results = event.toolResults ?? [];
				if (results.length === 0) return; // prose-only turn — nothing to remember

				const names = [...new Set(results.map((r) => r.toolName).filter(Boolean))] as string[];
				const shown = names.slice(0, MAX_TOOLS).join(", ") + (names.length > MAX_TOOLS ? ", …" : "");
				const failed = results.filter((r) => r.isError).length;
				const outcome =
					lastOutcome((event.message as { content?: unknown }).content) ??
					(failed ? `failed ${failed}/${results.length} tool calls` : "(no text)");

				const title = `slim turn ${event.turnIndex ?? "?"}`;
				const text = `${title}: ${shown} → ${outcome}`;
				// Only remember turns with something durable: a failure, or a real
				// outcome. A successful silent turn ("read → (no text)") is pure
				// noise — 96% of the llm store was exactly that class of dump
				// (RECALL_PLAN F2b). The durable record lives in <kern> blocks and
				// storeDecision; this hook is for what a turn proved, not that it ran.
				if (failed === 0 && (outcome === "(no text)" || outcome === "")) return;
				// Best-effort, fire-and-forget; the memory extension publishes __kern
				// with storeObservation (kern CLI, fail-open when absent).
				const kern = (globalThis as any).__kern;
				kern?.storeObservation?.(title, text, [`tools: ${shown}`, `failed: ${failed}`])?.catch?.(() => {});
			});
		},
	};
}
