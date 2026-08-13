// reflex/surface.ts — the measured half of the tool band: what the surface
// actually got used for.
//
// Ported from the reflex extension. The band (core/tools/band.ts) withholds
// schema from tools the model is not going to use; that policy is STATIC —
// hardcoded HOT_TOOLS, everything else deferred. This ledger is the feedback
// loop the band is missing:
//
//   - every tool fire is counted (per session, flushed on shutdown)
//   - one cold tool is drawn per session and the agent is asked to rate it:
//     `useful` (should have been reached and was not — the verdict carries the
//     missing trigger line), `situational` (correct to sit idle), `dead`
//   - verdicts OUTRANK the band: a `useful` tool is exempted from deferral, a
//     `dead`/`situational` one stays banded whatever its registration said
//   - a rare tool that fires >= PROMOTE_AT times is mislabelled — promoted
//   - names no longer registered are retired (history preserved, out of live
//     paths) and restored intact if they come back
//
// State is machine-local (the user's usage habits span repos), at
// <XDG_STATE_HOME>/pi/reflex/surface.json — same home as search-guard.log.
// Derived views (promotable / verdictBanded / exempt / triggers) are computed
// at read time, never written.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type VerdictKind = "useful" | "situational" | "dead";

export interface Verdict {
	verdict: VerdictKind;
	reason: string;
	at: string; // YYYY-MM-DD
}

export type Evaluation = { name: string; uses: number };

interface Retired {
	count?: number;
	verdict?: Verdict;
	trigger?: string;
	at: string;
}

interface State {
	counts: Record<string, number>;
	verdicts: Record<string, Verdict>;
	/** learned `situation → tool` lines from `useful` verdicts */
	triggers: Record<string, string>;
	retired: Record<string, Retired>;
}

/** A rare tool that fires this often is not rare — it is mislabelled. */
export const PROMOTE_AT = 3;
/** A verdict this old is stale: the surface moved, ask again. */
export const VERDICT_TTL_DAYS = 30;

// Lazy on purpose: tests set XDG_STATE_HOME to a temp dir before first call.
export function statePath(): string {
	return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "pi", "reflex", "surface.json");
}

const uses = new Map<string, number>(); // fires this session
let drawn: Evaluation | null = null;

function load(): State {
	try {
		const raw = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<State>;
		return {
			counts: raw?.counts ?? {},
			verdicts: raw?.verdicts ?? {},
			triggers: raw?.triggers ?? {},
			retired: raw?.retired ?? {},
		};
	} catch {
		return { counts: {}, verdicts: {}, triggers: {}, retired: {} };
	}
}

function save(next: State): void {
	try {
		mkdirSync(dirname(statePath()), { recursive: true });
		writeFileSync(statePath(), JSON.stringify(next, null, "\t"));
	} catch {
		/* counting is best-effort; never break a session over it */
	}
}

/** Record a tool fire for this session (flushed by flush()). */
export function recordUse(name: string): void {
	uses.set(name, (uses.get(name) ?? 0) + 1);
}

/** Persist the session's counts. */
export function flush(): void {
	if (uses.size === 0) return;
	const state = load();
	for (const [name, n] of uses) state.counts[name] = (state.counts[name] ?? 0) + n;
	save(state);
	uses.clear();
}

export function reset(): void {
	drawn = null;
	uses.clear();
}

/** Counts on disk plus this session's, so a report never lags its own turn. */
export function totals(): Record<string, number> {
	const all = { ...load().counts };
	for (const [name, n] of uses) all[name] = (all[name] ?? 0) + n;
	return all;
}

/**
 * Names no longer registered move to `retired` — out of every live path, and
 * restored intact if the name comes back, so a smaller surface cannot destroy
 * the history.
 */
export function prune(known: string[]): { retired: string[]; revived: string[] } {
	const out = { retired: [] as string[], revived: [] as string[] };
	if (!known.length) return out; // no surface to judge against — never guess
	const live = new Set(known);
	const state = load();

	for (const name of Object.keys(state.counts)) {
		if (live.has(name)) continue;
		const prior = state.retired[name];
		state.retired[name] = {
			count: (prior?.count ?? 0) + state.counts[name],
			verdict: state.verdicts[name] ?? prior?.verdict,
			trigger: state.triggers[name] ?? prior?.trigger,
			at: new Date().toISOString().slice(0, 10),
		};
		delete state.counts[name];
		delete state.verdicts[name];
		delete state.triggers[name];
		out.retired.push(name);
	}
	for (const name of Object.keys(state.verdicts))
		if (!live.has(name)) {
			state.retired[name] = {
				...(state.retired[name] ?? {}),
				verdict: state.verdicts[name],
				trigger: state.triggers[name],
				at: new Date().toISOString().slice(0, 10),
			};
			delete state.verdicts[name];
			delete state.triggers[name];
			out.retired.push(name);
		}

	for (const [name, row] of Object.entries(state.retired)) {
		if (!live.has(name)) continue;
		if (row.count) state.counts[name] = (state.counts[name] ?? 0) + row.count;
		if (row.verdict) state.verdicts[name] ??= row.verdict;
		if (row.trigger) state.triggers[name] ??= row.trigger;
		delete state.retired[name];
		out.revived.push(name);
	}

	if (out.retired.length || out.revived.length) save(state);
	return out;
}

/**
 * The cold half of the table, drawn at random, one per session. An unreached
 * tool is an unobserved tool — its row sits at "no signal yet" forever unless
 * something deliberately points at it, and a new tool has no count so it sorts
 * coldest and enters the rotation by construction.
 */
