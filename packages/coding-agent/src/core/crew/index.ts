import { Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import { briefingBlock, snapshot } from "./context.ts";
import { getProfile, loadProfiles, parseProfile, renderProfileList } from "./profiles.ts";
import {
	activeLabel,
	clearSettled,
	configure,
	crewStatus,
	events,
	load,
	MAX_DEPTH,
	renderList,
	result,
	resume,
	resumable,
	runs,
	start,
	stop,
	stopAll,
} from "./runner.ts";
import type { CrewRun } from "./types.ts";
import { runChainSync, runParallelSync, runSingleSync } from "./sync.ts";
import type { CrewProfile } from "./types.ts";

// ---------------------------------------------------------------------------
// Inline extension factory
// ---------------------------------------------------------------------------
export function createCrewExtension(): {
	name: string;
	factory: (pi: ExtensionAPI) => void;
} {
	return {
		name: "crew",
		factory(pi: ExtensionAPI) {
			let ui: ExtensionContext["ui"] | undefined;
			let repo = process.cwd();
			let cwd = process.cwd();
			let session = `pi-${process.pid}`;
			let refresh: ReturnType<typeof setInterval> | undefined;
			const depth: number = Number(process.env.CREW_DEPTH) || 0;
			const STATUS_KEY = "crew";

			interface WalkieTalkie {
				addr(): string;
				scopes(): string[];
				send(to: string, body: string, opts?: { re?: string; urgent?: boolean }): void;
			}

			const wt = (): WalkieTalkie | undefined => (globalThis as Record<string, unknown>).__wt as WalkieTalkie | undefined;
			const myAddr = (): string => wt()?.addr?.() ?? session;
			const myScopes = (): string[] => wt()?.scopes?.() ?? [];

			// ── helpers ────────────────────────────────────────────────────
			function paint(): void {
				ui?.setStatus?.(STATUS_KEY, activeLabel());
				const up = [...runs.values()].filter(
					(r) => r.state === "running" || r.state === "queued",
				).length;
				if (up && !refresh) {
					refresh = setInterval(paint, 2000);
					refresh?.unref?.();
				}
				if (!up && refresh) {
					clearInterval(refresh);
					refresh = undefined;
				}
			}

			function deliver(run: CrewRun): void {
				const cap = 6000;
				const body = result(run).slice(0, cap);
				const more =
					result(run).length > cap
						? `\n\n(truncated — \`crew\` action=result handle=${run.handle} for full output)`
						: "";
				pi.sendUserMessage(
					[
						`# Crew — ${run.handle} came back (${run.state})`,
						"",
						`Task: ${run.task.split("\n")[0]}`,
						`Session: ${run.sessionId} — \`crew\` action=resume handle=${run.handle} picks it up in place.`,
						"",
						body + more,
					].join("\n"),
					{ deliverAs: "followUp" },
				);
				if (run.state === "failed" || run.state === "timeout")
					ui?.notify?.(`crew: ${run.handle} ${run.state} — crew logs ${run.handle}`, "warning");
			}

			configure({ onChange: paint, onSettled: deliver });

			const fallback: CrewProfile = parseProfile(
				"worker",
				"---\ndescription: general worker\n---\nDo exactly the task you were given, nothing adjacent to it.",
				"(built in)",
			);

			interface DispatchOpts {
				cwd?: string;
				model?: string;
				timeout?: number;
			}

			function doDispatch(agent: string, task: string, opts: DispatchOpts = {}): string {
				const p = getProfile(repo, agent);
				if (!p && agent !== "worker")
					return `crew: no profile "${agent}"\n\n${renderProfileList(repo)}`;
				const { run, error } = start({
					agent,
					task,
					cwd: (opts.cwd ?? cwd) as string,
					repo,
					profile: p ?? fallback,
					model: opts.model,
					timeoutMin: opts.timeout,
					parentAddr: myAddr(),
					scopes: myScopes(),
					depth,
				});
				if (error || !run) return `crew: ${error ?? "dispatch failed"}`;
				paint();
				const where =
					run.state === "queued"
						? "queued behind the running crew"
						: `running as pid ${run.pid}`;
				return [
					`${run.handle} dispatched (${agent}), ${where}, session ${run.sessionId}.`,
					"Keep working — it reports over the channel and its result arrives as a follow-up.",
					wt()
						? `Steer it with \`crew\` action=say handle=${run.handle}.`
						: "walkie-talkie is not loaded: this run is one-shot, you cannot steer it.",
				].join("\n");
			}

			function doResume(handle: string, message?: string): string {
				const run = runs.get(handle);
				if (!run) return `crew: no run "${handle}"\n\n${renderList()}`;
				if (!resumable(run)) return `crew: ${handle} is ${run.state} — it is already working`;
				const p = getProfile(repo, run.agent);
				const { error } = resume(
					run,
					{
						agent: run.agent,
						task: run.task,
						cwd: run.cwd,
						repo,
						profile: p ?? fallback,
						parentAddr: myAddr(),
						scopes: myScopes(),
						depth,
					},
					message,
				);
				if (error) return `crew: ${error}`;
				paint();
				return `${handle} resumed in its own session (${run.sessionId}), attempt ${run.resumes + 1}. Its result comes back as a follow-up.`;
			}

			function doSay(handle: string, text: string): string {
				const run = runs.get(handle);
				if (!run) return `crew: no run "${handle}"`;
				if (run.state !== "running")
					return `crew: ${handle} is ${run.state} — nothing to steer`;
				const bus = wt();
				if (!bus)
					return "crew: walkie-talkie is not loaded, so there is no channel to steer over";
				bus.send(handle, text, { re: handle, urgent: true });
				return `sent to ${handle} — it interrupts the run within a few seconds`;
			}

			interface SyncParams {
				agent?: string;
				task?: string;
				cwd?: string;
				model?: string;
				thinking?: string;
				tasks?: Array<{ agent: string; task: string; cwd?: string }>;
				chain?: Array<{ agent: string; task: string; cwd?: string }>;
			}

			function doSync(
				params: SyncParams,
				signal: AbortSignal | undefined,
			): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
				const opts = { cwd, model: params.model, thinking: params.thinking };
				const profiles = loadProfiles(repo);
				if (params.chain && params.chain.length > 0) {
					return runChainSync(profiles, params.chain, opts, signal).then((text) => ({
						content: [{ type: "text", text }],
						details: { mode: "chain", results: params.chain },
					}));
				}
				if (params.tasks && params.tasks.length > 0) {
					return runParallelSync(profiles, params.tasks, opts, signal).then((text) => ({
						content: [{ type: "text", text }],
						details: { mode: "parallel", results: params.tasks },
					}));
				}
				const profile = profiles.get(params.agent ?? "") ?? fallback;
				return runSingleSync(
					profile,
					params.task ?? "",
					{ ...opts, cwdOverride: params.cwd },
					signal,
				).then((text) => ({
					content: [{ type: "text", text }],
					details: { mode: "single", agent: params.agent },
				}));
			}

			// ── lifecycle ──────────────────────────────────────────────────
			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
				ui = ctx?.ui;
				repo = ctx?.cwd ?? repo;
				cwd = ctx?.cwd ?? cwd;
				session = ctx?.sessionManager?.getSessionId?.() ?? session;
				load(cwd);
				const cut = [...runs.values()].filter((r) => r.state === "interrupted").length;
				if (cut) ui?.notify?.(`crew: ${cut} interrupted run(s) waiting — /crew list`, "info");
				paint();
			});

			pi.on("session_shutdown", () => {
				stopAll();
				if (refresh) clearInterval(refresh);
				refresh = undefined;
				ui?.setStatus?.(STATUS_KEY, undefined);
				ui = undefined;
			});

			pi.on("agent_settled", () => {
				if (
					[...runs.values()].filter(
						(r) => r.state === "running" || r.state === "queued",
					).length
				)
					paint();
			});

			// ── tool: crew ─────────────────────────────────────────────────
			pi.registerTool({
				name: "crew",
				label: "Crew",
				description:
					"Dispatch work to a subagent and carry on. action=start spawns a headless pi in its own process group and returns a handle immediately — it does NOT wait, and you must not wait for it either: pick up the next piece of your own work. The subagent reports progress over the walkie-talkie channel and its finished result is delivered to you as a follow-up at a later boundary. Each subagent is a real pi session with its own id and transcript, so action=stop is cheap and action=resume reopens the same session where it was cut off, even after this session restarted. Use it for anything that is self-contained and slow (a survey of a codebase, a research pass over an upstream repo, a mechanical refactor, a review), not for a step whose answer you need in this turn.",
				promptSnippet: "Delegate slow, self-contained work to a background subagent and keep going",
				parameters: Type.Object({
					action: Type.Union([
						Type.Literal("start"),
						Type.Literal("list"),
						Type.Literal("say"),
						Type.Literal("resume"),
						Type.Literal("result"),
						Type.Literal("logs"),
						Type.Literal("stop"),
						Type.Literal("status"),
						Type.Literal("agents"),
						Type.Literal("clear"),
						Type.Literal("sync"),
					]),
					task: Type.Optional(
						Type.String({
							description:
								"start/sync only: the whole brief, self-contained. The subagent shares no context with you — name the files, the goal and what 'done' means.",
						}),
					),
					agent: Type.Optional(
						Type.String({
							description: "start/sync only: profile name (action=agents lists them). Default: worker.",
						}),
					),
					handle: Type.Optional(
						Type.String({
							description: "the handle a start returned — for say/resume/result/logs/stop.",
						}),
					),
					message: Type.Optional(
						Type.String({
							description:
								"say: what to tell the running subagent. resume: what it should do now — omit to have it simply carry on from where it stopped.",
						}),
					),
					cwd: Type.Optional(
						Type.String({
							description: "start/sync only: where the subagent runs. Default: this session's cwd.",
						}),
					),
					model: Type.Optional(
						Type.String({
							description: "start/sync only: model pattern override for this run.",
						}),
					),
					timeout: Type.Optional(
						Type.Number({
							description: "start only: hard kill after this many minutes (default 20).",
						}),
					),
					lines: Type.Optional(
						Type.Number({
							description: "logs only: how many trace lines (default 40).",
						}),
					),
					tasks: Type.Optional(
						Type.Array(
							Type.Object({
								agent: Type.String({ description: "Profile name" }),
								task: Type.String({ description: "Task to delegate" }),
								cwd: Type.Optional(Type.String({ description: "Working directory" })),
							}),
							{ description: "Array of {agent, task} for parallel sync execution" },
						),
					),
					chain: Type.Optional(
						Type.Array(
							Type.Object({
								agent: Type.String({ description: "Profile name" }),
								task: Type.String({
									description: "Task with optional {previous} placeholder for prior output",
								}),
								cwd: Type.Optional(Type.String({ description: "Working directory" })),
							}),
							{ description: "Array of {agent, task} for sequential sync execution" },
						),
					),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					ui = ctx?.ui ?? ui;
					const out = (text: string) => ({
						content: [{ type: "text" as const, text }],
						details: {},
					});
					const a = params.action as string;
					if (a === "sync") {
						const sp = params as SyncParams;
						if (sp.chain?.length) return doSync(sp, signal);
						if (sp.tasks?.length) return doSync(sp, signal);
						if (!sp.agent || !sp.task)
							return out("sync needs (agent + task), tasks array, or chain array");
						return doSync(sp, signal);
					}
					if (a === "start") {
						if (!params.task) return out("start needs a task");
						return out(
							doDispatch(String(params.agent || "worker"), String(params.task), {
								cwd: params.cwd as string | undefined,
								model: params.model as string | undefined,
								timeout: params.timeout as number | undefined,
							}),
						);
					}
					if (a === "list") return out(renderList());
					if (a === "status") return out(crewStatus(params.handle as string | undefined));
					if (a === "agents") return out(renderProfileList(repo));
					if (a === "clear") return out(`cleared ${clearSettled()} settled run(s)`);
					if (a === "say") {
						if (!params.handle || !params.message) return out("say needs a handle and a message");
						return out(doSay(String(params.handle), String(params.message)));
					}
					if (a === "resume") {
						if (!params.handle) return out("resume needs a handle");
						return out(doResume(String(params.handle), params.message as string | undefined));
					}
					const run = runs.get(String(params.handle ?? ""));
					if (!run) return out(`crew: no run "${String(params.handle ?? "")}"\n\n${renderList()}`);
					if (a === "result") return out(result(run));
					if (a === "logs") return out(events(run, Number(params.lines) || 40));
					return out(
						stop(run.handle) ? `stopping ${run.handle}` : `crew: ${run.handle} is ${run.state}`,
					);
				},
			} as ToolDefinition);

			// ── slash command: /crew ───────────────────────────────────────
			pi.registerCommand("crew", {
				description:
					"dispatch a subagent and keep working: /crew [@profile] <task> | list | status | say | resume | stop | agents",
				handler: async (args: string, ctx: ExtensionCommandContext) => {
					ui = ctx.ui ?? ui;
					const tokens = args.trim().split(/\s+/).filter(Boolean);
					const head = tokens[0];
					const note = (t: string, k: "info" | "warning" | "error" = "info") =>
						ctx.ui?.notify?.(t, k);

					if (!head)
						return note(`crew (depth ${depth}/${MAX_DEPTH})\n\n${renderList()}`);
					if (head === "list") return note(renderList());
					if (head === "status") return note(crewStatus(tokens[1]));
					if (head === "agents") return note(renderProfileList(repo));
					if (head === "clear")
						return note(`crew: cleared ${clearSettled()} settled run(s)`);
					if (head === "stop") {
						const h = tokens[1];
						if (h === "all" || !h) {
							const n = [...runs.values()].filter(
								(r) => r.state === "running" || r.state === "queued",
							).length;
							stopAll();
							paint();
							return note(
								`crew: interrupted ${n} run(s) — /crew resume <handle> picks any of them up`,
							);
						}
						return note(
							stop(h) ? `crew: stopping ${h}` : `crew: no running ${h}`,
						);
					}
					if (head === "say")
						return note(doSay(tokens[1] ?? "", tokens.slice(2).join(" ")));
					if (head === "resume")
						return note(
							doResume(tokens[1] ?? "", tokens.slice(2).join(" ") || undefined),
						);
					if (head === "result" || head === "logs") {
						const run = runs.get(tokens[1] ?? "");
						if (!run) return note(`crew: no run "${tokens[1] ?? ""}"`);
						return note(head === "result" ? result(run) : events(run, 40));
					}
					const agent = head.startsWith("@") ? head.slice(1) : "worker";
					const task = (head.startsWith("@") ? tokens.slice(1) : tokens).join(" ");
					note(doDispatch(agent, task));
				},
			} satisfies Omit<RegisteredCommand, "name" | "sourceInfo">);
		},
	};
}

export { briefingBlock, snapshot } from "./context.ts";
export { getProfile, loadProfiles, parseProfile, renderProfileList } from "./profiles.ts";
export {
	crewStatus,
	events,
	human,
	live,
	renderList,
	result,
	resumable,
	runs,
	start,
	stop,
	stopAll,
} from "./runner.ts";
export { runChainSync, runParallelSync, runSingleSync } from "./sync.ts";
export { connectToParentAgent } from "./tcp-client.ts";
export { createFrameParser, encodeFrame, writeFrame } from "./tcp-protocol.ts";
export { startTcpServer } from "./tcp-server.ts";