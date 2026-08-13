// layers/store.ts — git-plumbing store for "layers": develop-on-refs branches
// with provenance. No pi imports; every op shells out to the system git binary
// against the repo at `cwd`. Layers live under refs/layers/<name> and fork from
// the current HEAD, so a plain 3-way merge back to main works with no special
// seeding.
//
// The main repo's index and working tree are NEVER touched by write/read/rm —
// those use a scratch index + scratch work tree. Only mergeLayer (atomic
// update-ref) and materialize/removeWorktree touch refs/worktrees, and even
// mergeLayer never writes the index.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const REF_PREFIX = "refs/layers/";

export interface LayerMeta {
	name: string;
	/** Branch the layer forked from (e.g. "main"); "detached@<short>" if forked off a branch. */
	base: string;
	/** Commit the layer forked from — the clean "what changed" diff anchor. */
	baseCommit: string;
	purpose: string;
	agent: string;
	session: string;
	created: string;
	state: "developing" | "tested" | "merged";
}

export interface CommitMeta {
	agent: string;
	session: string;
	purpose: string;
	tool: string;
	turn?: number;
}

export interface LogCommit {
	hash: string;
	subject: string;
	trailers: Record<string, string>;
}

const IDENT = {
	GIT_AUTHOR_NAME: "pi-layers",
	GIT_AUTHOR_EMAIL: "pi-layers@localhost",
	GIT_COMMITTER_NAME: "pi-layers",
	GIT_COMMITTER_EMAIL: "pi-layers@localhost",
};

