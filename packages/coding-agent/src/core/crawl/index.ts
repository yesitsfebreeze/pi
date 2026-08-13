// crawl — web research / topic scoring, ported into pi core as an inline
// extension. `.pi/crawl/` at repo root is the single representation:
// `topics.json` config + `pages/<base64url>.json` records. Absent dir: the
// store is inert (reads return empty, writes create the dir on demand).
//
// Ported from the pi-crawl extension, which shelled out to the external
// `kern` CLI for every ingest/query/list/rescore/export/research operation
// and degraded to "kern not available" without it. The core port replaces
// kern with local file-per-page storage (store.ts), so crawl works with no
// external dependency. The pure-TS kernel (textclean, score, config,
// research keyword-matching) is unchanged; rescore/export/research were
// reworked off kern onto the local store.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { dir, listTopics, readConfig, setCrawlRoot, type Topic, writeConfig } from "./config.ts";
import { exportAll, exportTopic } from "./export.ts";
import { rescoreAll, rescoreTopic } from "./rescore.ts";
import { research } from "./research.ts";
import { scorePages } from "./score.ts";
import { countPages, ensureStore, ingestPage, listPages, queryPages } from "./store.ts";

const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

// ---------------------------------------------------------------------------
// Inline extension factory
// ---------------------------------------------------------------------------
export function createCrawlInlineExtension(): {
	name: string;
	factory: (pi: ExtensionAPI) => void;
} {
	return {
		name: "crawl",
		factory(pi: ExtensionAPI) {
			let root = process.cwd();
			let ui: ExtensionContext["ui"] | undefined;
			const STATUS_KEY = "crawl";

			function paint(): void {
				if (!existsSync(dir())) {
					ui?.setStatus?.(STATUS_KEY, undefined);
					return;
				}
				const topics = readConfig();
				const pages = countPages();
				ui?.setStatus?.(STATUS_KEY, `crawl ${topics.length} topics · ${pages} pages`);
			}

			// ── lifecycle ──────────────────────────────────────────────────
			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
				root = ctx?.cwd ?? root;
				setCrawlRoot(root);
				ui = ctx?.ui;
				paint();
			});

			pi.on("agent_settled", () => paint());

			pi.on("session_shutdown", () => {
				ui?.setStatus?.(STATUS_KEY, undefined);
				ui = undefined;
			});

			// Re-assert the repo root at the top of every call path — a tool
			// invoked after a session_start on a different cwd would otherwise
			// read the wrong store (the module singleton pitfall; see gantt).
			const latch = (ctx: ExtensionContext) => {
				root = ctx?.cwd ?? root;
				setCrawlRoot(root);
				ui = ctx?.ui ?? ui;
			};

			// ── tools ──────────────────────────────────────────────────────
			pi.registerTool({
				name: "crawl",
				label: "Crawl",
				description:
					"Crawl a URL into the local crawl store (.pi/crawl/pages/). Stores cleaned page text keyed by URL; re-crawling the same URL updates in place. " +
					"Returns a one-line confirmation with the page's object-id. No external dependency — pages live as JSON files in the repo.",
				promptSnippet: "Crawl a web page into the local crawl store",
				parameters: Type.Object({
					url: Type.String({ description: "URL to crawl" }),
					content: Type.Optional(
						Type.String({
							description: "raw page content (HTML or text) to ingest; omit to record only the URL",
						}),
					),
					topic: Type.Optional(Type.String({ description: "topic id to file under (defaults to uncategorized)" })),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const url = String(params?.url ?? "");
					if (!url) return out("error: url required");
					const content = String(params?.content ?? `Crawled: ${url}`);
					const topic = String(params?.topic ?? "uncategorized");
					const rec = ingestPage(url, content, topic);
					paint();
					return out(`Crawled ${url} → ${rec.object_id} (topic: ${topic})`);
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "crawl_score",
				label: "Crawl score",
				description:
					"Score pages for a topic by keyword + recency + hub relevance. Returns the top 20 ranked pages as JSON. " +
					"Scoring is a derived view — nothing is written; re-running with updated keywords re-ranks from the same pages.",
				promptSnippet: "Rank crawled pages for a topic",
				parameters: Type.Object({
					topic: Type.String({ description: "topic id to score" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const topic = String(params?.topic ?? "");
					if (!topic) return out("error: topic required");
					const scored = scorePages(queryPages(topic));
					return out(JSON.stringify(scored.slice(0, 20), null, 2));
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "crawl_rescore",
				label: "Crawl rescore",
				promptSnippet: "Re-score crawled pages for one topic or all",
				description:
					"Re-score crawled pages against current keywords. action per-topic (pass topic) or all topics (omit). " +
					"Returns a count; the scored view is not persisted — use crawl_score or crawl_export to consume it.",
				parameters: Type.Object({
					topic: Type.Optional(Type.String({ description: "topic to rescore (omit for all)" })),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const topic = params?.topic ? String(params.topic) : undefined;
					if (topic) {
						const pages = rescoreTopic(topic);
						return out(`Rescored topic "${topic}": ${pages.length} pages`);
					}
					const all = rescoreAll();
					let total = 0;
					for (const pages of all.values()) total += pages.length;
					return out(`Rescored all topics: ${total} pages across ${all.size} topics`);
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "crawl_export",
				label: "Crawl export",
				promptSnippet: "Export crawled pages as a markdown book",
				description:
					"Export crawled pages as markdown book files (one .md per page + index.md per topic). " +
					"Pass a topic to export one, omit for all. outDir defaults to .pi/crawl/books/.",
				parameters: Type.Object({
					topic: Type.Optional(Type.String({ description: "topic to export (omit for all)" })),
					outDir: Type.Optional(Type.String({ description: "output directory (defaults to .pi/crawl/books/)" })),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const topic = params?.topic ? String(params.topic) : undefined;
					const outDir = String(params?.outDir ?? "") || join(dir(), "books");
					mkdirSync(outDir, { recursive: true });
					if (topic) {
						const n = exportTopic(topic, outDir);
						return out(`Exported topic "${topic}": ${n} pages → ${outDir}`);
					}
					const results = exportAll(outDir);
					let total = 0;
					for (const n of results.values()) total += n;
					return out(`Exported all: ${total} pages → ${outDir}`);
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "crawl_research",
				label: "Crawl research",
				promptSnippet: "Seed research into the best-matching crawl topic",
				description:
					"Research a request by seeding the best-matching topic. Matches the request against topic keywords; " +
					"the seed is recorded in the local store under the matched topic so a later rescore/export surfaces it. " +
					"Returns a confirmation naming the matched topic, or the list of available topics if nothing matches.",
				parameters: Type.Object({
					request: Type.String({ description: "research request or question" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const request = String(params?.request ?? "");
					if (!request) return out("error: request required");
					ensureStore();
					return out(research(request));
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "crawl_list",
				label: "Crawl list",
				promptSnippet: "List crawled pages in the local store",
				description: "List crawled pages stored in the local crawl store (object-ids).",
				parameters: Type.Object({}),
				async execute(
					_id: string,
					_params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const pages = listPages();
					return out(pages.length ? pages.join("\n") : "No pages found");
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "crawl_topics",
				label: "Crawl topics",
				promptSnippet: "List crawl topics, or add one",
				description:
					"List configured crawl topics (id: label (keywords)). Add topics by editing .pi/crawl/topics.json, " +
					"or pass add: {id, label, keywords[]} to append one via this tool.",
				parameters: Type.Object({
					add: Type.Optional(
						Type.Object({
							id: Type.String(),
							label: Type.String(),
							keywords: Type.Array(Type.String()),
							seeds: Type.Optional(Type.Array(Type.String())),
						}),
					),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					if (params?.add) {
						const a = params.add as { id: string; label: string; keywords: string[]; seeds?: string[] };
						const topics = listTopics();
						if (topics.some((t) => t.id === a.id)) return out(`error: topic "${a.id}" already exists`);
						const t: Topic = { id: a.id, label: a.label, keywords: a.keywords, seeds: a.seeds };
						topics.push(t);
						writeConfig(topics);
						paint();
						return out(`Added topic "${a.id}"`);
					}
					const topics = readConfig();
					if (topics.length === 0) return out("No topics configured. Add topics in .pi/crawl/topics.json.");
					return out(topics.map((t) => `${t.id}: ${t.label} (${t.keywords.join(", ")})`).join("\n"));
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "crawl_status",
				label: "Crawl status",
				promptSnippet: "Show crawl store status: topics and page counts",
				description: "Show crawl status — topics, page counts per topic.",
				parameters: Type.Object({}),
				async execute(
					_id: string,
					_params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const topics = readConfig();
					const stats: string[] = [
						`store: ${existsSync(dir()) ? "local" : "empty"}`,
						`topics: ${topics.length}`,
						"",
					];
					for (const t of topics) stats.push(`${t.id}: ${countPages(t.id)} pages`);
					return out(stats.join("\n"));
				},
			} as ToolDefinition);
		},
	};
}
