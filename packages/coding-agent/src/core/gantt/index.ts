// Gantt — file-per-ticket routine board, ported into pi core as an inline
// extension. `.pi/gantt/` at repo root is the single representation; the
// gantt/cursor/decisions views are computed from it at read time and never
// written to disk. Absent `.pi/gantt/` dir: zero cost — no status, no
// injection, the extension goes inert.
//
// Two sessions share one board: `/gantt plan` reconciles it against the
// requirements, `/gantt work` claims tickets off it. Steering between them
// rides the walkie-talkie channel (core/crew/crew-bridge), addressed to the
// `plan` and `work` roles — gantt's mode IS a walkie-talkie scope.
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
import { type Step, step } from "./message.ts";
import { planPrompt } from "./plan.ts";
import { boardClosed, prdPass } from "./prd.ts";
import { type Board, cursor, dir, loadBoard, setGanttRoot } from "./store.ts";

/** Which half of the board this session is working. */
export type Role = "plan" | "work";

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
	if (role) parts.push(role === "plan" ? "plan" : "work");
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

			const doneIds = (board: Board): Set<string> =>
				new Set([...board.tickets.values()].filter((t) => t.state === "done").map((t) => t.id));
			const openIds = (board: Board): Set<string> =>
				new Set([...board.tickets.values()].filter((t) => t.state === "open").map((t) => t.id));

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
				for (const r of ["plan", "work"]) if (r !== next) bus.leave?.(r);
				if (next) bus.join?.(next);
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
				description: "Work the gantt board: work | work-here | plan [stop] | chart | status | release <id>",
				handler: async (args: string, ctx: ExtensionCommandContext) => {
					ui = ctx?.ui ?? ui;
					root = ctx?.cwd ?? root;
					setGanttRoot(root);
					session = ctx?.sessionManager?.getSessionId?.() ?? session;
					const word = String(args ?? "")
						.trim()
						.toLowerCase();
					// All board-aware paths validate before they act.
					if (word !== "plan stop" && existsSync(dir())) {
						try {
							loadBoard(dir());
						} catch (e) {
							ctx.ui?.notify?.(reconcileError((e as Error).message ?? String(e)), "error");
							return;
						}
					}
					const note = (text: string, level: "info" | "warning" | "error" = "info") =>
						ctx.ui?.notify?.(text, level);

					if (word === "plan" || word === "plan stop") {
						if (word === "plan stop") {
							role = undefined;
							wear(undefined);
							note("gantt: plan mode off");
							paint();
							return;
						}
						if (!existsSync(dir())) {
							note("gantt: no .pi/gantt/ dir — /gantt chart to start one");
							return;
						}
						role = "plan";
						wear("plan");
						_planInFlight = true;
						pi.sendUserMessage(planPrompt(root, dir()), { deliverAs: "followUp" });
						paint();
						return;
					}
					if (word === "chart") {
						pi.sendUserMessage(chartPrompt(dir()), { deliverAs: "followUp" });
						return;
					}
					// closed or missing board: the PRD engine decides.
					const idle = (board: Board | null) => {
						const p = prdPass(root, dir());
						if (p.kind === "chart") {
							pi.sendUserMessage(p.prompt, { deliverAs: "followUp" });
						} else {
							note(
								board
									? "gantt: board closed, no .pi/gantt/prd.md — nothing to plan from."
									: "No .pi/gantt/ dir and no .pi/gantt/prd.md — /gantt chart to start one.",
							);
						}
					};
					if (!existsSync(dir())) return idle(null);
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
					// work (default) and work-here share everything below except
					// the step call: work-here fans nothing out and briefs this
					// session to implement.
					const here = word === "work-here";
					if (role !== "work") {
						role = "work";
						wear("work");
					}
					let s: Step;
					try {
						s = here
							? await step(dir(), session, undefined, true)
							: await step(dir(), session, (r: { prompt: string }) =>
									pi.sendUserMessage(r.prompt, { deliverAs: "followUp" }),
								);
					} catch (e) {
						note(reconcileError((e as Error).message ?? String(e)), "error");
						return;
					}
					if (s.kind === "dispatch") {
						(
							(globalThis as Record<string, unknown>).__crew as { doing?: (s: string) => void } | undefined
						)?.doing?.(`gantt ${here ? "work-here" : "work"}: ${s.ticket.id}`);
						if (s.unlocked)
							note(
								`gantt: ${s.ticket.id} dispatched WITHOUT a lock — the board's commit path refused it (pre-commit hook? read-only index?). Work is running; nothing marks the ticket, so another session can take it too. Fix the commit path.`,
								"warning",
							);
						pi.sendUserMessage(s.prompt, { deliverAs: "followUp" });
					} else if (s.kind === "empty" && !s.spawned.length) {
						if (s.waiting.length) {
							const board = loadBoard(dir());
							const names = s.waiting.map((id) => board?.tickets.get(id)?.title ?? id);
							note(`gantt: AFK work done — ${s.waiting.length} waiting-on-you (${names.join(", ")})`);
						} else if (boardClosed(loadBoard(dir()))) {
							idle(loadBoard(dir()));
						} else {
							const board = loadBoard(dir());
							const stale = board ? await staleClaims(board, STALE_CLAIM_MS) : [];
							if (stale.length) {
								const held = stale
									.map(
										(t) =>
											`${t.id} (${Math.floor((Date.now() - t.mtimeMs) / 3600_000)}h, ${t.claim ?? "unknown"})`,
									)
									.join("; ");
								note(
									`gantt: nothing dispatchable — ${stale.length} stale claim${stale.length > 1 ? "s" : ""} holding the board: ${held}. /gantt release <id> frees one.`,
									"warning",
								);
								notify("plan", `stale claims holding board: ${stale.map((t) => t.id).join(", ")}`, {
									kind: "reconcile",
								});
							} else {
								notify("plan", "nothing dispatchable — need work", { kind: "reconcile" });
								note("gantt: clear — nothing open and unblocked");
							}
						}
					}
					paint();
				},
			});
		},
	};
}
