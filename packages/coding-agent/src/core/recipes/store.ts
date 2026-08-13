// store — file-based recipe index at .pi/recipes/*.md.
// Reads all .md files, parses frontmatter + prose + ```!bash blocks,
// computes derived views (search, links) at read time — nothing persisted
// beyond the .md files.
//
// Module singleton latched on session_start AND re-asserted at every
// tool call path (same pitfall as gantt/crawl).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Recipe, RecipeBlock } from "./types.ts";

// ── repo-root latch ─────────────────────────────────────────────────────
let _root = process.cwd();
export function setRecipesRoot(root: string): void {
	_root = root;
}
export function recipesDir(): string {
	return join(_root, ".pi", "recipes");
}
function ensureDir(): void {
	const d = recipesDir();
	if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ── frontmatter parser ──────────────────────────────────────────────────

interface Frontmatter {
	name?: string;
	kind?: string;
	description?: string;
	tags?: string[];
	use_when?: string[];
	not_when?: string[];
	danger?: string;
	requires?: string[];
}

function splitFrontmatter(content: string): { fm: string; body: string; hasFM: boolean } {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trimEnd() !== "---") return { fm: "", body: content, hasFM: false };

	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trimEnd() === "---") {
			end = i;
			break;
		}
	}
	if (end < 0) return { fm: "", body: content, hasFM: false };

	const fm = lines.slice(1, end).join("\n");
	const body = lines.slice(end + 1).join("\n");
	// strip leading blank lines from body
	const trimmed = body.replace(/^\n+/, "");
	return { fm, body: trimmed, hasFM: true };
}

function parseFrontmatter(fm: string): Frontmatter {
	const result: Frontmatter = {};
	const lines = fm.split(/\r?\n/);

	// Simple YAML-ish parser — handles the justdown subset (scalars, arrays)
	let currentKey = "";
	let currentArray: string[] = [];

	function flush() {
		if (currentKey && currentArray.length > 0) {
			setField(currentKey, currentArray);
		}
		currentKey = "";
		currentArray = [];
	}

	function setField(key: string, value: unknown) {
		switch (key) {
			case "name":
				result.name = String(value);
				break;
			case "kind":
				result.kind = String(value);
				break;
			case "description":
				result.description = String(value);
				break;
			case "danger":
				result.danger = String(value);
				break;
		}
	}

	for (const line of lines) {
		// skip empty
		if (line.trim() === "") continue;

		// array item: "- value" or "  - value"
		const arrMatch = line.match(/^\s*-\s+(.+)$/);
		if (arrMatch) {
			currentArray.push(arrMatch[1].trim());
			continue;
		}

		// key: value or key:
		const kvMatch = line.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
		if (kvMatch) {
			flush();
			currentKey = kvMatch[1];
			const v = kvMatch[2].trim();

			if (v === "") {
				// empty value — may start an array on next lines
				continue;
			}

			// inline array: [a, b, c]
			const inlineArr = v.match(/^\[(.*)\]$/);
			if (inlineArr) {
				const items = inlineArr[1]
					.split(",")
					.map((s) =>
						s
							.trim()
							.replace(/^"(.*)"$/, "$1")
							.replace(/^'(.*)'$/, "$1"),
					)
					.filter(Boolean);
				switch (currentKey) {
					case "tags":
						result.tags = items;
						break;
					case "use_when":
						result.use_when = items;
						break;
					case "not_when":
						result.not_when = items;
						break;
					case "requires":
						result.requires = items;
						break;
				}
				currentKey = "";
				continue;
			}

			// scalar: strip quotes
			const scalar = v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
			setField(currentKey, scalar);
			currentKey = "";
		}
	}
	// flush remaining array
	flush();

	return result;
}

// ── ```!bash block parser ───────────────────────────────────────────────

/**
 * Split a block signature into its name and parameter list, accepting both
 * `name(a, b)` and `name a b`. Returns an empty param list for a bare name.
 */
function parseBlockSignature(signature: string): { name: string; params: string[] } {
	const paren = signature.match(/^([^\s(]+)\s*\(([^)]*)\)\s*$/);
	if (paren) {
		const params = paren[2]
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean);
		return { name: paren[1], params };
	}
	const parts = signature.trim().split(/\s+/);
	return { name: parts[0], params: parts.slice(1) };
}

function parseBangBlocks(body: string): RecipeBlock[] {
	const blocks: RecipeBlock[] = [];
	const lines = body.split(/\r?\n/);
	let inBang = false;
	let blockName = "";
	let blockParams: string[] = [];
	let blockLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		const bangMatch = trimmed.match(/^```!(\w+)\s+(.+)/);
		if (bangMatch) {
			// New named bang block — flush previous
			if (inBang) {
				blocks.push({ name: blockName, params: blockParams, body: blockLines.join("\n") });
				blockLines = [];
			}
			inBang = true;
			// Two signature forms are documented and both must work:
			//   ```!bash squash(base, message)   — the form in this module's header
			//   ```!bash squash base message     — space-separated
			// Only the second used to parse, so a block written the documented way
			// kept its parens in `name` and could never be matched by `blockName`.
			({ name: blockName, params: blockParams } = parseBlockSignature(bangMatch[2]));
			continue;
		}

		if (inBang && trimmed === "```") {
			blocks.push({ name: blockName, params: blockParams, body: blockLines.join("\n") });
			inBang = false;
			blockName = "";
			blockParams = [];
			blockLines = [];
			continue;
		}

		if (inBang) {
			blockLines.push(line);
		}
	}

	// flush unclosed block
	if (inBang && blockLines.length > 0) {
		blocks.push({ name: blockName, params: blockParams, body: blockLines.join("\n") });
	}

	return blocks;
}

