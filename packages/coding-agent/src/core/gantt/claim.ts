// gantt claim: the git commit IS the lock. Claim = rewrite one ticket
// header + commit that one file; with a remote, push decides the race —
// the loser's commit is rolled back and it re-reads the gantt. Stale
// claims are surfaced, never auto-stolen: silent lock-theft under a wrong
// staleness guess corrupts a live session's work.

import { execFile } from "node:child_process";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Board, gantt, loadBoard, parseTicket, type Ticket } from "./store.ts";

const execFileP = promisify(execFile);
const n = globalThis as any;

export type ClaimResult =
	| { ok: true; ticket: Ticket }
	| { ok: false; reason: "taken" | "lost-race" | "not-found" | "no-commit" };

// git child processes are network/checkout work — they must never block the
// event loop. promisified execFile rejects on both non-zero exit (e.code is
// the numeric exit status) and spawn failure (e.code is a string like
// "ENOENT"); map either to a failing status so callers' === 0 / !== 0 tests
// keep working unchanged.
async function git(dir: string, ...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileP("git", ["-C", dir, ...args], { encoding: "utf8" });
		return { status: 0, stdout, stderr: stderr ?? "" };
	} catch (e: any) {
		return { status: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

async function hasUpstream(dir: string): Promise<boolean> {
	return (await git(dir, "rev-parse", "--abbrev-ref", "@{upstream}")).status === 0;
}

// rewrite header fields in place, preserving body and field order;
// value undefined removes the line, unknown keys append before the fence.
function setFields(text: string, patch: Record<string, string | undefined>): string {
	const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!m) throw new Error("missing --- header block");
	const pending = { ...patch };
	const lines = m[1].split("\n").flatMap((line) => {
		const kv = line.match(/^([\w-]+):/);
		if (!kv || !(kv[1] in pending)) return [line];
		const v = pending[kv[1]];
		delete pending[kv[1]];
		return v === undefined ? [] : [`${kv[1]}: ${v}`];
	});
	for (const [k, v] of Object.entries(pending)) if (v !== undefined) lines.push(`${k}: ${v}`);
	return `---\n${lines.join("\n")}\n---\n${m[2]}`;
}

function ticketPath(dir: string, id: string) {
	return join(dir, "tickets", `${id}.md`);
}

async function commitTicket(dir: string, id: string, msg: string): Promise<{ pushed: boolean; lost: boolean }> {
	// paths handed to git are relative to -C dir — a dir-prefixed path
	// would double-prefix whenever dir itself is relative
	const rel = `tickets/${id}.md`;
	const add = await git(dir, "add", rel);
	if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);
	const commit = await git(dir, "commit", "-m", msg, "--", rel);
	if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
	if (!(await hasUpstream(dir))) return { pushed: false, lost: false };
	if ((await git(dir, "push")).status === 0) return { pushed: true, lost: false };
	// origin moved. Rebase: clean (other files) → re-push and win; conflict
	// on our ticket file → a true race — drop our commit, resync to winner.
	if ((await git(dir, "pull", "--rebase")).status === 0 && (await git(dir, "push")).status === 0)
		return { pushed: true, lost: false };
	await git(dir, "rebase", "--abort");
	await git(dir, "reset", "--hard", "@{upstream}");
	return { pushed: false, lost: true };
}

// Write a header rewrite and commit it as one act.
//
// The commit IS the lock, so a commit that does not happen must not leave a
// lock on disk. Every failure path — a pre-commit hook that refuses, a
// read-only index, anything else commitTicket throws on — restores the file
// byte-for-byte, mtime included, and reports it. Without this an unwritable
// commit leaves an orphan half-claim: real to loadBoard, which reads files
// and not git; invisible to every other machine; wiped by the next git
// checkout. Two tickets on a downstream board wedged exactly that way, and
// neither claim mark was ever committed.
async function commitLock(dir: string, id: string, before: string, after: string, msg: string): Promise<ClaimResult> {
	const p = ticketPath(dir, id);
	// mtime is the claim's timestamp for staleClaims, so a refused commit
	// must not leave the ticket looking freshly touched either
	const { atime, mtime } = statSync(p);
	writeFileSync(p, after);
	let r: { pushed: boolean; lost: boolean };
	try {
		r = await commitTicket(dir, id, msg);
	} catch {
		writeFileSync(p, before);
		utimesSync(p, atime, mtime);
		return { ok: false, reason: "no-commit" };
	}
	// a lost race has already reset the worktree to the winner's commit
	if (r.lost) return { ok: false, reason: "lost-race" };
	return { ok: true, ticket: parseTicket(id, readFileSync(p, "utf8"), statSync(p).mtimeMs) };
}

