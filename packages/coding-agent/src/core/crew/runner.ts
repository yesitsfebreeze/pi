import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { briefingBlock } from "./context.ts";
import type { CrewProfile, CrewRun, CrewSpec } from "./types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const MAX_RUNNING: number = Number(process.env.CREW_MAX_RUNNING) || 4;
export const MAX_DEPTH: number = Number(process.env.CREW_MAX_DEPTH) || 1;
const DEFAULT_TIMEOUT_MIN = 20;
const KILL_GRACE_MS = 5000;
const TEXT_CAP = 24_000;
const STDERR_CAP = 4000;

export const runs: Map<string, CrewRun> = new Map();
let onChange: () => void = () => {};
let onSettled: (run: CrewRun) => void = () => {};
let seq = 0;

export function configure(hooks: { onChange?: () => void; onSettled?: (run: CrewRun) => void }): void {
	if (hooks.onChange) onChange = hooks.onChange;
	if (hooks.onSettled) onSettled = hooks.onSettled;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function stateRoot(): string {
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi", "crew");
}

function slug(repo: string): string {
	return (
		repo
			.replace(/^\/+/, "")
			.replace(/[^\w.-]+/g, "-")
			.slice(-80) || "root"
	);
}

function repoDir(repo: string): string {
	return join(stateRoot(), slug(repo));
}

const PERSISTED: string[] = [
	"handle",
	"agent",
	"task",
	"cwd",
	"sessionId",
	"state",
	"started",
	"ended",
	"tools",
	"turns",
	"text",
	"resumes",
	"depth",
	"exitCode",
	"providerError",
];

function persist(run: CrewRun): void {
	try {
		const out: Record<string, unknown> = {};
		for (const k of PERSISTED) out[k] = (run as unknown as Record<string, unknown>)[k];
		writeFileSync(join(run.dir, "meta.json"), JSON.stringify(out, null, 2));
	} catch {
		/* a run that cannot write its meta still runs */
	}
}

export function load(repo: string): number {
	const dir = repoDir(repo);
	if (!existsSync(dir)) return 0;
	let n = 0;
	for (const entry of readdirSync(dir)) {
		const meta = join(dir, entry, "meta.json");
		if (runs.has(entry) || !existsSync(meta)) continue;
		try {
			const m = JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>;
			if (!m?.handle || !m?.sessionId) continue;
			const state: string =
				m.state === "running" || m.state === "queued" ? "interrupted" : String(m.state);
			runs.set(String(m.handle), {
				handle: String(m.handle),
				agent: String(m.agent ?? "worker"),
				task: String(m.task ?? ""),
				cwd: String(m.cwd ?? repo),
				sessionId: String(m.sessionId),
				state,
				resumes: Number(m.resumes ?? 0),
				started: Number(m.started ?? Date.now()),
				ended: Number(m.ended ?? Date.now()),
				tools: Number(m.tools ?? 0),
				turns: Number(m.turns ?? 0),
				text: String(m.text ?? ""),
				providerError: m.providerError ? String(m.providerError) : undefined,
				stderr: "",
				exitCode: m.exitCode != null ? Number(m.exitCode) : null,
				dir: join(dir, entry),
				depth: Number(m.depth ?? 0),
			});
			n += 1;
			const tail = /-(\d+)$/.exec(String(m.handle));
			if (tail) seq = Math.max(seq, Number(tail[1]));
		} catch {
			/* a corrupt meta is one lost handle */
		}
	}
	return n;
}

// ---------------------------------------------------------------------------
// Handle generation
// ---------------------------------------------------------------------------
function newHandle(agent: string): string {
	seq += 1;
	let h = `${agent}-${seq}`;
	while (runs.has(h)) {
		seq += 1;
		h = `${agent}-${seq}`;
	}
	return h;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export function live(): CrewRun[] {
	return [...runs.values()].filter((r) => r.state === "running" || r.state === "queued");
}

function running(): CrewRun[] {
	return [...runs.values()].filter((r) => r.state === "running");
}

export function resumable(run: CrewRun): boolean {
	return run.state !== "running" && run.state !== "queued";
}

export function human(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

// ---------------------------------------------------------------------------
// Briefing
// ---------------------------------------------------------------------------
function briefing(spec: CrewSpec, handle: string): string {
	const parts: string[] = [
		`You are \`${spec.agent}\`, a crew subagent dispatched by another pi session.`,
		"",
		spec.profile.prompt,
		"",
	];
	if (spec.profile.persona) {
		parts.push(
			"## Your persona",
			"",
			`You operate as \`${spec.profile.persona}\`. Your persona file defines your identity,`,
			"beliefs, working style and voice. Read it when the task is non-trivial for your",
			"role — a real design call, an ambiguous boundary, a failure you have not seen.",
			"Do not read it for a job you already know how to do; it is there to make you",
			"sharper, not slower.",
			"",
			`Find it at \`.pi/personas/${spec.profile.persona}/PERSONA.md\` or in the built-in`,
			"personas shipped with pi. Use `read` to fetch it when needed.",
			"",
		);
	}
	parts.push(briefingBlock(spec.cwd));
	parts.push(
		"## Reporting back",
		"",
		`On this repo's walkie-talkie channel you are \`${handle}\` and your parent is \`${spec.parentAddr}\`.`,
		`Use \`wt_send\` with \`to: ${spec.parentAddr}\` and \`re: ${handle}\`:`,
		"",
		"- once, as soon as you know what you are actually doing,",
		"- at any real milestone, and immediately if you are blocked or the task is wrong.",
		"",
		"Never wait for a reply — the parent is working on something else and reads at its",
		"next boundary. If a message from it arrives mid-run, fold it in and keep going.",
		"",
		"## Your result",
		"",
		"Your final assistant message is captured verbatim and handed to the parent, so end",
		"with the answer itself — what you did, what you found, what is left, which files.",
		"No preamble, no restating of the task.",
		"",
		`Work inside ${spec.cwd}. Do not commit, push or open a PR unless the task says so.`,
		"",
		"## Your task",
		"",
		spec.task.trim(),
	);
	return parts.join("\n");
}

function buildArgs(run: CrewRun, spec: CrewSpec, promptFile: string): string[] {
	const p = spec.profile;
	const args: string[] = [
		"--mode", "json", "-p", "--session-id", run.sessionId, "--name", `crew:${run.handle}`,
	];
	const model = spec.model ?? p.model;
	if (model) args.push("--model", model);
	if (p.thinking) args.push("--thinking", p.thinking);
	if (p.tools?.length) args.push("--tools", p.tools.join(","));
	if (p.exclude?.length) args.push("--exclude-tools", p.exclude.join(","));
	args.push(`@${promptFile}`);
	return args;
}

function continuation(run: CrewRun, message?: string): string {
	const why =
		run.state === "interrupted"
			? "You were cut off mid-run when the session that dispatched you went away."
			: run.state === "stopped"
				? "You were stopped on purpose."
				: run.state === "timeout"
					? "You were killed for running past your time budget — be faster and narrower now."
					: run.state === "failed"
						? "Your last run exited non-zero."
						: "You finished this task already.";
	return [
		`You are \`${run.handle}\` again, in the same session, resumed by your parent.`,
		"",
		why,
		"Everything you did before is above in this session — read it rather than starting over.",
		"",
		message?.trim()
			? `## What your parent wants now\n\n${message.trim()}`
			: "## What to do now\n\nPick up exactly where you left off and finish the task.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------
interface JsonMessage {
	content?: string | Array<{ type: string; text: string }>;
	role?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
		totalTokens?: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

function textOf(message?: JsonMessage): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

function onEvent(run: CrewRun, ev: Record<string, unknown>): void {
	switch (ev?.type) {
		case "tool_execution_start":
			run.tool = String(ev.toolName ?? "");
			run.tools += 1;
			break;
		case "tool_execution_end":
			run.tool = undefined;
			break;
		case "turn_end":
			run.turns += 1;
			if ((ev.message as JsonMessage)?.role === "assistant") {
				const t = textOf(ev.message as JsonMessage);
				if (t) run.text = t.slice(0, TEXT_CAP);
			}
			if ((ev.message as JsonMessage)?.errorMessage)
				run.providerError = String((ev.message as JsonMessage).errorMessage).slice(0, TEXT_CAP);
			break;
		case "auto_retry_start":
			if (ev.errorMessage) run.providerError = String(ev.errorMessage).slice(0, TEXT_CAP);
			break;
		case "message_end":
			if ((ev.message as JsonMessage)?.role === "assistant") {
				const t = textOf(ev.message as JsonMessage);
				if (t) run.text = t.slice(0, TEXT_CAP);
			}
			break;
	}
}

function pump(run: CrewRun): (chunk: Buffer) => void {
	let buf = "";
	return (chunk: Buffer) => {
		buf += chunk.toString();
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			nl = buf.indexOf("\n");
			if (!line.trim()) continue;
			try {
				appendFileSync(join(run.dir, "events.jsonl"), `${line}\n`);
			} catch {
				/* best effort */
			}
			try {
				onEvent(run, JSON.parse(line) as Record<string, unknown>);
			} catch {
				/* non-JSON line is startup noise */
			}
		}
		onChange();
	};
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
export function start(spec: CrewSpec): { run?: CrewRun; error?: string } {
	if (spec.depth >= MAX_DEPTH)
		return {
			error: `crew depth ${spec.depth} is already at the cap (${MAX_DEPTH}) — a subagent this deep does the work itself`,
		};
	if (!spec.task.trim()) return { error: "a dispatch needs a task" };

	const handle = newHandle(spec.agent);
	const dir = join(repoDir(spec.cwd), handle);
	const run: CrewRun = {
		handle,
		agent: spec.agent,
		task: spec.task.trim(),
		cwd: spec.cwd,
		sessionId: `crew-${handle}-${randomBytes(3).toString("hex")}`,
		state: "queued",
		resumes: 0,
		started: Date.now(),
		tools: 0,
		turns: 0,
		text: "",
		stderr: "",
		dir,
		profile: spec.profile,
		depth: spec.depth,
	};
	runs.set(handle, run);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "prompt.md"), briefing(spec, handle));
		persist(run);
	} catch (e: unknown) {
		runs.delete(handle);
		return { error: `crew: could not prepare ${dir}: ${(e as Error)?.message ?? e}` };
	}

	queueSpecs.set(handle, spec);
	if (running().length >= MAX_RUNNING) {
		onChange();
		return { run };
	}
	spawnRun(run, spec);
	return { run };
}

export function resume(
	run: CrewRun,
	spec: CrewSpec,
	message?: string,
): { error?: string } {
	if (!resumable(run)) return { error: `${run.handle} is ${run.state} — stop it before resuming it` };

	const file = join(run.dir, `resume-${run.resumes + 1}.md`);
	try {
		writeFileSync(file, continuation(run, message));
	} catch (e: unknown) {
		return { error: `could not write ${file}: ${(e as Error)?.message ?? e}` };
	}

	run.resumes += 1;
	run.ended = undefined;
	run.exitCode = undefined;
	run.stderr = "";
	run.profile = spec.profile;
	run.state = "queued";
	queueSpecs.set(run.handle, spec);
	resumeFiles.set(run.handle, file);

	if (running().length >= MAX_RUNNING) {
		persist(run);
		onChange();
		return {};
	}
	spawnRun(run, spec);
	return {};
}

const resumeFiles = new Map<string, string>();

function spawnRun(run: CrewRun, spec: CrewSpec): void {
	queueSpecs.delete(run.handle);
	const prompt = resumeFiles.get(run.handle) ?? join(run.dir, "prompt.md");
	resumeFiles.delete(run.handle);
	const args = buildArgs(run, spec, prompt);

	const child = spawn(process.env.CREW_PI_BIN || "pi", args, {
		cwd: run.cwd,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_SCOPES: [run.handle, ...(spec.scopes ?? [])].join(","),
			...(existsSync(join(spec.repo, ".pi", "gantt"))
				? { PI_WRITE_SCOPE_EXTRA: join(spec.repo, ".pi", "gantt") }
				: {}),
			PI_DOING: `crew ${run.agent}: ${run.task.split("\n")[0].slice(0, 120)}`,
			CREW_HANDLE: run.handle,
			CREW_PARENT: spec.parentAddr,
			CREW_DEPTH: String(spec.depth + 1),
			FORCE_COLOR: "0",
			NO_COLOR: "1",
		},
	});

	run.child = child;
	run.pid = child.pid;
	run.state = "running";
	run.started = Date.now();
	persist(run);

	child.stdout?.on("data", pump(run));
	child.stderr?.on("data", (b: Buffer) => {
		const text = b
			.toString()
			.split("\n")
			.filter((l) => !/No project session found with id/.test(l))
			.join("\n");
		run.stderr = (run.stderr + text).slice(-STDERR_CAP);
	});

	child.on("error", (e: Error) => {
		run.stderr = `${run.stderr}\ncrew: spawn failed: ${e.message}`.slice(-STDERR_CAP);
		finish(run, "failed", null);
	});

	child.on("exit", (code: number | null) => {
		if (run.state === "stopped" || run.state === "timeout" || run.state === "interrupted")
			return finish(run, run.state, code);
		finish(run, code === 0 ? "done" : "failed", code);
	});

	const minutes = spec.timeoutMin ?? spec.profile.timeout ?? DEFAULT_TIMEOUT_MIN;
	run.timeoutTimer = setTimeout(() => {
		run.timeoutTimer = undefined;
		if (run.state !== "running") return;
		run.state = "timeout";
		signal(run, "SIGTERM");
	}, minutes * 60_000);
	run.timeoutTimer.unref?.();
	onChange();
}

function finish(run: CrewRun, state: string, code: number | null): void {
	if (run.ended) return;
	run.state = state;
	run.ended = Date.now();
	run.exitCode = code;
	run.tool = undefined;
	run.child = undefined;
	if (run.killTimer) clearTimeout(run.killTimer);
	if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
	run.killTimer = undefined;
	run.timeoutTimer = undefined;
	try {
		writeFileSync(join(run.dir, "result.md"), result(run));
	} catch {
		/* best effort */
	}
	persist(run);
	onSettled(run);
	drainQueue();
	onChange();
}

let queueSpecs = new Map<string, CrewSpec>();

function drainQueue(): void {
	for (const run of [...runs.values()]) {
		if (run.state !== "queued") continue;
		if (running().length >= MAX_RUNNING) return;
		const spec = queueSpecs.get(run.handle);
		if (!spec) continue;
		queueSpecs.delete(run.handle);
		spawnRun(run, spec);
	}
}

function signal(run: CrewRun, sig: NodeJS.Signals): void {
	const pid = run.child?.pid;
	if (!pid) return;
	try {
		process.kill(-pid, sig);
	} catch {
		try {
			process.kill(pid, sig);
		} catch {
			/* already gone */
		}
	}
}

export function stop(handle: string): boolean {
	const run = runs.get(handle);
	if (!run) return false;
	if (run.state === "queued") {
		queueSpecs.delete(handle);
		finish(run, "stopped", null);
		return true;
	}
	if (run.state !== "running") return false;
	run.state = "stopped";
	signal(run, "SIGTERM");
	run.killTimer = setTimeout(() => {
		run.killTimer = undefined;
		signal(run, "SIGKILL");
	}, KILL_GRACE_MS);
	run.killTimer.unref?.();
	return true;
}

export function stopAll(): void {
	for (const run of runs.values()) {
		if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
		if (run.killTimer) clearTimeout(run.killTimer);
		if (run.state !== "running" && run.state !== "queued") continue;
		run.state = "interrupted";
		run.ended = Date.now();
		persist(run);
		if (!run.child) continue;
		signal(run, "SIGTERM");
		signal(run, "SIGKILL");
	}
	queueSpecs = new Map();
}

export function clearSettled(): number {
	let n = 0;
	for (const [h, r] of [...runs]) {
		if (!resumable(r)) continue;
		runs.delete(h);
		n += 1;
	}
	onChange();
	return n;
}

// ---------------------------------------------------------------------------
// Reading runs
// ---------------------------------------------------------------------------
export function result(run: CrewRun): string {
	const again = run.resumes ? `, resumed ${run.resumes}×` : "";
	const head = [
		`${run.handle} — ${run.state}${run.ended ? ` after ${human(run.ended - run.started)}` : ""},`,
		`${run.tools} tool call${run.tools === 1 ? "" : "s"}${again}`,
	].join(" ");
	const body = run.text.trim() || "(the subagent produced no final text)";
	const provider = run.providerError?.trim()
		? `\n\nprovider error (the child's turns failed before it could work):\n${run.providerError.trim()}`
		: "";
	const err = run.stderr.trim() && run.state === "failed" ? `\n\nstderr:\n${run.stderr.trim()}` : "";
	return `${head}\n\n${body}${provider}${err}`;
}

export function events(run: CrewRun, lines: number): string {
	try {
		const all = readFileSync(join(run.dir, "events.jsonl"), "utf8").trim().split("\n");
		return all
			.slice(-lines)
			.map((l) => {
				try {
					const ev = JSON.parse(l) as Record<string, unknown>;
					if (ev.type === "tool_execution_start")
						return `→ ${ev.toolName} ${JSON.stringify(ev.args ?? {}).slice(0, 160)}`;
					if (ev.type === "tool_execution_end") return `← ${ev.toolName}${ev.isError ? " (error)" : ""}`;
					if (ev.type === "message_end" && (ev.message as JsonMessage)?.role === "assistant")
						return `· ${textOf(ev.message as JsonMessage).split("\n")[0].slice(0, 160)}`;
					return "";
				} catch {
					return "";
				}
			})
			.filter(Boolean)
			.join("\n");
	} catch {
		return "(no events recorded yet)";
	}
}

export const GLYPH: Record<string, string> = {
	queued: "…",
	running: "▶",
	done: "✓",
	failed: "✗",
	stopped: "■",
	timeout: "⏱",
	interrupted: "↺",
};

export function renderList(now: number = Date.now()): string {
	const all = [...runs.values()];
	if (!all.length) return "no crew dispatched";
	return all
		.map((r) => {
			const age = human((r.ended ?? now) - r.started);
			const what = r.state === "running" ? (r.tool ? `in ${r.tool}` : "thinking") : r.state;
			const tail = resumable(r) ? `  · resume ${r.handle}` : "";
			return [
				`${GLYPH[r.state]} ${r.handle}  ${what}  ${age}  ${r.tools} tools${r.resumes ? `  ${r.resumes}× resumed` : ""}${tail}`,
				`   session ${r.sessionId}`,
				`   ${r.task.split("\n")[0].slice(0, 100)}`,
			].join("\n");
		})
		.join("\n");
}

export function crewStatus(handle?: string): string {
	const now = Date.now();
	if (handle) {
		const r = runs.get(handle);
		if (!r) return `crew: no run "${handle}"`;
		const age = human((r.ended ?? now) - r.started);
		return [
			`crew: ${GLYPH[r.state]} ${r.handle}  ${r.state}  ${age}  ${r.tools} tools${r.resumes ? `  ${r.resumes}× resumed` : ""}`,
			`   ${r.task.split("\n")[0].slice(0, 100)}`,
		].join("\n");
	}
	const all = [...runs.values()];
	if (!all.length) return "crew: no runs";
	const count = (s: string) => all.filter((r) => r.state === s).length;
	const parts: string[] = [];
	for (const s of ["running", "queued", "done", "failed", "timeout", "interrupted", "stopped"]) {
		const n = count(s);
		if (n) parts.push(`${GLYPH[s]}${n} ${s}`);
	}
	return `crew: ${all.length} run(s) — ${parts.join(", ") || "none live"}`;
}

export function activeLabel(): string | undefined {
	const up = running();
	const queued = [...runs.values()].filter((r) => r.state === "queued").length;
	const cut = [...runs.values()].filter((r) => r.state === "interrupted").length;
	if (!up.length && !queued) return cut ? `crew: ${cut} to resume` : undefined;
	const who = up.map((r) => `${r.handle}/${r.sessionId}`).join(", ");
	return `crew: ${who || `${queued} queued`}${queued && who ? ` +${queued}` : ""}`;
}