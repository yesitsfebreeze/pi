// The /gantt loop, one step at a time: claim the next AFK gantt
// ticket and produce its resolution prompt. HITL tickets are NEVER
// dispatched — they surface as waiting-on-you and the loop walks past.
// Dependency order is free: the gantt only ever contains unblocked
// tickets, so closing one admits its dependents on the next step.
//
// The loop session orchestrates; it does not implement. Its context is
// the board, never the codebase: every ticket is resolved by fresh-context
// subagents working from a written brief, and what comes back is an
// artifact — files touched, verify output, the decision — never a
// transcript. A routine is longer than one context window, so the only
// session that must stay lean is this one.

import { claimNext, importance } from "./claim.ts";
import { fanOut, type ResearchSpawn } from "./research.ts";
import { cursor, gantt, loadBoard, type Ticket } from "./store.ts";

export type Step =
	| { kind: "no-board" }
	| { kind: "empty"; waiting: string[]; spawned: Ticket[] }
	| { kind: "dispatch"; ticket: Ticket; prompt: string; spawned: Ticket[]; unlocked: boolean };

// The orchestration doctrine, prepended to every dispatched ticket. It is
// the same for all three kinds — only what the children are asked FOR
// differs — so it lives once here.
const ORCHESTRATE = [
	"You are the gantt loop session: you orchestrate, you do not implement.",
	"Do NOT read source files, grep the repo, or write code in this context.",
	"Anything that needs the codebase is a subagent's job, without exception.",
	"",
	"1. Write the brief from the ticket. The child starts fresh and cannot",
	"   see this session, so the brief is self-contained: objective in one",
	"   falsifiable sentence · where to work (paths, symbols) · acceptance",
	"   criteria · the verify command · what is explicitly OUT of scope ·",
	"   what to return. A brief you could not hand to a stranger is not done.",
	"2. Split the work as wide as it goes, then use as many subagents as the",
	"   work has independent parts — parallel is the default, not the reward",
	"   for an easy ticket. Decompose the ticket into the smallest independent",
	"   parts you can find and dispatch them as parallel subagents in one",
	"   batch, each writer in its own worktree — two writers never share a",
	"   tree. Run parts in series ONLY where one genuinely consumes another's",
	"   output, and name that output; imagined ordering is not a dependency.",
	"   A part you cannot brief without reading code first gets a scout",
	"   subagent whose only deliverable is the brief for the next fan-out.",
	"   Many narrow briefs running at once beat one wide brief run alone.",
	"3. Dispatch with a tool/turn budget per child, then wait for results.",
	"4. Take back an ARTIFACT, never a transcript: files touched, the verify",
	"   command's output, and a few lines of what changed and why. Never",
	"   paste a child's reasoning into this session or into the ticket.",
	"5. A child that fails twice on the same part is a briefing failure, not",
	"   a retry — but a zero-tool stall is ambiguous: a rate-limited child",
	"   (provider 429) looks identical to a briefing failure at the surface.",
	"   First rule out a provider error: grep the child's events.jsonl for",
	"   429, or read `crew result <handle>` / meta.json `providerError`.",
	"   Only call it a briefing failure once a provider error is ruled out;",
	"   then rewrite the brief or split it smaller.",
	"",
];

// The orchestrating loop's close/continue contract. It assumes the duplex:
// a planner session on the other end of the walkie-talkie. work-here has no
// planner — its close text is soloClose below.
function closeText(dir: string, t: Ticket, action: string): string {
	return [
		`Close it: edit ${dir}/tickets/${t.id}.md — set \`state: done\`, delete the`,
		"`claim:` line, keep the header fences intact — and commit that one file.",
		"The loop notifies the planner automatically when a ticket closes — no",
		"`crew_send` needed for that. Then take the next ticket: call the",
		`\`gantt\` tool with action "${action}" — it returns the next brief, so`,
		`the loop drives itself with no human in it. (\`/gantt ${action}\` does the`,
		"same if you are driving by hand.)",
		"",
		`When \`gantt ${action}\` says nothing is dispatchable, the board is not`,
		"done — the loop tells the planner you need work automatically; `crew_recv`",
		"for the planner's reply. The planner may chart new tickets, steer you to",
		"an experiment, or confirm there is genuinely no work. Take what it sends",
		"and keep going; only stop when the planner confirms there is no work.",
		"",
		"Blocked, or the ticket contradicts the map? Do not guess and do not",
		're-plan it yourself: call `crew_send`, to: "plan", with the ticket id and',
		"what is wrong, then `crew_recv` for the planner's resolution. The planner",
		"will try to solve it — re-scope the ticket, write a follow-on, or answer",
		"the question. If it resolves the block, take the next ticket. Only if the",
		"planner says it cannot resolve it does the process halt and the user is",
		"asked — then stop and wait; do not escalate to the user yourself.",
	].join("\n");
}

