// The wire. Every message this deck sends between two things — two pi
// sessions, a browser drop, a web dashboard question — is a file in one
// directory, and this file is the only code that writes or reads it.
//
// Sorted directory, no daemon, no socket. Filenames are ISO stamps, so
// lexical order IS arrival order, and a per-reader cursor file is the whole
// delivery protocol: read once, never twice.
//
// The channel lives outside the repo (XDG state, keyed by repo root), so
// chatter can never land in a commit and no .gitignore is needed to hide it.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Who a message is for: one session id, or one scope. There is no everyone. */
export type Addr = string;

/** What a message is. Plain talk unless something structured needs a lane. */
export type Kind = "say" | "ask" | "answer" | "drop" | "question" | "reconcile" | "resolution";

export type Message = {
	file: string;
	to: Addr;
	from: string;
	kind: Kind;
	re?: string;
	urgent: boolean;
	text: string;
};

export type Post = {
	to: Addr;
	from: string;
	text: string;
	kind?: Kind;
	re?: string;
	urgent?: boolean;
};

const KINDS: Kind[] = ["say", "ask", "answer", "drop", "question", "reconcile", "resolution"];

export function stateRoot(): string {
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi", "walkie-talkie");
}

/** One channel per repo. The slug keeps two checkouts of the same project apart. */
export function slug(repo: string): string {
	return (
		repo
			.replace(/^\/+/, "")
			.replace(/[^\w.-]+/g, "-")
			.slice(-80) || "root"
	);
}

export function channelDir(repo: string): string {
	return join(stateRoot(), slug(repo));
}

export function mailDir(repo: string): string {
	return join(channelDir(repo), "mail");
}

export function ensureChannel(repo: string): string {
	const m = mailDir(repo);
	mkdirSync(m, { recursive: true });
	return m;
}

const stamp = (now: number) => new Date(now).toISOString().replace(/[:.]/g, "-");

export function post(repo: string, msg: Post, now = Date.now()): string {
	// There is no broadcast address. Every message names one session or one
	// scope, because a message nobody chose to receive is a message every session
	// stops to reconcile — the noise that made this channel unusable. Reject it at
	// the wire, the only chokepoint that sees every send (the maildir lives in XDG
	// state outside the repo, so a .preventions shell guard cannot see it).
	const to = (msg.to ?? "").trim();
	if (!to || to === "all") {
		throw new Error(
			"crew: there is no broadcast address — address one session id or one scope. " +
				"If several sessions need this, they are a group: have them join a scope and send to that. " +
				"See the deck skill (skills/deck.md).",
		);
	}
	const m = ensureChannel(repo);
	const head = [`to: ${to}`, `from: ${msg.from}`, `kind: ${msg.kind ?? "say"}`];
	if (msg.re) head.push(`re: ${msg.re}`);
	if (msg.urgent) head.push("urgent: true");
	const body = `---\n${head.join("\n")}\n---\n\n${msg.text.trim()}\n`;
	// Filenames must sort in creation order, because `drain` keeps a single
	// lexical high-water-mark cursor: any newer file must be lexically greater or
	// it is skipped and lost. A random suffix breaks that within one millisecond
	// — two posts share the stamp and order by chance, so a same-ms message with a
	// smaller suffix falls below the cursor and never delivers. Claim the next
	// free sequence instead, with an exclusive create: a lower seq was only free
	// earlier, so `${stamp}-${seq}` is strictly monotonic across posters.
	const base = stamp(now);
	for (let seq = 0; ; seq++) {
		const file = `${base}-${seq.toString().padStart(4, "0")}.md`;
		try {
			writeFileSync(join(m, file), body, { flag: "wx" });
			return file;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
	}
}

export function parseMessage(file: string, text: string): Message {
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	const head: Record<string, string> = {};
	for (const line of (m?.[1] ?? "").split("\n")) {
		const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim());
		if (kv) head[kv[1]] = kv[2].trim();
	}
	const kind = KINDS.includes(head.kind as Kind) ? (head.kind as Kind) : "say";
	return {
		file,
		to: head.to ?? "",
		from: head.from ?? "unknown",
		kind,
		re: head.re || undefined,
		urgent: head.urgent === "true",
		text: text.slice(m?.[0].length ?? 0).trim(),
	};
}

const cursorPath = (repo: string, reader: string) => join(mailDir(repo), `.read-${reader}`);

/**
 * Everything addressed to `reader` that arrived after its last drain.
 * `reader` is a session id or a role — both are just addresses.
 * `addrs` widens the match when one reader answers to several names
 * (a session that is also the `work` role, say).
 */
export function drain(repo: string, reader: string, addrs: string[] = []): Message[] {
	const m = mailDir(repo);
	if (!existsSync(m)) return [];
	let last = "";
	try {
		last = readFileSync(cursorPath(repo, reader), "utf8").trim();
	} catch {
		/* first drain */
	}
	const files = readdirSync(m)
		.filter((f) => f.endsWith(".md") && f > last)
		.sort();
	if (!files.length) return [];
	writeFileSync(cursorPath(repo, reader), `${files[files.length - 1]}\n`);
	// No wildcard in the match set: a message is delivered to the addresses it
	// names, and nothing is addressed to everyone.
	const mine = new Set([reader, ...addrs]);
	return files.map((f) => parseMessage(f, readFileSync(join(m, f), "utf8"))).filter((x) => mine.has(x.to));
}

/**
 * Advance the cursor without delivering — past chatter is not a trigger.
 * Only the newest filename matters, so no message body is opened: routing this
 * through drain() read and parsed the entire backlog just to throw it away
 * (32ms on a 5000-message channel, measured).
 */
export function adopt(repo: string, reader: string): void {
	const m = mailDir(repo);
	if (!existsSync(m)) return;
	const files = readdirSync(m)
		.filter((f) => f.endsWith(".md"))
		.sort();
	if (!files.length) return;
	writeFileSync(cursorPath(repo, reader), `${files[files.length - 1]}\n`);
}

export function dropCursor(repo: string, reader: string): void {
	try {
		unlinkSync(cursorPath(repo, reader));
	} catch {
		/* never drained */
	}
}

/** Delete messages older than `maxAgeMs`. The channel is chatter, not an archive. */
export function sweep(repo: string, maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()): number {
	const m = mailDir(repo);
	if (!existsSync(m)) return 0;
	const cut = stamp(now - maxAgeMs);
	let n = 0;
	for (const f of readdirSync(m)) {
		if (!f.endsWith(".md") || f >= cut) continue;
		try {
			unlinkSync(join(m, f));
			n++;
		} catch {
			/* raced */
		}
	}
	return n;
}

export function renderInbox(msgs: Message[], me: string): string {
	if (!msgs.length) return "";
	const one = (x: Message) => {
		const tags = [x.from, x.re ? `re ${x.re}` : "", x.urgent ? "urgent" : ""].filter(Boolean);
		return `- [${tags.join(", ")}]\n  ${x.text.split("\n").join("\n  ")}`;
	};
	return [
		`# Walkie-talkie — ${msgs.length} for ${me}`,
		"",
		"Incoming from another session. Act on this BEFORE continuing:",
		"",
		...msgs.map(one),
		"",
	].join("\n");
}
