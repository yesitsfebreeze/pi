// ontology — world model digest over the memory store.
// One markdown file per repo at .pi/ontology/digest.md (plain file,
// not stored in kern — simpler than the oilrig approach of storing
// the digest as a kern thought). Auto-seeds from a template on first
// access. Entity lines follow the convention:
//   - <Name> kern:<id> — <hook> | rel: <type> -> <Entity> | see: <hint>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── repo-root latch ─────────────────────────────────────────────────────
let _root = process.cwd();
export function setOntologyRoot(root: string): void {
	_root = root;
}
function ontologyDir(): string {
	return join(_root, ".pi", "ontology");
}
function digestFile(): string {
	return join(ontologyDir(), "digest.md");
}
/** Path to the digest, so a truncated injection can point at the full file. */
export function digestPath(): string {
	return digestFile();
}

// ── digest template ─────────────────────────────────────────────────────
function template(root: string): string {
	return [
		`# Ontology digest — ${root}`,
		"",
		"World model index. Pointers, not data: kern IDs, typed relations, search",
		"hints. The substance lives in the memory store and in files — this file",
		"only says where.",
		"",
		"## Focus",
		"",
		"- (what this project is trying to do — keep current)",
		"",
		"## Entities",
		"",
		"(none yet)",
		"",
		"## Open questions",
		"",
		"(none)",
		"",
	].join("\n");
}

export function ensureDigest(): void {
	if (existsSync(digestFile())) return;
	if (!existsSync(ontologyDir())) mkdirSync(ontologyDir(), { recursive: true });
	writeFileSync(digestFile(), template(_root), "utf8");
}

export function readDigest(): string | null {
	try {
		if (!existsSync(digestFile())) return null;
		return readFileSync(digestFile(), "utf8");
	} catch {
		return null;
	}
}

export function writeDigest(body: string): void {
	if (!existsSync(ontologyDir())) mkdirSync(ontologyDir(), { recursive: true });
	writeFileSync(digestFile(), body, "utf8");
}

// ── entity parsing ──────────────────────────────────────────────────────

export interface OntologyEntry {
	term: string;
	summary: string;
	kernId?: string;
}

/** Extract entity entries from the digest. An entity line is `- <Name> kern:<id> …`. */
export function parseDigest(digest: string): OntologyEntry[] {
	const entries: OntologyEntry[] = [];
	for (const line of digest.split("\n")) {
		if (!/^-\s.*kern:/.test(line)) continue;
		const body = line.replace(/^-\s+/, "");
		const kernId = body.match(/kern:([^\s·)]+)/)?.[1];
		const cut = body.split(/\s+—\s+|\s+·\s+/);
		const term = cut[0].replace(/\s*kern:.*$/, "").trim();
		if (!term) continue;
		const summary = body
			.slice(cut[0].length)
			.replace(/^[\s—·]+/, "")
			.trim();
		entries.push({ term, summary, kernId });
	}
	return entries;
}

export function countEntities(digest: string): number {
	return parseDigest(digest).length;
}
