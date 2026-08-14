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
function auditStampPath(): string {
	return join(nvimLearningDir(), "audit-stamp.json");
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

// ── audit stamp & memory-bank freshness ──────────────────────────────────

/**
 * Stamp left by `nvim_learn audit`: when the last full sift of the user's
 * nvim setup ran, plus content hashes of the config files and of the probe
 * results (plugin set + runnability) it observed. The gate compares these
 * against the current state to decide whether the memory bank is fresh.
 */
export interface AuditStamp {
	at: string; // ISO timestamp of the audit
	configHash: string; // sha256 over sorted config-file fingerprints
	probeHash: string; // sha256 over the probe results JSON
}

/** Read the audit stamp, or null when the bank was never audited. */
export function readAuditStamp(): AuditStamp | null {
	try {
		const raw = readFileSync(auditStampPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed.configHash === "string" && typeof parsed.probeHash === "string") {
			return parsed as AuditStamp;
		}
		return null;
	} catch {
		return null;
	}
}

/** Write the audit stamp (marks the memory bank as fully indexed). */
export function writeAuditStamp(configHash: string, probeHash: string): void {
	ensureDir(nvimLearningDir());
	const stamp: AuditStamp = { at: new Date().toISOString(), configHash, probeHash };
	writeFileSync(auditStampPath(), `${JSON.stringify(stamp, null, 2)}\n`);
}

/**
 * sha256 over the sorted concatenation of every config file's fingerprint
 * hash — a cheap content-level digest of the whole config tree.
 */
export function configTreeHash(files: string[]): string {
	const hashes = files
		.map((f) => fingerprintFile(f)?.sha256 ?? "")
		.filter((h) => h !== "")
		.sort();
	return sha256Of(hashes.join("\n"));
}

/** The note names the audit regenerates (the factual inventory). */
export const AUDIT_NOTE_NAMES = ["keymaps", "options", "plugins", "lsp", "recipes"] as const;

/**
 * The connect gate: is the memory bank fully indexed and fresh?
 * Fresh = every required note exists AND the config tree is unchanged since
 * the manifest was recorded AND an audit stamp matches the current config.
 * Runnability itself is verified by the audit (the stamp's probeHash) — the
 * gate only decides whether an audit is needed.
 */
export function memoryBankStatus(
	files: string[],
	notes: string[] = listNotes(),
	stamp: AuditStamp | null = readAuditStamp(),
): { needsAudit: boolean; reason: string } {
	const missing = AUDIT_NOTE_NAMES.filter((n) => !notes.includes(n));
	if (missing.length > 0) {
		return { needsAudit: true, reason: `notes missing: ${missing.join(", ")}` };
	}
	if (!stamp) {
		return { needsAudit: true, reason: "never audited (no stamp)" };
	}
	const treeHash = configTreeHash(files);
	if (stamp.configHash !== treeHash) {
		return { needsAudit: true, reason: "config changed since last audit" };
	}
	return { needsAudit: false, reason: "indexed and fresh" };
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

/**
 * Compact pointer to the accumulated notes, for the one-shot nvim-connect
 * notice — so every session knows prior-session knowledge exists instead of
 * re-discovering the setup from scratch. Empty when nothing is learned yet.
 */
export function learnedNotesBlock(): string {
	const notes = listNotes();
	if (notes.length === 0) return "";
	return (
		`Learned knowledge from prior sessions (nvim_learn notes: ${notes.join(", ")}). ` +
		`nvim_learn note_read <name> pulls the full note — read them before driving the ` +
		`user's editor (tools = the pi↔nvim tool map, keymaps = mappings incl. telescope pickers).`
	);
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

/**
 * Write an audit-generated note WITHOUT clobbering agent-curated knowledge.
 * - Note missing → write it.
 * - Note audit-owned (starts with `# <name> (audited)`) → replace it.
 * - Note agent-curated → preserve it and append the audited inventory as a
 *   `## <name> (audited)` section (a prior audit section is dropped first, so
 *   repeated audits do not stack duplicate sections).
 */
export function writeAuditNote(name: string, body: string): void {
	const existing = readNote(name);
	if (!existing) {
		writeNote(name, body);
		return;
	}
	// Audit-owned notes open with `# <Name> (audited)` (case-insensitive).
	const firstLine = existing.split("\n")[0] ?? "";
	if (/^# .+ \(audited\)$/i.test(firstLine)) {
		writeNote(name, body);
		return;
	}
	// Agent-curated note: preserve it. Drop any `## <name> (audited)` section a
	// previous audit appended, then append the fresh one.
	const markerRe = new RegExp(
		`\\n\\n---\\n\\n## ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(audited\\).*$`,
		"is",
	);
	const base = existing.replace(markerRe, "").replace(/\s+$/, "");
	const section = body.replace(/^# (.+?)(?: \(audited\))?$/m, `## $1 (audited)`).trim();
	writeNote(name, `${base}\n\n---\n\n${section}\n`);
}

/** Human-readable one-line location for a note path (repo-relative). */
export function notePath(name: string): string {
	const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
	return relative(_root, join(notesDir(), `${safe}.md`));
}
