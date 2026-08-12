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
import { createCrewExtension } from "./crew/index.ts";
import type { InlineExtension } from "./extensions/types.ts";
import { FileTouchTracker } from "./file-touch-tracker.ts";
import { createForestExtension } from "./forest/index.ts";
import { createRecordStallToolDefinition, IssueReporter } from "./issue-reporter.ts";
import { createLaunchToolDefinition, LaunchManager } from "./launch.ts";
import { createNvimSurfaceExtension } from "./nvim/nvim-surface-context.ts";
import { PersonaManager } from "./personas/persona-manager.ts";
import { createRigorExtension } from "./rigor/index.ts";
import { createUntilToolDefinition, UntilManager } from "./until.ts";

// ---------------------------------------------------------------------------
// file-awareness — stamp reads, warn on external edits
// ---------------------------------------------------------------------------

export function createFileAwarenessExtension(): InlineExtension {
	return {
		name: "file-awareness",
		hidden: true,
		factory(pi) {
			const tracker = new FileTouchTracker();
			let cwd = process.cwd();

			pi.on("session_start", (_event, ctx) => {
				cwd = ctx?.cwd ?? cwd;
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
			pi.on("before_agent_start", (event) => {
				const changed = tracker.getChangedFiles();
				if (changed.length === 0) return;
				const block = [
					"",
					"<auto-injected-context>",
					"# External file changes",
					"These files changed on disk since you last read them. Re-read before",
					"relying on any content you have cached from a prior read:",
					...changed.map((p) => `- ${p}`),
					"</auto-injected-context>",
				].join("\n");
				return { systemPrompt: `${event.systemPrompt}\n${block}` };
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
				mgr.sendMessage = (msg) => pi.sendMessage(msg as any);
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
			pi.on("input", (event) => {
				if (event.source !== "interactive") return;
				if (mgr.active) return;
				if (!mgr.detectTrigger(event.text)) return;
				mgr.armGoal(event.text);
				paint();
				return { action: "continue" };
			});

			// Inject until/pace context into the system prompt each turn.
			pi.on("before_agent_start", (event) => {
				const blocks: string[] = [];
				const untilCtx = mgr.injectContext();
				if (untilCtx) blocks.push(untilCtx.content);
				const paceCtx = mgr.paceInject();
				if (paceCtx) blocks.push(paceCtx);
				if (blocks.length === 0) return;
				return { systemPrompt: `${event.systemPrompt}\n${blocks.join("\n")}` };
			});

			pi.on("agent_start", () => mgr.onAgentStart());

			// Detect the DONE marker in assistant messages.
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;
				if (mgr.checkDoneMarker(event.message.content as unknown)) paint();
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
			pi.on("tool_result", (event) => {
				if (!event.isError) return;
				const builtin = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "tools"]);
				if (builtin.has(event.toolName)) return;
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
// rigor — automated post-pass verification
// ---------------------------------------------------------------------------

export function createRigorInlineExtension(): InlineExtension {
	const factory = createRigorExtension() as (pi: import("./extensions/types.ts").ExtensionAPI) => void;
	return { name: "rigor", factory };
}

// ---------------------------------------------------------------------------
// forest — isolated git worktrees + write-scope enforcement
// ---------------------------------------------------------------------------

export function createForestInlineExtension(): InlineExtension {
	return createForestExtension();
}

// ---------------------------------------------------------------------------
// crew — subagent dispatch
// ---------------------------------------------------------------------------

export function createCrewInlineExtension(): InlineExtension {
	return createCrewExtension();
}

// ---------------------------------------------------------------------------
// persona — agent identity
// ---------------------------------------------------------------------------

export function createPersonaExtension(): InlineExtension {
	return {
		name: "persona",
		factory(pi) {
			const mgr = new PersonaManager(process.cwd());
			let ui: { setStatus?: (key: string, text: string | undefined) => void } | undefined;

			// Register the /persona command + picker at load time so it is part
			// of the static command surface (not deferred to session_start).
			mgr.register(pi);

			pi.on("session_start", (_event, ctx) => {
				mgr.updateCwd(ctx?.cwd ?? process.cwd());
				ui = ctx?.ui;
				if (ctx) mgr.setStatusBar(ctx);
			});

			pi.on("session_shutdown", (_event, ctx) => {
				if (ctx) mgr.clearStatusBar(ctx);
				ui?.setStatus?.("persona", undefined);
				ui = undefined;
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

export function getCoreInlineExtensions(): InlineExtension[] {
	return [
		createFileAwarenessExtension(),
		createPersonaExtension(),
		createRigorInlineExtension(),
		createForestInlineExtension(),
		createLaunchExtension(),
		createUntilExtension(),
		createIssueReporterExtension(),
		createCrewInlineExtension(),
		createNvimSurfaceExtension(),
	];
}
