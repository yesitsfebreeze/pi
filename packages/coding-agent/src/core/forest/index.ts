// Forest — isolated git worktrees under .pi/trees/.
//
// Tools: forest_dispatch (create), forest_cleanup (prune/list/remove).
// Auto-sweep: removes trees whose branch is merged, reclaims stale ones.
// Write-scope enforcement: latched at session_start, blocks writes outside scope.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";

// ── path helpers ───────────────────────────────────────────────────
function real(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

function treesRoot(cwd: string): string {
	return real(join(cwd, ".pi", "trees"));
}

// ── write-scope ────────────────────────────────────────────────────
let scope: string[] | null = null;

function parseScope(raw: string, cwd: string): string[] {
	const out: string[] = [];
	for (let line of raw.split(/[\n:]+/)) {
		line = line.trim();
		if (!line || line.startsWith("#")) continue;
		out.push(real(line.startsWith("/") ? line : join(cwd, line)));
	}
	return out;
}

function latchScope(cwd: string): void {
	const env = process.env.PI_WRITE_SCOPE;
	if (env) {
		scope = parseScope(env, cwd);
	} else {
		const f = join(cwd, ".pi", "write-scope");
		if (!existsSync(f)) {
			scope = null;
		} else {
			try {
				scope = parseScope(readFileSync(f, "utf8"), cwd);
			} catch {
				scope = [];
			}
		}
	}
	const extra = process.env.PI_WRITE_SCOPE_EXTRA;
	if (scope !== null && extra?.trim()) {
		scope = [...scope, ...parseScope(extra, cwd)];
	}
}

function inScope(target: string, prefixes: string[]): boolean {
	if (!target) return true;
	const rt = real(target);
	for (const p of prefixes) {
		if (rt === p || rt.startsWith(`${p}/`)) return true;
	}
	return false;
}

function resolveWriteTarget(t: string, cwd: string): string {
	t = t.trim().replace(/^['"]|['"]$/g, "");
	if (!t || t.startsWith("/dev/") || t.startsWith("$") || t.startsWith("<")) return "";
	const abs = t.startsWith("/") ? t : join(cwd, t);
	// realpathSync fails for not-yet-existing files (the common write case),
	// so resolve the longest existing ancestor and re-append the rest. This
	// keeps symlinked prefixes (/var -> /private/var) consistent with a scope
	// whose dir already exists and was resolved.
	try {
		return realpathSync(abs);
	} catch {
		return join(real(dirname(abs)), basename(abs));
	}
}

// ── git helpers ─────────────────────────────────────────────────────
function git(cwd: string, args: string[], timeout = 15_000): string | null {
	try {
		return execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] });
	} catch {
		return null;
	}
}