// Atomic claim. A ticket has exactly one active owner. The committed owner
// is the duplicate-work guard shared by every pi session and the web board.
export async function claim(dir: string, id: string, session: string): Promise<ClaimResult> {
	const p = ticketPath(dir, id);
	let text: string;
	try {
		text = readFileSync(p, "utf8");
	} catch {
		return { ok: false, reason: "not-found" };
	}
	const t = parseTicket(id, text);
	if (t.state !== "open" && t.state !== "claimed") return { ok: false, reason: "taken" };
	if (t.claim) return { ok: false, reason: "taken" };
	const r = await commitLock(
		dir,
		id,
		text,
		setFields(text, { state: "claimed", claim: session }),
		`claim ${id}: ${session}`,
	);
	if (r.ok) {
		n.__kern
			?.storeDecision(`gantt: claimed ${id}`, `Ticket "${r.ticket.title}" claimed by ${session}`, 0.95, [
				`ticket: ${id}`,
				`session: ${session}`,
				`board: ${dir}`,
			])
			.catch(() => {});
	}
	return r;
}

// Release on close (done, default) or back to open (abandon). Closing and
// abandoning both clear the sole owner; no agent may retain a finished lock.
export async function release(
	dir: string,
	id: string,
	session: string,
	state: "done" | "open" = "done",
): Promise<ClaimResult> {
	const p = ticketPath(dir, id);
	let text: string;
	try {
		text = readFileSync(p, "utf8");
	} catch {
		return { ok: false, reason: "not-found" };
	}
	const t = parseTicket(id, text);
	if (t.claim && t.claim !== session) return { ok: false, reason: "taken" };
	const after = setFields(text, { state, claim: undefined });
	const r = await commitLock(dir, id, text, after, `${state === "done" ? "close" : "release"} ${id}: ${session}`);
	if (r.ok) {
		n.__kern
			?.storeDecision(
				`gantt: ${state} ${id}`,
				`Ticket "${r.ticket.title}" set to ${state} by ${session}`,
				state === "done" ? 0.95 : 0.85,
				[`ticket: ${id}`, `session: ${session}`, `state: ${state}`],
			)
			.catch(() => {});
	}
	return r;
}

// The board's own lock commits, which claim() and release() write and
// nothing else does. They name the ticket, so a message grep finds them —
// and they are the one thing that is definitely not progress on the work.
const LOCK_COMMIT = /^(claim|close|release) \S+:/;

// Has work naming this ticket landed since it was claimed?
//
// The ticket's own mtime is the claim's timestamp — claim() writes the file
// — so that is the window to search. Commits match on the full id and on
// the lane prefix ahead of the first dash, case-insensitively, because that
// is how an id actually reaches a subject line: the downstream commits for
// sl3-retention-bar read "(SL3)".
async function workSince(dir: string, t: Ticket): Promise<boolean> {
	const lane = t.id.split("-")[0];
	const r = await git(
		dir,
		"log",
		`--since=${new Date(t.mtimeMs).toISOString()}`,
		"--regexp-ignore-case",
		"--grep",
		t.id,
		"--grep",
		lane,
		"--format=%s",
	);
	// No git, no answer. A board outside a repo cannot hold a committed
	// claim in the first place — claim() fails with no-commit there — so this
	// only ever reports on a hand-written header, and reporting one is a
	// notification, never a theft.
	if (r.status !== 0) return false;
	return r.stdout.split("\n").some((s) => s.trim() !== "" && !LOCK_COMMIT.test(s.trim()));
}

