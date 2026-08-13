/**
 * Model ledger — a persisted, categorized view of the models that are actually
 * available right now.
 *
 * Two questions answered in one place:
 *   1. Which models work (the model runtime already knows availability — the
 *      ledger records a *categorized* snapshot of exactly that set).
 *   2. Which job each model is best for: a tier (`fast` / `balanced` /
 *      `frontier` / `embedder`) plus tags (`vision`, `large-context`).
 *
 * Categories come from two sources, merged:
 *   - `rebuildFromRules` — deterministic classification from model metadata.
 *     Always works, offline, instant; used as the fallback.
 *   - `refreshWithModel` — asks a cheap always-available model to re-derive the
 *     tiers. This is what makes the categories "actually reasonable" rather than
 *     a coarse heuristic. Run on demand via `/model-ledger refresh` and lazily
 *     when the ledger is stale.
 *
 * The ledger only covers *available* models (models whose provider has
 * credentials). That is the set `/model` shows and crew dispatches, so it is the
 * only set worth categorizing.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import type { ModelRegistry } from "./model-registry.ts";

export type LedgerTier = "embedder" | "fast" | "balanced" | "frontier";
export type LedgerTag = "vision" | "large-context";

const LEDGER_TIERS: readonly LedgerTier[] = ["embedder", "fast", "balanced", "frontier"];
const LEDGER_TAGS: readonly LedgerTag[] = ["vision", "large-context"];

/** Role → tier. Crew profiles declare a `role`; the ledger resolves it to a tier. */
export const ROLE_TO_TIER: Record<string, LedgerTier> = {
	embedder: "embedder",
	fast: "fast",
	balanced: "balanced",
	frontier: "frontier",
};

export interface LedgerEntry {
	tier: LedgerTier;
	tags: LedgerTag[];
}

export interface ModelLedgerData {
	version: 1;
	generatedAt: number;
	/** Signature of the available model set this ledger was built from. */
	catalogSignature: string;
	/** How the categories were derived: "rules" (metadata heuristic) or "model" (LLM). */
	source: "rules" | "model";
	/** `provider/id` → entry. */
	entries: Record<string, LedgerEntry>;
}

export const MODEL_LEDGER_PATH = join(getAgentDir(), "models-ledger.json");

/** Default staleness window: a ledger older than this is re-derived on next use. */
export const MODEL_LEDGER_TTL_MS = Number(process.env.MODEL_LEDGER_TTL_MS) || 7 * 24 * 60 * 60 * 1000;

export function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function catalogSignature(models: readonly Model<Api>[]): string {
	const key = models
		.map((m) => modelKey(m))
		.sort()
		.join("\n");
	return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/** Cost per million input tokens, or Infinity when unknown. */
function inputCost(model: Model<Api>): number {
	const cost = model.cost?.input;
	return typeof cost === "number" && Number.isFinite(cost) ? cost : Infinity;
}

/**
 * Deterministic metadata classification.
 *
 * Rules are deliberately coarse — this is the offline fallback, refined by the
 * LLM pass. Tiers:
 *   - embedder: model id/name signals embeddings (none in the current catalog).
 *   - fast: non-reasoning models, or reasoning models cheap enough for
 *     mechanical work (input < $0.30/M).
 *   - frontier: reasoning models with a very large context window and a premium
 *     price — the "hard work" tier.
 *   - balanced: every other reasoning model (the workhorse default).
 */
export function classifyModel(model: Model<Api>): LedgerEntry {
	const tags: LedgerTag[] = [];
	if (model.input?.includes("image")) tags.push("vision");
	if ((model.contextWindow ?? 0) >= 1_000_000) tags.push("large-context");

	const name = `${model.name ?? ""} ${model.id}`.toLowerCase();
	const isEmbedder = /embed|rerank|moderat/i.test(name);

	let tier: LedgerTier;
	if (isEmbedder) tier = "embedder";
	else if (!model.reasoning || inputCost(model) < 0.3) tier = "fast";
	else if ((model.contextWindow ?? 0) >= 1_000_000 && inputCost(model) >= 2) tier = "frontier";
	else tier = "balanced";

	return { tier, tags };
}

export function classifyAll(models: readonly Model<Api>[]): Record<string, LedgerEntry> {
	const entries: Record<string, LedgerEntry> = {};
	for (const model of models) entries[modelKey(model)] = classifyModel(model);
	return entries;
}

/** Cheapest available model in the given tier, by input cost then larger context. */
function cheapestInTier(
	models: readonly Model<Api>[],
	entries: Record<string, LedgerEntry>,
	tier: LedgerTier,
): Model<Api> | undefined {
	let best: Model<Api> | undefined;
	let bestCost = Infinity;
	let bestWindow = -1;
	for (const model of models) {
		if (entries[modelKey(model)]?.tier !== tier) continue;
		const cost = inputCost(model);
		const window = model.contextWindow ?? 0;
		if (cost < bestCost || (cost === bestCost && window > bestWindow)) {
			best = model;
			bestCost = cost;
			bestWindow = window;
		}
	}
	return best;
}

/**
 * Resolve a crew role to the cheapest available model in that tier.
 *
 * Falls back (in order): exact tier → any balanced model → any available model.
 * Never returns a model whose provider lacks credentials, because `models` is
 * already the available set.
 */
export function pickForRole(
	role: string | undefined,
	models: readonly Model<Api>[],
	entries: Record<string, LedgerEntry>,
): Model<Api> | undefined {
	if (models.length === 0) return undefined;
	const tier = ROLE_TO_TIER[role ?? "balanced"] ?? "balanced";
	return cheapestInTier(models, entries, tier) ?? cheapestInTier(models, entries, "balanced") ?? models[0];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function readLedger(path: string = MODEL_LEDGER_PATH): ModelLedgerData | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as ModelLedgerData;
		if (parsed?.version !== 1 || typeof parsed.entries !== "object") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function writeLedger(data: ModelLedgerData, path: string = MODEL_LEDGER_PATH): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2));
}