// The close gate for build tickets: simplify runs once, here, and nowhere
// else. Ordinary sessions never see it — the tool exists but nothing pulls at
// it — because three follow-up sub-agents per change only pays for itself at a
// ticket boundary, where "done" is a claim someone else will build on.
// Decision and research tickets skip it: their artifact is the ticket body,
// and there is no diff to review.
const SIMPLIFY_GATE = [
	"",
	"Before you close: run the simplify tool ONCE over this ticket's change.",
	"It dispatches the follow-up — check, test, persona review — to three",
	"sub-agents in order, each exactly once, and returns a verdict.",
	"[SIMPLIFY: CLEAN] means close the ticket. [SIMPLIFY: FIXES NEEDED] returns",
	"the findings: fix the change, then run simplify once more. Never loop it",
	"to re-check your own work — one run per ticket.",
].join("\n");

// The solo doctrine — work-here's counterpart to ORCHESTRATE. The session
// IS the implementer: it reads the code, writes the change, runs the verify,
// one ticket at a time, no subagents and no worktrees.
const SOLO = [
	"You are the gantt work-here session: you implement, right here.",
	"No subagents, no worktrees, no fan-out — read the source, make the",
	"change, and run the verify yourself, in this session and this working",
	"tree. Work ONE ticket at a time: this brief is the most important",
	"ready ticket (it unblocks the most work behind it) — finish and close",
	"it before taking the next; never claim ahead.",
	"Keep the ticket's scope: what its body marks out of scope stays out.",
	"",
];

// work-here's close/continue contract. No planner session exists in the solo
// loop, so nothing here rides the walkie-talkie: close, take the next most
// important ticket, and when nothing is dispatchable, stop and report.
function soloClose(dir: string, t: Ticket): string {
	return [
		`Close it: edit ${dir}/tickets/${t.id}.md — set \`state: done\`, delete the`,
		"`claim:` line, keep the header fences intact — and commit that one file",
		"together with the work it verifies. Closing is part of the ticket:",
		"work whose ticket still says open is not finished.",
		"",
		"Then take the next ticket: call the `gantt` tool with action",
		'"work-here" — it returns the next most important brief — and repeat',
		"until it says nothing is dispatchable. (`/gantt work-here` does the",
		"same if you are driving by hand.) When nothing is dispatchable, stop:",
		"report what you closed and what is left waiting-on-you.",
		"",
		"Blocked, or the ticket contradicts the map? Do not guess: write what",
		"is wrong into the ticket body (below the header), put the ticket back",
		"— set `state: open`, delete the `claim:` line — commit that, tell the",
		"user, and take the next ticket.",
	].join("\n");
}

export function promptHere(dir: string, t: Ticket): string {
	const close = soloClose(dir, t);
	const head = `Ticket ${t.id} (${t.kind}, claimed for you):\n\n${t.body}\n`;
	if (t.kind === "decision")
		return [
			head,
			...SOLO,
			"Investigate the options yourself — read whatever code or docs the",
			"decision needs — then weigh the evidence against the map's destination",
			"and write the resolution and its why INTO the ticket body (below the",
			"header), in your words.",
			close,
		].join("\n");
	if (t.kind === "research")
		return [
			head,
			...SOLO,
			"Research this yourself and write the key findings INTO the ticket body",
			"(below the header) — enough for a cold session to act on without",
			"re-doing the research. No throwaway branch: the ticket body is the",
			"artifact.",
			close,
		].join("\n");
	return [
		head,
		...SOLO,
		t.verify
			? `Verify — run \`${t.verify}\` YOURSELF before closing.\nYour own memory of the change is not evidence; the command's output is.`
			: "No verify line — record what you ran and what it showed in the ticket\nbody as evidence.",
		SIMPLIFY_GATE,
		close,
	].join("\n");
}

