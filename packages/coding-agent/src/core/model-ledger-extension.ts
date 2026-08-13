/**
 * Model-ledger extension — registers the `/model-ledger` command and
 * periodic stale-ledge refresh. The ledger itself lives in model-ledger.ts.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand } from "./extensions/types.ts";
import {
	catalogSignature,
	classifyAll,
	isLedgerStale,
	type LedgerEntry,
	type LedgerTier,
	MODEL_LEDGER_PATH,
	MODEL_LEDGER_TTL_MS,
	type ModelLedgerData,
	modelKey,
	pickRefinerModel,
	readLedger,
	refineWithModel,
	writeLedger,
} from "./model-ledger.ts";
import type { ModelRegistry } from "./model-registry.ts";

function formatAge(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

function tierLabel(tier: LedgerTier): string {
	switch (tier) {
		case "fast":
			return "fast (cheap/mechanical)";
		case "balanced":
			return "balanced (workhorse)";
		case "frontier":
			return "frontier (hard reasoning)";
		case "embedder":
			return "embedder";
	}
}

function ledgerStatus(ledger: ModelLedgerData | undefined, signature: string, now: number): string {
	const lines: string[] = [];
	if (!ledger) {
		lines.push("No ledger yet — run `/model-ledger refresh` to build one.");
	} else {
		lines.push(
			`Ledger: ${Object.keys(ledger.entries).length} models`,
			`  source: ${ledger.source}`,
			`  generated: ${new Date(ledger.generatedAt).toISOString()} (${formatAge(now - ledger.generatedAt)} ago)`,
			`  ttl: ${formatAge(MODEL_LEDGER_TTL_MS)}`,
		);
		const counts: Record<string, number> = {};
		for (const e of Object.values(ledger.entries)) {
			counts[e.tier] = (counts[e.tier] ?? 0) + 1;
		}
		const tierLines = ["fast", "balanced", "frontier", "embedder"]
			.filter((t) => counts[t])
			.map((t) => `  ${t}: ${counts[t]}`);
		if (tierLines.length) lines.push(...tierLines);
		lines.push(`  file: ${MODEL_LEDGER_PATH}`);
	}
	if (isLedgerStale(ledger, signature, now)) {
		lines.push("", `Ledger is stale (catalog changed or TTL exceeded). Run \`/model-ledger refresh\` to update.`);
	}
	return lines.join("\n");
}

function ledgerShow(ledger: ModelLedgerData | undefined, models: readonly Model<Api>[]): string {
	if (!ledger) return "No ledger yet. Run `/model-ledger refresh` to build one.";
	const entries = ledger.entries;
	const tiers: LedgerTier[] = ["frontier", "balanced", "fast", "embedder"];
	const grouped = new Map<LedgerTier, Array<{ key: string; entry: LedgerEntry; model: Model<Api> | undefined }>>();
	for (const model of models) {
		const key = modelKey(model);
		const entry = entries[key];
		if (!entry) continue;
		if (!grouped.has(entry.tier)) grouped.set(entry.tier, []);
		grouped.get(entry.tier)!.push({ key, entry, model });
	}

	const lines: string[] = [];
	for (const tier of tiers) {
		const items = grouped.get(tier);
		if (!items || items.length === 0) continue;
		lines.push(`## ${tierLabel(tier)}`);
		items.sort((a, b) => (a.key < b.key ? -1 : 1));
		for (const { key, model } of items) {
			const cost = model?.cost?.input;
			const costStr = typeof cost === "number" && Number.isFinite(cost) ? `  $${cost}/M` : "";
			lines.push(`  ${key}${costStr}`);
		}
		lines.push("");
	}
	return lines.length ? lines.join("\n") : "Ledger has no entries matching the available models.";
}

export function createModelLedgerExtension(): {
	name: string;
	factory: (pi: ExtensionAPI) => void;
} {
	return {
		name: "model-ledger",
		factory(pi: ExtensionAPI) {
			let registry: ModelRegistry | undefined;
			let ui: ExtensionCommandContext["ui"] | undefined;

			// ── lifecycle ──────────────────────────────────────────────────
			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
				registry = ctx?.modelRegistry ?? registry;
				ui = ctx?.ui;
				// Kick a non-blocking staleness check — if stale, refresh in the
				// background so the ledger is fresh next time someone looks.
				if (!registry) return;
				const available = registry.getAvailable();
				const sig = catalogSignature(available);
				const ledger = readLedger();
				if (isLedgerStale(ledger, sig)) {
					// Rules only, and only locally: classifyAll is pure metadata, costs
					// nothing and answers the question for every model in the catalog.
					//
					// This used to also fire an LLM refinement in the background on every
					// stale session start — a whole completion, against whatever model
					// pickRefinerModel happened to choose (the session's own paid model
					// included), for a categorization the user never asked for and may
					// never look at. It was invisible: no status line, no cost attribution,
					// and it raced with the session's first real turn.
					//
					// `/model-ledger refresh` still runs the LLM pass, explicitly, when
					// someone actually wants the refined tiers.
					const entries = classifyAll(available);
					writeLedger({
						version: 1,
						generatedAt: Date.now(),
						catalogSignature: sig,
						source: "rules",
						entries,
					});
				}
			});

			pi.on("session_shutdown", () => {
				ui = undefined;
				registry = undefined;
			});

			// ── command: /model-ledger ─────────────────────────────────────
			pi.registerCommand("model-ledger", {
				description:
					"model ledger: show | refresh (rebuild the categorized model list) | /model-ledger alone for status",
				handler: async (args: string, ctx: ExtensionCommandContext) => {
					registry = ctx?.modelRegistry ?? registry;
					ui = ctx?.ui ?? ui;
					const tokens = args.trim().split(/\s+/).filter(Boolean);
					const action = tokens[0] ?? "status";

					if (!registry) {
						ui?.notify?.("model-ledger: model registry not available", "error");
						return;
					}
					const available = registry.getAvailable();
					const sig = catalogSignature(available);

					if (action === "refresh") {
						ui?.notify?.("model-ledger: rebuilding…", "info");
						// Rules first — instant.
						const entries = classifyAll(available);
						writeLedger({ version: 1, generatedAt: Date.now(), catalogSignature: sig, source: "rules", entries });
						ui?.notify?.("model-ledger: rules-based ledger saved. Trying LLM refinement…", "info");
						// LLM refine.
						const refiner = pickRefinerModel(available);
						if (refiner) {
							try {
								const refined = await refineWithModel(registry, refiner, available);
								writeLedger({
									version: 1,
									generatedAt: Date.now(),
									catalogSignature: sig,
									source: "model",
									entries: refined,
								});
								ui?.notify?.(`model-ledger: refreshed (LLM) — ${Object.keys(refined).length} models`, "info");
							} catch (err) {
								ui?.notify?.(
									`model-ledger: LLM refinement failed (${err instanceof Error ? err.message : err}), using rules-based fallback`,
									"warning",
								);
							}
						} else {
							ui?.notify?.(
								"model-ledger: no available model for LLM refinement, rules-based fallback saved",
								"warning",
							);
						}
						return;
					}

					if (action === "show") {
						const ledger = readLedger();
						ui?.notify?.(ledgerShow(ledger, available), "info");
						return;
					}

					// Default: status.
					ui?.notify?.(ledgerStatus(readLedger(), sig, Date.now()), "info");
				},
			} satisfies Omit<RegisteredCommand, "name" | "sourceInfo">);
		},
	};
}
