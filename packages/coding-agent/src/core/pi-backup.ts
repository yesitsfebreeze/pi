// pi-backup — keep a project's agent data (.pi) on a dedicated orphan branch,
// keeping the main branch free of agent code.
//
// Pattern: the main branch ignores `.pi/`; an orphan branch `pi` carries an
// *inverted* .gitignore (ignore everything except `.pi/`), so it tracks exactly
// that data and nothing else. The two branches
// share one working directory but track disjoint subsets — no submodules, no
// working-tree churn.
//
// All branch writes use a private index + commit-tree + update-ref (never a
// checkout, and the working tree is never touched — not even the .gitignore,
// which is staged from a blob). Each call stages into its own index file, so
// concurrent pi sessions can't corrupt each other's staging.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, InlineExtension } from "./extensions/types.ts";

const execFileP = promisify(execFile);

const ORPHAN_BRANCH = "pi";
// The well-known empty tree object; present in every git repo.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DATA_DIRS = [".pi"];

export interface BackupResult {
	ok: boolean;
	/** One line per action taken, rendered to the user. */
	text: string;
}

// Bound every git call so a hung process (dead network, credential prompt,
// wedged index) dies instead of accumulating across sessions — with several
// sessions auto-syncing per tool call, unbounded pushes can exhaust the
// process table (fork EAGAIN) and take the user's shell down with it.
const GIT_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
	return execFileP("git", args, {
		cwd,
		encoding: "utf8",
		env: env ? { ...process.env, ...env } : process.env,
		maxBuffer: 32 * 1024 * 1024,
		timeout: GIT_TIMEOUT_MS,
	});
}

async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
		return true;
	} catch {
		return false;
	}
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
	try {
		await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
		return true;
	} catch {
		return false;
	}
}

/** Paths currently staged on the real index. */
async function stagedPaths(cwd: string): Promise<Set<string>> {
	const { stdout } = await git(cwd, ["diff", "--cached", "--name-only"]);
	return new Set(stdout.trim().split("\n").filter(Boolean));
}

/** Existing data dirs. */
function existingDataDirs(cwd: string): string[] {
	return DATA_DIRS.filter((d) => existsSync(join(cwd, d)));
}

/** Relative paths (e.g. ".pi/trees") of nested git repos/worktrees and
 * mis-rooted pi stores under the data dirs — these must never be committed
 * to the orphan branch. */
function detectNestedRoots(cwd: string, dirs: string[]): string[] {
	const roots: string[] = [];
	const stack = dirs.map((d) => join(cwd, d));
	while (stack.length > 0) {
		const dir = stack.pop()!;
		if (!existsSync(dir)) continue;
		try {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				if (e.name === ".git") {
					// file (worktree pointer) or dir (nested repo): the containing
					// directory is the nested root.
					roots.push(relative(cwd, dir));
					continue;
				}
				if (e.name === ".pi") {
					// a pi store rooted inside the store (e.g. .pi/.pi from a
					// session whose cwd was the store) — the dir itself is the
					// nested root.
					roots.push(relative(cwd, join(dir, e.name)));
					continue;
				}
				if (e.isDirectory() && e.name !== "node_modules") stack.push(join(dir, e.name));
			}
		} catch {}
	}
	return roots;
}

function buildOrphanGitignore(nestedRoots: string[]): string {
	const excludes = nestedRoots.map((p) => `/${p}/`).join("\n");
	return [
		"# pi backup branch — inverse gitignore: track only agent data.",
		"# The main branch ignores this; this branch ignores everything else.",
		"/*",
		"!.gitignore",
		"!/.pi/",
		excludes,
		"",
	].join("\n");
}

/** Ensure the orphan branch exists (as a root commit) and push the current
 * data dirs onto it. Idempotent; safe to call repeatedly. */