export function promptFor(dir: string, t: Ticket): string {
	const close = closeText(dir, t, "work");
	const head = `Ticket ${t.id} (${t.kind}, claimed for you):\n\n${t.body}\n`;
	if (t.kind === "decision")
		return [
			head,
			...ORCHESTRATE,
			"For this decision the children investigate, you decide: brief one",
			"scout per option (or one scout for the whole comparison) and ask each",
			"for evidence + a recommendation, never a rewrite. Then weigh what",
			"came back against the map's destination and write the resolution and",
			"its why INTO the ticket body (below the header) — in your words, not",
			"a pasted report.",
			close,
		].join("\n");
	if (t.kind === "research")
		return [
			head,
			...ORCHESTRATE,
			"Research this through subagents: findings land on a throwaway branch",
			`\`research/${t.id}\`. Write a pointer to that branch plus the key`,
			"findings into the ticket body — enough for a cold session to act",
			"without reading the branch.",
			close,
		].join("\n");
	return [
		head,
		...ORCHESTRATE,
		t.verify
			? `Verify — run \`${t.verify}\` YOURSELF in this session before closing.\nA child reporting green is not evidence; the command's output is.`
			: "No verify line — make each child return its own evidence and record\nthat evidence in the ticket body.",
		SIMPLIFY_GATE,
		close,
	].join("\n");
}

// one loop step: research tickets on the gantt fan out first (all of
// them, parallel); then the next afk build/decision ticket is claimed
// and dispatched. Empty afk gantt → stop, hitl surfaced, still open.
// `here` picks the loop flavour. Default: orchestrate — research fans out
// through `spawn`, the brief is promptFor's subagent doctrine, ready tickets
// go in board order. here=true: solo — nothing fans out (research is claimed
// inline like any other ticket), the brief is promptHere's implement-it-
// yourself doctrine, and the ready set is ranked by importance so the serial
// worker always takes the ticket that unblocks the most.

// conductor fan-out: claim EVERY ready afk ticket (all kinds — research too,
// the conductor runs them like any other) and build each one's dispatch
// brief. The conductor session then runs each ticket as its own parallel
// subagent, so the board drains wide instead of one-at-a-time. Research
// tickets get no special branch treatment here — the conductor dispatches
// them through crew like every other kind, and crew children own their tree.
export async function fanOutReady(
	dir: string,
	session: string,
	brief: (t: Ticket) => string,
): Promise<{ tickets: Ticket[]; briefs: string[]; unlocked: string[] }> {
	const tickets: Ticket[] = [];
	const briefs: string[] = [];
	const unlocked: string[] = [];
	for (;;) {
		const next = await claimNext(dir, session, (t) => t.mode === "afk");
		if (next.kind === "none") return { tickets, briefs, unlocked };
		tickets.push(next.ticket);
		briefs.push(brief(next.ticket));
		if (next.kind === "unlocked") unlocked.push(next.ticket.id);
	}
}

export async function step(
	dir: string,
	session: string,
	spawn?: (r: ResearchSpawn) => void,
	here = false,
): Promise<Step> {
	let board = loadBoard(dir);
	if (!board) return { kind: "no-board" };
	const spawned = spawn && !here ? await fanOut(dir, session, spawn) : [];
	if (spawned.length) board = loadBoard(dir)!;
	const waiting = () => cursor(loadBoard(dir)!).waiting;
	const pick = (t: Ticket) => t.mode === "afk" && (spawn && !here ? t.kind !== "research" : true);
	const afk = gantt(board).filter(pick);
	if (afk.length === 0) return { kind: "empty", waiting: waiting(), spawned };
	const next = await claimNext(dir, session, pick, here ? importance : undefined);
	if (next.kind === "none") return { kind: "empty", waiting: waiting(), spawned };
	// An unlocked ticket still dispatches — a broken commit path is a defect
	// to report, not a reason to leave the routine standing still.
	const ticket = next.ticket;
	const brief = here ? promptHere : promptFor;
	return { kind: "dispatch", ticket, prompt: brief(dir, ticket), spawned, unlocked: next.kind === "unlocked" };
}
