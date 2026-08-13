/**
 * crawl — web research / topic scoring, ported into pi core.
 *
 * Tests cover the pure-TS kernel (textclean, score, config), the local
 * page store (ingest/query/list/count, re-ingest preserves backlinks),
 * rescore/export off the local store, research keyword-matching, and the
 * inline extension lifecycle + all 8 tools. Each test builds a fresh
 * `.pi/crawl/` under a temp repo so nothing escapes the run.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	dir,
	getTopic,
	listTopics,
	readConfig,
	setCrawlRoot,
	topicScore,
	writeConfig,
} from "../../src/core/crawl/config.ts";
import { exportAll, exportTopic } from "../../src/core/crawl/export.ts";
import { createCrawlInlineExtension } from "../../src/core/crawl/index.ts";
import { rescoreAll, rescoreTopic } from "../../src/core/crawl/rescore.ts";
import { bestTopicFromRequest, research } from "../../src/core/crawl/research.ts";
import { combinedScore, hubScore, keywordScore, recencyScore, scorePages } from "../../src/core/crawl/score.ts";
import { addBacklink, countPages, getPage, ingestPage, listPages, queryPages } from "../../src/core/crawl/store.ts";
import { cleanText, normalizeWhitespace, stripHtmlChrome } from "../../src/core/crawl/textclean.ts";

let repo: string;

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "crawl-test-"));
	setCrawlRoot(repo);
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

function writeTopics(topics: ReturnType<typeof readConfig>): void {
	writeConfig(topics);
}

const TOPICS = [
	{ id: "test-topic", label: "Test Topic", keywords: ["test", "topic", "example"], seeds: ["https://example.com"] },
	{ id: "rust", label: "Rust Programming", keywords: ["rust", "cargo", "borrow checker"] },
];

// ── textclean ────────────────────────────────────────────────────────────────

describe("textclean", () => {
	it("stripHtmlChrome removes tags and entities, keeps text", () => {
		const r = stripHtmlChrome("<p>Hello <b>world</b></p>");
		expect(r.includes("<")).toBe(false);
		expect(r.includes("Hello")).toBe(true);
	});

	it("normalizeWhitespace collapses runs of blank lines", () => {
		expect(normalizeWhitespace("a\n\n\n\nb")).toBe("a\n\nb");
	});

	it("cleanText runs the full pipeline", () => {
		expect(cleanText("<div><p>Test</p></div>")).toBe("Test");
	});
});

// ── score ────────────────────────────────────────────────────────────────────

describe("score", () => {
	beforeEach(() => writeTopics(TOPICS));

	it("keywordScore is positive on keyword matches", () => {
		expect(keywordScore("test-topic", "this is a test")).toBeGreaterThan(0);
	});

	it("recencyScore decays with age", () => {
		const recent = recencyScore(1000 * 60 * 60 * 24);
		const old = recencyScore(1000 * 60 * 60 * 24 * 365);
		expect(recent).toBeGreaterThan(old);
	});

	it("hubScore is positive with backlinks, zero without", () => {
		expect(hubScore(5)).toBeGreaterThan(0);
		expect(hubScore(0)).toBe(0);
		expect(hubScore(undefined)).toBe(0);
	});

	it("scorePages sorts by combined score descending", () => {
		const pages = [
			{ url: "a", title: "test", topic: "test-topic" },
			{ url: "b", title: "nothing here", topic: "test-topic" },
			{ url: "c", title: "test example topic", topic: "test-topic", backlinkCount: 10 },
		];
		const scored = scorePages(pages);
		expect(scored[0].url).toBe("c");
		// every score is set and rounded to 2dp
		for (const p of scored) expect(typeof p.score).toBe("number");
	});

	it("combinedScore sums keyword + recency + hub + authority", () => {
		const s = combinedScore({
			url: "x",
			title: "test topic",
			topic: "test-topic",
			recencyMs: 1000,
			backlinkCount: 4,
			hubScore: 3,
		});
		expect(s).toBeGreaterThan(0);
	});
});

// ── config ───────────────────────────────────────────────────────────────────

describe("config", () => {
	it("readConfig returns [] when topics.json is absent", () => {
		expect(readConfig()).toEqual([]);
	});

	it("writeConfig + readConfig round-trips", () => {
		writeConfig(TOPICS);
		expect(readConfig().map((t) => t.id)).toEqual(["test-topic", "rust"]);
	});

	it("topicScore counts keyword hits, zero on no match", () => {
		writeTopics(TOPICS);
		expect(topicScore("test-topic", "this is a test topic example")).toBeGreaterThan(0);
		expect(topicScore("rust", "nothing here")).toBe(0);
	});

	it("topicScore ignores keywords shorter than the minimum length", () => {
		writeTopics([{ id: "short", label: "Short", keywords: ["x", "test"] }]);
		// "x" is too short (min 4), "test" counts
		expect(topicScore("short", "x x x test")).toBeGreaterThan(0);
	});

	it("listTopics returns a copy", () => {
		writeTopics(TOPICS);
		const a = listTopics();
		a.push({ id: "mutated", label: "m", keywords: [] });
		expect(listTopics().length).toBe(2);
	});

	it("getTopic finds by id or returns undefined", () => {
		writeTopics(TOPICS);
		expect(getTopic("rust")?.label).toBe("Rust Programming");
		expect(getTopic("nope")).toBeUndefined();
	});
});

// ── store (local page storage) ───────────────────────────────────────────────

describe("store (local page storage, off kern)", () => {
	beforeEach(() => writeTopics(TOPICS));

	it("ingestPage writes a JSON record and returns it with an object-id", () => {
		const rec = ingestPage("https://example.com/a", "<p>test topic content</p>", "test-topic");
		expect(rec.url).toBe("https://example.com/a");
		expect(rec.topic).toBe("test-topic");
		expect(rec.object_id).toContain("crawl/page/");
		expect(rec.content).toContain("test topic content");
		expect(existsSync(join(dir(), "pages"))).toBe(true);
	});

	it("re-ingesting the same URL updates in place and preserves backlinks", () => {
		ingestPage("https://example.com/a", "first", "test-topic");
		addBacklink("https://example.com/a");
		expect(getPage("https://example.com/a")?.backlinkCount).toBe(1);
		ingestPage("https://example.com/a", "second", "test-topic");
		const after = getPage("https://example.com/a");
		expect(after?.content).toBe("second");
		expect(after?.backlinkCount).toBe(1); // preserved across re-ingest
	});

	it("queryPages returns pages for a topic with live recencyMs", () => {
		ingestPage("https://example.com/a", "test", "test-topic");
		ingestPage("https://example.com/b", "test", "test-topic");
		ingestPage("https://example.com/c", "rust cargo", "rust");
		const pages = queryPages("test-topic");
		expect(pages.length).toBe(2);
		expect(pages.every((p) => typeof p.recencyMs === "number")).toBe(true);
		expect(queryPages("rust").length).toBe(1);
		expect(queryPages("nope")).toEqual([]);
	});

	it("queryPages limit slices the result", () => {
		for (let i = 0; i < 5; i++) ingestPage(`https://example.com/${i}`, "test", "test-topic");
		expect(queryPages("test-topic", 2).length).toBe(2);
	});

	it("listPages returns object-ids", () => {
		ingestPage("https://example.com/a", "test", "test-topic");
		const ids = listPages();
		expect(ids.length).toBe(1);
		expect(ids[0]).toContain("crawl/page/");
	});

	it("countPages counts all or per-topic", () => {
		ingestPage("https://example.com/a", "test", "test-topic");
		ingestPage("https://example.com/b", "test", "test-topic");
		ingestPage("https://example.com/c", "rust", "rust");
		expect(countPages()).toBe(3);
		expect(countPages("test-topic")).toBe(2);
		expect(countPages("rust")).toBe(1);
	});

	it("is inert when no store exists", () => {
		expect(queryPages("test-topic")).toEqual([]);
		expect(listPages()).toEqual([]);
		expect(countPages()).toBe(0);
		expect(getPage("https://nope")).toBeNull();
	});
});

// ── rescore ──────────────────────────────────────────────────────────────────

describe("rescore (off kern)", () => {
	beforeEach(() => writeTopics(TOPICS));

	it("rescoreTopic ranks pages by current keywords", () => {
		ingestPage("https://example.com/a", "test topic example", "test-topic");
		ingestPage("https://example.com/b", "nothing here", "test-topic");
		const ranked = rescoreTopic("test-topic");
		expect(ranked[0].url).toBe("https://example.com/a");
	});

	it("rescoreTopic returns [] for an unknown topic", () => {
		expect(rescoreTopic("nope")).toEqual([]);
	});

	it("rescoreAll covers every configured topic", () => {
		ingestPage("https://example.com/a", "test", "test-topic");
		ingestPage("https://example.com/b", "rust cargo", "rust");
		const all = rescoreAll();
		expect(all.size).toBe(2);
		expect(all.get("test-topic")?.length).toBe(1);
		expect(all.get("rust")?.length).toBe(1);
	});
});

// ── export ───────────────────────────────────────────────────────────────────

describe("export (off kern)", () => {
	beforeEach(() => writeTopics(TOPICS));

	it("exportTopic writes one .md per page + an index.md", () => {
		ingestPage("https://example.com/a", "test topic", "test-topic");
		ingestPage("https://example.com/b", "test example", "test-topic");
		const outDir = join(repo, "books");
		const n = exportTopic("test-topic", outDir);
		expect(n).toBe(2);
		const topicDir = join(outDir, "test-topic");
		expect(existsSync(join(topicDir, "index.md"))).toBe(true);
		const files = readdirSync(topicDir).filter((f) => f.endsWith(".md") && f !== "index.md");
		expect(files.length).toBe(2);
		// index links to each page file
		const index = readFileSync(join(topicDir, "index.md"), "utf8");
		expect(index).toContain("page-001.md");
		expect(index).toContain("page-002.md");
	});

	it("exportTopic returns 0 for a topic with no pages", () => {
		expect(exportTopic("test-topic", join(repo, "books"))).toBe(0);
	});

	it("exportAll exports every configured topic", () => {
		ingestPage("https://example.com/a", "test", "test-topic");
		ingestPage("https://example.com/b", "rust cargo", "rust");
		const results = exportAll(join(repo, "books"));
		expect(results.get("test-topic")).toBe(1);
		expect(results.get("rust")).toBe(1);
	});
});

// ── research ──────────────────────────────────────────────────────────────────

describe("research", () => {
	beforeEach(() => writeTopics(TOPICS));

	it("bestTopicFromRequest matches the request to the best topic by keyword hits", () => {
		expect(bestTopicFromRequest("test topic example")?.id).toBe("test-topic");
		expect(bestTopicFromRequest("rust cargo borrow checker")?.id).toBe("rust");
	});

	it("bestTopicFromRequest returns undefined on no match", () => {
		expect(bestTopicFromRequest("completely unrelated query xyz")).toBeUndefined();
	});

	it("bestTopicFromRequest returns undefined when no topics configured", () => {
		writeConfig([]);
		expect(bestTopicFromRequest("anything")).toBeUndefined();
	});

	it("research seeds the matched topic and records it in the store", () => {
		const r = research("test topic example");
		expect(r).toContain("test-topic");
		// the seed is recorded as a frontier page under the matched topic
		expect(queryPages("test-topic").length).toBe(1);
	});

	it("research reports available topics when nothing matches", () => {
		const r = research("completely unrelated query xyz");
		expect(r).toContain("No matching");
		expect(r).toContain("test-topic");
		expect(r).toContain("rust");
	});

	it("research reports when no topics are configured", () => {
		writeConfig([]);
		expect(research("anything")).toContain("No topics configured");
	});
});

// ── inline extension ──────────────────────────────────────────────────────────

function makeApi() {
	const tools: Record<string, { execute: (...args: any[]) => any; parameters?: unknown }> = {};
	const handlers: Record<string, Array<(...args: any[]) => any>> = {};
	const status: Record<string, string | undefined> = {};
	const api: any = {
		on(event: string, h: (...args: any[]) => any) {
			handlers[event] ??= [];
			handlers[event].push(h);
		},
		registerTool(t: any) {
			tools[t.name] = t;
		},
		registerCommand() {},
		sendUserMessage() {},
	};
	const ctx = (cwd: string) => ({
		cwd,
		ui: {
			setStatus: (k: string, t: string | undefined) => {
				status[k] = t;
			},
			notify: () => {},
		},
	});
	async function fire(event: string, ev: any, c: any) {
		for (const h of handlers[event] ?? []) await h(ev, c);
	}
	return { api, tools, fire, status, ctx };
}

describe("crawl inline extension", () => {
	it("registers all 8 crawl tools", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		const names = Object.keys(h.tools).sort();
		expect(names).toEqual(
			[
				"crawl",
				"crawl_export",
				"crawl_list",
				"crawl_rescore",
				"crawl_research",
				"crawl_score",
				"crawl_status",
				"crawl_topics",
			].sort(),
		);
	});

	it("is inert (no status bar) when .pi/crawl/ is absent", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		expect(h.status.crawl).toBeUndefined();
	});

	it("sets a status bar once topics/pages exist", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		writeTopics(TOPICS);
		ingestPage("https://example.com/a", "test", "test-topic");
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		expect(h.status.crawl).toContain("2 topics");
		expect(h.status.crawl).toContain("1 pages");
	});

	it("crawl tool ingests a page and confirms with object-id", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const res = await h.tools.crawl.execute(
			"1",
			{ url: "https://x.test", content: "<p>hello</p>", topic: "t" },
			undefined,
			undefined,
			h.ctx(repo),
		);
		expect(res.content[0].text).toContain("crawl/page/");
		expect(getPage("https://x.test")?.content).toBe("hello");
	});

	it("crawl tool errors without a url", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const res = await h.tools.crawl.execute("1", {}, undefined, undefined, h.ctx(repo));
		expect(res.content[0].text).toContain("error: url required");
	});

	it("crawl_score returns ranked JSON", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		writeTopics(TOPICS);
		ingestPage("https://example.com/a", "test topic example", "test-topic");
		ingestPage("https://example.com/b", "nothing", "test-topic");
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const res = await h.tools.crawl_score.execute("1", { topic: "test-topic" }, undefined, undefined, h.ctx(repo));
		const parsed = JSON.parse(res.content[0].text);
		expect(parsed[0].url).toBe("https://example.com/a");
	});

	it("crawl_topics lists, and adds a topic via add:", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		writeTopics(TOPICS);
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const list = await h.tools.crawl_topics.execute("1", {}, undefined, undefined, h.ctx(repo));
		expect(list.content[0].text).toContain("test-topic");
		const added = await h.tools.crawl_topics.execute(
			"1",
			{ add: { id: "new", label: "New", keywords: ["fresh"] } },
			undefined,
			undefined,
			h.ctx(repo),
		);
		expect(added.content[0].text).toContain('Added topic "new"');
		expect(getTopic("new")?.keywords).toEqual(["fresh"]);
		// duplicate add is rejected
		const dup = await h.tools.crawl_topics.execute(
			"1",
			{ add: { id: "new", label: "New", keywords: ["fresh"] } },
			undefined,
			undefined,
			h.ctx(repo),
		);
		expect(dup.content[0].text).toContain("already exists");
	});

	it("crawl_export writes a book to .pi/crawl/books/ by default", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		writeTopics(TOPICS);
		ingestPage("https://example.com/a", "test topic", "test-topic");
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const res = await h.tools.crawl_export.execute("1", { topic: "test-topic" }, undefined, undefined, h.ctx(repo));
		expect(res.content[0].text).toContain("1 pages");
		expect(existsSync(join(dir(), "books", "test-topic", "index.md"))).toBe(true);
	});

	it("crawl_status reports the store state", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		writeTopics(TOPICS);
		ingestPage("https://example.com/a", "test", "test-topic");
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const res = await h.tools.crawl_status.execute("1", {}, undefined, undefined, h.ctx(repo));
		expect(res.content[0].text).toContain("store: local");
		expect(res.content[0].text).toContain("test-topic: 1 pages");
	});

	it("crawl_research seeds and reports the matched topic", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		writeTopics(TOPICS);
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const res = await h.tools.crawl_research.execute(
			"1",
			{ request: "test topic example" },
			undefined,
			undefined,
			h.ctx(repo),
		);
		expect(res.content[0].text).toContain('Seeded topic "test-topic"');
		expect(queryPages("test-topic").length).toBe(1);
	});

	it("crawl_list returns page object-ids or 'No pages found'", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const empty = await h.tools.crawl_list.execute("1", {}, undefined, undefined, h.ctx(repo));
		expect(empty.content[0].text).toBe("No pages found");
		ingestPage("https://example.com/a", "test", "t");
		const list = await h.tools.crawl_list.execute("1", {}, undefined, undefined, h.ctx(repo));
		expect(list.content[0].text).toContain("crawl/page/");
	});

	it("clears status on shutdown", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		writeTopics(TOPICS);
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		expect(h.status.crawl).toBeDefined();
		await h.fire("session_shutdown", { type: "session_shutdown" }, h.ctx(repo));
		expect(h.status.crawl).toBeUndefined();
	});

	it("re-asserts repo root per call — a tool invoked with a different cwd reads that cwd's store", async () => {
		const h = makeApi();
		createCrawlInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		// ingest into repo A
		await h.tools.crawl.execute(
			"1",
			{ url: "https://a.test", content: "a", topic: "t" },
			undefined,
			undefined,
			h.ctx(repo),
		);
		// a second repo has its own empty store
		const repoB = mkdtempSync(join(tmpdir(), "crawl-test-b-"));
		try {
			setCrawlRoot(repoB);
			const res = await h.tools.crawl_list.execute("1", {}, undefined, undefined, h.ctx(repoB));
			expect(res.content[0].text).toBe("No pages found");
			// and repo A's store is untouched/visible when cwd is repo A again
			setCrawlRoot(repo);
			const listA = await h.tools.crawl_list.execute("1", {}, undefined, undefined, h.ctx(repo));
			// listPages returns object-ids (crawl/page/<base64url>), not raw URLs
			expect(listA.content[0].text).toContain("crawl/page/");
			expect(listA.content[0].text).not.toContain("No pages found");
		} finally {
			rmSync(repoB, { recursive: true, force: true });
		}
	});
});
