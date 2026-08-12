// until — loop surface: goal mode + schedule mode + pace loops.
// Wired directly into AgentSession; no extension layer.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "../core/extensions/types.ts";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "until-config.json");
const DONE_MARKER = "[UNTIL: DONE]";

// ─── pace config ─────────────────────────────────────────────────────

interface PaceConfig {
	ledger: string;
	verify: string | null;
	boxMinutes: number;
	editMinutes: number;
	label: string;
}

const DEFAULT_PACE: PaceConfig = {
	ledger: "PACE.md",
	verify: null,
	boxMinutes: 15,
	editMinutes: 10,
	label: "loop",
};

export interface UntilConfig {
	triggerWord: string;
	maxIterations: number;
}

// ─── schedule loop types ──────────────────────────────────────────────

interface LoopState {
	id: string;
	kind: "sleep" | "cron";
	spec: string;
	seconds?: number;
	cron?: string[];
	message: string;
	status: "active" | "stopped";
	count: number;
	started: string;
	nextFire?: string;
	lastFire?: string;
	firstFireAt?: string;
	autoSeconds?: number;
}

interface Timer {
	state: LoopState;
	handle: ReturnType<typeof setTimeout>;
}

// ─── cron helpers ─────────────────────────────────────────────────────

const CRON_ALIAS: Record<string, string> = {
	"@hourly": "0 * * * *",
	"@daily": "0 0 * * *",
	"@weekly": "0 0 * * * 0",
	"@monthly": "0 0 1 * *",
	"@yearly": "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
};

function parseDuration(spec: string): number | null {
	const m = /^(\d+)(ms|s|m|h)?$/.exec(spec.trim());
	if (!m) return null;
	const n = Number(m[1]);
	switch (m[2] ?? "s") {
		case "ms":
			return n;
		case "s":
			return n * 1000;
		case "m":
			return n * 60_000;
		default:
			return n * 3_600_000;
	}
}

function parseSchedule(spec: string): { kind: "sleep"; seconds: number } | { kind: "cron"; cron: string[] } {
	spec = spec.trim();
	if (spec in CRON_ALIAS) return { kind: "cron", cron: CRON_ALIAS[spec].split(" ") };
	if (spec.startsWith("@every ")) {
		const ms = parseDuration(spec.slice("@every ".length));
		if (ms === null) throw new Error(`bad duration: ${spec.slice("@every ".length)}`);
		return { kind: "sleep", seconds: ms / 1000 };
	}
	if (spec.startsWith("@")) throw new Error(`unknown alias: ${spec}`);
	const spaces = [...spec].filter((c) => c.trim() === "").length;
	if (spaces >= 4 && /[*/-]/.test(spec)) {
		const parts = spec.split(/\s+/);
		if (parts.length === 5) return { kind: "cron", cron: parts };
	}
	const ms = parseDuration(spec);
	if (ms === null) throw new Error(`bad duration: ${spec}`);
	return { kind: "sleep", seconds: ms / 1000 };
}

function field(part: string, lo: number, hi: number): Set<number> {
	const vals = new Set<number>();
	for (const token of part.split(",")) {
		let base = token;
		let step = 1;
		if (token.includes("/")) {
			const [b2, s2] = token.split("/");
			base = b2;
			step = parseInt(s2, 10);
		}
		let a: number, b: number;
		if (base === "*") [a, b] = [lo, hi];
		else if (base.includes("-")) [a, b] = base.split("-").map((x) => parseInt(x, 10)) as [number, number];
		else a = b = parseInt(base, 10);
		for (let v = a; v <= b; v += step) if (v >= lo && v <= hi) vals.add(v);
	}
	return vals.size ? vals : new Set([lo]);
}

function nextCronFire(cron: string[], after: Date): Date {
	const mins = field(cron[0], 0, 59);
	const hrs = field(cron[1], 0, 23);
	const doms = field(cron[2], 1, 31);
	const mons = field(cron[3], 1, 12);
	const dows = field(cron[4], 0, 6);
	const t = new Date(after.getTime() - (after.getTime() % 60000) + 60000);
	for (let i = 0; i < 366 * 1440; i++) {
		if (
			mins.has(t.getUTCMinutes()) &&
			hrs.has(t.getUTCHours()) &&
			mons.has(t.getUTCMonth() + 1) &&
			doms.has(t.getUTCDate()) &&
			dows.has((t.getUTCDay() + 1) % 7)
		)
			return t;
		t.setUTCMinutes(t.getUTCMinutes() + 1);
	}
	throw new Error("no next fire within a year — bad cron");
}

