// layers/index.ts — inline extension: develop-on-refs with provenance.
//
// A "layer" is a branch under refs/layers/<name> forked from the current HEAD.
// Agents write to layers without a worktree; every commit carries provenance
// trailers (Agent/Session/Purpose/Tool/Turn). To validate, `layer_test`
// materializes the layer into one ephemeral worktree, runs a command, and
// removes it. On success, `layer_merge` squash-merges the layer onto the
// current branch as a single checkpoint commit (atomic CAS update) and drops
// the layer ref. Metadata lives under .pi/layers/<name>.json.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import {
	type CommitMeta,
	createLayer,
	deleteLayer,
	diff,
	editFile,
	type LayerMeta,
	listFiles,
	listLayers,
	logCommits,
	materialize,
	materializeMerged,
	mergeLayer,
	readText,
	relPath,
	removeFile,
	removeWorktree,
	tip,
	validateName,
	writeFile,
} from "./store.ts";

// ── metadata ────────────────────────────────────────────────────────
function metaPath(cwd: string, name: string): string {
	return join(cwd, ".pi", "layers", `${name}.json`);
}

function loadMeta(cwd: string, name: string): LayerMeta | null {
	try {
		return JSON.parse(readFileSync(metaPath(cwd, name), "utf8")) as LayerMeta;
	} catch {
		return null;
	}
}

function saveMeta(cwd: string, meta: LayerMeta): void {
	mkdirSync(join(cwd, ".pi", "layers"), { recursive: true });
	writeFileSync(metaPath(cwd, meta.name), JSON.stringify(meta, null, 2));
}

function deleteMeta(cwd: string, name: string): void {
	try {
		rmSync(metaPath(cwd, name), { force: true });
	} catch {
		/* ok */
	}
}

// ── active layer (the layer this session is currently focused on) ───
function activePath(cwd: string): string {
	return join(cwd, ".pi", "layers", "active.json");
}

function loadActive(cwd: string): string | null {
	try {
		const raw = JSON.parse(readFileSync(activePath(cwd), "utf8")) as { layer?: string };
		return raw.layer ?? null;
	} catch {
		return null;
	}
}

function saveActive(cwd: string, layer: string | null): void {
	mkdirSync(join(cwd, ".pi", "layers"), { recursive: true });
	if (!layer) {
		rmSync(activePath(cwd), { force: true });
		return;
	}
	writeFileSync(activePath(cwd), JSON.stringify({ layer, setAt: new Date().toISOString() }, null, 2));
}

// ── deps sharing (the rebuild-cost fix) ─────────────────────────────
function shareNodeModules(cwd: string, wpath: string): void {
	const src = join(cwd, "node_modules");
	const dst = join(wpath, "node_modules");
	if (!existsSync(src) || existsSync(dst)) return;
	try {
		symlinkSync(src, dst, "dir");
	} catch {
		/* best effort — the test command can still install on its own */
	}
}