export function isLedgerStale(
	ledger: ModelLedgerData | undefined,
	signature: string,
	now: number = Date.now(),
): boolean {
	if (!ledger) return true;
	if (ledger.catalogSignature !== signature) return true;
	return now - ledger.generatedAt > MODEL_LEDGER_TTL_MS;
}

// ---------------------------------------------------------------------------
// LLM-assisted refinement
// ---------------------------------------------------------------------------

const CATEGORY_PROMPT = (catalog: string): string =>
	[
		"You are a model-availability ledger. Given the list of models below (provider/id, name, reasoning, image input, context window, input cost $/M), assign each a single tier and optional tags.",
		"",
		"Tiers (choose exactly one per model):",
		"- embedder: embedding/reranking models (none of the listed models are embedders).",
		"- fast: cheap/quick models for mechanical work (scouting, small edits, search).",
		"- balanced: general workhorse for implementation and review.",
		"- frontier: best reasoning for hard problems, large refactors, deep design.",
		"",
		"Tags (optional, any subset):",
		"- vision: model accepts image input.",
		"- large-context: context window >= 1,000,000 tokens.",
		"",
		'Respond with ONLY a JSON object mapping "provider/id" to {"tier": string, "tags": string[]}. No prose.',
		"",
		catalog,
	].join("\n");

function modelCatalogLine(model: Model<Api>): string {
	const cost = inputCost(model);
	return [
		modelKey(model),
		`name=${model.name}`,
		`reasoning=${model.reasoning}`,
		`image=${model.input?.includes("image") ?? false}`,
		`context=${model.contextWindow ?? 0}`,
		`cost=${Number.isFinite(cost) ? cost : "unknown"}`,
	].join(" | ");
}

function extractJson(text: string): string {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return "";
	return text.slice(start, end + 1);
}

function sanitizeEntry(value: unknown): LedgerEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const tier = LEDGER_TIERS.find((t) => t === raw.tier);
	if (!tier) return undefined;
	const tags: LedgerTag[] = Array.isArray(raw.tags)
		? raw.tags.filter((t): t is LedgerTag => (LEDGER_TAGS as readonly string[]).includes(String(t)))
		: [];
	return { tier, tags };
}

/**
 * Ask `model` to re-derive the ledger for `models`, merged over the rule-based
 * fallback. Returns the merged entries; never throws — on any failure the
 * rule-based entries are returned unchanged.
 */
export async function refineWithModel(
	registry: ModelRegistry,
	model: Model<Api>,
	models: readonly Model<Api>[],
): Promise<Record<string, LedgerEntry>> {
	const fallback = classifyAll(models);
	const catalog = models.map(modelCatalogLine).join("\n");
	try {
		const message = await registry.complete(model, {
			systemPrompt: "You are a concise, JSON-only classifier.",
			messages: [{ role: "user", content: CATEGORY_PROMPT(catalog), timestamp: Date.now() }],
		});
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const parsed = JSON.parse(extractJson(text)) as Record<string, unknown>;
		const merged: Record<string, LedgerEntry> = { ...fallback };
		for (const [key, value] of Object.entries(parsed)) {
			const entry = sanitizeEntry(value);
			if (entry) merged[key] = entry;
		}
		return merged;
	} catch {
		return fallback;
	}
}

/**
 * Pick the cheapest available model to run the refinement itself. This is the
 * "one basic model that is always available": prefer a fast-tier model, else
 * the cheapest available model, else the caller's fallback.
 */
export function pickRefinerModel(models: readonly Model<Api>[]): Model<Api> | undefined {
	// Same ladder as the "fast" role — keep it in one place so the two cannot drift.
	return pickForRole("fast", models, classifyAll(models));
}