function computeNext(s: LoopState, after: Date): Date {
	if (s.kind === "sleep") return new Date(after.getTime() + (s.seconds ?? 0) * 1000);
	return nextCronFire(s.cron!, after);
}

export class UntilManager {
	private _config: UntilConfig;
	private _active = false;
	private _objective = "";
	private _label = "";
	private _iterations = 0;
	private _done = false;
	private _timers = new Map<string, Timer>();
	private _busy = false;
	private _sessionLoopId: string | undefined;
	private _root = process.cwd();

	// pace state
	private _paceT0 = 0;

	// callbacks set by AgentSession
	sendUserMessage: ((msg: string, opts: { deliverAs: "followUp" | "steer" }) => void) | null = null;
	sendMessage: ((msg: { customType: string; content: string; display: boolean }) => void) | null = null;
	onStatusChange: (() => void) | null = null;

	constructor() {
		this._config = this._loadConfig();
	}

	setCwd(cwd: string): void {
		this._root = cwd;
	}

	get config(): UntilConfig {
		return this._config;
	}

	get active(): boolean {
		return this._active;
	}

	get statusLine(): string | undefined {
		if (!this._active) return undefined;
		return `until: iter ${this._iterations}/${this._config.maxIterations}`;
	}

	get loopStatusLine(): string | undefined {
		const n = this._activeLoops().length;
		return n > 0 ? `loop: ${n} active` : undefined;
	}

	get paceStatusLine(): string | undefined {
		if (!this._paceT0) return undefined;
		const cfg = this._loadPaceConfig();
		const left = cfg.boxMinutes * 60 - (Math.floor(Date.now() / 1000) - this._paceT0);
		const m = Math.floor(Math.abs(left) / 60);
		const s = Math.abs(left) % 60;
		const clock = `${m}:${String(s).padStart(2, "0")}`;
		return left >= 0 ? `pace ${clock} left` : `pace OVER by ${clock}`;
	}

	private _loadConfig(): UntilConfig {
		try {
			const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			return { triggerWord: cfg.triggerWord ?? "until", maxIterations: cfg.maxIterations ?? 50 };
		} catch {
			return { triggerWord: "until", maxIterations: 50 };
		}
	}

	private _writeConfig(): void {
		try {
			writeFileSync(CONFIG_PATH, `${JSON.stringify(this._config, null, 2)}\n`);
		} catch {
			/* best-effort */
		}
	}