// ── auto-sweep ─────────────────────────────────────────────────────
function sweepOrphans(cwd: string): number {
	const root = treesRoot(cwd);
	if (!existsSync(root)) return 0;

	try {
		execSync("git worktree prune", { cwd, stdio: "ignore" });
	} catch {
		/* ok */
	}

	let list: string;
	try {
		list = execSync("git worktree list --porcelain", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
	} catch {
		return 0;
	}

	const realCwd = real(cwd);
	let removed = 0;
	const lines = list.split("\n");
	let wt = "";
	for (const ln of lines) {
		if (ln.startsWith("worktree ")) wt = real(ln.slice(9).trim());
		else if (ln === "") {
			if (!wt || wt === realCwd) {
				wt = "";
				continue;
			}
			if (wt !== root && !wt.startsWith(`${root}/`)) {
				wt = "";
				continue;
			}

			// Merged branch?
			let merged = false;
			try {
				const branch = execSync("git rev-parse --abbrev-ref HEAD", {
					cwd: wt,
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
				if (branch && branch !== "HEAD") {
					let target = "main";
					try {
						const up = execSync(`git rev-parse --abbrev-ref ${branch}@{upstream}`, {
							cwd: wt,
							encoding: "utf8",
							stdio: ["pipe", "pipe", "pipe"],
						}).trim();
						if (up) target = up;
					} catch {
						/* no upstream */
					}
					const mb = execSync(`git merge-base ${branch} ${target}`, {
						cwd: wt,
						encoding: "utf8",
						stdio: ["pipe", "pipe", "pipe"],
					}).trim();
					const head = execSync(`git rev-parse ${branch}`, {
						cwd: wt,
						encoding: "utf8",
						stdio: ["pipe", "pipe", "pipe"],
					}).trim();
					merged = mb === head;
				}
			} catch {
				/* non-critical */
			}

			if (merged) {
				try {
					execSync(`git worktree remove --force ${wt}`, { cwd, stdio: "ignore" });
					removed++;
				} catch {
					/* ok */
				}
				wt = "";
				continue;
			}

			// Stale: clean, no commits ahead, untouched >1h
			let stale = false;
			try {
				stale = Date.now() - statSync(wt).mtimeMs > 60 * 60 * 1000;
			} catch {
				stale = true;
			}
			if (stale) {
				let dirty = true;
				try {
					dirty =
						execSync("git status --porcelain", {
							cwd: wt,
							encoding: "utf8",
							stdio: ["pipe", "pipe", "pipe"],
						}).trim().length > 0;
				} catch {
					/* assume dirty */
				}
				if (!dirty) {
					let ahead = 0;
					try {
						ahead =
							parseInt(
								execSync("git rev-list --count main..HEAD", {
									cwd: wt,
									encoding: "utf8",
									stdio: ["pipe", "pipe", "pipe"],
								}).trim(),
								10,
							) || 0;
					} catch {
						ahead = 1;
					}
					if (ahead === 0) {
						try {
							execSync(`git worktree remove --force ${wt}`, { cwd, stdio: "ignore" });
							removed++;
						} catch {
							/* ok */
						}
					}
				}
			}
			wt = "";
		}
	}
	return removed;
}

// ── extension factory ───────────────────────────────────────────────
export function createForestExtension(): { name: string; factory: (pi: ExtensionAPI) => void } {
	return {
		name: "forest",
		factory(pi: ExtensionAPI) {
			let cwd = process.cwd();
			let ui: ExtensionContext["ui"] | undefined;

			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
				cwd = ctx?.cwd ?? cwd;
				ui = ctx?.ui;
				latchScope(cwd);
				const removed = sweepOrphans(cwd);
				if (removed) ui?.notify?.(`forest: reclaimed ${removed} worktree(s) under .pi/trees`, "info");
			});

			pi.on("session_shutdown", () => {
				ui = undefined;
			});

			// ── write-scope enforcement ───────────────────────────
			pi.on("tool_call", async (event: { toolName: string; input: Record<string, unknown> }) => {
				if (scope === null) return;
				if (!scope.length) {
					return { block: true, reason: "write-scope: scoped but no allowed prefixes." };
				}

				let targets: string[] = [];
				const tn = event.toolName;
				if (tn === "write" || tn === "edit") {
					const p = event.input.path;
					if (typeof p === "string") targets = [p];
				} else if (tn === "bash") {
					const cmd = String(event.input.command ?? "");
					for (const m of cmd.matchAll(/(?<![\d\->])&?\d?>>?\s*([^\s;&|<>()]+)/g)) {
						const t = m[1].trim().replace(/^['"]|['"]$/g, "");
						if (t) targets.push(t);
					}
					for (const m of cmd.matchAll(/\btee\b([^;&|<>()]*)/g)) {
						for (const tok of m[1].split(/\s+/)) {
							if (tok && !tok.startsWith("-")) targets.push(tok.replace(/^['"]|['"]$/g, ""));
						}
					}
					for (const m of cmd.matchAll(/\b(?:cp|mv|rsync)\b((?:\s+[^\s;&|<>()]+)+)/g)) {
						const args = m[1].split(/\s+/).filter((t: string) => t && !t.startsWith("-"));
						if (args.length >= 2) targets.push(args[args.length - 1]);
					}
					for (const m of cmd.matchAll(/\bsed\s+(-[^\s;&|]*i[^\s;&|]*)((?:\s+[^\s;&|<>()]+)+)/g)) {
						const args = m[2].split(/\s+/).filter((t: string) => t && !t.startsWith("-"));
						const rest = m[1].includes("e") ? args : args.slice(1);
						for (const t of rest) targets.push(t);
					}
					for (const m of cmd.matchAll(/\bdd\b[^;&|]*?\bof=([^\s;&|<>()]+)/g)) targets.push(m[1]);
				} else {
					return; // non-write tool
				}

				for (const raw of targets) {
					const t = resolveWriteTarget(raw, cwd);
					if (t && !inScope(t, scope)) {
						return { block: true, reason: `write-scope: ${t} is outside scope (${scope.join(", ")}).` };
					}
				}
			});

			// ── tool: forest_dispatch ──────────────────────────────
			pi.registerTool({
				name: "forest_dispatch",
				label: "Forest: Dispatch",
				description:
					"Create an isolated git worktree under .pi/trees/. Returns path. Write-scope is pre-configured.",
				parameters: Type.Object({
					branch: Type.Optional(Type.String({ description: "Branch name (default: pi-forest-<pid>)" })),
					base: Type.Optional(Type.String({ description: "Base branch (default: current branch)" })),
				}),
				async execute(_id: string, params: Record<string, unknown>) {
					const args = params as { branch?: string; base?: string };
					const name = args.branch || `pi-forest-${process.pid}`;

					let base = args.base;
					if (!base) {
						const r = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
						base = r?.trim() || "main";
					}
					if (!base || base === "HEAD") base = "main";

					mkdirSync(treesRoot(cwd), { recursive: true });
					const wpath = join(cwd, ".pi", "trees", name);

					const r = git(cwd, ["worktree", "add", "-b", name, wpath, base]);
					if (r === null) {
						return {
							content: [{ type: "text" as const, text: `Failed to create worktree at ${wpath}` }],
							details: {},
						};
					}

					mkdirSync(join(wpath, ".pi"), { recursive: true });
					writeFileSync(join(wpath, ".pi", "write-scope"), `${real(wpath)}\n`);

					return {
						content: [
							{
								type: "text" as const,
								text: `worktree: ${real(wpath)}\nbranch: ${name}\nbase: ${base}\nWrite-scope set.`,
							},
						],
						details: {},
					};
				},
			} as ToolDefinition);

			// ── tool: forest_cleanup ───────────────────────────────
			pi.registerTool({
				name: "forest_cleanup",
				label: "Forest: Cleanup",
				description:
					"Clean up worktrees under .pi/trees/: prune, list, or remove. Auto-detects merged branches. Never touches outside .pi/trees/.",
				parameters: Type.Object({
					action: Type.Union([Type.Literal("list"), Type.Literal("prune"), Type.Literal("remove")], {
						description: "list (default), prune metadata, remove trees",
					}),
					path: Type.Optional(
						Type.String({ description: "Tree path to remove. Omit to remove all under .pi/trees/." }),
					),
				}),
				async execute(_id: string, params: Record<string, unknown>) {
					const args = params as { action?: string; path?: string };
					const action = args.action || "list";
					const root = treesRoot(cwd);

					if (action === "prune") {
						git(cwd, ["worktree", "prune"]);
						const left = git(cwd, ["worktree", "list"])?.trim() || "no worktrees";
						return { content: [{ type: "text" as const, text: left }], details: {} };
					}

					if (action === "remove") {
						const requested = args.path ? real(args.path) : null;
						if (requested && !(requested === root || requested.startsWith(`${root}/`))) {
							return {
								content: [
									{
										type: "text" as const,
										text: `refusing to remove worktree outside .pi/trees/: ${args.path}`,
									},
								],
								details: {},
							};
						}

						const list = git(cwd, ["worktree", "list", "--porcelain"]);
						if (!list) return { content: [{ type: "text" as const, text: "no worktrees" }], details: {} };

						const targets: string[] = [];
						const lines = list.split("\n");
						let wt = "";
						for (const ln of lines) {
							if (ln.startsWith("worktree ")) wt = real(ln.slice(9).trim());
							else if (ln === "") {
								if (!wt || wt === real(cwd)) {
									wt = "";
									continue;
								}
								if (wt !== root && !wt.startsWith(`${root}/`)) {
									wt = "";
									continue;
								}
								if (requested ? wt === requested : true) targets.push(wt);
								wt = "";
							}
						}

						if (!targets.length) {
							return { content: [{ type: "text" as const, text: "no matching trees to remove" }], details: {} };
						}

						const out: string[] = [];
						for (const t of targets) {
							const r = git(cwd, ["worktree", "remove", "--force", t]);
							out.push(r !== null ? `removed ${t}` : `failed to remove ${t}`);
						}
						git(cwd, ["worktree", "prune"]);
						const left = git(cwd, ["worktree", "list"])?.trim() || "done";
						out.push("", left);
						return { content: [{ type: "text" as const, text: out.join("\n") }], details: {} };
					}

					// list
					const all = git(cwd, ["worktree", "list"]);
					const mergedOut: string[] = [];
					const plist = git(cwd, ["worktree", "list", "--porcelain"]);
					if (plist) {
						const lines = plist.split("\n");
						let wt = "";
						for (const ln of lines) {
							if (ln.startsWith("worktree ")) wt = real(ln.slice(9).trim());
							else if (ln === "") {
								if (wt !== root && !wt.startsWith(`${root}/`)) {
									wt = "";
									continue;
								}
								try {
									const branch = execSync("git rev-parse --abbrev-ref HEAD", {
										cwd: wt,
										encoding: "utf8",
										stdio: ["pipe", "pipe", "pipe"],
									}).trim();
									if (branch && branch !== "HEAD") {
										let target = "main";
										try {
											const up = execSync(`git rev-parse --abbrev-ref ${branch}@{upstream}`, {
												cwd: wt,
												encoding: "utf8",
												stdio: ["pipe", "pipe", "pipe"],
											}).trim();
											if (up) target = up;
										} catch {
											/* no upstream */
										}
										const mb = execSync(`git merge-base ${branch} ${target}`, {
											cwd: wt,
											encoding: "utf8",
											stdio: ["pipe", "pipe", "pipe"],
										}).trim();
										const head = execSync(`git rev-parse ${branch}`, {
											cwd: wt,
											encoding: "utf8",
											stdio: ["pipe", "pipe", "pipe"],
										}).trim();
										if (mb === head) mergedOut.push(`  ${wt} [merged — safe to remove]`);
									}
								} catch {
									/* skip */
								}
								wt = "";
							}
						}
					}
					const text = [(all || "no worktrees").trim()];
					if (mergedOut.length) text.push("", "# Merged:", ...mergedOut);
					return { content: [{ type: "text" as const, text: text.join("\n") }], details: {} };
				},
			} as ToolDefinition);
		},
	};
}