// ── link scanner ────────────────────────────────────────────────────────

function isWordByte(c: number): boolean {
	return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45; // a-z 0-9 _ -
}

function scanLinks(prose: string): { links: string[]; fuzzyLinks: string[] } {
	const links: string[] = [];
	const fuzzyLinks: string[] = [];

	for (let i = 0; i < prose.length; i++) {
		if (prose[i] === "@") {
			let j = i + 1;
			let fuzzy = false;

			if (j < prose.length && prose[j] === "?") {
				fuzzy = true;
				j++;
			}

			const s = j;
			while (j < prose.length && isWordByte(prose.charCodeAt(j))) j++;

			if (j === s) continue; // bare @ / @? with no word

			let end = j;
			// dir/name form
			if (!fuzzy && j < prose.length && prose[j] === "/") {
				const s2 = j + 1;
				let k = s2;
				while (k < prose.length && isWordByte(prose.charCodeAt(k))) k++;
				if (k > s2) end = k;
			}

			const token = prose.slice(fuzzy ? s : i + 1, end);
			if (fuzzy) {
				if (!fuzzyLinks.includes(token)) fuzzyLinks.push(token);
			} else {
				if (!links.includes(token)) links.push(token);
			}
			i = end - 1;
		}
	}

	return { links, fuzzyLinks };
}

// ── parse recipe from file ──────────────────────────────────────────────

function parseRecipe(filePath: string, recipeRoot: string): Recipe | null {
	const content = readFileSync(filePath, "utf-8");
	const rel = relative(recipeRoot, filePath); // e.g. "git/squash.md"

	// Derive key from path: strip .md, use dir/basename
	const noExt = rel.replace(/\.md$/, "");
	const parts = noExt.split("/");
	let key: string;
	let category: string;
	if (parts.length >= 2) {
		category = parts[parts.length - 2];
		key = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
	} else {
		category = "";
		key = parts[parts.length - 1];
	}

	const { fm, body, hasFM } = splitFrontmatter(content);
	const parsed = hasFM ? parseFrontmatter(fm) : {};

	const blocks = parseBangBlocks(body);

	// extract prose: everything outside ```! fences
	const proseLines: string[] = [];
	let inFence = false;
	for (const line of body.split(/\r?\n/)) {
		if (/^```/.test(line.trim())) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) proseLines.push(line);
	}
	const prose = proseLines.join("\n").trim();

	const { links, fuzzyLinks } = scanLinks(prose);

	const name = parsed.name ?? key;

	return {
		key,
		name,
		kind: parsed.kind ?? "tool",
		description: parsed.description ?? name,
		tags: parsed.tags ?? [],
		useWhen: parsed.use_when ?? [],
		notWhen: parsed.not_when ?? [],
		danger: parsed.danger ?? "none",
		requires: parsed.requires ?? [],
		category,
		path: rel,
		frontmatter: fm,
		prose,
		blocks,
		links,
		fuzzyLinks,
	};
}

// ── index operations ────────────────────────────────────────────────────

/** Collect all .md files recursively under the recipes root. */
function collectMd(dir: string, out: string[]): void {
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				// skip hidden dirs
				if (!e.name.startsWith(".")) collectMd(full, out);
			} else if (e.isFile() && e.name.endsWith(".md")) {
				out.push(full);
			}
		}
	} catch {
		// dir doesn't exist — no files
	}
}

/** Load all recipes from .pi/recipes/ */
export function loadRecipes(): Recipe[] {
	const root = recipesDir();
	if (!existsSync(root)) return [];
	const files: string[] = [];
	collectMd(root, files);
	if (files.length === 0) return [];

	const recipes: Recipe[] = [];
	const seen = new Set<string>();
	for (const f of files) {
		const r = parseRecipe(f, root);
		if (r && !seen.has(r.key)) {
			seen.add(r.key);
			recipes.push(r);
		}
	}
	return recipes;
}

/** Resolve a ref (@key, key, path, or name) to a recipe. */
export function resolveRecipe(ref: string, recipes: Recipe[]): Recipe | null {
	const needle = ref.startsWith("@") ? ref.slice(1) : ref;

	// exact key match
	for (const r of recipes) if (r.key === needle) return r;

	// name match
	for (const r of recipes) if (r.name === needle) return r;

	// path match (relative path without .md)
	const pathNeedle = needle.replace(/\.md$/, "");
	for (const r of recipes) if (r.path.replace(/\.md$/, "") === pathNeedle) return r;

	// basename match
	for (const r of recipes) {
		const base = r.path.split("/").pop()?.replace(/\.md$/, "");
		if (base === needle) return r;
	}

	return null;
}

/** Create a new recipe file. Returns the parsed recipe. */
export function createRecipe(name: string, frontmatterFields: Record<string, unknown>, body: string): Recipe {
	ensureDir();

	// Build the markdown content
	let fm = "---\n";
	fm += `name: ${name}\n`;
	for (const [k, v] of Object.entries(frontmatterFields)) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			fm += `${k}: [${v.map((s: string) => `"${s}"`).join(", ")}]\n`;
		} else {
			fm += `${k}: ${v}\n`;
		}
	}
	fm += "---\n\n";
	fm += body;

	const filePath = join(recipesDir(), `${name}.md`);
	writeFileSync(filePath, fm, "utf-8");
	return parseRecipe(filePath, recipesDir())!;
}

/** Count recipes across categories. */
export function countRecipes(): Map<string, number> {
	const recipes = loadRecipes();
	const counts = new Map<string, number>();
	for (const r of recipes) {
		const cat = r.category || "misc";
		counts.set(cat, (counts.get(cat) ?? 0) + 1);
	}
	return counts;
}