	private _triggerRegex(): RegExp {
		const word = this._config.triggerWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`\\b${word}\\b`, "i");
	}

	private _activeLoops(): LoopState[] {
		return [...this._timers.values()]
			.map((t) => t.state)
			.filter((s) => s.status === "active")
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	private _getLoop(id: string): LoopState | undefined {
		return this._timers.get(id)?.state;
	}

	private _newLoopId(): string {
		const d = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const rnd = Math.floor(Math.random() * 0xffff)
			.toString(16)
			.padStart(4, "0");
		return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rnd}`;
	}

	private _fireLoop(s: LoopState): void {
		this.sendUserMessage?.(s.message, { deliverAs: "followUp" });
		s.lastFire = new Date().toISOString();
		if (s.count === 0 && !s.autoSeconds) s.firstFireAt = s.lastFire;
		s.count += 1;
	}

	private _armLoop(s: LoopState, delayMs: number): void {
		const t = setTimeout(() => this._tickLoop(s.id), delayMs);
		this._timers.set(s.id, { state: s, handle: t });
	}

	private _tickLoop(id: string): void {
		const t = this._timers.get(id);
		if (!t) return;
		this._timers.delete(id);
		const s = t.state;
		if (s.status === "stopped") return;
		if (!this._busy) this._fireLoop(s);
		const delayMs = s.autoSeconds
			? Math.max(1000, (s.autoSeconds ?? 0) * 1000)
			: Math.max(1000, computeNext(s, new Date()).getTime() - Date.now());
		s.nextFire = new Date(Date.now() + delayMs).toISOString();
		this._armLoop(s, delayMs);
		this.onStatusChange?.();
	}

	// ─── goal mode ──────────────────────────────────────────────────

	detectTrigger(text: string): boolean {
		if (!text.trim()) return false;
		if (/^\s*\//.test(text)) return false;
		return this._triggerRegex().test(text);
	}

	armGoal(objective: string, label?: string): void {
		this._active = true;
		this._objective = objective;
		this._label = (label ?? objective).replace(/\s+/g, " ").trim();
		this._iterations = 0;
		this._done = false;
	}

	deactivateGoal(): void {
		this._active = false;
		this._objective = "";
		this._label = "";
		this._iterations = 0;
		this._done = false;
	}

	injectContext(): { customType: string; content: string; display: boolean } | undefined {
		if (!this._active) return undefined;
		return {
			customType: "until-loop-state",
			content: [
				"<auto-injected-context>",
				"# Until mode active",
				`Objective: ${this._objective}`,
				`Iteration: ${this._iterations}/${this._config.maxIterations}.`,
				"",
				"You are in UNTIL mode. Work until the objective is FULLY done:",
				"implemented, reconciled, tested, documented — the complete deliverable.",
				"",
				"Each turn: plan the next step while executing the current one. After",
				"this turn settles, you will be re-dispatched to continue.",
				"",
				`When the objective is fully complete, include ${DONE_MARKER} in your`,
				"response with a summary of what was done. This deactivates until mode.",
				"",
				"If you hit a blocker you cannot resolve, say so plainly and include",
				`${DONE_MARKER} — do not loop forever on an unresolvable problem.`,
				"# Background reference — not a user message; do not respond to it.",
				"</auto-injected-context>",
			].join("\n"),
			display: false,
		};
	}

	checkDoneMarker(assistantContent: unknown): boolean {
		if (!this._active) return false;
		let text = "";
		if (typeof assistantContent === "string") text = assistantContent;
		else if (Array.isArray(assistantContent)) {
			text = (assistantContent as Array<{ type?: string; text?: string }>)
				.filter((b) => b?.type === "text")
				.map((b) => b.text ?? "")
				.join("");
		}
		if (text.includes(DONE_MARKER)) {
			this._done = true;
			return true;
		}
		return false;
	}

	onAgentSettled(): string | undefined {
		// auto-interval calibration
		if (this._sessionLoopId) {
			const s = this._getLoop(this._sessionLoopId);
			if (s?.firstFireAt && !s.autoSeconds && s.count >= 1) {
				const elapsed = (Date.now() - new Date(s.firstFireAt).getTime()) / 1000;
				if (elapsed > 5) {
					s.autoSeconds = Math.round(elapsed);
					s.spec = `${s.autoSeconds}s`;
					s.kind = "sleep";
					s.seconds = s.autoSeconds;
					this.onStatusChange?.();
				}
			}
		}

		if (!this._active || this._done) return undefined;

		this._iterations++;
		if (this._iterations > this._config.maxIterations) {
			this.deactivateGoal();
			this.onStatusChange?.();
			return "until: max iterations reached — stopping";
		}

		this.onStatusChange?.();
		return [
			"<until-continuation>",
			`Objective: ${this._label || this._objective}`,
			`Iteration ${this._iterations + 1}/${this._config.maxIterations}.`,
			"",
			"Assess progress. Is the objective fully done — implemented,",
			"reconciled, tested, documented?",
			"",
			"If YES: respond with [UNTIL: DONE] and a summary.",
			"If NO: state the next concrete step, then execute it.",
			"</until-continuation>",
		].join("\n");
	}

	// ─── goal commands ──────────────────────────────────────────────

	setTriggerWord(word: string): string {
		this._config.triggerWord = word;
		this._writeConfig();
		return `until: trigger word set to "${word}"`;
	}

	setMaxIterations(n: number): { ok: boolean; msg: string } {
		if (n <= 0) return { ok: false, msg: "until: max must be a positive number" };
		this._config.maxIterations = n;
		this._writeConfig();
		return { ok: true, msg: `until: max iterations set to ${n}` };
	}

	// ─── schedule loop commands ─────────────────────────────────────

	loopStart(interval: string, message: string): { ok: boolean; msg: string } {
		let spec = "auto";
		let autoMode = false;
		let sched: { kind: "sleep"; seconds: number } | { kind: "cron"; cron: string[] };

		if (interval) {
			try {
				sched = parseSchedule(interval);
				spec = interval;
			} catch {
				autoMode = true;
				sched = { kind: "sleep", seconds: 0 };
			}
		} else {
			autoMode = true;
			sched = { kind: "sleep", seconds: 0 };
		}

		const id = this._newLoopId();
		this._sessionLoopId = id;
		const s: LoopState = {
			id,
			kind: sched.kind,
			spec,
			seconds: sched.kind === "sleep" ? sched.seconds : undefined,
			cron: sched.kind === "cron" ? sched.cron : undefined,
			message,
			status: "active",
			count: 0,
			started: new Date().toISOString(),
		};
		if (!this._busy) this._fireLoop(s);
		const next = autoMode ? new Date(Date.now() + 60_000) : computeNext(s, new Date());
		s.nextFire = next.toISOString();
		this._armLoop(s, Math.max(1000, next.getTime() - Date.now()));
		this.onStatusChange?.();
		const label = autoMode ? "auto-interval" : `every ${spec}`;
		return { ok: true, msg: `loop ${id} started — ${label} → ${message}\nstop: /until stop ${id}` };
	}

	loopStop(arg: string): { ok: boolean; msg: string } {
		if (!arg) return { ok: false, msg: "usage: /until stop <id|all>" };
		const targets = arg === "all" ? this._activeLoops() : ([this._getLoop(arg)].filter(Boolean) as LoopState[]);
		if (!targets.length) return { ok: true, msg: "no active loops" };
		const stopped: string[] = [];
		for (const s of targets) {
			const t = this._timers.get(s.id);
			if (t) {
				clearTimeout(t.handle);
				this._timers.delete(s.id);
			}
			s.status = "stopped";
			stopped.push(s.id);
		}
		this.onStatusChange?.();
		return { ok: true, msg: `loop stopped: ${stopped.join(", ")}` };
	}

	loopList(): string {
		const rows = this._activeLoops();
		if (!rows.length) return "no active loops";
		return rows
			.map((s) => {
				const next = s.nextFire ? new Date(s.nextFire).toLocaleString() : "—";
				const m = s.message.length > 48 ? `${s.message.slice(0, 48)}…` : s.message;
				return `${s.id}  ${s.spec}  fires=${s.count}  next=${next}  ${m}`;
			})
			.join("\n");
	}

	loopStatus(id?: string): string {
		if (id) {
			const s = this._getLoop(id);
			if (!s) return `loop: no such id ${id}`;
			return JSON.stringify(s, null, 2);
		}
		const rows = this._activeLoops();
		if (!rows.length) return "no active loops";
		return rows.map((s) => JSON.stringify(s)).join("\n");
	}

	loopFire(id: string): { ok: boolean; msg: string } {
		if (!id) return { ok: false, msg: "usage: /until fire <id>" };
		const s = this._getLoop(id);
		if (!s) return { ok: false, msg: `loop: no such id ${id}` };
		if (s.status !== "active") return { ok: false, msg: `loop ${id} not active (${s.status})` };
		this._fireLoop(s);
		this.onStatusChange?.();
		return { ok: true, msg: `loop ${id} fired (count=${s.count})` };
	}

	stopAll(): string {
		const hadLoops = this._activeLoops().length > 0;
		if (hadLoops) this.loopStop("all");
		this.deactivateGoal();
		this.onStatusChange?.();
		return hadLoops ? "until: stopped (goal + loops)" : "until: stopped";
	}

	// ─── pace ───────────────────────────────────────────────────────

	private _loadPaceConfig(): PaceConfig {
		const p = join(this._root, ".pace.json");
		if (!existsSync(p)) return DEFAULT_PACE;
		try {
			const raw = JSON.parse(readFileSync(p, "utf8"));
			return { ...DEFAULT_PACE, ...raw };
		} catch {
			return DEFAULT_PACE;
		}
	}

	private _paceLedgerPath(cfg: PaceConfig): string {
		return join(this._root, cfg.ledger);
	}

	private _paceBudget(cfg: PaceConfig): { speed: number; rows: number; last: number } {
		const p = this._paceLedgerPath(cfg);
		if (!existsSync(p)) return { speed: 0, rows: 0, last: 0 };
		const text = readFileSync(p, "utf8");
		const speed = Number(/^\*\*Budget speed \(running\):\*\*[^0-9]*([0-9.]+)/m.exec(text)?.[1] ?? 0);
		const data = text.split("\n").filter((l) => /^\| *[0-9]+ *\|/.test(l));
		const last = Number(
			data
				.at(-1)
				?.split("|")[7]
				?.match(/[0-9.]+/)?.[0] ?? 0,
		);
		return { speed, rows: data.length, last };
	}

	paceInject(): string | undefined {
		const cfg = this._loadPaceConfig();
		const b = this._paceBudget(cfg);
		if (!b.rows && !existsSync(join(this._root, ".pace.json"))) return undefined;
		return [
			"<auto-injected-context>",
			"# Pace — the loop is a command",
			"",
			`\`/pace\` runs one timeboxed ${cfg.boxMinutes}-minute ${cfg.label}: stamps t0,`,
			"sizes the slice from the measured budget, implements with tests,",
			"commits, then records the measured row. `/pace --status` reads the",
			"ledger, `/pace --dry` picks a slice without starting, `/pace off` clears.",
			"",
			`Measured so far: ${b.rows} ${cfg.label}(s), budget ~${b.speed} loc/min,`,
			`last ${cfg.label} ${b.last} loc/min. Config: .pace.json (absent = defaults).`,
			"# Background reference — not a user message.",
			"</auto-injected-context>",
		].join("\n");
	}

	paceCommand(args: string): { followUp?: string; notify?: string } {
		const cfg = this._loadPaceConfig();
		const arg = args.trim();
		const word = arg.toLowerCase();
		const b = this._paceBudget(cfg);

		if (word === "off") {
			this._paceT0 = 0;
			const sp = join(this._root, ".pi/pace.t0");
			if (existsSync(sp)) writeFileSync(sp, "");
			this.onStatusChange?.();
			return { followUp: "Pace loop cleared — no timebox armed." };
		}

		if (word === "--status" || word === "status") {
			const p = this._paceLedgerPath(cfg);
			let tail = "(no ledger yet)";
			if (existsSync(p)) {
				const text = readFileSync(p, "utf8");
				const at = text.indexOf("## Ledger");
				tail = at < 0 ? "(no ## Ledger section)" : text.slice(at).trim();
			}
			return {
				followUp: [
					"Report the pace state and STOP — do not start a loop.",
					"",
					tail,
					"",
					this._paceT0 ? `A loop is armed: t0 ${this._paceT0}, ${cfg.boxMinutes}-min box.` : "No loop armed.",
				].join("\n"),
			};
		}

		const dry = word === "--dry" || word === "dry";
		const target = dry ? "" : arg;
		const speed = Math.max(b.last || 0, b.speed || 0);
		const maxLines = Math.round(speed * cfg.editMinutes);

		if (!dry) {
			const p = this._paceLedgerPath(cfg);
			if (!existsSync(p)) {
				writeFileSync(
					p,
					[
						`# Pace — the ${cfg.label} ledger`,
						"",
						"Self-pacing for timeboxed loops. Numbers over adjectives.",
						"",
						"## Ledger",
						"",
						"| # | date | feature | wall min | net +lines | tests | loc/min | outcome |",
						"|---|---|------|---------|----------|-----------|-------|---------|---------|",
						"",
						"**Budget speed (running):** not yet measured — the first row sets it.",
						"",
					].join("\n"),
				);
			}
			this._paceT0 = Math.floor(Date.now() / 1000);
			const sp = join(this._root, ".pi/pace.t0");
			writeFileSync(sp, `${this._paceT0}\n`);
			this.onStatusChange?.();
		}

		const verifyLine = cfg.verify
			? `\`${cfg.verify}\`. Name the pass count.`
			: "this project's own test/build command. Name the pass count.";

		return {
			followUp: [
				dry
					? "Pace DRY run — pick the slice, state its line estimate, then STOP."
					: `Pace loop ARMED. t0 = ${this._paceT0} (epoch). Box = ${cfg.boxMinutes} min.`,
				"",
				speed > 0
					? `Budget: ~${speed} loc/min measured → this slice fits ~${maxLines} net lines in ~${cfg.editMinutes} editing minutes.`
					: `Budget: no prior loops measured yet — pick a slice you can finish inside the ${cfg.boxMinutes}-minute box; the first row sets the budget.`,
				"",
				target ? `Target: ${target}` : "Target: take the next slice the ledger's closing line names.",
				"",
				"1. Recon inside ~3 min.",
				"2. Implement with tests in the same change.",
				`3. Verify — ${verifyLine}`,
				"4. Commit — stage ONLY this loop's paths.",
				"5. Close the row — wall minutes from git, COMPUTED, never estimated.",
				"6. Report — what shipped, the numbers, the next slice.",
			]
				.filter((l) => l !== "")
				.join("\n"),
		};
	}

	// ─── lifecycle ──────────────────────────────────────────────────

	onAgentStart(): void {
		this._busy = true;
	}

	onAgentSettledHandler(): string | undefined {
		this._busy = false;
		return this.onAgentSettled();
	}

	shutdown(): void {
		this.deactivateGoal();
		for (const t of this._timers.values()) clearTimeout(t.handle);
		this._timers.clear();
	}
}

