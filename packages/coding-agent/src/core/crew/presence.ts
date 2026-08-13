// Who is on the channel, and what each of them is doing. A session writes one
// JSON file while it lives and touches it on a heartbeat; a reader treats
// anything older than STALE_MS as gone and reaps it. That is the whole
// discovery protocol — no registry process, no lock, and a crashed session
// cleans itself up by going quiet.
//
// A peer carries more than its identity; these fields are what make the deck
// legible to itself:
//
//   scopes — every name this session answers to besides its id. A scope is a
//            group address: join `auth-rewrite` and mail to `auth-rewrite`
//            reaches you and everyone else who joined it. Membership is a set,
//            not a slot, so one session is in as many groups as it has jobs.
//   doing  — one line of what it is working on right now, so `crew_list` answers
//            "what is everyone up to" instead of just "who is here".
//   state  — working (mid-turn) or idle (settled, waiting).
//   messageCount — session size, a proxy for how much context it holds.
//   mission/task/next — parsed from the session's last `<recap>` block, so a
//            peer can see the goal, current task and next step at a glance.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { channelDir, dropCursor } from "./channel.ts";

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;

export type Peer = {
	sessionId: string;
	pid: number;
	cwd: string;
	/** every group address this session answers to */
	scopes: string[];
	/** display name, when the session has one (session_info) */
	name?: string;
	/** one line: what this session is working on right now */
	doing?: string;
	/** live activity: working (mid-turn) or idle (settled, waiting) */
	state?: "working" | "idle";
	/** session size — number of messages, a proxy for how much context it holds */
	messageCount?: number;
	/** when it last actually did something (turn or settle); falls back to lastHeartbeat */
	lastActivity?: string;
	/** recap parsed from the session's last assistant message */
	mission?: string;
	task?: string;
	next?: string;
	startedAt: string;
	lastHeartbeat: string;
};

export function activeDir(repo: string): string {
	return join(channelDir(repo), "active");
}

export function announce(repo: string, peer: Peer): string {
	const d = activeDir(repo);
	mkdirSync(d, { recursive: true });
	const f = join(d, `${peer.sessionId}.json`);
	writeFileSync(f, JSON.stringify(peer, null, 2));
	return f;
}

export function leave(repo: string, sessionId: string): void {
	try {
		unlinkSync(join(activeDir(repo), `${sessionId}.json`));
	} catch {
		/* never announced */
	}
	dropCursor(repo, sessionId);
}

/** Everyone whose heartbeat is fresh. Stale files are reaped on the way past. */
export function peers(repo: string, now = Date.now()): Peer[] {
	const d = activeDir(repo);
	if (!existsSync(d)) return [];
	const out: Peer[] = [];
	for (const f of readdirSync(d)) {
		if (!f.endsWith(".json")) continue;
		try {
			const p = JSON.parse(readFileSync(join(d, f), "utf8")) as Peer;
			if (now - new Date(p.lastHeartbeat).getTime() < STALE_MS) out.push({ ...p, scopes: p.scopes ?? [] });
			else unlinkSync(join(d, f));
		} catch {
			/* corrupt or raced — skip */
		}
	}
	return out.sort((a, b) => hotness(b, now) - hotness(a, now) || a.sessionId.localeCompare(b.sessionId));
}

/**
 * How "hot" a session is — one score that orders the session list by what a
 * reader most wants to see first. Four clamped signals, added together:
 *
 *   recency (0–100) — last activity as a fraction of STALE_MS; freshest = 100.
 *   state   (0–40)  — actively working (+40) vs settled (0).
 *   size    (0–20)  — messageCount / 200, capped; a bigger session holds more
 *                     context a peer has to reconcile.
 *   breadth (0–10)  — scopes.length / 4, capped; many groups = more central.
 */
export function hotness(p: Peer, now = Date.now()): number {
	const activity = new Date(p.lastActivity ?? p.lastHeartbeat ?? p.startedAt).getTime();
	const ageMs = Number.isNaN(activity) ? STALE_MS : Math.max(0, now - activity);
	const recency = Math.max(0, 1 - ageMs / STALE_MS) * 100;
	const working = p.state === "working" ? 40 : 0;
	const size = Math.min((p.messageCount ?? 0) / 200, 1) * 20;
	const breadth = Math.min((p.scopes?.length ?? 0) / 4, 1) * 10;
	return recency + working + size + breadth;
}

/**
 * Pull MISSION/TASK/NEXT out of a `<recap>` block, if the session's last
 * message carried one. Case-insensitive; a value that is only an angle-bracket
 * placeholder (the template's `<one short sentence …>`) is dropped.
 */
