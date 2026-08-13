// Research fan-out: every AFK research ticket on the gantt is claimed
// and handed to a spawn callback in one pass — parallel by construction,
// findings land on a throwaway research/<id> branch, the ticket body gets
// the pointer. An unresolved research ticket blocks its dependents like
// any other open ticket: the gantt computation already enforces that.

import { claimNext } from "./claim.ts";
import type { Ticket } from "./store.ts";

export type ResearchSpawn = {
	id: string;
	branch: string;
	body: string;
	prompt: string;
};

export function researchPrompt(dir: string, t: Ticket): string {
	return [
		`Research ticket ${t.id} (claimed for you) — fan this out as a parallel`,
		"subagent; do not block the main loop on it and do not research it in",
		"this context. Brief the child self-contained — it starts fresh and",
		"cannot see this session: the question, where to look, what counts as an",
		"answer, what is out of scope.",
		"",
		t.body,
		"",
		`Findings go on a throwaway branch \`research/${t.id}\` — commit notes,`,
		"artifacts, spike code there; the branch is disposable, the ticket is not.",
		`What comes back to you is an artifact, never a transcript. Write INTO`,
		`${dir}/tickets/${t.id}.md: a pointer to the branch and the key findings`,
		"(enough for a cold session to act without the branch).",
		"Close it: set `state: done`, delete the `claim:` line, commit that one",
		"file. Its dependents unblock only when it closes.",
	].join("\n");
}

// claim + spawn every afk research ticket currently on the gantt.
export async function fanOut(dir: string, session: string, spawn: (r: ResearchSpawn) => void): Promise<Ticket[]> {
	const spawned: Ticket[] = [];
	for (;;) {
		const next = await claimNext(dir, session, (x) => x.mode === "afk" && x.kind === "research");
		if (next.kind === "none") return spawned;
		const t = next.ticket;
		spawn({ id: t.id, branch: `research/${t.id}`, body: t.body, prompt: researchPrompt(dir, t) });
		spawned.push(t);
		// An unlocked ticket is still on the gantt, so another pass would hand
		// out the same one forever. Fan out this one and stop.
		if (next.kind === "unlocked") return spawned;
	}
}
