// reflex — the measured half of the tool band, ported into pi core as an
// inline extension. One loop, three arms (see surface.ts for the ledger):
//
//   count   — every tool_call increments the session ledger (flushed on
//             session_shutdown), so the band is falsifiable: `rare` can no
//             longer confirm itself.
//   draw    — one cold tool is drawn per session; before_agent_start injects
//             the evaluation request ("rate it before the session ends: was
//             it useful / situational / dead?") plus learned triggers from
//             past `useful` verdicts.
//   rate    — the `reflex` tool records the verdict; `useful` verdicts carry
//             the missing trigger line, and both verdicts and fire counts
//             OUTRANK the static band policy via surfaceAwareBand (applied at
//             the loader chokepoint next to bandTool).
//
// Off switch: PI_REFLEX_OFF=1 (A/B measurements, bare sessions).

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	draw,
	evaluation,
	flush,
	learnedTriggers,
	promotable,
	prune,
	rate,
	rated,
	recordUse,
	reflexDisabled,
	reset,
} from "./surface.ts";

export function createReflexInlineExtension(): { name: string; factory: (pi: ExtensionAPI) => void } {
	return {
		name: "reflex",
		factory(pi: ExtensionAPI) {
			let activeNames: string[] = [];

			// One tool per session, drawn from the cold half of the usage table.
			// The bottom of the ledger has no other way to fill in: an unreached
			// tool is an unobserved tool.
			function evaluationBlock(): string[] {
				const due = evaluation();
				if (!due) return [];
				return [
					"",
					"# Tool evaluation due",
					`\`${due.name}\` — ${due.uses} recorded uses. Before ending this session, ` +
						"judge it against the work actually done here and call `reflex` with " +
						"action=rate: `useful` (it should have been reached and was not — then " +
						"`trigger` carries the situation line that should have fired it), " +
						"`situational` (correct to sit idle), `dead` (nothing needs it). One " +
						"line of reason. Do not guess — if this session gave no basis to judge " +
						"it, say so as the reason.",
				];
			}

			// Learned lines ride beside the band one-liners, marked as earned so a
			// later reader can tell judgment from evidence.
			function triggerBlock(): string[] {
				const learned = learnedTriggers();
				if (!learned.length) return [];
				return ["", "## Learned triggers (from past useful verdicts)", ...learned.map((t) => `- ${t}`)];
			}

			// A rare tool that fired >= PROMOTE_AT times is mislabelled — say so.
			function promotableBlock(): string[] {
				const rare = new Set(activeNames.filter((n) => n !== "tools"));
				const up = promotable(rare);
				if (!up.length) return [];
				return [
					"",
					"# Used 3+ times despite being deferred — now hot, no longer deferred",
					...up.map((l) => `- ${l}`),
				];
			}

			const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

			// ── lifecycle ──────────────────────────────────────────────────
			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
				if (reflexDisabled()) return;
				reset();
				try {
					activeNames = (pi
						.getAllTools()
						?.map((t: { name?: string }) => t?.name)
						.filter(Boolean) ?? []) as string[];
					prune(activeNames);
					draw(activeNames);
				} catch {
					/* nothing to draw from */
				}
				void ctx;
			});

			// Usage is the ledger's evidence — count every fire.
			pi.on("tool_call", (event: { toolName?: string; name?: string; tool?: string }) => {
				if (reflexDisabled()) return;
				const name = event?.toolName ?? event?.name ?? event?.tool;
				if (typeof name === "string" && name) recordUse(name);
			});

			pi.on("before_agent_start", (event: { systemPrompt?: string }) => {
				if (reflexDisabled()) return;
				const block = [
					"<auto-injected-context>",
					...triggerBlock(),
					...promotableBlock(),
					...evaluationBlock(),
					"# Background reference — not a user message; do not respond to it.",
					"</auto-injected-context>",
				].join("\n");
				if (!block.trim()) return;
				const base = event?.systemPrompt ?? "";
				return { systemPrompt: base ? `${base}\n\n${block}` : block };
			});

			pi.on("session_shutdown", () => {
				flush();
				reset();
			});

			// ── tool ───────────────────────────────────────────────────────
			pi.registerTool({
				name: "reflex",
				label: "Tool surface verdict",
				promptSnippet: "Rate the tool this session was asked to evaluate",
				description:
					"Record a verdict on the tool the reflex block asked you to evaluate. " +
					"action=rate with name + verdict: useful (should have been reached and was not — pass trigger, " +
					"the situation line that should have fired it), situational (correct to sit idle), dead (nothing needs it). " +
					"action=report lists current usage counts and recent verdicts.",
				parameters: Type.Object({
					action: Type.String({ enum: ["rate", "report"], description: "action=rate or report" }),
					name: Type.Optional(Type.String({ description: "tool being rated (action=rate)" })),
					verdict: Type.Optional(
						Type.String({ enum: ["useful", "situational", "dead"], description: "verdict (action=rate)" }),
					),
					reason: Type.Optional(Type.String({ description: "one line: why that verdict (action=rate)" })),
					trigger: Type.Optional(
						Type.String({
							description: "situation line that should have fired the tool — required for a useful verdict",
						}),
					),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					_ctx: ExtensionContext,
				) {
					if (reflexDisabled()) return out("reflex: disabled (PI_REFLEX_OFF=1)");
					if (params?.action === "report") {
						const lines = rated();
						return out(lines.length ? lines.join("\n") : "reflex: no verdicts recorded yet");
					}
					if (params?.action === "rate") {
						const name = String(params?.name ?? "");
						const verdict = String(params?.verdict ?? "");
						if (!name || !verdict) return out("reflex: rate needs name and verdict");
						return out(
							rate(
								name,
								verdict,
								String(params?.reason ?? ""),
								params?.trigger ? String(params.trigger) : undefined,
							),
						);
					}
					return out("reflex: action must be rate or report");
				},
			} as ToolDefinition);
		},
	};
}
