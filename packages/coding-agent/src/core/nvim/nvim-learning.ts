/**
 * Persistent nvim learning store at <repo>/.pi/nvim/.
 *
 * The agent accumulates knowledge about the user's nvim setup across sessions.
 * Two artifacts:
 *
 *   .pi/nvim/manifest.json  fingerprint (sha256 + mtime + size) of every nvim
 *                           config file we've seen, keyed by absolute path.
 *   .pi/nvim/notes/         learned markdown notes (keymaps, plugins, LSP,
 *                           options, gotchas) written by the agent.
 *
 * Change detection is content-hash based: we diff the current fingerprint of
 * each config file against the manifest and report {new, changed, unchanged,
 * removed}. mtime and size are stored alongside the hash as diagnostics, but
 * the hash is authoritative — it catches edits that preserve mtime and ignores
 * mere touches that change mtime without changing content.
 *
 * Module singleton latched on connect AND re-asserted at the top of every
 * tool execute (same pitfall as gantt/crawl/recipes — a session that switches
 * cwd must not keep reading the wrong repo).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// ── repo-root latch ─────────────────────────────────────────────────────
let _root = process.cwd();
export function setNvimLearningRoot(root: string): void {
	_root = root;
}
export function nvimLearningDir(): string {
	return join(_root, ".pi", "nvim");
}
function manifestPath(): string {
	return join(nvimLearningDir(), "manifest.json");
}
export function notesDir(): string {
	return join(nvimLearningDir(), "notes");
}
function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── fingerprinting ──────────────────────────────────────────────────────

export interface ConfigFingerprint {
	sha256: string;
	mtimeMs: number;
	size: number;
}

export type ConfigManifest = Record<string, ConfigFingerprint>;

function sha256Of(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Fingerprint a single file, or null if it cannot be read. */
export function fingerprintFile(absPath: string): ConfigFingerprint | null {
	try {
		const content = readFileSync(absPath);
		const st = statSync(absPath);
		return { sha256: sha256Of(content), mtimeMs: st.mtimeMs, size: content.length };
	} catch {
		return null;
	}
}

/** Load the persisted manifest (empty if missing or corrupt). */
export function loadManifest(): ConfigManifest {
	try {
		const raw = readFileSync(manifestPath(), "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as ConfigManifest) : {};
	} catch {
		return {};
	}
}

function saveManifest(manifest: ConfigManifest): void {
	ensureDir(nvimLearningDir());
	writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
}

// ── change detection ────────────────────────────────────────────────────

export interface ConfigDiff {
	/** Files present now but not in the manifest (never seen before). */
	new: string[];
	/** Files whose content hash differs from the manifest. */
	changed: string[];
	/** Files present now with a matching hash. */
	unchanged: string[];
	/** Files in the manifest that no longer exist on disk. */
	removed: string[];
}

/**
 * Diff the current on-disk state of `files` against the manifest.
 * Returns absolute paths grouped by change category. Nothing is written.
 */
export function diffConfigFiles(files: string[], manifest: ConfigManifest = loadManifest()): ConfigDiff {
	const result: ConfigDiff = { new: [], changed: [], unchanged: [], removed: [] };

	for (const abs of files) {
		const fp = fingerprintFile(abs);
		if (!fp) continue; // unreadable now; treat as absent (removed is handled below)
		const prev = manifest[abs];
		if (!prev) result.new.push(abs);
		else if (prev.sha256 !== fp.sha256) result.changed.push(abs);
		else result.unchanged.push(abs);
	}

	for (const abs of Object.keys(manifest)) {
		if (!files.includes(abs)) result.removed.push(abs);
	}

	return result;
}

/** Record current fingerprints of `files` into the manifest (marks them seen). */
export function recordSeen(files: string[]): void {
	const manifest = loadManifest();
	for (const abs of files) {
		const fp = fingerprintFile(abs);
		if (fp) manifest[abs] = fp;
	}
	saveManifest(manifest);
}

// ── notes ───────────────────────────────────────────────────────────────

/** List note files (names without extension) in the notes directory. */
export function listNotes(): string[] {
	const dir = notesDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((e) => e.endsWith(".md"))
		.map((e) => e.slice(0, -".md".length))
		.sort();
}

/** Read a note's content, or undefined if it doesn't exist. */
export function readNote(name: string): string | undefined {
	const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
	const p = join(notesDir(), `${safe}.md`);
	if (!existsSync(p)) return undefined;
	return readFileSync(p, "utf8");
}

/** Write (create or overwrite) a note. */
export function writeNote(name: string, content: string): void {
	const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
	ensureDir(notesDir());
	writeFileSync(join(notesDir(), `${safe}.md`), content);
}

/** Human-readable one-line location for a note path (repo-relative). */
export function notePath(name: string): string {
	const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
	return relative(_root, join(notesDir(), `${safe}.md`));
}
