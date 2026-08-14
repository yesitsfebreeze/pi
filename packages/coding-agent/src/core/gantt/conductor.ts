// Conductor — the continuous /gantt loop. One session is BOTH the planner
// and the worker: it charts (no board), reconciles (requirements → tickets),
// claims every ready ticket at once, runs each as its own subagent in its
// own worktree, closes them as results land, and re-injects a board-derived
// continuation after every settle until the agent emits [GANTT: DONE].
// The two-session plan/work duplex is gone from the command surface — the
// walkie-talkie scopes exist only so stray plan/work mail still reaches the
// conductor.

import { type Board, cursor, gantt, type Ticket } from "./store.ts";

export const DONE_MARKER = "[GANTT: DONE]";

// The bootstrap: sent once when /gantt arms the loop. Everything after is
// the continuation re-injected on each settle.
export function bootstrapPrompt(root: string, dir: string): string {
	return [
		`You are the gantt CONDUCTOR: one session that plans AND works the board at ${dir}/ — no separate`,
		"planner session, no separate worker session. The loop re-injects instructions after every turn and",
		`ends only when you reply with ${DONE_MARKER}.`,
		"",
		"1. Chart if needed. If the board does not exist or is closed:",
		`   - ${root}/.pi/gantt/prd.md exists → chart the uncovered PRD scope: diff the PRD against what the board`,
		"     already covers (closed tickets, the map). Covered scope is done — do not re-chart it. No",
		`     uncovered remainder → the PRD is fully covered: report that and reply ${DONE_MARKER}.`,
		"   - no prd.md → derive the destination from THIS conversation: write map.md (Destination / Notes /",
		"     Out of scope / Fog) + tickets/*.md, breadth over depth. blocked-by only where a ticket genuinely",
		"     needs another's artifact to begin — independent tickets stay unblocked so they run in parallel.",
		"     An unclear goal → ask the user. Never invent scope the requirements do not name.",
		"2. Reconcile. Read the requirements (prd.md, plans/, specs/), diff against the board: create tickets",
		"   for uncovered scope, mark out-of-scope what the requirements no longer want (never delete), fix",
		"   drifted bodies. Never edit a claimed ticket — chain a follow-on blocked-by it instead. Ground every",
		"   new ticket in the requirements or the map's Destination. Coverage of the requirements IS the bar —",
		"   do not invent open-ended experiments to keep yourself busy.",
		'3. Dispatch — parallel, all at once. Call the `gantt` tool action "dispatch-all": it claims EVERY',
		"   ready afk ticket and returns one implement-brief per ticket. For each brief: `forest_dispatch` a",
		"   worktree, then `crew` action=start with task=<brief> and cwd=<worktree path>. One subagent per",
		"   ticket, all in one batch, every writer in its own tree. This session only orchestrates — never",
		"   implement.",
		"4. Collect. When a `# Crew — <handle> came back` message arrives: merge that child's worktree branch",
		"   into your branch, run the ticket's verify yourself, then close it: edit tickets/<id>.md →",
		"   state: done, delete the claim: line, keep the header fences, commit that one file. Run the simplify",
		"   tool once over the child's merged change before closing (check/test/persona review — one run per",
		"   ticket; [SIMPLIFY: CLEAN] means close). A child that failed twice is a briefing failure, not a",
		"   retry — rewrite the brief or release the ticket (state: open, drop claim, commit) and tell the",
		"   user.",
		"5. HITL tickets are never dispatched. When only they remain, surface each to the user and wait for",
		"   the answer; write the answer into the ticket body and close it.",
		"6. Stop ONLY when nothing is ready, nothing is in flight, and the reconcile added nothing → reply",
		`   with ${DONE_MARKER} plus a summary of what shipped.`,
	].join("\n");
}

// The per-settle continuation, computed from the board as it stands NOW so
// the agent never has to re-derive the state.
export function continuationPrompt(board: Board): string {
	const c = cursor(board);
	const ready = gantt(board).filter((t) => t.mode === "afk");
	const inFlight = [...board.tickets.values()].filter((t) => t.state === "claimed");
	const title = (id: string) => board.tickets.get(id)?.title ?? id;
	return [
		"<gantt-conductor>",
		`Board at ${board.dir}/: ${c.done}/${c.total} done · ready: ${ready.length ? ready.map((t) => t.id).join(", ") : "none"} · in flight: ${inFlight.length ? inFlight.map((t) => `${t.id} (${title(t.id)})`).join(", ") : "none"} · waiting-on-you: ${c.waiting.length ? c.waiting.join(", ") : "none"}`,
		"",
		"1. Collect results. For each in-flight ticket, `crew` action=result on its handle. Where the run is",
		"   done: merge its worktree branch into your branch, run the verify yourself, then run the simplify",
		"   tool once over the merged change (check/test/persona review — one run per ticket) and close the",
		"   ticket (state: done, delete the claim: line, commit). Failed runs: rewrite the brief or release",
		"   the ticket and tell the user. A run that has not reported after hours is stale — `crew` action=list,",
		"   release its ticket, re-dispatch.",
		'2. Dispatch. Ready tickets: call the `gantt` tool action "dispatch-all" — it claims EVERY ready afk',
		"   ticket and returns one brief per ticket. Start one `crew` subagent per brief in ONE batch, each in",
		"   its own `forest_dispatch` worktree (cwd=<tree>). Parallel is the default; never implement in this",
		"   session.",
		"3. Reconcile. Nothing ready and nothing in flight → read the requirements, diff against the board,",
		"   create/update tickets for uncovered scope (never edit a claimed ticket — chain a follow-on). Board",
		"   closed but prd.md exists → chart the uncovered PRD scope.",
		`4. Nothing added, nothing ready, nothing in flight → reply ${DONE_MARKER} with a summary of what`,
		"   shipped. That ends the loop.",
		"5. Only HITL tickets remain → surface them to the user and wait; write the answer into the ticket",
		"   body and close it.",
		"</gantt-conductor>",
	].join("\n");
}

// The brief handed to the subagent that implements ONE ticket, alone, in its
// own worktree. Deliberately different from promptFor/promptHere: no loop
// continuation contract, no further claiming — the child implements and
// commits, and the conductor merges + closes.
export function childBrief(dir: string, t: Ticket): string {
	const verify = t.verify
		? `Run the verify yourself: \`${t.verify}\`. Its output is the evidence.`
		: "Run this project's own test/build command relevant to the change and report the pass count.";
	return [
		`Gantt ticket ${t.id} (${t.kind}). You implement this ticket, alone, in this working tree. A fresh`,
		"session with no context — this brief is everything you get.",
		"",
		t.body,
		"",
		"1. Read what you need from this tree, make the change, and commit it on this tree's branch.",
		`2. ${verify}`,
		"3. Do NOT touch .pi/gantt/ or any ticket files — the conductor closes the ticket after you land.",
		"4. Return an artifact, not a transcript: files touched, verify output, and a few lines of what",
		"   changed and why.",
	].join("\n");
}