// ── git plumbing ────────────────────────────────────────────────────
function gitRaw(
	cwd: string,
	args: string[],
	opts: { input?: Buffer | string; indexFile?: string } = {},
): { ok: boolean; stdout: string; stderr: string } {
	const env: NodeJS.ProcessEnv = { ...process.env, ...IDENT };
	if (opts.indexFile) {
		env.GIT_INDEX_FILE = opts.indexFile;
		// update-index --force-remove demands a work tree even though we never
		// read its contents; a scratch dir satisfies the guard.
		env.GIT_WORK_TREE = join(cwd, ".pi", "layers", "tmp");
	}
	try {
		const stdout = execFileSync("git", args, {
			cwd,
			env,
			input: opts.input,
			maxBuffer: 256 * 1024 * 1024,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { ok: true, stdout, stderr: "" };
	} catch (e) {
		const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
		return {
			ok: false,
			stdout: err.stdout ? String(err.stdout) : "",
			stderr: err.stderr ? String(err.stderr) : "",
		};
	}
}

/** Binary-safe git (no utf8 decoding) — for cat-file blob reads. */
function gitRawBytes(
	cwd: string,
	args: string[],
	opts: { input?: Buffer | string } = {},
): { ok: boolean; bytes: Buffer | null } {
	const env: NodeJS.ProcessEnv = { ...process.env, ...IDENT };
	try {
		const bytes = execFileSync("git", args, {
			cwd,
			env,
			input: opts.input,
			maxBuffer: 256 * 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { ok: true, bytes };
	} catch {
		return { ok: false, bytes: null };
	}
}

function git(cwd: string, args: string[], opts = {}): string | null {
	const r = gitRaw(cwd, args, opts);
	return r.ok ? r.stdout : null;
}

function gitText(cwd: string, args: string[], opts = {}): string {
	return (git(cwd, args, opts) ?? "").trim();
}

/** Run git and throw on failure (with stderr) — plumbing ops must not fail silently. */
function must(
	cwd: string,
	args: string[],
	opts: { input?: Buffer | string; indexFile?: string } = {},
	what: string,
): string {
	const r = gitRaw(cwd, args, opts);
	if (!r.ok) throw new Error(`${what} failed${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
	return r.stdout;
}

/** The current branch name, or null if HEAD is detached. */
export function currentBranch(cwd: string): string | null {
	const r = gitRaw(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
	if (!r.ok) return null;
	return r.stdout.trim().replace(/^refs\/heads\//, "") || null;
}

// ── validation ──────────────────────────────────────────────────────
/** Validate a layer name. Cheap regex first, then git's authoritative ref check. */
export function validateName(cwd: string, name: string): string | null {
	if (!name) return "layer name is required";
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
		return "layer name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}";
	}
	// git rejects things the regex allows: `..`, trailing `.`, `.lock`, etc.
	if (!gitRaw(cwd, ["check-ref-format", `refs/layers/${name}`]).ok) {
		return `bad layer name (git check-ref-format): ${name}`;
	}
	return null;
}

/** Normalize a user path to a repo-relative forward-slash path, or null if it escapes. */
export function relPath(cwd: string, p: string): string | null {
	if (!p) return null;
	const abs = isAbsolute(p) ? p : join(cwd, p);
	const rel = relative(cwd, abs).split(sep).join("/");
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel;
}

// ── commit message with provenance trailers ─────────────────────────
function commitMessage(meta: CommitMeta, subject: string): string {
	const lines = [subject || "layer change", ""];
	lines.push(`Agent: ${meta.agent}`);
	lines.push(`Session: ${meta.session}`);
	lines.push(`Purpose: ${meta.purpose}`);
	lines.push(`Tool: ${meta.tool}`);
	if (meta.turn != null) lines.push(`Turn: ${meta.turn}`);
	return lines.join("\n");
}

// ── layer lifecycle ─────────────────────────────────────────────────
export function tip(cwd: string, name: string): string | null {
	return gitText(cwd, ["rev-parse", "--verify", "-q", REF_PREFIX + name]) || null;
}

export function createLayer(cwd: string, name: string): { ref: string; base: string; baseCommit: string } {
	const branch = currentBranch(cwd);
	const baseCommit = gitText(cwd, ["rev-parse", "HEAD"]);
	if (!baseCommit) throw new Error("no HEAD commit to fork from");
	if (git(cwd, ["update-ref", REF_PREFIX + name, baseCommit]) === null) {
		throw new Error(`could not create layer ${name} (update-ref failed)`);
	}
	return { ref: REF_PREFIX + name, base: branch ?? `detached@${baseCommit.slice(0, 8)}`, baseCommit };
}

export function listLayers(cwd: string): string[] {
	return gitText(cwd, ["for-each-ref", "--format=%(refname)", REF_PREFIX])
		.split("\n")
		.filter(Boolean)
		.map((s) => s.slice(REF_PREFIX.length));
}

export function deleteLayer(cwd: string, name: string): boolean {
	return git(cwd, ["update-ref", "-d", REF_PREFIX + name]) !== null;
}

// ── file ops (scratch index, main index untouched) ──────────────────
function tmpIndexFile(cwd: string): string {
	const dir = join(cwd, ".pi", "layers", "tmp");
	mkdirSync(dir, { recursive: true });
	return join(dir, `idx-${process.pid}-${randomBytes(3).toString("hex")}`);
}

/** The git mode of a path in a tree (e.g. "100755" for an executable), or "100644" if absent. */
function modeOf(cwd: string, treeish: string, rel: string): string {
	const line = gitText(cwd, ["ls-tree", treeish, "--", rel]);
	const m = /^(\d{6})\s/.exec(line);
	return m ? m[1] : "100644";
}

export function writeFile(
	cwd: string,
	name: string,
	rel: string,
	bytes: Buffer | string,
	meta: CommitMeta,
	subject?: string,
): string {
	const parent = tip(cwd, name);
	if (!parent) throw new Error(`no such layer: ${name}`);
	const blob = gitText(cwd, ["hash-object", "-w", "--stdin"], { input: bytes });
	if (!blob) throw new Error("hash-object failed");
	// Preserve the existing mode (e.g. executable bit) when overwriting.
	const mode = modeOf(cwd, parent, rel);
	const idx = tmpIndexFile(cwd);
	try {
		must(cwd, ["read-tree", parent], { indexFile: idx }, "read-tree");
		must(cwd, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${rel}`], { indexFile: idx }, "update-index");
		const tree = must(cwd, ["write-tree"], { indexFile: idx }, "write-tree").trim();
		if (!tree) throw new Error("write-tree returned empty");
		const commit = must(
			cwd,
			["commit-tree", tree, "-p", parent, "-m", commitMessage(meta, subject ?? `write ${rel}`)],
			{},
			"commit-tree",
		).trim();
		// CAS: only move the layer ref if it is still at `parent` — a concurrent
		// writer landing first would otherwise be silently orphaned.
		if (!gitRaw(cwd, ["update-ref", REF_PREFIX + name, commit, parent]).ok) {
			throw new Error(`concurrent modification of layer ${name} — retry`);
		}
		return commit;
	} finally {
		rmSync(idx, { force: true });
	}
}

export function removeFile(cwd: string, name: string, rel: string, meta: CommitMeta): string {
	const parent = tip(cwd, name);
	if (!parent) throw new Error(`no such layer: ${name}`);
	// The file must be in the layer tree, else update-index --force-remove is a
	// silent no-op and we'd commit a tree identical to its parent.
	if (!gitRaw(cwd, ["cat-file", "blob", `${parent}:${rel}`]).ok) {
		throw new Error(`no such file in layer: ${rel}`);
	}
	const idx = tmpIndexFile(cwd);
	try {
		must(cwd, ["read-tree", parent], { indexFile: idx }, "read-tree");
		must(cwd, ["update-index", "--force-remove", rel], { indexFile: idx }, "update-index");
		const tree = must(cwd, ["write-tree"], { indexFile: idx }, "write-tree").trim();
		if (!tree) throw new Error("write-tree returned empty");
		const commit = must(
			cwd,
			["commit-tree", tree, "-p", parent, "-m", commitMessage(meta, `rm ${rel}`)],
			{},
			"commit-tree",
		).trim();
		if (!gitRaw(cwd, ["update-ref", REF_PREFIX + name, commit, parent]).ok) {
			throw new Error(`concurrent modification of layer ${name} — retry`);
		}
		return commit;
	} finally {
		rmSync(idx, { force: true });
	}
}

export function readFile(cwd: string, name: string, rel: string): { bytes: Buffer; from: "layer" | "disk" } | null {
	// Binary-safe: read the blob as raw bytes, not a utf8-decoded string.
	const b = gitRawBytes(cwd, ["cat-file", "blob", `${REF_PREFIX}${name}:${rel}`]);
	if (b.ok && b.bytes) return { bytes: b.bytes, from: "layer" };
	try {
		return { bytes: readFileSync(join(cwd, rel)), from: "disk" };
	} catch {
		return null;
	}
}

export function readText(cwd: string, name: string, rel: string): { text: string; from: "layer" | "disk" } | null {
	const r = readFile(cwd, name, rel);
	if (!r) return null;
	return { text: r.bytes.toString("utf8"), from: r.from };
}

export function editFile(
	cwd: string,
	name: string,
	rel: string,
	oldStr: string,
	newStr: string,
	meta: CommitMeta,
): { commit: string; from: "layer" | "disk" } {
	const r = readText(cwd, name, rel);
	if (!r) throw new Error(`no such file: ${rel}`);
	const parts = r.text.split(oldStr);
	if (parts.length - 1 !== 1) {
		throw new Error(`expected exactly one occurrence of the search string in ${rel}, found ${parts.length - 1}`);
	}
	const commit = writeFile(cwd, name, rel, Buffer.from(parts.join(newStr), "utf8"), meta, `edit ${rel}`);
	return { commit, from: r.from };
}

export function listFiles(cwd: string, name: string): string[] {
	// Delta relative to the fork point (merge-base with HEAD) — only the
	// files the layer itself touched, not the full inherited tree.
	const head = gitText(cwd, ["rev-parse", "HEAD"]);
	const args = ["diff", "--name-only"];
	if (head) args.push(`HEAD...${REF_PREFIX}${name}`);
	else args.push(`${REF_PREFIX}${name}`);
	return gitText(cwd, args).split("\n").filter(Boolean);
}

// ── diff / log ──────────────────────────────────────────────────────
export function diff(cwd: string, name: string, baseCommit: string): string {
	return gitText(cwd, ["diff", baseCommit, REF_PREFIX + name]);
}

export function logCommits(cwd: string, refs: string[], limit = 100): LogCommit[] {
	if (refs.length === 0) return [];
	const head = gitText(cwd, ["rev-parse", "HEAD"]);
	const all: LogCommit[] = [];
	for (const ref of refs) {
		// Exclude the fork point (merge-base with HEAD) so the base commit(s)
		// don't pollute the layer's own history — only the layer's commits show.
		const mb = head ? gitText(cwd, ["merge-base", ref, head]) || null : null;
		const args = ["log", "--format=%H%x1f%B%x1e", ref];
		if (mb) args.push("--not", mb);
		args.push("-n", String(limit));
		const out = git(cwd, args);
		if (out) all.push(...parseLog(out));
	}
	return all;
}

function parseLog(out: string): LogCommit[] {
	return out
		.split("\x1e")
		.map((chunk) => chunk.trim())
		.filter(Boolean)
		.map((chunk) => {
			const sep = chunk.indexOf("\x1f");
			const hash = sep === -1 ? chunk : chunk.slice(0, sep);
			const body = sep === -1 ? "" : chunk.slice(sep + 1);
			const lines = body.split("\n");
			const subject = lines[0] ?? "";
			const trailers: Record<string, string> = {};
			let inTrailers = false;
			for (const line of lines.slice(1)) {
				if (line.trim() === "") {
					inTrailers = true;
					continue;
				}
				if (inTrailers) {
					const m = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(line);
					if (m) trailers[m[1]] = m[2];
				}
			}
			return { hash, subject, trailers };
		});
}

// ── merge (atomic, index untouched) ─────────────────────────────────

/**
 * Compute the merge tree of HEAD and the layer tip using `merge-tree --write-tree`.
 * Returns the merged tree hash, or the conflict list if the merge is not clean.
 * Shared by `mergeLayer` (the real CAS merge) and `materializeMerged` (the
 * pre-merge test gate) so the gate tests exactly the tree that merge would land.
 */
export function computeMergeTree(
	cwd: string,
	name: string,
): { tree: string; head: string; layerTip: string } | { error: string; conflicts: string[] } {
	const layerTip = tip(cwd, name);
	if (!layerTip) return { error: `no such layer: ${name}`, conflicts: [] };
	const head = gitText(cwd, ["rev-parse", "HEAD"]);
	if (!head) return { error: "no HEAD commit", conflicts: [] };
	const base = gitText(cwd, ["merge-base", head, layerTip]) || head;
	const { ok, stdout, stderr } = gitRaw(cwd, ["merge-tree", "--write-tree", `--merge-base=${base}`, head, layerTip]);
	const tree = stdout.split("\n")[0]?.trim();
	if (!ok || !tree) {
		const conflicts = [
			...new Set(
				stdout
					.split("\n")
					.map((l) => /^\d{6} [0-9a-f]+ [123]\t(.+)$/.exec(l)?.[1])
					.filter((s): s is string => Boolean(s)),
			),
		];
		return {
			error: `merge conflict${conflicts.length ? ` in ${conflicts.length} file(s)` : ""}${stderr ? `: ${stderr.trim()}` : ""}`,
			conflicts,
		};
	}
	return { tree, head, layerTip };
}

export function mergeLayer(
	cwd: string,
	name: string,
	message: string,
): { commit: string; branch: string } | { error: string; conflicts: string[] } {
	const r = computeMergeTree(cwd, name);
	if ("error" in r) return r;
	const branch = currentBranch(cwd);
	if (!branch) return { error: "detached HEAD — check out a branch before merging", conflicts: [] };
	const { tree, head } = r;
	const commit = gitText(cwd, ["commit-tree", tree, "-p", head, "-m", message]);
	if (!commit) return { error: "commit-tree failed", conflicts: [] };
	// CAS: only move the branch if it is still at `head` (no concurrent lander won).
	const u = git(cwd, ["update-ref", `refs/heads/${branch}`, commit, head]);
	if (u === null) return { error: "branch moved under us — re-test and merge again", conflicts: [] };
	return { commit, branch };
}

// ── test worktree (materialize / remove) ────────────────────────────
export function worktreePath(cwd: string, name: string): string {
	return join(cwd, ".pi", "layers", "worktrees", name);
}

export function materialize(cwd: string, name: string): { path: string } | { error: string } {
	const path = worktreePath(cwd, name);
	mkdirSync(join(cwd, ".pi", "layers", "worktrees"), { recursive: true });
	if (existsSync(path)) return { error: `worktree already exists: ${path}` };
	// Detached checkout of the layer tip — test-only, never committed from here.
	const r = gitRaw(cwd, ["worktree", "add", path, REF_PREFIX + name]);
	if (!r.ok) {
		return { error: r.stderr || r.stdout || "worktree add failed" };
	}
	return { path };
}

/**
 * Materialize the *merge result* of the layer with the current branch into a
 * worktree — the exact tree `mergeLayer` would land — so a test gate can run
 * against current main before the CAS merge. If the merge has conflicts, no
 * worktree is created and the conflict list is returned (adjust the layer
 * first). The worktree is a detached checkout of a throwaway commit whose tree
 * is the merge result; it is removed by `removeWorktree`.
 */
export function materializeMerged(
	cwd: string,
	name: string,
): { path: string } | { error: string; conflicts: string[] } {
	const r = computeMergeTree(cwd, name);
	if ("error" in r) return r;
	const { tree, head } = r;
	const path = worktreePath(cwd, `${name}-merged`);
	mkdirSync(join(cwd, ".pi", "layers", "worktrees"), { recursive: true });
	if (existsSync(path)) return { error: `worktree already exists: ${path}`, conflicts: [] };
	// Throwaway commit at the merge tree, parented at HEAD, so `worktree add --detach`
	// checks out a real commit (a bare tree is not a valid checkout target).
	const tempCommit = gitText(cwd, ["commit-tree", tree, "-p", head, "-m", `layer ${name} merge-test`]);
	if (!tempCommit) return { error: "commit-tree failed for merge-test", conflicts: [] };
	const add = gitRaw(cwd, ["worktree", "add", "--detach", path, tempCommit]);
	if (!add.ok) {
		return { error: add.stderr || add.stdout || "worktree add failed", conflicts: [] };
	}
	return { path };
}

export function removeWorktree(cwd: string, name: string): boolean {
	const path = worktreePath(cwd, name);
	const ok = git(cwd, ["worktree", "remove", "--force", path]) !== null;
	git(cwd, ["worktree", "prune"]);
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
		/* already gone */
	}
	return ok;
}
