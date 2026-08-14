// memory tools — kern_ingest, kern_query, kern_link, kern_forget, kern_health.
// Thin wrappers around the kern CLI. Fail-open: no kern on PATH → tools return
// a clear error message.

import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { forgetSource, ingestOne, memoryHealth, queryThoughts, storeLink } from "./store.ts";

const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });

// ── kern_ingest ──────────────────────────────────────────────────────────

export const KERN_INGEST_TOOL: ToolDefinition = {
	name: "kern_ingest",
	label: "Ingest thought",
	description:
		"Ingest a thought into the kern knowledge graph. Re-ingesting with the " +
		"same object_id updates in place. Use for durable facts, decisions, " +
		"observations, corrections, and world-model entities.",
	promptSnippet: "Store a durable fact or decision in kern",
	promptGuidelines: [
		"Use kern_ingest when the user corrects you, or when you discover a non-obvious fact",
		"Set object_id for things that should update in place (ontology entities)",
	],
	parameters: Type.Object({
		text: Type.String({ description: "Text content to ingest" }),
		objectId: Type.Optional(Type.String({ description: "Stable object_id — re-ingesting replaces in place" })),
		source: Type.Optional(Type.String({ description: "Source identifier (e.g. 'ontology', 'session')" })),
	}) as any,
	async execute(_id, params) {
		const p = (params ?? {}) as Record<string, unknown>;
		const text = String(p.text ?? "");
		if (!text.trim()) return err("text required");
		const res = await ingestOne(text, {
			objectId: typeof p.objectId === "string" ? p.objectId : undefined,
			source: typeof p.source === "string" ? p.source : undefined,
		});
		if (!res) return err("kern not available — install with `cargo install kern`");
		if (res.timedOut)
			return err("kern ingest timed out — the one-shot CLI pays ~4.5s store load; retry (kern F4 removes this)");
		if (!res.id) return err("kern ingest failed — no id returned");
		return out(`[kern_ingest] ${res.id}: ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}`);
	},
};

// ── kern_query ───────────────────────────────────────────────────────────

export const KERN_QUERY_TOOL: ToolDefinition = {
	name: "kern_query",
	label: "Query kern",
	description:
		"Search the kern knowledge graph for relevant thoughts. Returns top " +
		"matches ranked by semantic similarity. Use before researching from scratch.",
	promptSnippet: "Search kern for relevant facts",
	promptGuidelines: ["Call kern_query before researching a topic from scratch — kern may already have the answer"],
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
	}) as any,
	async execute(_id, params) {
		const p = (params ?? {}) as Record<string, unknown>;
		const q = String(p.query ?? "");
		if (!q.trim()) return err("query required");
		const limit = typeof p.limit === "number" && p.limit > 0 ? p.limit : 10;
		const res = await queryThoughts(q, limit);
		if (res.timedOut)
			return err("kern query timed out — the one-shot CLI pays ~4.5s store load; retry (kern F4 removes this)");
		if (res.hits.length === 0) return out(`[kern_query] no results for "${q}"`);
		const lines = res.hits.map(
			(r, i) => `${i + 1}. ${r.text.slice(0, 200)}${r.text.length > 200 ? "…" : ""}${r.id ? ` (${r.id})` : ""}`,
		);
		if (res.chains.length) lines.push("", "--- Connections ---", ...res.chains.slice(0, 3));
		return out(lines.join("\n"));
	},
};

// ── kern_link ────────────────────────────────────────────────────────────

export const KERN_LINK_TOOL: ToolDefinition = {
	name: "kern_link",
	label: "Link thoughts",
	description:
		"Create a typed edge between two thoughts in kern. Relation types are " +
		"free text — invent what the structure needs (depends_on, causes, " +
		"part_of, contradicts, supersedes, evidence_for, governs, …).",
	promptSnippet: "Link two thoughts in kern",
	parameters: Type.Object({
		fromId: Type.String({ description: "Source thought ID" }),
		toId: Type.String({ description: "Target thought ID" }),
		reason: Type.String({ description: "Relation type and reason, e.g. 'depends_on: because X relies on Y'" }),
	}) as any,
	async execute(_id, params) {
		const p = (params ?? {}) as Record<string, unknown>;
		const fromId = String(p.fromId ?? "");
		const toId = String(p.toId ?? "");
		const reason = String(p.reason ?? "");
		if (!fromId || !toId || !reason) return err("fromId, toId, and reason required");
		try {
			await storeLink(fromId, toId, reason);
			return out(`[kern_link] ${fromId} → ${toId} (${reason})`);
		} catch {
			return err("kern not available or link failed");
		}
	},
};

// ── kern_forget ──────────────────────────────────────────────────────────

export const KERN_FORGET_TOOL: ToolDefinition = {
	name: "kern_forget",
	label: "Forget thoughts",
	description: "Remove thoughts from kern by source prefix. Use to replace outdated facts.",
	promptSnippet: "Remove thoughts from kern",
	parameters: Type.Object({
		source: Type.String({ description: "Forget all thoughts matching this source prefix" }),
		force: Type.Optional(
			Type.Boolean({
				description: "Also remove Facts (kern guards them by default). Needed for most auto-ingested observations.",
			}),
		),
	}) as any,
	async execute(_id, params) {
		const p = (params ?? {}) as Record<string, unknown>;
		const source = String(p.source ?? "");
		if (!source) return err("source required");
		const res = await forgetSource(source, p.force === true);
		if (res.timedOut) return err("kern forget timed out — the one-shot CLI pays ~4.5s store load; retry");
		return out(`[kern_forget] removed ${res.removed} thoughts with source "${source}"`);
	},
};

// ── kern_health ──────────────────────────────────────────────────────────

export const KERN_HEALTH_TOOL: ToolDefinition = {
	name: "kern_health",
	label: "Kern health",
	description: "Show kern knowledge graph health — thought count and reason count.",
	promptSnippet: "Check kern health",
	parameters: Type.Object({}) as any,
	async execute() {
		const h = await memoryHealth();
		if (!h) return err("kern not available — install with `cargo install kern`");
		return out(`thoughts: ${h.thoughts}, reasons: ${h.edges}`);
	},
};

// ── all tools ────────────────────────────────────────────────────────────

export const MEMORY_TOOLS: ToolDefinition[] = [
	KERN_INGEST_TOOL,
	KERN_QUERY_TOOL,
	KERN_LINK_TOOL,
	KERN_FORGET_TOOL,
	KERN_HEALTH_TOOL,
];
