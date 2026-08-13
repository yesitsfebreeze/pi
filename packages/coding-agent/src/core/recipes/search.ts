// search — justdown-style ranked retrieval.
// Ported from the justdown Go library (src/search.go).
// Ranking weights: name/use_when = 3, tags = 2, description/prose = 1.
// not_when vetoes. Tiebreaker: link degree → alphabetical.

import type { Recipe, SearchResult } from "./types.ts";

// ── tokenizer ───────────────────────────────────────────────────────────

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"or",
	"the",
	"of",
	"to",
	"in",
	"on",
	"at",
	"is",
	"it",
	"its",
	"be",
	"as",
	"do",
	"for",
	"my",
	"our",
	"your",
	"this",
	"that",
	"with",
	"from",
	"by",
]);

export function words(s: string): string[] {
	const out: string[] = [];
	let start = -1;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		const ok =
			(c >= 97 && c <= 122) || // a-z
			(c >= 48 && c <= 57) || // 0-9
			c === 43; // +
		if (ok) {
			if (start < 0) start = i;
		} else if (start >= 0) {
			out.push(s.slice(start, i));
			start = -1;
		}
	}
	if (start >= 0) out.push(s.slice(start));
	return out;
}

function isStopword(w: string): boolean {
	return STOPWORDS.has(w);
}

/** substring-or-prefix match in a field's tokens */
function fhit(field: string, term: string): boolean {
	for (const w of words(field)) {
		if (w.includes(term)) return true;
	}
	return false;
}

// ── link degree ─────────────────────────────────────────────────────────

/** Compute total degree per recipe key (outbound + inbound links) */
export function degreeMap(recipes: Recipe[]): Map<string, number> {
	const indeg = new Map<string, number>();
	for (const r of recipes) {
		for (const l of r.links) {
			indeg.set(l, (indeg.get(l) ?? 0) + 1);
		}
	}
	const deg = new Map<string, number>();
	for (const r of recipes) {
		deg.set(r.key, r.links.length + (indeg.get(r.key) ?? 0));
	}
	return deg;
}

// ── rank ────────────────────────────────────────────────────────────────

/**
 * Rank recipes by query. Returns scored results, best first.
 * Ported from justdown's Rank() — exact mode (no stemming/synonyms).
 */
export function rank(recipes: Recipe[], query: string, kind?: string, category?: string): SearchResult[] {
	const q = query.toLowerCase();
	const terms = words(q).filter((t) => !isStopword(t));
	if (terms.length === 0) return [];

	const deg = degreeMap(recipes);
	const results: SearchResult[] = [];

	for (const recipe of recipes) {
		if (kind && recipe.kind !== kind) continue;
		if (category && recipe.category !== category) continue;

		const name = recipe.name.toLowerCase();
		const useWhen = recipe.useWhen.join(" ").toLowerCase();
		const tags = recipe.tags.join(" ").toLowerCase();
		const desc = recipe.description.toLowerCase();
		const notWhen = recipe.notWhen.join(" ").toLowerCase();
		const prose = recipe.prose.toLowerCase();

		let score = 0;
		let vetoed = false;

		for (const term of terms) {
			if (notWhen && fhit(notWhen, term)) {
				vetoed = true;
				break;
			}
			if (fhit(name, term) || fhit(useWhen, term)) {
				score += 3;
			} else if (fhit(tags, term)) {
				score += 2;
			} else if (fhit(desc, term)) {
				score += 1;
			} else if (prose.includes(term)) {
				score += 1;
			}
		}

		if (vetoed || score <= 0) continue;
		results.push({ recipe, score });
	}

	// sort: score desc → degree desc → name asc
	const d = deg;
	results.sort((a, b) => {
		if (a.score !== b.score) return b.score - a.score;
		const da = d.get(a.recipe.key) ?? 0;
		const db = d.get(b.recipe.key) ?? 0;
		if (da !== db) return db - da;
		return a.recipe.name.localeCompare(b.recipe.name);
	});

	return results;
}
