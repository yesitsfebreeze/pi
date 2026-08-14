/**
 * Core inline extensions — features wired directly into pi (not user-installable
 * extensions). Each returns an {@link InlineExtension} that the
 * {@link DefaultResourceLoader} loads alongside user-provided inline factories,
 * so they receive the full extension lifecycle (session_start, before_agent_start,
 * tool_call, agent_settled, session_shutdown) and can register tools/commands.
 *
 * These were previously ported as standalone modules but never instantiated.
 * This module is the single wiring point that makes them live in every session.
 */
import { resolve } from "node:path";
import { createBtwInlineExtension } from "./btw/index.ts";
import { autoInjectedBlock, createVolatileChannel } from "./context-injection.ts";
import { createCrawlInlineExtension } from "./crawl/index.ts";
import { createCrewExtension } from "./crew/index.ts";
import type { InlineExtension } from "./extensions/types.ts";
import { FileTouchTracker } from "./file-touch-tracker.ts";
import { createForestExtension } from "./forest/index.ts";
import { createGanttInlineExtension } from "./gantt/index.ts";
import { createInitExtension } from "./init.ts";
import { createInteractExtension } from "./interact/index.ts";
import { createRecordStallToolDefinition, IssueReporter } from "./issue-reporter.ts";
import { createLaunchToolDefinition, LaunchManager } from "./launch.ts";
import { createLayersExtension } from "./layers/index.ts";
import { createMemInlineExtension } from "./mem/index.ts";
import { createMemoryInlineExtension } from "./memory/index.ts";
import { createModelLedgerExtension } from "./model-ledger-extension.ts";
import { createNvimSurfaceExtension } from "./nvim/nvim-surface-context.ts";
import { PersonaManager } from "./personas/persona-manager.ts";
import { createPiBackupExtension } from "./pi-backup.ts";
import { createRecipesInlineExtension } from "./recipes/index.ts";
import { createReflexInlineExtension } from "./reflex/index.ts";
import { createRigorExtension } from "./rigor/index.ts";
import { createSearchGuardExtension } from "./search-guard.ts";
import { createSimplifyExtension } from "./simplify/index.ts";
import { createSlimInlineExtension } from "./slim/index.ts";
import { createUntilToolDefinition, UntilManager } from "./until.ts";
import { createVitalsInlineExtension } from "./vitals/index.ts";

// ---------------------------------------------------------------------------
// vitals — session memory watchdog (RSS ceiling, growth trend, proc storm)
// ---------------------------------------------------------------------------

export function createVitalsExtension(): InlineExtension {
	return createVitalsInlineExtension();
}

// ---------------------------------------------------------------------------
// file-awareness — stamp reads, warn on external edits
// ---------------------------------------------------------------------------

export function createFileAwarenessExtension(): InlineExtension {
	return {
		name: "file-awareness",
		hidden: true,
		factory(pi) {
			const tracker = new FileTouchTracker();
			// The changed-file list is different on most turns, so it rides a custom
			// message instead of the system prompt: appending it to the prompt moved
			// the cache breakpoint every turn and rewrote the whole cached prefix.
			const channel = createVolatileChannel("file-awareness");
			let cwd = process.cwd();

			pi.on("session_start", (_event, ctx) => {
				cwd = ctx?.cwd ?? cwd;
				channel.reset();
			});

			// Stamp every successful read so we know the mtime at read time.
			pi.on("tool_result", (event, ctx) => {
				if (event.toolName !== "read") return;
				if (event.isError) return;
				const raw = (event.input as { path?: unknown }).path;
				if (typeof raw !== "string") return;
				const base = ctx?.cwd ?? cwd;
				tracker.stamp(resolve(base, raw));
			});

			// Before each turn, warn about files changed externally since the
			// last read so the agent re-reads instead of trusting stale memory.
			pi.on("before_agent_start", () => {
				const changed = tracker.getChangedFiles();
				// Always call emit — a turn with nothing changed clears the gate, so a
				// later change to the same file is reported again instead of being
				// mistaken for a repeat of the warning already sent.
				if (changed.length === 0) return channel.emit(undefined);
				return channel.emit(
					autoInjectedBlock(
						[
							"# External file changes",
							"These files changed on disk since you last read them. Re-read before",
							"relying on any content you have cached from a prior read:",
							...changed.map((p) => `- ${p}`),
						].join("\n"),
					),
				);
			});
		},
	};
}

