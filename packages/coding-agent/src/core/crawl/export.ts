// crawl export — write crawled pages out as a markdown "book" (one .md per
// page + an index.md), off kern. Reads from the local store, ranks by
// rescoreTopic's score, writes to outDir. The book is a derived artifact:
// re-running export from the same pages reproduces it byte-for-byte.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "./config.ts";
import { scorePages } from "./score.ts";
import { queryPages } from "./store.ts";
import { cleanText } from "./textclean.ts";

interface PageRecord {
	url: string;
	title?: string;
	topic?: string;
	content?: string;
	score?: number;
}

function topicRecords(topic: string): PageRecord[] {
	// queryPages gives PageMeta (no content); read full records from disk.
	// Re-derive score so export ranks by the current keywords.
	const metas = queryPages(topic);
	const scored = scorePages(metas);
	return scored.map((s) => ({
		url: s.url,
		title: s.title,
		topic: s.topic,
		score: s.score,
		// content is not on PageMeta; export reads it back via the store
		content: contentFor(s.url),
	}));
}

// read the stored content for a url without surfacing the whole store
// surface here — keep the export module focused on markdown rendering.
import { getPage } from "./store.ts";

function contentFor(url: string): string | undefined {
	return getPage(url)?.content;
}

function pageToMarkdown(p: PageRecord): string {
	const parts: string[] = [];
	parts.push(`# ${p.title || p.url || "Untitled"}`);
	parts.push("");
	parts.push(`Source: ${p.url}`);
	if (p.topic) parts.push(`Topic: ${p.topic}`);
	if (p.score != null) parts.push(`Score: ${p.score}`);
	parts.push("");
	if (p.content) parts.push(cleanText(p.content));
	parts.push("");
	return parts.join("\n");
}

export function exportTopic(topic: string, outDir: string): number {
	const pages = topicRecords(topic);
	if (pages.length === 0) return 0;
	const topicDir = join(outDir, topic);
	mkdirSync(topicDir, { recursive: true });
	const indexLines: string[] = [`# Topic: ${topic}\n`, ""];
	for (const [i, page] of pages.entries()) {
		const filename = `page-${String(i + 1).padStart(3, "0")}.md`;
		writeFileSync(join(topicDir, filename), pageToMarkdown(page), "utf8");
		indexLines.push(`- [${page.title || page.url}](${filename})`);
	}
	writeFileSync(join(topicDir, "index.md"), indexLines.join("\n"), "utf8");
	return pages.length;
}

export function exportAll(outDir: string): Map<string, number> {
	const results = new Map<string, number>();
	for (const topic of readConfig()) results.set(topic.id, exportTopic(topic.id, outDir));
	return results;
}
