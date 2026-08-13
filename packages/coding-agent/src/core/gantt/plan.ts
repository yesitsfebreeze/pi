// Plan mode — the other half of the duplex. The working session claims
// tickets one at a time; the planning session keeps the board honest
// against the requirements and tells the worker what moved. A board is
// not a plan written once: it is the reconciled projection of whatever
// the requirements say right now, and the requirements change while the
// worker is mid-ticket.
//
// The reconcile pass is a dispatched prompt, not code: only the agent can
// read a PRD and decide what a paragraph means for a ticket DAG. What is
// code here is WHEN it fires (a requirements file changed) and the one
// rule that keeps two sessions from colliding: never edit a claimed
// ticket, chain a follow-on instead.
import { existsSync } from "node:fs";
import { join } from "node:path";

// Requirements sources, in reconcile-read order. Missing ones are skipped.
export const SOURCES = [".pi/gantt/prd.md", ".pi/gantt/plans", ".pi/gantt/specs"];

export function watchPaths(root: string): string[] {
	return SOURCES.map((p) => join(root, p)).filter((p) => existsSync(p));
}

export function planPrompt(root: string, dir: string, trigger = "manual /gantt plan"): string {
	const sources = SOURCES.map((p) => join(root, p));
	return `Plan mode for the gantt board at ${dir}/. Trigger: ${trigger}.

You are the PLANNING half of a two-session loop. Another pi session is
working this board ticket by ticket right now. You NEVER claim, implement
or close a work ticket — you keep the board matching the requirements and
tell the worker what moved.

1. Read the requirements, skipping what does not exist:
${sources.map((p) => `   - ${p}`).join("\n")}

2. Read the board: ${dir}/map.md and every ${dir}/tickets/*.md.

3. Diff requirements against board. For each difference:
   - requirement no ticket covers → write a new ticket file with a full
     header:

     ---
     kind: build
     state: open
     mode: afk
     est: 1d
     ---

     kind is decision|research|build. mode is hitl for anything needing
     the human (naming, taste, money), afk otherwise — never leave mode
     empty. blocked-by wired ONLY to a real artifact dependency — leave
     independent tickets unblocked so the worker runs them in parallel;
     a deep serial chain is a smell.
     The body is a brief for a fresh subagent that
     cannot see you: objective in one falsifiable sentence, where to work,
     acceptance criteria, what is out of scope. The work session hands it
     to a child verbatim — a vague body is a ticket that bounces back.
   - ticket the requirements no longer want → \`state: out-of-scope\` plus
     one line in the body saying why. Never delete a ticket.
   - ticket whose scope drifted → rewrite its body to match.
   - destination moved → rewrite map.md Destination / Out of scope / Fog.

4. HARD RULE — a ticket with \`state: claimed\` is being worked RIGHT NOW.
   Do not edit it, do not re-scope it, do not close it. If the change
   invalidates it, write a follow-on ticket \`blocked-by: <that id>\` and
   say so in step 6 with urgent set.

5. Nothing differs in the reconcile → the board matches the requirements,
   but you are NOT done. An idle planner drives the product forward toward
   the map's Destination:
   - Look for experiments worth running and write a \`kind: research\` or
     \`kind: build\` ticket for each one that could move the board toward
     the Destination. An experiment that cannot tie back to it is noise.
   - Evaluate the tickets already on the board for improvement potential —
     a body too vague to brief a stranger, a missing verify, a dependency
     that is imagined not real, an est that is clearly wrong. Fix those in
     place (never on a \`state: claimed\` ticket — see step 4).
   - Anything that clearly moves the product toward the vision and is not
     yet a ticket becomes one, with a full header and a stranger-ready
     body as in step 3.
   Ground every new ticket in the Destination or a requirement — invention
   that names neither is scope creep, not progress.

6. A worker may \`crew_send\` to: "plan" reporting it is blocked or has
   nothing to do. You try to solve it:
   - Blocked ticket → re-scope it, write a follow-on \`blocked-by\` it, or
     answer the question in your reply. Then \`crew_send\` to: "work" with
     the resolution.
   - Nothing to do → chart new tickets per step 5, or if there is
     genuinely no work, \`crew_send\` to: "work" saying so.
   - If you CANNOT resolve the block — it needs a human call (taste,
     naming, money, a product decision only the user can make) — raise it
     to the user: that is the one case the process halts. Say so in your
     reply to "work" so the worker waits, and surface the question.

7. Commit only the board files you touched, one commit: \`plan: <what moved>\`.

8. The loop notifies the worker automatically when your reconcile adds or
   cuts tickets — no \`crew_send\` needed for that. DO call \`crew_send\`, to:
   "work", yourself only for a resolution to a worker's block, or to set
   urgent: true when the worker's claimed ticket is invalidated or its
   dependents changed under it. Nothing moved and no worker is asking →
   no message.

9. Stop. Plan mode re-fires this pass when a requirements file changes,
   or when a worker asks for work or reports a block.`;
}