// ---------------------------------------------------------------------------
// launch — background job manager
// ---------------------------------------------------------------------------

export function createLaunchExtension(): InlineExtension {
	return {
		name: "launch",
		factory(pi) {
			const mgr = new LaunchManager();
			let ui: { setStatus?: (key: string, text: string | undefined) => void } | undefined;

			const paint = () => ui?.setStatus?.("launch", mgr.statusLine);

			pi.on("session_start", (_event, ctx) => {
				mgr.setCwd(ctx?.cwd ?? process.cwd());
				ui = ctx?.ui;
				mgr.setOnStatusChange(paint);
				paint();
			});

			pi.on("session_shutdown", () => {
				mgr.shutdown();
				ui?.setStatus?.("launch", undefined);
				ui = undefined;
			});

			pi.on("agent_settled", paint);

			pi.registerTool(createLaunchToolDefinition(mgr));

			// Health check surfaced to /doctor: report failed background jobs so the
			// agent is nudged to restart or clear them. No jobs -> SKIP (nothing to
			// check); failed jobs -> DIRTY; otherwise PASS (all running/exited ok).
			pi.registerHealthCheck({
				name: "launch:jobs",
				description: "Background job health — flags failed launch jobs",
				run() {
					const all = [...mgr.jobs.values()];
					if (all.length === 0) return { status: "SKIP", detail: "no background jobs" };
					const failed = all.filter((j) => j.status === "failed");
					if (failed.length > 0) {
						return {
							status: "DIRTY",
							detail: `${failed.length} failed job(s): ${failed.map((j) => j.name).join(", ")}`,
						};
					}
					return { status: "PASS", detail: `${all.length} job(s), none failed` };
				},
			});

			pi.registerCommand("launch", {
				description:
					"Background jobs: /launch <what to run> | stop <name|all> | restart <name> | list | logs <name> | status | clear",
				async handler(args, ctx) {
					ui = ctx.ui ?? ui;
					mgr.setCwd(ctx.cwd);
					const tokens = args.trim().split(/\s+/).filter(Boolean);
					const head = tokens[0] ?? "list";
					const note = (t: string, k: "info" | "warning" | "error" = "info") => ctx.ui?.notify?.(t, k);
					if (head === "stop") return note(mgr.stop(tokens[1] ?? "all").msg);
					if (head === "restart") return note(mgr.restart(tokens[1] ?? "").msg);
					if (head === "list") return note(mgr.list());
					if (head === "logs") return note(mgr.logs(tokens[1] ?? "", Number(tokens[2]) || 40).msg);
					if (head === "status") return note(mgr.status(tokens[1]));
					if (head === "clear") return note(mgr.clear().msg);
					// default: treat the whole line as a run request
					const req = args.trim();
					if (!req) return note(mgr.list());
					const r = mgr.request(req, (msg) => pi.sendUserMessage(msg, { deliverAs: "followUp" }));
					note(r.msg, r.ok ? "info" : "warning");
				},
			});
		},
	};
}

// ---------------------------------------------------------------------------
// until — goal/schedule/pace loops
// ---------------------------------------------------------------------------