export async function pushPiBackup(cwd: string): Promise<BackupResult> {
	if (!(await isGitRepo(cwd))) {
		return { ok: false, text: "not a git repo — nothing to back up" };
	}
	const dirs = existingDataDirs(cwd);
	if (dirs.length === 0) {
		return { ok: true, text: "no .pi directory yet — nothing to back up" };
	}

	if (!(await refExists(cwd, `refs/heads/${ORPHAN_BRANCH}`))) {
		const commit = (
			await git(cwd, ["commit-tree", EMPTY_TREE, "-m", "chore: pi backup branch (orphan)"])
		).stdout.trim();
		await git(cwd, ["update-ref", `refs/heads/${ORPHAN_BRANCH}`, commit]);
	}

	const nested = detectNestedRoots(cwd, dirs);
	const orphanGitignore = buildOrphanGitignore(nested);
	// Unique per call: concurrent pi sessions share the repo but must not
	// share a staging area.
	const idx = join(cwd, ".git", `pi-backup-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
	const env = { GIT_INDEX_FILE: idx };

	try {
		await git(cwd, ["read-tree", ORPHAN_BRANCH], env);

		// Stage the inverted .gitignore from a blob — the working-tree
		// .gitignore is never touched, so a sync can't clobber user edits.
		const tmpGitignore = join(
			cwd,
			".git",
			`pi-backup-gitignore-${process.pid}-${Math.random().toString(36).slice(2)}`,
		);
		try {
			writeFileSync(tmpGitignore, orphanGitignore, "utf8");
			const { stdout: gitignoreBlob } = await git(cwd, ["hash-object", "-w", tmpGitignore], env);
			await git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${gitignoreBlob.trim()},.gitignore`], env);
		} finally {
			rmSync(tmpGitignore, { force: true });
		}
		// -f bypasses main's ignore rules (which exclude the data dirs);
		// nested git roots get dropped from the index afterwards.
		await git(cwd, ["add", "-f", ...dirs], env);
		if (nested.length > 0) {
			await git(cwd, ["rm", "-r", "--cached", "--ignore-unmatch", "--", ...nested], env);
		}

		const tree = (await git(cwd, ["write-tree"], env)).stdout.trim();
		const parent = (await git(cwd, ["rev-parse", ORPHAN_BRANCH])).stdout.trim();
		const parentTree = (await git(cwd, ["rev-parse", `${ORPHAN_BRANCH}^{tree}`])).stdout.trim();
		if (tree === parentTree) {
			return { ok: true, text: `nothing new to back up — ${ORPHAN_BRANCH} branch is current` };
		}
		const commit = (await git(cwd, ["commit-tree", tree, "-p", parent, "-m", "chore: pi backup"], env)).stdout.trim();
		await git(cwd, ["update-ref", `refs/heads/${ORPHAN_BRANCH}`, commit]);
	} finally {
		rmSync(idx, { force: true });
	}

	return { ok: true, text: `backed up ${dirs.join(", ")} to orphan branch ${ORPHAN_BRANCH}` };
}

/** Materialize the data dirs from the orphan branch into the working tree.
 * Only fills in dirs that are missing locally, so a fresh clone gets the data
 * without clobbering existing work. Never touches the real index: files land
 * in the working tree only (git archive into a temp tar, extracted with tar),
 * so main's ignore/untrack state survives and a repo that still tracks .pi
 * paths (mid-migration, or gantt `!`-negations) is left exactly as it was. */
export async function pullPiBackup(cwd: string): Promise<BackupResult> {
	if (!(await isGitRepo(cwd))) {
		return { ok: false, text: "not a git repo — nothing to pull" };
	}
	let ref = ORPHAN_BRANCH;
	if (!(await refExists(cwd, `refs/heads/${ORPHAN_BRANCH}`))) {
		if (await refExists(cwd, `refs/remotes/origin/${ORPHAN_BRANCH}`)) {
			ref = `origin/${ORPHAN_BRANCH}`;
		} else {
			try {
				await git(cwd, ["fetch", "origin", ORPHAN_BRANCH]);
				ref = `origin/${ORPHAN_BRANCH}`;
			} catch {
				return { ok: false, text: `no ${ORPHAN_BRANCH} branch locally or on origin — run setup first` };
			}
		}
	}

	const materialized: string[] = [];
	for (const d of DATA_DIRS) {
		if (existsSync(join(cwd, d))) continue;
		const tmpTar = join(cwd, ".git", `pi-pull-archive-${process.pid}-${Math.random().toString(36).slice(2)}.tar`);
		try {
			// Extract only the data dir; a mis-rooted store (.pi/.pi) that a
			// stale branch still carries is excluded rather than resurrected.
			await git(cwd, ["archive", "--format=tar", "-o", tmpTar, ref, "--", d, `:(exclude)${d}/.pi`]);
			await execFileP("tar", ["-xf", tmpTar, "-C", cwd], { timeout: GIT_TIMEOUT_MS });
			if (existsSync(join(cwd, d))) materialized.push(d);
		} catch {
			// path absent on the branch — skip
		} finally {
			rmSync(tmpTar, { force: true });
		}
	}

	if (materialized.length === 0) {
		return { ok: true, text: "nothing to pull — data dirs already present or empty on the branch" };
	}
	return { ok: true, text: `pulled ${materialized.join(", ")} from ${ref}` };
}

/** One-time setup: stop tracking the data dirs on the current branch, ignore
 * them, and create + populate the orphan branch. Idempotent. */
