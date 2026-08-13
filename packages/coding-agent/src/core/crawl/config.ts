// crawl config — topics.json at .pi/crawl/. Reworked from the extension's
// global ~/.local/state/crawl default to pi's repo-root convention (gantt's
// .pi/gantt/, forest's .pi/trees/). The repo root is a module singleton latched
// on session_start AND re-asserted at the top of every tool/command call
// path (see core/gantt for the same pattern) — a tool invoked after a
// session_start on a different cwd would otherwise read the wrong store.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let _root = process.cwd();
export function setCrawlRoot(root: string): void {
	_root = root;
}
export function dir(): string {
	return join(_root, ".pi", "crawl");
}
export function topicsFile(): string {
	return join(dir(), "topics.json");
}

export const RECENCY_HALF_LIFE_DAYS = 90;
export const MIN_KEYWORD_MATCH_LENGTH = 4;

export interface Topic {
	id: string;
	label: string;
	keywords: string[];
	seeds?: string[];
	weight?: number;
}

function ensureDir(): void {
	if (!existsSync(dir())) mkdirSync(dir(), { recursive: true });
}

export function readConfig(): Topic[] {
	try {
		if (!existsSync(topicsFile())) return [];
		return JSON.parse(readFileSync(topicsFile(), "utf8")) as Topic[];
	} catch {
		return [];
	}
}

export function writeConfig(topics: Topic[]): void {
	ensureDir();
	writeFileSync(topicsFile(), JSON.stringify(topics, null, 2), "utf8");
}

export function getTopic(id: string): Topic | undefined {
	return readConfig().find((t) => t.id === id);
}

export function listTopics(): Topic[] {
	return [...readConfig()];
}

// keyword hit count for a topic against text. Keywords shorter than the
// minimum match length are skipped (tiny stopwords dominate otherwise).
export function topicScore(topic: string, text: string): number {
	const t = getTopic(topic);
	if (!t) return 0;
	const lower = text.toLowerCase();
	let hits = 0;
	for (const kw of t.keywords) {
		if (kw.length < MIN_KEYWORD_MATCH_LENGTH) continue;
		let idx = lower.indexOf(kw.toLowerCase());
		while (idx !== -1) {
			hits++;
			idx = lower.indexOf(kw.toLowerCase(), idx + kw.length);
		}
	}
	return hits;
}