// claimed tickets that look abandoned: held past thresholdMs with no
// committed work naming them since the claim.
//
// The threshold alone measures the wrong thing. A ticket's mtime moves on
// claim and on release and on nothing else, so it tracks lock churn rather
// than whether anyone is working — a session eight hours into a job never
// touches its ticket and reads as dead, and a session that died a minute
// after claiming reads as alive. Downstream that ranked a live ticket and
// an abandoned one identically, and a report written off it proposed
// releasing both; one of the two held ~997 lines of landed work. Commits
// are what separate them, and they are what a human checks by hand.
//
// Detection only, still: a lane whose work lands under some other name
// reads as abandoned here, which is why nothing auto-steals on this.
export async function staleClaims(board: Board, thresholdMs: number, now = Date.now()): Promise<Ticket[]> {
	const out: Ticket[] = [];
	for (const t of board.tickets.values()) {
		if (t.state === "claimed" && now - t.mtimeMs > thresholdMs && !(await workSince(board.dir, t))) out.push(t);
	}
	return out;
}

// What claimNext found.
//
// `unlocked` is a ticket the caller should still run. The lock could not be
// committed, so nothing marks it on the board and a second session could
// take it too — but a board whose commit path refuses is something to fix,
// not a reason to stop working. The failure rides along with the work as a
// signal instead of standing in front of it.
export type NextTicket = { kind: "claimed"; ticket: Ticket } | { kind: "unlocked"; ticket: Ticket } | { kind: "none" };

// Importance of a ready ticket = how much of the board it is standing in
// front of: the count of open tickets transitively blocked behind it. A
// serial worker taking one ticket at a time should always take the one
// whose closing unblocks the most, so the critical path drains first.
// Ties keep file order (the board's own alphabetical order), so ranking
// never reorders tickets that unblock nothing.
export function importance(board: Board): (a: Ticket, b: Ticket) => number {
	const kids = new Map<string, string[]>();
	for (const t of board.tickets.values()) {
		if (t.state !== "open") continue;
		for (const b of t.blockedBy) {
			const list = kids.get(b);
			if (list) list.push(t.id);
			else kids.set(b, [t.id]);
		}
	}
	const memo = new Map<string, number>();
	const behind = (id: string, seen: Set<string>): number => {
		const hit = memo.get(id);
		if (hit !== undefined) return hit;
		if (seen.has(id)) return 0; // dependency cycle — count each ticket once
		seen.add(id);
		const reach = new Set<string>();
		const walk = (from: string) => {
			for (const k of kids.get(from) ?? [])
				if (!reach.has(k)) {
					reach.add(k);
					walk(k);
				}
		};
		walk(id);
		memo.set(id, reach.size);
		return reach.size;
	};
	return (a, b) => behind(b.id, new Set()) - behind(a.id, new Set());
}

// convenience for the loop: claim the next matching gantt ticket,
// retrying past race losers until the gantt is empty. An optional `rank`
// orders the ready set per fresh board read before the first candidate is
// taken — the sort is stable, so unranked boards keep file order.
export async function claimNext(
	dir: string,
	session: string,
	pick: (t: Ticket) => boolean = () => true,
	rank?: (board: Board) => (a: Ticket, b: Ticket) => number,
): Promise<NextTicket> {
	for (;;) {
		const board = loadBoard(dir);
		if (!board) return { kind: "none" };
		const candidates = gantt(board).filter(pick);
		if (rank) candidates.sort(rank(board));
		if (candidates.length === 0) return { kind: "none" };
		const r = await claim(dir, candidates[0].id, session);
		if (r.ok) return { kind: "claimed", ticket: r.ticket };
		// A refused commit is the environment, not a race. commitLock puts the
		// ticket back exactly as it was, so it is still the first candidate and
		// retrying picks it again, forever — the rollback that fixed the orphan
		// half-claim is what makes this loop non-terminating. Hand the ticket
		// back unlocked and let the caller report the board, not hang on it.
		if (r.reason === "no-commit") return { kind: "unlocked", ticket: candidates[0] };
		// taken or lost-race: board changed under us — re-read, next ticket
	}
}
