import { topicScore } from "./config.ts";

const HUB_BOOST = 2.0;
const _AUTHORITY_BOOST = 1.5;
const RECENCY_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

export interface PageMeta {
	url: string;
	title?: string;
	topic?: string;
	score?: number;
	hubScore?: number;
	recencyMs?: number;
	backlinkCount?: number;
}

export function keywordScore(topic: string, text: string): number {
	const hits = topicScore(topic, text);
	return hits > 0 ? Math.log2(hits + 1) * 10 : 0;
}

export function recencyScore(recencyMs: number | undefined): number {
	if (!recencyMs) return 0;
	const halfLives = recencyMs / RECENCY_HALF_LIFE_MS;
	return 10 * 0.5 ** halfLives;
}

export function hubScore(backlinkCount: number | undefined): number {
	if (!backlinkCount || backlinkCount <= 0) return 0;
	return Math.log2(backlinkCount + 1) * HUB_BOOST;
}

export function combinedScore(meta: PageMeta): number {
	const k = keywordScore(meta.topic || "", meta.title || "");
	const r = recencyScore(meta.recencyMs);
	const h = hubScore(meta.backlinkCount);
	const a = meta.hubScore || 0;
	return k + r + h + a;
}

export function scorePages(pages: PageMeta[]): PageMeta[] {
	return pages
		.map((page) => {
			const score = combinedScore(page);
			return { ...page, score: Math.round(score * 100) / 100 };
		})
		.sort((a, b) => (b.score || 0) - (a.score || 0));
}