export function draw(names: string[]): Evaluation | null {
	drawn = null;
	if (!names.length) return null;
	const state = load();
	const fresh = Date.now() - VERDICT_TTL_DAYS * 86400_000;
	const eligible = names.filter((n) => {
		const v = state.verdicts[n];
		if (!v) return true;
		const at = Date.parse(v.at);
		return Number.isFinite(at) ? at < fresh : true;
	});
	if (!eligible.length) return null;
	const scored = eligible.map((n) => ({ name: n, uses: state.counts[n] ?? 0 })).sort((a, b) => a.uses - b.uses);
	const cold = scored.slice(0, Math.max(1, Math.ceil(scored.length / 2)));
	drawn = cold[Math.floor(Math.random() * cold.length)] ?? null;
	return drawn;
}

export function evaluation(): Evaluation | null {
	return drawn;
}

/**
 * A `useful` verdict says the tool should have been reached and was not — a
 * statement about the TRIGGER, not the tool, so the trigger is required there
 * and recorded in the moment, or lost. Every rating is also stored in kern as
 * a decision so future sessions see the pattern without re-deriving it.
 */
export function rate(name: string, verdict: string, reason: string, trigger?: string): string {
	const ok: VerdictKind[] = ["useful", "situational", "dead"];
	if (!ok.includes(verdict as VerdictKind)) return `reflex: verdict must be one of ${ok.join(" | ")}`;
	if (verdict === "useful" && !trigger?.trim())
		return "reflex: a `useful` verdict needs `trigger` — the situation line that should have fired it, e.g. 'unfamiliar repo, need the big picture: crawl_status'";

	const state = load();
	state.verdicts[name] = {
		verdict: verdict as VerdictKind,
		reason,
		at: new Date().toISOString().slice(0, 10),
	};
	if (verdict === "useful" && trigger) state.triggers[name] = trigger.trim();
	if (verdict === "dead") delete state.triggers[name];
	save(state);
	if (drawn?.name === name) drawn = null;

	const conf = verdict === "useful" ? 0.95 : verdict === "situational" ? 0.85 : 0.75;
	const extra = [`tool: ${name}`, `verdict: ${verdict}`, `reason: ${reason}`];
	if (trigger) extra.push(`trigger: ${trigger}`);
	const kern = (globalThis as any).__kern;
	kern
		?.storeDecision?.(`reflex: ${verdict} ${name}`, `Tool "${name}" rated ${verdict} — ${reason}`, conf, extra)
		.catch(() => {});

	const next =
		verdict === "useful"
			? "trigger recorded — it ships in the reflex block from the next session"
			: verdict === "dead"
				? "candidate for deletion from the surface"
				: "stays banded; correct to sit idle";
	return `reflex: ${name} rated ${verdict} — ${next}`;
}

/** Learned trigger lines, newest last. These ship beside the band one-liners. */
export function learnedTriggers(): string[] {
	return Object.values(load().triggers).filter(Boolean);
}

/** A banded tool that keeps getting used is mislabelled — the count is the evidence. */
export function promotable(rare: Set<string>): string[] {
	return Object.entries(totals())
		.filter(([name, n]) => rare.has(name) && n >= PROMOTE_AT)
		.sort((a, b) => b[1] - a[1])
		.map(([name, n]) => `${name} (${n})`);
}

/** Tools a verdict says are idle — banded whatever the seed row says. */
export function verdictBanded(): string[] {
	return Object.entries(load().verdicts)
		.filter(([, v]) => v.verdict === "situational" || v.verdict === "dead")
		.map(([name]) => name);
}

/** Evidence that outranks the band: useful verdicts + tools that fired enough. */
export function exempt(band: Set<string>): string[] {
	const state = load();
	const out = Object.entries(state.verdicts)
		.filter(([, v]) => v.verdict === "useful")
		.map(([name]) => name);
	const counts = totals();
	for (const name of band) if ((counts[name] ?? 0) >= PROMOTE_AT) out.push(name);
	return out;
}

/** Counts say what got used; verdicts say why the rest did not. */
export function rated(): string[] {
	return Object.entries(load().verdicts)
		.sort((a, b) => (a[1].at < b[1].at ? 1 : -1))
		.slice(0, 8)
		.map(([name, v]) => `${name}: ${v.verdict} (${v.at}) ${v.reason}`.trim());
}

/** True when the reflex surface arms are disabled (A/B, or a bare session). */
export function reflexDisabled(): boolean {
	return process.env.PI_REFLEX_OFF === "1" || process.env.PI_REFLEX_OFF === "true";
}

// ── band override ──────────────────────────────────────────────────────────

/**
 * Apply the band policy, then let the ledger override it: verdicts and counts
 * outrank the static policy (a `useful` tool is exempted from deferral, a
 * `dead`/`situational` one is forced deferred, a rare tool with >= PROMOTE_AT
 * fires is promoted). Hot builtins (rare === undefined) are never touched.
 */
export function surfaceAwareBand<T extends { name: string; rare?: boolean }>(tool: T): T {
	if (reflexDisabled()) return tool;
	if (tool.rare === undefined) return tool; // hot builtin / explicit always-hot
	const name = tool.name;
	const state = load();
	const v = state.verdicts[name];
	if (v?.verdict === "useful") return { ...tool, rare: false };
	if (v && (v.verdict === "situational" || v.verdict === "dead")) return { ...tool, rare: true };
	if ((totals()[name] ?? 0) >= PROMOTE_AT) return { ...tool, rare: false };
	return tool;
}