export function parseRecap(text: string): { mission?: string; task?: string; next?: string } {
	const block = text.match(/<recap>([\s\S]*?)<\/recap>/i);
	if (!block) return {};
	const out: { mission?: string; task?: string; next?: string } = {};
	for (const line of block[1].split("\n")) {
		const m = line.match(/^\s*(MISSION|TASK|NEXT)\s*:\s*(.*?)\s*$/i);
		if (!m) continue;
		const value = m[2].replace(/^(?:<[^>]*>\s*)+/, "").trim();
		if (!value) continue;
		out[m[1].toLowerCase() as "mission" | "task" | "next"] = value;
	}
	return out;
}

/**
 * Resolve a user-typed target to real addresses. Two ranges, in the order a
 * sender means them: one session (id prefix) or one group (scope). There is no
 * third range — `all` resolves to nothing, because an unaddressed update is
 * what every other session has to stop and reconcile.
 */
export function resolve(repo: string, target: string, now = Date.now()): string[] {
	if (target === "all") return [];
	const all = peers(repo, now);
	const byId = all.filter((p) => p.sessionId.startsWith(target));
	if (byId.length) return byId.map((p) => p.sessionId);
	const byScope = all.filter((p) => p.scopes.includes(target));
	if (byScope.length) return byScope.map((p) => p.sessionId);
	return [];
}

/** Every scope with a live member, and who is in it. */
export function scopes(repo: string, now = Date.now()): Map<string, Peer[]> {
	const out = new Map<string, Peer[]>();
	for (const p of peers(repo, now)) {
		for (const s of p.scopes) {
			const list = out.get(s);
			if (list) list.push(p);
			else out.set(s, [p]);
		}
	}
	return out;
}

// Twelve, not eight. Eight was enough when every session id was a random uuid;
// a crew child's id is `crew-<handle>-<hex>`, and two of them truncate to the
// same `crew-sco`. Resolution is still by prefix, so a longer label costs
// nothing and a reader can tell two subagents apart.
const short = (id: string) => id.slice(0, 12);

/** Human age since a peer last did something — "now", "3m", "2h", "5d". */
function ageLabel(ms: number): string {
	if (ms < 45_000) return "now";
	if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
	return `${Math.round(ms / (24 * 60 * 60_000))}d`;
}

/** The name a reader sees: the session's own name, or auto-derived from its recap (task > mission), or its id prefix. */
export function displayName(p: Peer): string {
	if (p.name?.trim()) return p.name.trim();
	const derived = p.task?.trim() || p.mission?.trim();
	if (derived) return derived.length > 50 ? `${derived.slice(0, 47)}…` : derived;
	return short(p.sessionId);
}

export function renderPeers(list: Peer[], me: string, now = Date.now()): string {
	if (!list.length) return "no other sessions on the channel";
	const ranked = [...list].sort((a, b) => hotness(b, now) - hotness(a, now) || a.sessionId.localeCompare(b.sessionId));
	const lines: string[] = [`channel has ${ranked.length} session${ranked.length > 1 ? "s" : ""}, hottest first:`];
	ranked.forEach((p, i) => {
		const activity = new Date(p.lastActivity ?? p.lastHeartbeat ?? p.startedAt).getTime();
		const age = Number.isNaN(activity) ? "?" : ageLabel(Math.max(0, now - activity));
		const mark = p.sessionId === me ? " (you)" : "";
		const label = displayName(p);
		const hasUserName = !!p.name?.trim();
		const msgs = `${p.messageCount ?? 0} msgs`;
		const state = p.state === "working" ? "working" : "idle";
		const scopes = (p.scopes ?? []).length ? p.scopes.join(",") : "-";
		lines.push(`${i + 1}. ${label}${mark}  ${state}  ${msgs}  ${age}  [${scopes}]  ${p.cwd}`);
		if (p.doing) lines.push(`   doing: ${p.doing}`);
		// Skip mission/task lines when the auto-label already shows them.
		if (p.mission && (!hasUserName || label !== p.mission.trim())) lines.push(`   mission: ${p.mission}`);
		if (p.task && (!hasUserName || label !== p.task.trim())) lines.push(`   task: ${p.task}`);
		if (p.next) lines.push(`   next: ${p.next}`);
	});
	return lines.join("\n");
}

/** The groups on this channel, for an agent deciding where to send something. */
export function renderScopes(repo: string, now = Date.now()): string {
	const map = scopes(repo, now);
	if (!map.size) return "no scopes on the channel — every session is only reachable by id";
	return [...map]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(
			([name, members]) =>
				`${name}  ${members.length} member${members.length > 1 ? "s" : ""}  ${members.map((m) => short(m.sessionId)).join(" ")}`,
		)
		.join("\n");
}