export async function setupPiBackup(cwd: string): Promise<BackupResult> {
	if (!(await isGitRepo(cwd))) {
		return { ok: false, text: "not a git repo — run inside a project with git" };
	}
	const lines: string[] = [];

	// 1. Ensure the data dirs are ignored on main, then untrack exactly what
	// the ignore rules exclude. Negation overrides survive setup — e.g. a
	// gantt board re-included via `!/.pi/gantt/**` (claim/release lock commits
	// on main) stays tracked instead of being re-untracked at every session
	// start.
	const before = await stagedPaths(cwd);

	const gitignorePath = join(cwd, ".gitignore");
	let gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
	let changed = false;
	for (const d of DATA_DIRS) {
		const entry = `${d}/`;
		if (!gitignore.split("\n").some((l) => l.trim() === entry)) {
			gitignore += `${(gitignore.endsWith("\n") ? "" : "\n") + entry}\n`;
			changed = true;
		}
	}
	if (changed) {
		writeFileSync(gitignorePath, gitignore, "utf8");
		await git(cwd, ["add", gitignorePath]);
		lines.push("added .pi/ to .gitignore");
	}

	const tracked = await git(cwd, ["ls-files", "--cached", "-z", "--", ...DATA_DIRS]);
	if (tracked.stdout.length > 0) {
		const trackedPaths = tracked.stdout.replace(/\0$/, "").split("\0").filter(Boolean);
		// check-ignore reports only paths the ignore rules exclude; anything a
		// `!` negation re-includes stays tracked on main. Exit 1 (nothing
		// ignored) surfaces as an empty set.
		let ignoredPaths: string[] = [];
		try {
			const { stdout: ignored } = await git(cwd, ["check-ignore", "--no-index", "--", ...trackedPaths]);
			ignoredPaths = ignored
				.split("\n")
				.map((p) => p.trim())
				.filter(Boolean);
		} catch {
			// nothing ignored — negations cover everything tracked
		}
		if (ignoredPaths.length > 0) {
			await git(cwd, ["rm", "-r", "--cached", "--ignore-unmatch", "--", ...ignoredPaths]);
			lines.push(`untracked ${ignoredPaths.length} ignored .pi file(s) on main (negated overrides left tracked)`);
		}
	}

	// Commit only what setup itself staged — never sweep the user's staged
	// work (e.g. an in-progress gantt claim) into a chore commit, and never
	// create one when there is nothing to untrack.
	const after = await stagedPaths(cwd);
	const ours = [...after].filter((p) => !before.has(p));
	const theirs = [...after].filter((p) => before.has(p));
	if (ours.length > 0 && theirs.length === 0) {
		await git(cwd, ["commit", "-m", "chore: track pi data on the orphan pi branch"]);
		lines.push("committed the .gitignore/untrack changes on the current branch");
	} else if (ours.length > 0) {
		lines.push("left the .gitignore/untrack changes staged — you have other staged changes; commit them together");
	}

	// 2. Create + populate the orphan branch.
	const pushed = await pushPiBackup(cwd);
	lines.push(pushed.text);

	return { ok: pushed.ok, text: lines.join("\n") };
}

// ── auto-sync extension ───────────────────────────────────────────────────

const SYNC_DEBOUNCE_MS = 3000;

/**
 * Behind-the-scenes auto-sync: one-time setup + materialize on session start,
 * a debounced commit + push after each tool execution, and a final flush on
 * shutdown. No user-facing command required.
 */
export function createPiBackupExtension(): InlineExtension {
	return {
		name: "pi-backup",
		factory(pi: ExtensionAPI) {
			let root = process.cwd();
			let timer: ReturnType<typeof setTimeout> | null = null;
			// Serialize this instance's git operations; each call also uses its
			// own temp index, so other sessions can't interfere.
			let chain: Promise<void> = Promise.resolve();

			const enqueue = (work: () => Promise<void>): Promise<void> => {
				chain = chain.then(work).catch(() => {});
				return chain;
			};

			const sync = (cwd: string): Promise<void> =>
				enqueue(async () => {
					const pushed = await pushPiBackup(cwd);
					if (!pushed.ok) return;
					try {
						// Force: the orphan branch is a pure mirror of local .pi
						// state — last writer wins, never merge.
						await execFileP("git", ["push", "--force", "origin", ORPHAN_BRANCH], {
							cwd,
							timeout: PUSH_TIMEOUT_MS,
						});
					} catch {
						// offline or no remote — the local branch is still current
					}
				});

			const schedule = (): void => {
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					timer = null;
					void sync(root);
				}, SYNC_DEBOUNCE_MS);
			};

			pi.on("session_start", (_event, ctx) => {
				root = ctx?.cwd ?? root;
				void enqueue(async () => {
					await setupPiBackup(root);
					await pullPiBackup(root);
				});
			});

			pi.on("tool_execution_end", () => {
				schedule();
			});

			pi.on("session_shutdown", () => {
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				return sync(root);
			});
		},
	};
}
