// Gantt — file-per-ticket routine board, ported into pi core as an inline
// extension. `.pi/gantt/` at repo root is the single representation; the
// gantt/cursor/decisions views are computed from it at read time and never
// written to disk. Absent `.pi/gantt/` dir: zero cost — no status, no
// injection, the extension goes inert.
//
// One session runs the whole board: `/gantt` with no arguments arms the
// CONDUCTOR — chart (no board) → reconcile (requirements → tickets) →
// claim every ready ticket → run each as its own parallel subagent in its
// own worktree → close as results land, looping until the agent replies
// [GANTT: DONE]. The two-session plan/work split is gone from the command
// surface; the `gantt` tool keeps the step-wise actions (work, work-here,
// plan) for headless sessions and until loops, and the walkie-talkie
// scopes exist so stray plan/work mail still reaches a conductor.
//
// Ported from the pi-gantt extension; the web board server, billboard slot,
// mirror, and governance commands were shed (pi has its own TUI; the loop
// is the core ROI). The store/claim/message/research/prd/chart/plan modules
// are unchanged — the file-per-ticket model and the git-commit-is-the-lock
// claim protocol are the product.

import { existsSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { chartPrompt } from "./chart.ts";
import { release, staleClaims } from "./claim.ts";
import { bootstrapPrompt, childBrief, continuationPrompt, DONE_MARKER } from "./conductor.ts";
import { fanOutReady, type Step, step } from "./message.ts";
import { planPrompt } from "./plan.ts";
import { boardClosed, prdPass } from "./prd.ts";
import { type Board, cursor, dir, gantt, loadBoard, setGanttRoot } from "./store.ts";

/** Which half of the board this session is working. "conductor" is both. */
export type Role = "plan" | "work" | "conductor";

// How long a claim may run without landing a commit that names it before
// "clear" is worth doubting. Age alone says nothing — a ticket's mtime
// tracks lock churn, not work — so `staleClaims` pairs it with whether any
// commit has named the ticket since the claim. Detection only: `/gantt
// release` is the act, and a human stands between them.
const STALE_CLAIM_MS = 6 * 60 * 60 * 1000;

export function statusLine(board: Board, role?: Role): string {
	const c = cursor(board);
	const title = (id: string) => board.tickets.get(id)?.title ?? id;
	const afk = c.ready.find((id) => !c.waiting.includes(id));
	const parts = [`gantt ${c.done}/${c.total}`, `next ${title(afk ?? c.ready[0] ?? "—")}`];
	if (c.waiting.length) parts.push(`${c.waiting.length} waiting`);
	if (role === "conductor") {
		const claimed = [...board.tickets.values()].filter((t) => t.state === "claimed").length;
		parts.push("conductor");
		if (claimed) parts.push(`${claimed} in flight`);
	} else if (role) parts.push(role === "plan" ? "plan" : "work");
	return parts.join("  ");
}

export function reconcileError(message: string): string {
	const prefix = "gantt: invalid board data — no ticket was changed automatically.";
	const badKind = message.match(/^ticket ([^:]+): kind "([^"]+)"/);
	if (badKind)
		return `${prefix}\nfile: .pi/gantt/tickets/${badKind[1]}.md\nticket: ${badKind[1]}\nfield: kind\ninvalid value: ${badKind[2]}\nallowed values: decision | research | build\nrepair (copy/paste): kind: build\nverify: optional shell command; it is accepted on all ticket kinds, but only build tickets run it automatically. Keep, change, or remove it manually.\nThen call \`gantt work\` again.`;
	const field = message.match(/^ticket ([^:]+): (state|mode|est) "([^"]+)"(?: \(([^)]+)\))?/);
	if (field)
		return `${prefix}\nfile: .pi/gantt/tickets/${field[1]}.md\nticket: ${field[1]}\nfield: ${field[2]}\ninvalid value: ${field[3]}\nallowed values: ${field[4] ?? "see ticket schema"}\nrepair: replace that header line with one allowed value, then call \`gantt work\` again.`;
	const ticket = message.match(/^ticket ([^:]+):/);
	return `${prefix}\nfile: .pi/gantt/tickets/${ticket?.[1] ?? "<id>"}.md\nticket: ${ticket?.[1] ?? "<id>"}\ndiagnostic: ${message}\nrepair: correct the named header or dependency without changing ticket intent, then call \`gantt work\` again.`;
}

