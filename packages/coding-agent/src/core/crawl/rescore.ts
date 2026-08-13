// crawl rescore — re-score crawled pages against current keywords, off
// kern. Reads pages from the local store (store.queryPages) and runs
// score.scorePages. Nothing is written — score is a derived view, so a
// rescore is a read that returns ranked PageMeta[]; the caller (export,
// the tool) decides whether to persist it.
import { readConfig } from "./config.ts";
import type { PageMeta } from "./score.ts";
import { scorePages } from "./score.ts";
import { queryPages } from "./store.ts";

export function rescoreTopic(topic: string): PageMeta[] {
	if (!readConfig().some((t) => t.id === topic)) return [];
	return scorePages(queryPages(topic));
}

export function rescoreAll(): Map<string, PageMeta[]> {
	const results = new Map<string, PageMeta[]>();
	for (const topic of readConfig()) results.set(topic.id, rescoreTopic(topic.id));
	return results;
}