export function createUntilExtension(): InlineExtension {
	return {
		name: "until",
		factory(pi) {
			const mgr = new UntilManager();
			// Loop state changes every iteration — custom message, not system prompt.
			const channel = createVolatileChannel("until");
			let ui: { setStatus?: (key: string, text: string | undefined) => void } | undefined;

			const paint = () => {
				ui?.setStatus?.("until", mgr.statusLine);
				ui?.setStatus?.("loop", mgr.loopStatusLine);
				ui?.setStatus?.("pace", mgr.paceStatusLine);
			};

			mgr.onStatusChange = paint;

			pi.on("session_start", (_event, ctx) => {
				mgr.setCwd(ctx?.cwd ?? process.cwd());
				ui = ctx?.ui;
				// Wire the manager's send callbacks to the extension API.
				mgr.sendUserMessage = (msg, opts) => pi.sendUserMessage(msg, { deliverAs: opts?.deliverAs ?? "followUp" });
				mgr.sendMessage = (msg) => pi.sendMessage(msg);
				paint();
			});

			pi.on("session_shutdown", () => {
				mgr.shutdown();
				ui?.setStatus?.("until", undefined);
				ui?.setStatus?.("loop", undefined);
				ui?.setStatus?.("pace", undefined);
				ui = undefined;
			});

			// Arm a goal loop when the user's own message contains the trigger word.
			// Confirm first — the trigger word is easy to type by accident. Default is Yes
			// (Enter arms the loop); No proceeds with the message once, without the loop;
			// Escape cancels the input entirely.
			pi.on("input", async (event, ctx) => {
				if (event.source !== "interactive") return;
				if (mgr.active) return;
				if (!mgr.detectTrigger(event.text)) return;
				const choice = ctx.hasUI
					? await ctx.ui.select("Run an until loop?", ["Yes — arm the loop", "No — send once, no loop"])
					: "Yes — arm the loop";
				if (choice === undefined) return { action: "handled" };
				if (choice.startsWith("No")) return { action: "continue" };
				mgr.armGoal(event.text);
				paint();
				return { action: "continue" };
			});

			// Inject until/pace context each turn, gated on change.
			pi.on("before_agent_start", () => {
				const blocks: string[] = [];
				const untilCtx = mgr.injectContext();
				if (untilCtx) blocks.push(untilCtx.content);
				const paceCtx = mgr.paceInject();
				if (paceCtx) blocks.push(paceCtx);
				// Emit unconditionally so an idle turn clears the gate (see file-awareness).
				return channel.emit(blocks.join("\n"));
			});

			pi.on("agent_start", () => mgr.onAgentStart());

			// Detect the DONE marker in assistant messages.
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;
				if (mgr.checkDoneMarker(event.message.content)) paint();
			});

			// Re-dispatch the continuation when a turn settles.
			pi.on("agent_settled", () => {
				const cont = mgr.onAgentSettledHandler();
				paint();
				if (cont) pi.sendUserMessage(cont, { deliverAs: "followUp" });
			});

			pi.registerTool(createUntilToolDefinition(mgr));

			pi.registerCommand("until", {
				description:
					"Loop surface: /until <objective> | every <interval> <msg> | stop <id|all> | status | word <w> | max <n> | off",
				async handler(args, ctx) {
					ui = ctx.ui ?? ui;
					mgr.setCwd(ctx.cwd);
					const tokens = args.trim().split(/\s+/).filter(Boolean);
					const head = tokens[0];
					const note = (t: string, k: "info" | "warning" | "error" = "info") => ctx.ui?.notify?.(t, k);
					if (!head) return note(mgr.active ? "until: goal active" : "until: idle");
					if (head === "stop") return note(tokens[1] ? mgr.loopStop(tokens[1]).msg : mgr.stopAll());
					if (head === "off") return note(mgr.stopAll());
					if (head === "status") return note(mgr.active ? "until: goal active" : "until: idle");
					if (head === "list") return note(mgr.loopList());
					if (head === "word") return note(mgr.setTriggerWord(tokens[1] ?? ""));
					if (head === "max") return note(mgr.setMaxIterations(Number(tokens[1]) || 50).msg);
					if (head === "every") {
						const interval = tokens[1];
						const message = tokens.slice(2).join(" ");
						if (!interval || !message) return note("until: every needs <interval> <message>", "warning");
						return note(mgr.loopStart(interval, message).msg);
					}
					// default: arm a goal with the whole line
					mgr.armGoal(args.trim());
					paint();
					note(`until: goal armed — ${args.trim()}`);
				},
			});

			pi.registerCommand("pace", {
				description: "Pace timeboxed loop: /pace [target] | --status | --dry | off",
				async handler(args, ctx) {
					ui = ctx.ui ?? ui;
					mgr.setCwd(ctx.cwd);
					const r = mgr.paceCommand(args);
					paint();
					if (r.followUp) ctx.ui?.notify?.(r.followUp, "info");
					if (r.notify) ctx.ui?.notify?.(r.notify, "warning");
				},
			});
		},
	};
}

