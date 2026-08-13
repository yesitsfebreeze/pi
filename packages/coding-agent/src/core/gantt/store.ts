// gantt store: parse .pi/gantt/ (map.md + tickets/*.md) into one typed
// model and compute every derived view. Nothing here writes to disk —
// single representation, that rule is the product.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

let _ganttRoot: string | null = null;
export function setGanttRoot(root: string): void {
	_ganttRoot = root;
}
export function dir(): string {
	return join(_ganttRoot || ".", ".pi", "gantt");
}

export type Kind = "decision" | "research" | "build";
export type State = "open" | "claimed" | "done" | "out-of-scope";
export type Mode = "hitl" | "afk";

export type Ticket = {
	id: string;
	kind: Kind;
	state: State;
	mode: Mode;
	blockedBy: string[];
	est?: number;
	/** Single active owner. A ticket is never dispatched twice. */
	claim?: string;
	verify?: string;
	title: string;
	body: string;
	mtimeMs: number;
};

export type BoardMap = {
	destination: string;
	notes: string;
	outOfScope: string;
	fog: string;
};

export type Board = {
	dir: string;
	map: BoardMap;
	tickets: Map<string, Ticket>;
};

const KINDS = new Set(["decision", "research", "build"]);
const STATES = new Set(["open", "claimed", "done", "out-of-scope"]);
const MODES = new Set(["hitl", "afk"]);

function parseMap(text: string): BoardMap {
	const sections: Record<string, string> = {};
	let current = "";
	for (const line of text.split("\n")) {
		// A heading is keyed by its first word-run only: boards write
		// `## Destination — Phase 4`, and an exact-title match reads that as a
		// section nobody asks for, so the page renders "no destination".
		const h = line.match(/^##\s+(.+?)\s*$/);
		if (h) {
			current = h[1]
				.split(/\s+[—–-]\s+|:/)[0]
				.trim()
				.toLowerCase();
			sections[current] = "";
			continue;
		}
		if (current) sections[current] += `${line}\n`;
	}
	const grab = (k: string) => (sections[k] ?? "").trim();
	return {
		destination: grab("destination"),
		notes: grab("notes"),
		outOfScope: grab("out of scope"),
		fog: grab("fog"),
	};
}

export function parseTicket(id: string, text: string, mtimeMs = 0): Ticket {
	const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!m) throw new Error(`ticket ${id}: missing --- header block`);
	const fields: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		if (!line.trim()) continue;
		const kv = line.match(/^([\w-]+):\s*(.*?)\s*(?:#.*)?$/);
		if (!kv) throw new Error(`ticket ${id}: bad header line "${line}"`);
		fields[kv[1]] = kv[2].trim();
	}
	const kind = fields.kind,
		state = fields.state,
		mode = fields.mode;
	if (!KINDS.has(kind))
		throw new Error(
			`ticket ${id}: kind "${kind}" (allowed: decision|research|build; use kind: build with verify: <command> for verification work)`,
		);
	if (!STATES.has(state)) throw new Error(`ticket ${id}: state "${state}" (allowed: open|claimed|done|out-of-scope)`);
	if (!MODES.has(mode)) throw new Error(`ticket ${id}: mode "${mode}"`);
	let est: number | undefined;
	if (fields.est) {
		const e = fields.est.match(/^(\d+(?:\.\d+)?)d$/);
		if (!e) throw new Error(`ticket ${id}: est "${fields.est}" (want <n>d)`);
		est = Number(e[1]);
	}
	const body = m[2].trim();
	const title = (body.split("\n").find((l) => l.trim()) ?? id).replace(/^#+\s*/, "").trim();
	return {
		id,
		kind: kind as Kind,
		state: state as State,
		mode: mode as Mode,
		blockedBy: fields["blocked-by"]
			? fields["blocked-by"]
					.replace(/^\[|\]$/g, "")
					.split(/[\s,]+/)
					.filter(Boolean)
			: [],
		est,
		claim: fields.claim || undefined,
		verify: fields.verify || undefined,
		title,
		body,
		mtimeMs,
	};
}

// dir = the .pi/gantt/ directory itself. Absent → null (extension goes inert).
export function loadBoard(dir: string): Board | null {
	if (!existsSync(dir)) return null;
	const mapPath = join(dir, "map.md");
	const map = parseMap(existsSync(mapPath) ? readFileSync(mapPath, "utf8") : "");
	const tickets = new Map<string, Ticket>();
	const tdir = join(dir, "tickets");
	if (existsSync(tdir)) {
		for (const f of readdirSync(tdir)
			.filter((f) => f.endsWith(".md"))
			.sort()) {
			const p = join(tdir, f);
			tickets.set(basename(f, ".md"), parseTicket(basename(f, ".md"), readFileSync(p, "utf8"), statSync(p).mtimeMs));
		}
	}
	for (const t of tickets.values())
		for (const b of t.blockedBy) if (!tickets.has(b)) throw new Error(`ticket ${t.id}: unknown blocked-by "${b}"`);
	return { dir, map, tickets };
}

// resolved = no longer gates dependents: done, or deliberately cut.
// Named `resolved` not `closed` because `closed` collides with the prose
// word for board-level state and invites writing `state: closed` in tickets
// (which is not a valid State literal).
const resolved = (t: Ticket) => t.state === "done" || t.state === "out-of-scope";

// gantt: open ∧ every blocker resolved ∧ unclaimed. The work surface.
export function gantt(board: Board): Ticket[] {
	return [...board.tickets.values()].filter(
		(t) => t.state === "open" && !t.claim && t.blockedBy.every((b) => resolved(board.tickets.get(b)!)),
	);
}

export type Cursor = { done: number; total: number; ready: string[]; waiting: string[] };

// cursor: done/total (out-of-scope excluded from both), ready = gantt
// ids, waiting = open hitl tickets on the gantt (surfaced, never dispatched).
export function cursor(board: Board): Cursor {
	const counted = [...board.tickets.values()].filter((t) => t.state !== "out-of-scope");
	const front = gantt(board);
	return {
		done: counted.filter((t) => t.state === "done").length,
		total: counted.length,
		ready: front.map((t) => t.id),
		waiting: front.filter((t) => t.mode === "hitl").map((t) => t.id),
	};
}

export type Decision = { id: string; title: string; body: string };

// decisions-so-far: closed decision tickets, oldest first (newest last).
export function decisions(board: Board): Decision[] {
	return [...board.tickets.values()]
		.filter((t) => t.kind === "decision" && t.state === "done")
		.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id))
		.map((t) => ({ id: t.id, title: t.title, body: t.body }));
}