// ---------------------------------------------------------------------------
// Inline extension factory
// ---------------------------------------------------------------------------
export function createGanttInlineExtension(): {
	name: string;
	factory: (pi: ExtensionAPI) => void;
} {
	return {
		name: "gantt",
		factory(pi: ExtensionAPI) {
			let ui: ExtensionContext["ui"] | undefined;
			let root = process.cwd();
			let session = `pi-${process.pid}`;
			let role: Role | undefined;
			const STATUS_KEY = "gantt";
			// Duplex coordination state — the hooks, not prompt prose, drive
			// worker↔planner notifications over the walkie-talkie bus.
			let lastDoneIds = new Set<string>();
			let lastOpenIds = new Set<string>();
			// Plan mode's re-entrancy guard: a reconcile pass's own board
			// commits must not re-fire it. (No source watcher in core — plan
			// re-fires on worker notifications — but the guard still keeps a
			// manual `/gantt plan` from compounding.)
			let _planInFlight = false;
			// Conductor loop state: bare `/gantt` turns THIS session into the
			// planner AND the worker, continuously. The loop re-injects a
			// board-derived continuation on every settle (gated on change) until
			// the agent emits [GANTT: DONE]. _lastConductorSig is the board's
			// ready/claimed/waiting signature at the last injection, so settles
			// that changed nothing stay quiet while subagents are in flight.
			let _conductor = false;
			let _lastConductorSig = "";
			let _lastConductorTick = 0;
			const HEARTBEAT_MS = 15 * 60 * 1000;

			const doneIds = (board: Board): Set<string> =>
				new Set([...board.tickets.values()].filter((t) => t.state === "done").map((t) => t.id));
			const openIds = (board: Board): Set<string> =>
				new Set([...board.tickets.values()].filter((t) => t.state === "open").map((t) => t.id));

			// Board signature for the conductor's change gate: everything the
			// continuation's "what to do" line depends on. Unchanged board +
			// subagents in flight → no new injection (their results wake us).
			function conductorSig(board: Board): string {
				const c = cursor(board);
				const claimed = [...board.tickets.values()]
					.filter((t) => t.state === "claimed")
					.map((t) => t.id)
					.sort()
					.join(",");
				return `${c.done}/${c.total}|${c.ready.sort().join(",")}|${claimed}|${c.waiting.sort().join(",")}`;
			}

			// One conductor loop tick, run on every settle while the loop is
			// armed. Re-injects the board-derived continuation only when there
			// is something to do or the board moved; a quiet board with runs in
			// flight stays quiet until a `# Crew — <handle> came back` followUp
			// wakes the session, or the heartbeat forces a check (a child can
			// die silently and nothing else would ever wake the loop).
			function conductorTick(board: Board | null): void {
				const sig = board ? conductorSig(board) : "";
				const inFlight = board ? [...board.tickets.values()].filter((t) => t.state === "claimed").length : 0;
				if (board && sig === _lastConductorSig && inFlight > 0 && Date.now() - _lastConductorTick < HEARTBEAT_MS)
					return;
				_lastConductorSig = sig;
				_lastConductorTick = Date.now();
				if (!board) {
					pi.sendUserMessage(
						[
							"<gantt-conductor>",
							"No board yet. Chart one now: from .pi/gantt/prd.md if it exists (uncovered PRD scope), else",
							"from this conversation's goal — map.md + tickets/*.md, breadth over depth, independent tickets",
							'unblocked. Unclear goal → ask the user. Then call the `gantt` tool action "dispatch-all" to',
							"claim the ready tickets.",
							"</gantt-conductor>",
						].join("\n"),
						{ deliverAs: "followUp" },
					);
					return;
				}
				pi.sendUserMessage(continuationPrompt(board), { deliverAs: "followUp" });
			}

			// End the conductor loop (message_end saw the DONE marker, or the
			// user ran /gantt stop).
			function conductorStop(): void {
				_conductor = false;
				_lastConductorSig = "";
				_lastConductorTick = 0;
				role = undefined;
				wear(undefined);
				paint();
			}

			// Auto-notify the counterpart role over the walkie-talkie bus. The
			// loop fires this, not the agent. No live-peer guard — a message to
			// a scope with nobody on it sits in the maildir and is swept in 24h.
			function notify(to: string, text: string, opts?: { kind?: string; re?: string; urgent?: boolean }): void {
				const bus = (globalThis as Record<string, unknown>).__crew as
					| { send?: (to: string, text: string, opts?: { kind?: string; re?: string; urgent?: boolean }) => void }
					| undefined;
				bus?.send?.(to, text, opts);
			}

			// gantt's mode IS a walkie-talkie scope: `crew_send to: "plan"` reaches
			// whoever is planning only if entering plan mode joins the group.
			// Every `role =` assignment funnels through here, so
			// `globalThis.__gantt.role` is the one answer to "is this session
			// inside a gantt loop right now".
			function wear(next: Role | undefined): void {
				const g = ((globalThis as Record<string, unknown>).__gantt ?? {}) as Record<string, unknown>;
				(globalThis as Record<string, unknown>).__gantt = g;
				g.role = next;
				// seed the duplex marks from the board as it stands NOW, so the
				// first settle after entering a role diffs from reality.
				try {
					if (existsSync(dir())) {
						const b = loadBoard(dir());
						if (b) {
							lastDoneIds = doneIds(b);
							if (next === "plan") lastOpenIds = openIds(b);
						}
					}
				} catch {
					/* board unreadable — diff from empty, harmless */
				}
				const bus = (globalThis as Record<string, unknown>).__crew as
					| { join?: (s: string) => void; leave?: (s: string) => void }
					| undefined;
				if (!bus) return;
				// The conductor IS both halves: it joins plan AND work so stray
				// plan/work mail (a child, another session) still reaches it.
				if (next === "conductor") {
					bus.join?.("plan");
					bus.join?.("work");
				} else {
					for (const r of ["plan", "work"]) if (r !== next) bus.leave?.(r);
					if (next) bus.join?.(next);
				}
			}

			/**
			 * Repaint the status line. Pass an already-loaded board to avoid a
			 * second read — `loadBoard` walks and parses every ticket file, so
			 * callers that need the board anyway should hand it over.
			 */
			function paint(loaded?: Board | null): void {
				if (!existsSync(dir())) {
					ui?.setStatus?.(STATUS_KEY, undefined);
					return;
				}
				try {
					const board = loaded !== undefined ? loaded : loadBoard(dir());
					if (!board) {
						ui?.setStatus?.(STATUS_KEY, undefined);
						return;
					}
					ui?.setStatus?.(STATUS_KEY, statusLine(board, role));
				} catch {
					ui?.setStatus?.(STATUS_KEY, "gantt: board invalid");
				}
			}

			// ── lifecycle ──────────────────────────────────────────────────
			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
				ui = ctx?.ui;
				root = ctx?.cwd ?? root;
				setGanttRoot(root);
				session = ctx?.sessionManager?.getSessionId?.() ?? session;
				paint();
			});

			pi.on("agent_settled", () => {
				// One-shot re-entrancy guard: the settle right after `/gantt plan` is
				// the plan's own doing (it just wrote the planning brief and the
				// board). Its commits must not re-notify the counterpart — that is
				// what compounds plan loops. Every later settle notifies normally.
				const planInFlight = _planInFlight;
				_planInFlight = false;
				if (planInFlight) return;
				// Conductor: the loop drives itself — a board-derived continuation
				// on every settle instead of the two-session duplex notify.
				if (_conductor) {
					let board: Board | null = null;
					try {
						board = existsSync(dir()) ? loadBoard(dir()) : null;
					} catch {
						board = null; // mid-chart invalid board — keep the loop alive
					}
					paint(board);
					conductorTick(board);
					return;
				}
				if (!existsSync(dir())) return;
				// Duplex auto-notify: the hook, not the prompt, tells the
				// counterpart what moved. One read serves both the status line
				// and the diff below.
				let board: Board | null;
				try {
					board = loadBoard(dir());
				} catch {
					ui?.setStatus?.(STATUS_KEY, "gantt: board invalid");
					return;
				}
				paint(board);
				if (!board) return;
				if (role === "work") {
					const done = doneIds(board);
					const closed = [...done].filter((id) => !lastDoneIds.has(id));
					lastDoneIds = done;
					if (closed.length) notify("plan", `closed ${closed.join(", ")}`, { kind: "reconcile" });
				} else if (role === "plan") {
					const opened = [...openIds(board)].filter((id) => !lastOpenIds.has(id));
					lastOpenIds = openIds(board);
					if (opened.length) notify("work", `added ${opened.join(", ")}`, { kind: "reconcile" });
				}
			});

			pi.on("message_end", (event) => {
				// The conductor's one way out: the agent replies [GANTT: DONE] once
				// nothing is ready, nothing is in flight, and reconcile added
				// nothing. Anything else is a normal turn.
				if (!_conductor) return;
				if (event?.message?.role !== "assistant") return;
				const content = event.message.content;
				let text = "";
				if (typeof content === "string") text = content;
				else if (Array.isArray(content))
					text = (content as Array<{ type?: string; text?: string }>)
						.filter((b) => b?.type === "text")
						.map((b) => b.text ?? "")
						.join("");
				if (text.includes(DONE_MARKER)) {
					conductorStop();
					ui?.notify?.(`gantt: ${DONE_MARKER} — conductor loop complete`, "info");
				}
			});

			pi.on("session_shutdown", () => {
				// Runs unconditionally. This used to be gated on a `wasLive` flag
				// latched at session_start, so a board created mid-session skipped the
				// whole teardown: `globalThis.__gantt.role` stayed set process-wide, and
				// the next unrelated session saw role === "work" — simplify reads exactly
				// that and appended its principles + a "run simplify before closing the
				// ticket" follow-up to a session with no ticket in sight.
				ui?.setStatus?.(STATUS_KEY, undefined);
				// Leave the walkie-talkie scopes we joined.
				const bus = (globalThis as Record<string, unknown>).__crew as { leave?: (s: string) => void } | undefined;
				for (const r of ["plan", "work"]) bus?.leave?.(r);
				if ((globalThis as Record<string, unknown>).__gantt) {
					delete (globalThis as Record<string, unknown>).__gantt;
				}
				_conductor = false;
				_lastConductorSig = "";
				_lastConductorTick = 0;
			});

			// ── tool: gantt ────────────────────────────────────────────────
			// The board as a TOOL, not just a slash command — a headless
			// child, an `until` goal loop, or any harness that cannot self-
			// invoke `/gantt` can still take the next ticket, so the loop
			// drives itself with no human in it. The tool RETURNS the ticket's
			// brief as its result, so an agent calls `gantt` action "work",
			// does the work, closes the ticket, and calls `gantt` again.
			pi.registerTool({
				name: "gantt",
				label: "Gantt",
				description:
					"Work the gantt board without the /gantt slash command, so a headless or looping session can drive it. " +
					'action "work" (default): claim the next ready ticket and RETURN its orchestration brief as the result — do that work, close the ticket (edit its file to state: done, drop the claim line, commit), then call this again for the next ticket. ' +
					"Research tickets fanned out in the same step come back in the result too, to dispatch as parallel subagents. " +
					'action "dispatch-all": claim EVERY ready afk ticket and return one implement-brief per ticket — the /gantt conductor loop runs each as its own parallel subagent in its own worktree. ' +
					'action "conductor": arm the continuous loop on this session (chart → reconcile → dispatch → close, until the agent replies [GANTT: DONE]); "stop" ends it. ' +
					'action "work-here": serial solo loop — claims the most important ready ticket (the one unblocking the most work), and the brief tells THIS session to implement it itself: no subagents, no worktrees, one ticket at a time, close it, call again; research tickets are claimed inline instead of fanned out. ' +
					'action "status": the board\'s one-line state. "plan"/"chart": the planning brief. ' +
					"When the result says nothing is dispatchable (clear, closed, waiting-on-you, or stale claims), the loop is done — stop calling.",
				promptSnippet: "Take the next ready gantt ticket and drive the board loop from a tool",
				parameters: Type.Object({
					action: Type.Optional(
						Type.Union(
							[
								Type.Literal("work"),
								Type.Literal("work-here"),
								Type.Literal("dispatch-all"),
								Type.Literal("conductor"),
								Type.Literal("stop"),
								Type.Literal("status"),
								Type.Literal("plan"),
								Type.Literal("chart"),
							],
							{ description: "default work" },
						),
					),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					root = ctx?.cwd ?? root;
					setGanttRoot(root);
					session = ctx?.sessionManager?.getSessionId?.() ?? session;
					ui = ctx?.ui ?? ui;
					const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
					const action = String(params?.action ?? "work").toLowerCase();
					// conductor/stop do not need a board — arm or end the loop even
					// when the board is absent (the loop charts it).
					if (action === "conductor") {
						if (_conductor) return out('gantt: conductor already running — action "stop" ends it');
						_conductor = true;
						_lastConductorSig = "";
						_lastConductorTick = 0;
						role = "conductor";
						wear("conductor");
						paint();
						return out(bootstrapPrompt(root, dir()));
					}
					if (action === "stop") {
						conductorStop();
						return out("gantt: conductor stopped");
					}
					if (!existsSync(dir())) {
						const p = prdPass(root, dir());
						return out(
							p.kind === "chart" ? p.prompt : "gantt: no .pi/gantt/ board and no prd.md — nothing to work.",
						);
					}
					// Every tool action validates an extant board first.
					let board: Board | null;
					try {
						board = loadBoard(dir());
					} catch (e) {
						return out(reconcileError((e as Error).message ?? String(e)));
					}
					if (action === "status") return out(board ? statusLine(board, role) : "gantt: empty board");
					if (action === "chart") return out(chartPrompt(dir()));
					if (action === "plan") {
						if (!existsSync(dir())) return out("gantt: no .pi/gantt/ dir — /gantt chart to start one");
						role = "plan";
						wear("plan");
						_planInFlight = true;
						return out(planPrompt(root, dir()));
					}
					if (action === "dispatch-all") {
						// The conductor's claim step: every ready afk ticket, all
						// kinds, in one pass, each with its implement-brief. The
						// conductor then runs each as its own parallel subagent.
						const fanned = await fanOutReady(dir(), session, (t) => childBrief(dir(), t));
						paint();
						if (fanned.tickets.length) {
							(
								(globalThis as Record<string, unknown>).__crew as { doing?: (s: string) => void } | undefined
							)?.doing?.(`gantt dispatch-all: ${fanned.tickets.map((t) => t.id).join(", ")}`);
							const parts: string[] = [];
							if (fanned.unlocked.length)
								parts.push(
									`WARNING: ${fanned.unlocked.join(", ")} dispatched WITHOUT a lock — the board's commit path refused it (pre-commit hook? read-only index?). Fix the commit path.`,
								);
							fanned.tickets.forEach((t, i) => {
								parts.push(
									`=== ${t.id} (${t.kind}) — dispatch as ONE crew subagent in its OWN forest worktree ===\n\n${fanned.briefs[i]}`,
								);
							});
							return out(parts.join("\n\n"));
						}
						// Nothing ready — say why so the conductor knows its next move.
						const waiting = board ? cursor(board).waiting : [];
						if (waiting.length) {
							const names = waiting.map((id) => board?.tickets.get(id)?.title ?? id);
							return out(
								`gantt: nothing ready — ${waiting.length} waiting-on-you: ${names.join(", ")}. Surface them to the user.`,
							);
						}
						if (boardClosed(board)) {
							const p = prdPass(root, dir());
							return out(
								p.kind === "chart" ? p.prompt : "gantt: board closed and no prd.md — nothing to plan from.",
							);
						}
						return out(
							"gantt: nothing ready — run the reconcile pass (read the requirements, create tickets for uncovered scope), then dispatch-all again.",
						);
					}
					// work / work-here: same step() the command runs, but the
					// brief comes back as the result instead of a followUp.
					const here = action === "work-here";
					if (role !== "work") {
						role = "work";
						wear("work");
					}
					const fanned: string[] = [];
					let s: Step;
					try {
						s = here
							? await step(dir(), session, undefined, true)
							: await step(dir(), session, (r: { prompt: string }) => fanned.push(r.prompt));
					} catch (e) {
						return out(reconcileError((e as Error).message ?? String(e)));
					}
					paint();
					if (s.kind === "dispatch") {
						(
							(globalThis as Record<string, unknown>).__crew as { doing?: (s: string) => void } | undefined
						)?.doing?.(`gantt ${action}: ${s.ticket.id}`);
						const parts: string[] = [];
						if (fanned.length)
							parts.push(
								`${fanned.length} research ticket(s) fanned out in this step — dispatch these as parallel subagents too:\n\n${fanned.join("\n\n---\n\n")}`,
							);
						if (s.unlocked)
							parts.push(
								`WARNING: ${s.ticket.id} dispatched WITHOUT a lock — the board's commit path refused it (pre-commit hook? read-only index?). Work is running but nothing marks the ticket, so another session can take it too. Fix the commit path.`,
							);
						parts.push(s.prompt);
						return out(parts.join("\n\n===\n\n"));
					}
					// empty: research may still have fanned out; otherwise report
					// why the loop has nothing — the caller's cue to stop.
					if (fanned.length)
						return out(
							`${fanned.length} research ticket(s) fanned out — dispatch these as parallel subagents:\n\n${fanned.join("\n\n---\n\n")}`,
						);
					let latest: Board | null;
					try {
						latest = loadBoard(dir());
					} catch (e) {
						return out(reconcileError((e as Error).message ?? String(e)));
					}
					if (s.kind !== "empty") return out("gantt: clear — nothing open and unblocked. Loop complete.");
					if (s.waiting.length) {
						const names = s.waiting.map((id: string) => latest?.tickets.get(id)?.title ?? id);
						return out(
							`gantt: nothing to dispatch — ${s.waiting.length} waiting-on-you: ${names.join(", ")}. The loop is done until you unblock them.`,
						);
					}
					if (boardClosed(latest)) {
						const p = prdPass(root, dir());
						return out(
							p.kind === "chart"
								? p.prompt
								: "gantt: board closed — nothing open and no prd.md to plan from. Loop complete.",
						);
					}
					const stale = latest ? await staleClaims(latest, STALE_CLAIM_MS) : [];
					if (stale.length) {
						const held = stale
							.map(
								(t) => `${t.id} (${Math.floor((Date.now() - t.mtimeMs) / 3600_000)}h, ${t.claim ?? "unknown"})`,
							)
							.join("; ");
						notify("plan", `stale claims holding board: ${stale.map((t) => t.id).join(", ")}`, {
							kind: "reconcile",
						});
						return out(
							`gantt: nothing dispatchable — ${stale.length} stale claim(s) holding the board: ${held}. Free one with the /gantt release <id> command, then call work again.`,
						);
					}
					notify("plan", "nothing dispatchable — need work", { kind: "reconcile" });
					return out("gantt: clear — nothing open and unblocked. Loop complete.");
				},
			} as ToolDefinition);

			// ── command: /gantt ────────────────────────────────────────────
			pi.registerCommand("gantt", {
				description: "Continuous board loop: /gantt | stop | status | chart | release <id>",
				handler: async (args: string, ctx: ExtensionCommandContext) => {
					ui = ctx?.ui ?? ui;
					root = ctx?.cwd ?? root;
					setGanttRoot(root);
					session = ctx?.sessionManager?.getSessionId?.() ?? session;
					const word = String(args ?? "")
						.trim()
						.toLowerCase();
					// All board-aware paths validate before they act.
					if (word && word !== "stop" && existsSync(dir())) {
						try {
							loadBoard(dir());
						} catch (e) {
							ctx.ui?.notify?.(reconcileError((e as Error).message ?? String(e)), "error");
							return;
						}
					}
					const note = (text: string, level: "info" | "warning" | "error" = "info") =>
						ctx.ui?.notify?.(text, level);

					// ── bare /gantt: the continuous conductor loop ──────────
					// One session, no arguments: charts (no board), reconciles
					// (requirements → tickets), claims every ready ticket at once,
					// runs each as its own parallel subagent, closes as results
					// land — until the agent replies [GANTT: DONE].
					if (!word) {
						if (_conductor) {
							note("gantt: conductor already running — /gantt stop ends it");
							return;
						}
						_conductor = true;
						_lastConductorSig = "";
						_lastConductorTick = 0;
						role = "conductor";
						wear("conductor");
						pi.sendUserMessage(bootstrapPrompt(root, dir()), { deliverAs: "followUp" });
						note(
							"gantt: conductor started — this session charts, plans, and runs tickets in parallel until the board is done. Stop: /gantt stop",
						);
						paint();
						return;
					}
					if (word === "stop") {
						conductorStop();
						note("gantt: conductor stopped");
						return;
					}
					if (word === "chart") {
						pi.sendUserMessage(chartPrompt(dir()), { deliverAs: "followUp" });
						return;
					}
					if (word === "status") {
						try {
							const board = loadBoard(dir());
							note(board ? statusLine(board, role) : "gantt: empty board");
						} catch (e) {
							note(reconcileError((e as Error).message ?? String(e)), "error");
						}
						return;
					}
					if (word.startsWith("release ")) {
						const id = word.slice(8).trim();
						const board = loadBoard(dir());
						const t = board?.tickets.get(id);
						if (!t) {
							note(`gantt: no ticket "${id}"`);
							return;
						}
						const owner = t.claim;
						if (!owner) {
							note(`gantt: ${id} is not claimed`);
							return;
						}
						const released = (await release(dir(), id, owner, "open")).ok;
						note(
							released ? `gantt: ${id} released from ${owner}` : `gantt: ${id} release failed for ${owner}`,
							released ? "info" : "warning",
						);
						paint();
						return;
					}
					if (word === "plan" || word === "work" || word === "work-here") {
						note(
							"gantt: plan and work are one loop now — just /gantt (runs continuously, tickets in parallel). /gantt stop ends it.",
							"warning",
						);
						return;
					}
					note(
						"gantt: /gantt starts the continuous loop. Control: /gantt stop | status | chart | release <id>",
						"warning",
					);
				},
			});
		},
	};
}