// ─── tool definition ──────────────────────────────────────────────────

const UntilAction = Type.Union([
	Type.Literal("start"),
	Type.Literal("every"),
	Type.Literal("stop"),
	Type.Literal("status"),
	Type.Literal("list"),
	Type.Literal("fire"),
	Type.Literal("word"),
	Type.Literal("max"),
]);

export function createUntilToolDefinition(mgr: UntilManager): ToolDefinition {
	return {
		name: "until",
		label: "Until",
		description:
			"Loop surface — hand it a workload and it works until done, re-dispatching each settled turn until the agent emits [UNTIL: DONE] or hits max iterations. action=every: re-dispatch a message on an interval/cron schedule (first fire immediate).",
		promptSnippet: "Autonomous loop: hand it a prose objective and it works until done",
		parameters: Type.Object({
			action: Type.Optional(UntilAction),
			objective: Type.Optional(
				Type.String({
					description:
						"The workload as prose — the goal to work until fully done. Passing this with no action arms a goal loop.",
				}),
			),
			interval: Type.Optional(
				Type.String({
					description:
						"Schedule: duration (5m, 15m, 2h30m), 5-field cron, or @hourly/@daily/@weekly/@monthly. action=every only.",
				}),
			),
			message: Type.Optional(Type.String({ description: "Message re-dispatched each fire. action=every only." })),
			id: Type.Optional(Type.String({ description: "Loop id for stop/status/fire." })),
			word: Type.Optional(Type.String({ description: "New trigger word. action=word only." })),
			max: Type.Optional(Type.Integer({ description: "Max iterations before auto-stop. action=max only." })),
		}),
		async execute(_id: string, params: unknown) {
			const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			const p = params as any;
			const a = p.action ?? (p.objective ? "start" : "status");
			if (a === "start") {
				if (!p.objective) return out("until: start needs an objective");
				mgr.armGoal(p.objective);
				return out(`until: goal armed — ${p.objective}`);
			}
			if (a === "every") {
				if (!p.interval || !p.message) return out("until: every needs interval and message");
				return out(mgr.loopStart(p.interval, p.message).msg);
			}
			if (a === "stop") {
				if (!p.id || p.id === "all") return out(mgr.stopAll());
				return out(mgr.loopStop(p.id).msg);
			}
			if (a === "status") {
				if (p.id) return out(mgr.loopStatus(p.id));
				const goal = mgr.active ? "goal active" : "goal inactive";
				return out(`${goal}\n${mgr.loopList()}`);
			}
			if (a === "list") return out(mgr.loopList());
			if (a === "fire") return out(mgr.loopFire(p.id ?? "").msg);
			if (a === "word") {
				if (!p.word) return out("until: word needs a value");
				return out(mgr.setTriggerWord(p.word));
			}
			if (a === "max") {
				const r = mgr.setMaxIterations(p.max ?? 50);
				return out(r.msg);
			}
			return out("until: unknown action");
		},
	};
}
