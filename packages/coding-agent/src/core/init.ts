// init — one-time project setup. Bootstraps a directory into a fully-wired pi
// workspace:
//
//   1. git repo (git init) + baseline commit on the current branch
//   2. the orphan `pi` backup branch (.pi tracked there, ignored on main)
//   3. AGENTS.md (identity + conventions, read by crew subagent briefings)
//   4. the ontology digest (.pi/ontology/digest.md)
//   5. the empty stores the other tools read (.pi/agents, .pi/recipes,
//      .pi/crawl/topics.json, .pi/context)
//
// then dispatches /discover to survey the codebase.
//
// Every step is idempotent — re-running init skips what already exists and
// never clobbers a file it did not create.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, InlineExtension } from "./extensions/types.ts";
import { ensureDigest, setOntologyRoot } from "./memory/ontology.ts";
import { setupPiBackup } from "./pi-backup.ts";

const execFileP = promisify(execFile);

// ── git helpers ──────────────────────────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return execFileP("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
	try {
		await git(cwd, args);
		return true;
	} catch {
		return false;
	}
}

async function gitConfigGet(cwd: string, key: string): Promise<string | undefined> {
	try {
		const { stdout } = await git(cwd, ["config", "--get", key]);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function isGitRepo(cwd: string): Promise<boolean> {
	return gitOk(cwd, ["rev-parse", "--is-inside-work-tree"]);
}

async function hasHead(cwd: string): Promise<boolean> {
	return gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
}

async function hasStaged(cwd: string): Promise<boolean> {
	return !(await gitOk(cwd, ["diff", "--cached", "--quiet"]));
}

// ── templates ────────────────────────────────────────────────────────────

function agentsMdTemplate(name: string): string {
	return [
		`# ${name}`,
		"",
		"<!-- One line: what this project does and who it is for. Replace this comment. -->",
		"",
		"## Conventions",
		"",
		"- Read before writing; verify before reporting.",
		"- Keep answers short and direct.",
		"",
		"## Commands",
		"",
		"<!-- Build / test / lint. A subagent runs these to verify its work. -->",
		"",
		"## Git",
		"",
		"<!-- Branching, commit, and PR conventions. -->",
		"",
	].join("\n");
}

// ── setup steps ──────────────────────────────────────────────────────────

/** Ensure a git repo exists. Returns whether we created it this run. */
async function ensureGitRepo(cwd: string): Promise<{ initialized: boolean; message: string }> {
	if (await isGitRepo(cwd)) {
		return { initialized: false, message: "git repo already present" };
	}
	try {
		await git(cwd, ["init", "-b", "main"]);
		return { initialized: true, message: "git init (branch: main)" };
	} catch {
		await git(cwd, ["init"]);
		return { initialized: true, message: "git init" };
	}
}

/**
 * Commits need an identity. Leave the user's global config alone; if nothing
 * is set anywhere, drop a local fallback so the baseline commit can land.
 */
async function ensureGitIdentity(cwd: string): Promise<string | null> {
	const name = await gitConfigGet(cwd, "user.name");
	const email = await gitConfigGet(cwd, "user.email");
	if (name && email) return null;
	if (!name) await git(cwd, ["config", "user.name", "pi"]);
	if (!email) await git(cwd, ["config", "user.email", "pi@localhost"]);
	return 'no git identity configured — set a local fallback (user.name=pi, user.email=pi@localhost). Override with: git config user.name "<you>" && git config user.email "<you@example.com>"';
}

/** Write the files that do not exist yet; report one line per action. */
function scaffold(cwd: string): string[] {
	const lines: string[] = [];

	const agentsPath = join(cwd, "AGENTS.md");
	if (existsSync(agentsPath)) {
		lines.push("AGENTS.md already present — left as-is");
	} else {
		writeFileSync(agentsPath, agentsMdTemplate(basename(cwd)), "utf8");
		lines.push("created AGENTS.md");
	}

	const digestPath = join(cwd, ".pi", "ontology", "digest.md");
	const hadDigest = existsSync(digestPath);
	setOntologyRoot(cwd);
	ensureDigest();
	lines.push(hadDigest ? "ontology digest already present" : "created .pi/ontology/digest.md");

	for (const store of [".pi/agents", ".pi/recipes", ".pi/context", ".pi/crawl"]) {
		const p = join(cwd, store);
		if (!existsSync(p)) {
			mkdirSync(p, { recursive: true });
			lines.push(`created ${store}/`);
		}
	}

	const topicsPath = join(cwd, ".pi", "crawl", "topics.json");
	if (!existsSync(topicsPath)) {
		writeFileSync(topicsPath, "[]\n", "utf8");
		lines.push("created .pi/crawl/topics.json (empty)");
	}

	return lines;
}

/**
 * Land a baseline commit so HEAD exists — discovery, worktrees and the orphan
 * branch all want a base. Only runs when the repo is brand-new or has no
 * commits yet; an existing repo with history is left untouched.
 */
async function commitBaseline(cwd: string, initialized: boolean): Promise<string | null> {
	if (!initialized && (await hasHead(cwd))) return null;
	await git(cwd, ["add", "-A"]);
	if (await hasStaged(cwd)) {
		await git(cwd, ["commit", "-m", "chore: init baseline (pi workspace)"]);
		return "baseline commit created on the current branch";
	}
	await git(cwd, ["commit", "--allow-empty", "-m", "chore: init baseline (pi workspace)"]);
	return "baseline commit created (empty repo)";
}

// ── orchestrator ─────────────────────────────────────────────────────────

export async function runInit(cwd: string): Promise<string[]> {
	const lines: string[] = [];

	const repo = await ensureGitRepo(cwd);
	lines.push(repo.message);

	const identity = await ensureGitIdentity(cwd);
	if (identity) lines.push(identity);

	lines.push(...scaffold(cwd));

	const backup = await setupPiBackup(cwd);
	lines.push(backup.text);

	const baseline = await commitBaseline(cwd, repo.initialized);
	if (baseline) lines.push(baseline);

	return lines;
}

// ── inline extension ─────────────────────────────────────────────────────

export function createInitExtension(): InlineExtension {
	return {
		name: "init",
		factory(pi: ExtensionAPI) {
			let root = process.cwd();

			pi.on("session_start", (_event, ctx) => {
				root = ctx?.cwd ?? root;
			});

			pi.registerCommand("init", {
				description:
					"One-time project setup: git repo + baseline commit, orphan pi backup branch, AGENTS.md, ontology digest, and the other .pi stores. Then runs /discover.",
				async handler(_args: string, ctx: ExtensionCommandContext) {
					root = ctx?.cwd ?? root;
					try {
						const lines = await runInit(root);
						ctx.ui?.notify?.(lines.join("\n"), "info");
						// Dispatch the registered /discover command to survey the
						// codebase now that the workspace exists.
						pi.sendUserMessage("/discover", { deliverAs: "followUp", expandPromptTemplates: true });
					} catch (err) {
						ctx.ui?.notify?.(`init failed: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
				},
			});
		},
	};
}
