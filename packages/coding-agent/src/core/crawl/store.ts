// crawl store — local file-per-page storage at .pi/crawl/pages/, replacing
// the extension's kern CLI dependency. One JSON record per crawled URL,
// keyed by base64url(url) so a re-crawl of the same URL updates in place
// (same as kern's object-id scheme, just on the local filesystem). Every
// derived view (query by topic, list, rescore) reads pages from disk at
// call time — single representation, nothing derived written, mirroring
// gantt's store discipline.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "./config.ts";
import type { PageMeta } from "./score.ts";
import { cleanText } from "./textclean.ts";

export interface PageRecord extends PageMeta {
	/** ISO timestamp of ingestion. */
	ingestedAt?: string;
	/** Raw object-id mirroring kern's scheme, for list/export parity. */
	object_id?: string;
	/** Raw cleaned content body. */
	content?: string;
}

function pagesDir(): string {
	return join(dir(), "pages");
}

function pagePath(url: string): string {
	return join(pagesDir(), `${Buffer.from(url).toString("base64url")}.json`);
}

export function ensureStore(): void {
	if (!existsSync(pagesDir())) mkdirSync(pagesDir(), { recursive: true });
}

export function ingestPage(url: string, rawContent: string, topic = "uncategorized"): PageRecord {
	ensureStore();
	const content = cleanText(rawContent);
	const rec: PageRecord = {
		url,
		topic,
		title:
			content
				.split("\n")
				.find((l) => l.trim())
				?.slice(0, 200) || url,
		content,
		recencyMs: 0, // fresh: 0 recencyMs → recencyScore treats absent as 0; set below
		ingestedAt: new Date().toISOString(),
		object_id: `crawl/page/${Buffer.from(url).toString("base64url")}`,
	};
	// recencyMs = ms since ingestion drives recencyScore's half-life decay;
	// store as 0 so a freshly-ingested page scores at full recency.
	rec.recencyMs = 0;
	// Preserve backlinkCount/hubScore if re-ingesting an existing page.
	const prev = getPage(url);
	if (prev) {
		rec.backlinkCount = prev.backlinkCount;
		rec.hubScore = prev.hubScore;
	}
	writeFileSync(pagePath(url), JSON.stringify(rec, null, 2), "utf8");
	return rec;
}

export function getPage(url: string): PageRecord | null {
	try {
		return JSON.parse(readFileSync(pagePath(url), "utf8")) as PageRecord;
	} catch {
		return null;
	}
}

// all pages, as records (with content). Reads every file — fine for the
// hundreds-of-pages scale crawl targets; a kern-backed graph would matter
// at millions.
function allRecords(): PageRecord[] {
	if (!existsSync(pagesDir())) return [];
	const out: PageRecord[] = [];
	for (const f of readdirSync(pagesDir())
		.filter((f) => f.endsWith(".json"))
		.sort()) {
		try {
			out.push(JSON.parse(readFileSync(join(pagesDir(), f), "utf8")) as PageRecord);
		} catch {
			/* skip malformed */
		}
	}
	return out;
}

// query pages for a topic. Returns PageMeta[] (score.ts's narrower shape)
// with recencyMs computed from ingestedAt at read time, so decay is live.
export function queryPages(topic: string, limit = 0): PageMeta[] {
	const now = Date.now();
	const pages: PageMeta[] = allRecords()
		.filter((r) => r.topic === topic)
		.map((r) => ({
			url: r.url,
			title: r.title,
			topic: r.topic,
			hubScore: r.hubScore,
			backlinkCount: r.backlinkCount,
			recencyMs: r.ingestedAt ? now - new Date(r.ingestedAt).getTime() : undefined,
		}));
	return limit > 0 ? pages.slice(0, limit) : pages;
}

export function listPages(): string[] {
	return allRecords().map((r) => r.object_id ?? r.url);
}

// backlink/hub bookkeeping: bump a page's backlinkCount when another page
// links to it. Cheap text scan of the linker's cleaned content for the
// target URL.
export function addBacklink(targetUrl: string): void {
	const t = getPage(targetUrl);
	if (!t) return;
	t.backlinkCount = (t.backlinkCount ?? 0) + 1;
	writeFileSync(pagePath(targetUrl), JSON.stringify(t, null, 2), "utf8");
}

// count pages for status reporting.
export function countPages(topic?: string): number {
	// The unfiltered count is just the file count — don't read and parse every
	// record (each carries the full cleaned page text) to produce one integer.
	if (topic === undefined) {
		if (!existsSync(pagesDir())) return 0;
		return readdirSync(pagesDir()).filter((f) => f.endsWith(".json")).length;
	}
	return allRecords().filter((r) => r.topic === topic).length;
}