// ---------------------------------------------------------------------------
// issue-reporter — record stalls/issues as GitHub issues
// ---------------------------------------------------------------------------

export function createIssueReporterExtension(): InlineExtension {
	return {
		name: "issue-reporter",
		hidden: true,
		factory(pi) {
			const reporter = new IssueReporter();

			pi.registerTool(createRecordStallToolDefinition(reporter));

			// Auto-report errors from extension-registered (non-builtin) tools.
			// Ask the registry rather than keeping a hand-written name list: the
			// list silently drifts as builtins are added, and it never covered
			// SDK-registered tools like doctor_probe, so every doctor failure
			// filed a GitHub issue.
			pi.on("tool_result", (event) => {
				if (!event.isError) return;
				const source = pi.getAllTools().find((t) => t.name === event.toolName)?.sourceInfo.source;
				if (source === "builtin" || source === "sdk") return;
				void reporter.autoReportError(
					event.toolName,
					event.content.map((c) => ("text" in c ? c.text : "")).join("\n"),
					new Set([event.toolName]),
				);
			});

			pi.registerCommand("issue", {
				description: "File a GitHub issue: /issue <title> | --kind <kind> --desc <text>",
				async handler(args, ctx) {
					const text = args.trim();
					if (!text) return ctx.ui?.notify?.("usage: /issue <title>", "warning");
					const r = await reporter.fileIssue({ title: text });
					ctx.ui?.notify?.(r.content[0]?.text ?? "issue filed", r.isError ? "error" : "info");
				},
			});
		},
	};
}

// ---------------------------------------------------------------------------
// persona — agent identity
// ---------------------------------------------------------------------------

export function createPersonaExtension(): InlineExtension {
	return {
		name: "persona",
		factory(pi) {
			const mgr = new PersonaManager(process.cwd());

			// Register the /persona command + picker at load time so it is part
			// of the static command surface (not deferred to session_start).
			mgr.register(pi);

			pi.on("session_start", (_event, ctx) => {
				mgr.updateCwd(ctx?.cwd ?? process.cwd());
			});

			pi.on("before_agent_start", (event) => {
				const block = mgr.buildInjectedBlock();
				if (!block) return;
				return { systemPrompt: `${event.systemPrompt}\n${block}` };
			});
		},
	};
}

// ---------------------------------------------------------------------------
// All core inline extensions, in load order.
// ---------------------------------------------------------------------------

/**
 * The tool band (schema withheld, name + one-liner kept, `tools action=on` to
 * restore) is applied for every extension in `createExtensionApi` — see
 * `tools/band.ts`. Nothing to do here.
 */
export function getCoreInlineExtensions(): InlineExtension[] {
	return [
		createFileAwarenessExtension(),
		createPersonaExtension(),
		createVitalsExtension(),
		createModelLedgerExtension(),
		createSearchGuardExtension(),
		{ name: "rigor", factory: createRigorExtension() },
		{ name: "simplify", factory: createSimplifyExtension() },
		createReflexInlineExtension(),
		createSlimInlineExtension(),
		createForestExtension(),
		createLayersExtension(),
		createLaunchExtension(),
		createUntilExtension(),
		createIssueReporterExtension(),
		createMemoryInlineExtension(),
		createCrewExtension(),
		createPiBackupExtension(),
		createInitExtension(),
		createGanttInlineExtension(),
		createBtwInlineExtension(),
		createCrawlInlineExtension(),
		createRecipesInlineExtension(),
		createMemInlineExtension(),
		createInteractExtension(),
		createNvimSurfaceExtension(),
	];
}