// ── extension factory ───────────────────────────────────────────────
export function createLayersExtension(): { name: string; factory: (pi: ExtensionAPI) => void } {
	return {
		name: "layers",
		factory(pi: ExtensionAPI) {
			let cwd = process.cwd();
			let session = "self";
			let agent = process.env.CREW_HANDLE ?? "self";
			let turn = 0;
			let activeLayer: string | null = null;

			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
				cwd = ctx?.cwd ?? cwd;
				session = ctx?.sessionManager?.getSessionId?.() ?? session;
				agent = process.env.CREW_HANDLE ?? "self";
				// Restore the active layer for this repo, but only if the ref still exists
				// (a layer merged/discard in another session would otherwise leave a stale pointer).
				const restored = loadActive(cwd);
				activeLayer = restored && tipExists(cwd, restored) ? restored : null;
				if (restored && !activeLayer) saveActive(cwd, null);
			});

			pi.on("turn_start", () => {
				turn += 1;
			});

			const metaFor = (layer: string, tool: string): CommitMeta => {
				const m = loadMeta(cwd, layer);
				return { agent, session, purpose: m?.purpose ?? "", tool, turn };
			};

			// Re-assert cwd/session/agent on every tool execute — a tool invoked after
			// a mid-session cwd switch would otherwise read the wrong repo (the gantt/
			// crawl pitfall).
			const latch = (ctx: ExtensionContext) => {
				cwd = ctx.cwd;
				session = ctx.sessionManager?.getSessionId?.() ?? session;
				agent = process.env.CREW_HANDLE ?? "self";
			};

			/** Resolve a layer argument: explicit wins, else fall back to the active layer. */
			const resolveLayer = (layer: string | undefined, tool: string): string | { error: string } => {
				const resolved = layer ?? activeLayer;
				if (!resolved) {
					return {
						error: `no layer specified and no active layer set. Create one with layer_new, or pass the 'layer' parameter to ${tool}.`,
					};
				}
				if (!tipExists(cwd, resolved)) {
					return { error: `no such layer: ${resolved}` };
				}
				return resolved;
			};

			const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
			const fail = (s: string) => text(s);

			// ── layer_new ───────────────────────────────────────────
			pi.registerTool({
				name: "layer_new",
				label: "Layer: New",
				promptSnippet: "Start a layer: a git branch under refs/layers/ that accumulates work without a worktree",
				description:
					"Create a new layer (a git branch under refs/layers/<name> forked from the current branch). A layer is where an agent accumulates work without a worktree. Give it a short name and a one-line purpose; the purpose is recorded on every commit so the work is filterable by why it was made.",
				parameters: Type.Object({
					name: Type.String({ description: "Short kebab-case layer name, e.g. auth-rewrite" }),
					purpose: Type.String({ description: "One line describing why this layer exists" }),
				}),
				promptGuidelines: [
					"Judge scope per request and reach for layers on non-trivial work: call layer_new (with a short name + one-line purpose), then layer_write/layer_edit to accumulate changes, layer_test to validate, and layer_merge to land them as one checkpoint commit. Use layers when a change spans multiple files, benefits from isolation or provenance (why it was made), or wants a test-then-merge gate.",
					"Do NOT use layers for trivial edits (one-line fixes, typos, single-file tweaks, pure exploration) — edit the working tree directly with edit/write. Layers add overhead; only pay it when the change is big enough to justify a checkpoint.",
					"If the user says 'no layers', 'don't use layers', or asks to work directly, respect that and skip layers for that request.",
				],
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const { name, purpose } = params as { name: string; purpose: string };
					const bad = validateName(cwd, name);
					if (bad) return fail(bad);
					if (tipExists(cwd, name)) return fail(`layer already exists: ${name}`);
					const { base, baseCommit } = createLayer(cwd, name);
					const meta: LayerMeta = {
						name,
						base,
						baseCommit,
						purpose: purpose ?? "",
						agent,
						session,
						created: new Date().toISOString(),
						state: "developing",
					};
					saveMeta(cwd, meta);
					activeLayer = name;
					saveActive(cwd, name);
					return text(
						`layer ${name} created (forked from ${base} @ ${baseCommit.slice(0, 8)})\npurpose: ${meta.purpose}\nactive layer set: ${name}`,
					);
				},
			} as ToolDefinition);

			// ── layer_write ─────────────────────────────────────────
			pi.registerTool({
				name: "layer_write",
				label: "Layer: Write",
				promptSnippet: "Write a whole file inside a layer",
				description:
					"Write a file into a layer (create or overwrite). Commits to the layer with provenance trailers; does not touch the working tree or index. Omit 'layer' to target the active layer.",
				parameters: Type.Object({
					layer: Type.Optional(Type.String({ description: "Layer name (defaults to the active layer)" })),
					path: Type.String({ description: "Repo-relative file path" }),
					content: Type.String({ description: "Full file content" }),
					message: Type.Optional(Type.String({ description: "Why this change (defaults to 'write <path>')" })),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const {
						layer: layerArg,
						path,
						content,
						message,
					} = params as {
						layer?: string;
						path: string;
						content: string;
						message?: string;
					};
					const rel = relPath(cwd, path);
					if (!rel) return fail(`bad path: ${path}`);
					const resolved = resolveLayer(layerArg, "layer_write");
					if (typeof resolved === "object") return fail(resolved.error);
					const layer = resolved;
					try {
						const commit = writeFile(
							cwd,
							layer,
							rel,
							Buffer.from(content, "utf8"),
							metaFor(layer, "layer_write"),
							message,
						);
						return text(`wrote ${rel} to layer ${layer} @ ${commit.slice(0, 8)}`);
					} catch (e) {
						return fail((e as Error).message);
					}
				},
			} as ToolDefinition);

			// ── layer_edit ──────────────────────────────────────────
			pi.registerTool({
				name: "layer_edit",
				label: "Layer: Edit",
				promptSnippet: "Edit a file inside a layer",
				description:
					"Replace exactly one occurrence of a string in a file inside a layer. Reads the layer's version of the file (falling back to the working tree), so edits stack correctly. Omit 'layer' to target the active layer.",
				parameters: Type.Object({
					layer: Type.Optional(Type.String({ description: "Layer name (defaults to the active layer)" })),
					path: Type.String({ description: "Repo-relative file path" }),
					old: Type.String({ description: "Exact text to replace (must occur exactly once)" }),
					new: Type.String({ description: "Replacement text" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const {
						layer: layerArg,
						path,
						old: oldStr,
						new: newStr,
					} = params as {
						layer?: string;
						path: string;
						old: string;
						new: string;
					};
					const rel = relPath(cwd, path);
					if (!rel) return fail(`bad path: ${path}`);
					const resolved = resolveLayer(layerArg, "layer_edit");
					if (typeof resolved === "object") return fail(resolved.error);
					const layer = resolved;
					try {
						const { commit, from } = editFile(cwd, layer, rel, oldStr, newStr, metaFor(layer, "layer_edit"));
						return text(`edited ${rel} in layer ${layer} @ ${commit.slice(0, 8)} (read from ${from})`);
					} catch (e) {
						return fail((e as Error).message);
					}
				},
			} as ToolDefinition);

			// ── layer_read ──────────────────────────────────────────
			pi.registerTool({
				name: "layer_read",
				label: "Layer: Read",
				promptSnippet: "Read a file as it stands inside a layer",
				description:
					"Read a file as it exists in a layer. Returns the layer's version when the path is tracked there, otherwise the working-tree bytes. Omit 'layer' to target the active layer.",
				parameters: Type.Object({
					layer: Type.Optional(Type.String({ description: "Layer name (defaults to the active layer)" })),
					path: Type.String({ description: "Repo-relative file path" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const { layer: layerArg, path } = params as { layer?: string; path: string };
					const rel = relPath(cwd, path);
					if (!rel) return fail(`bad path: ${path}`);
					const resolved = resolveLayer(layerArg, "layer_read");
					if (typeof resolved === "object") return fail(resolved.error);
					const r = readText(cwd, resolved, rel);
					if (!r) return fail(`no such file: ${rel}`);
					return text(r.text);
				},
			} as ToolDefinition);

			// ── layer_rm ────────────────────────────────────────────
			pi.registerTool({
				name: "layer_rm",
				label: "Layer: Remove",
				promptSnippet: "Delete a file inside a layer",
				description:
					"Remove a file from a layer (records the deletion as a commit). Omit 'layer' to target the active layer.",
				parameters: Type.Object({
					layer: Type.Optional(Type.String({ description: "Layer name (defaults to the active layer)" })),
					path: Type.String({ description: "Repo-relative file path" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const { layer: layerArg, path } = params as { layer?: string; path: string };
					const rel = relPath(cwd, path);
					if (!rel) return fail(`bad path: ${path}`);
					const resolved = resolveLayer(layerArg, "layer_rm");
					if (typeof resolved === "object") return fail(resolved.error);
					const layer = resolved;
					try {
						const commit = removeFile(cwd, layer, rel, metaFor(layer, "layer_rm"));
						return text(`removed ${rel} from layer ${layer} @ ${commit.slice(0, 8)}`);
					} catch (e) {
						return fail((e as Error).message);
					}
				},
			} as ToolDefinition);

			// ── layer_diff ──────────────────────────────────────────
			pi.registerTool({
				name: "layer_diff",
				label: "Layer: Diff",
				promptSnippet: "Show a layer's diff against its base",
				description:
					"Show what a layer changed relative to the commit it forked from. Omit 'layer' to target the active layer.",
				parameters: Type.Object({
					layer: Type.Optional(Type.String({ description: "Layer name (defaults to the active layer)" })),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const { layer: layerArg } = params as { layer?: string };
					const resolved = resolveLayer(layerArg, "layer_diff");
					if (typeof resolved === "object") return fail(resolved.error);
					const meta = loadMeta(cwd, resolved);
					if (!meta) return fail(`no metadata for layer: ${resolved}`);
					const out = diff(cwd, resolved, meta.baseCommit);
					return text(out || "(no changes)");
				},
			} as ToolDefinition);

			// ── layer_log ───────────────────────────────────────────
			pi.registerTool({
				name: "layer_log",
				label: "Layer: Log",
				promptSnippet: "Show a layer's commits and their recorded purpose",
				description:
					"Show commits across layers, filterable by provenance (purpose, agent, tool). Omit layer to search all layers. This is how you filter work by why it was made.",
				parameters: Type.Object({
					layer: Type.Optional(Type.String({ description: "Restrict to one layer" })),
					purpose: Type.Optional(Type.String({ description: "Filter by Purpose trailer substring" })),
					agent: Type.Optional(Type.String({ description: "Filter by Agent trailer substring" })),
					tool: Type.Optional(Type.String({ description: "Filter by Tool trailer substring" })),
					limit: Type.Optional(Type.Number({ description: "Max commits (default 50)" })),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const {
						layer,
						purpose,
						agent: agentF,
						tool,
						limit,
					} = params as {
						layer?: string;
						purpose?: string;
						agent?: string;
						tool?: string;
						limit?: number;
					};
					const refs = layer ? [`refs/layers/${layer}`] : listLayers(cwd).map((n) => `refs/layers/${n}`);
					const commits = logCommits(cwd, refs, limit ?? 50).filter((c) => {
						if (purpose && !(c.trailers.Purpose ?? "").toLowerCase().includes(purpose.toLowerCase()))
							return false;
						if (agentF && !(c.trailers.Agent ?? "").toLowerCase().includes(agentF.toLowerCase())) return false;
						if (tool && !(c.trailers.Tool ?? "").toLowerCase().includes(tool.toLowerCase())) return false;
						return true;
					});
					if (!commits.length) return text("(no matching commits)");
					const out = commits
						.map((c) => {
							const p = c.trailers.Purpose ? ` · ${c.trailers.Purpose}` : "";
							const a = c.trailers.Agent ? ` [${c.trailers.Agent}]` : "";
							return `${c.hash.slice(0, 8)}${a}${p}\n   ${c.subject}`;
						})
						.join("\n");
					return text(out);
				},
			} as ToolDefinition);

			// ── layer_list ──────────────────────────────────────────
			pi.registerTool({
				name: "layer_list",
				label: "Layer: List",
				promptSnippet: "List layers with their base, purpose, and state",
				description: "List all layers with their state, purpose, and file count.",
				parameters: Type.Object({}),
				async execute(
					_id: string,
					_params: Record<string, unknown>,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const names = listLayers(cwd);
					if (!names.length) return text("(no layers)");
					const out = names
						.map((n) => {
							const meta = loadMeta(cwd, n);
							const files = listFiles(cwd, n).length;
							const state = meta?.state ?? "developing";
							const purpose = meta?.purpose ?? "(no purpose)";
							return `${n}  [${state}]  ${files} file(s)\n   ${purpose}`;
						})
						.join("\n");
					return text(out);
				},
			} as ToolDefinition);

			// ── layer_test ──────────────────────────────────────────
			pi.registerTool({
				name: "layer_test",
				label: "Layer: Test",
				promptSnippet: "Run the test command against a layer's content",
				description:
					"Materialize a layer into an ephemeral worktree and run a command (default `npm test`). The main tree's node_modules is symlinked in when present so tests run without a fresh install. With merged=true the worktree is the MERGE RESULT of the layer onto current HEAD (materializeMerged) — the pre-merge gate: it validates what landing the layer would produce, conflicts and all, before the CAS merge. The worktree is removed afterwards unless keep=true. Returns the command output and exit code.",
				parameters: Type.Object({
					layer: Type.String({ description: "Layer name" }),
					command: Type.Optional(
						Type.String({ description: "Command to run in the worktree (default: npm test)" }),
					),
					keep: Type.Optional(Type.Boolean({ description: "Keep the worktree after the test (default false)" })),
					merged: Type.Optional(
						Type.Boolean({
							description:
								"Test the merge result of the layer onto current HEAD instead of the layer content alone (default false)",
						}),
					),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const { layer, command, keep, merged } = params as {
						layer: string;
						command?: string;
						keep?: boolean;
						merged?: boolean;
					};
					if (!tipExists(cwd, layer)) return fail(`no such layer: ${layer}`);
					const r = merged ? materializeMerged(cwd, layer) : materialize(cwd, layer);
					if ("error" in r) return fail(r.error);
					const wpath = r.path;
					shareNodeModules(cwd, wpath);
					const cmd = command ?? "npm test";
					let output = "";
					let exitCode = 0;
					try {
						output = execSync(cmd, {
							cwd: wpath,
							encoding: "utf8",
							timeout: 600_000,
							maxBuffer: 256 * 1024 * 1024,
							stdio: ["pipe", "pipe", "pipe"],
						});
					} catch (e) {
						exitCode = (e as { status?: number }).status ?? 1;
						output = (e as { stdout?: string; stderr?: string }).stdout ?? "";
						const err = (e as { stderr?: string }).stderr;
						if (err) output = `${output}\n${err}`;
					}
					const meta = loadMeta(cwd, layer);
					if (meta && exitCode === 0) {
						meta.state = "tested";
						saveMeta(cwd, meta);
					}
					if (!keep) removeWorktree(cwd, merged ? `${layer}-merged` : layer);
					const tail = output.split("\n").slice(-60).join("\n");
					const head = `layer ${layer}: ${cmd} ${exitCode === 0 ? "PASSED" : `FAILED (exit ${exitCode})`}\nworktree: ${wpath}${keep ? " (kept)" : " (removed)"}\n`;
					return text(head + tail);
				},
			} as ToolDefinition);

			// ── layer_merge ─────────────────────────────────────────
			pi.registerTool({
				name: "layer_merge",
				label: "Layer: Merge",
				promptSnippet: "Land a layer onto its base as one checkpoint commit",
				description:
					"Squash-merge a layer onto the current branch as one checkpoint commit (atomic CAS update — fails cleanly if the branch moved). On success the layer ref, metadata, and any test worktree are removed.",
				parameters: Type.Object({
					layer: Type.String({ description: "Layer name" }),
					message: Type.Optional(
						Type.String({ description: "Checkpoint commit subject (defaults to 'merge layer <name>')" }),
					),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const { layer, message } = params as { layer: string; message?: string };
					const meta = loadMeta(cwd, layer);
					if (!meta) return fail(`no such layer: ${layer}`);
					const subject = message ?? `merge layer ${layer}`;
					const full = [
						subject,
						"",
						`Layer: ${layer}`,
						`Agent: ${agent}`,
						`Session: ${session}`,
						`Purpose: ${meta.purpose}`,
					].join("\n");
					const r = mergeLayer(cwd, layer, full);
					if ("error" in r) {
						return fail(`${r.error}${r.conflicts.length ? `\nconflicts: ${r.conflicts.join(", ")}` : ""}`);
					}
					deleteLayer(cwd, layer);
					deleteMeta(cwd, layer);
					removeWorktree(cwd, layer);
					return text(
						`merged layer ${layer} onto ${r.branch} @ ${r.commit.slice(0, 8)} (checkpoint)\npurpose: ${meta.purpose}`,
					);
				},
			} as ToolDefinition);

			// ── layer_discard ───────────────────────────────────────
			pi.registerTool({
				name: "layer_discard",
				label: "Layer: Discard",
				promptSnippet: "Throw a layer away without merging",
				description: "Delete a layer and its metadata and any test worktree, abandoning its work.",
				parameters: Type.Object({
					layer: Type.String({ description: "Layer name" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: unknown,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const { layer } = params as { layer: string };
					if (!tipExists(cwd, layer)) return fail(`no such layer: ${layer}`);
					deleteLayer(cwd, layer);
					deleteMeta(cwd, layer);
					removeWorktree(cwd, layer);
					return text(`discarded layer ${layer}`);
				},
			} as ToolDefinition);

			// ── /layers command ─────────────────────────────────────
			pi.registerCommand("layers", {
				description: "Layers: /layers [list] | log [purpose]",
				async handler(args, ctx) {
					cwd = ctx.cwd;
					const tokens = args.trim().split(/\s+/).filter(Boolean);
					const head = tokens[0] ?? "list";
					const note = (t: string, k: "info" | "warning" | "error" = "info") => ctx.ui?.notify?.(t, k);
					if (head === "list" || head === "status") {
						const names = listLayers(cwd);
						if (!names.length) return note("layers: none");
						return note(
							names
								.map(
									(n) =>
										`${n} [${loadMeta(cwd, n)?.state ?? "developing"}] ${listFiles(cwd, n).length} file(s)`,
								)
								.join("\n"),
						);
					}
					if (head === "log") {
						const purpose = tokens[1];
						const refs = listLayers(cwd).map((n) => `refs/layers/${n}`);
						const commits = logCommits(cwd, refs, 50).filter(
							(c) => !purpose || (c.trailers.Purpose ?? "").toLowerCase().includes(purpose.toLowerCase()),
						);
						if (!commits.length) return note("layers: no matching commits");
						return note(
							commits.map((c) => `${c.hash.slice(0, 8)} ${c.trailers.Purpose ?? ""} · ${c.subject}`).join("\n"),
						);
					}
					return note(`layers: unknown "${head}" — use list | log [purpose]`, "warning");
				},
			});
		},
	};
}

// ── shared helpers ──────────────────────────────────────────────────
function tipExists(cwd: string, name: string): boolean {
	return tip(cwd, name) !== null;
}
