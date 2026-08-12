// launch — background job manager. Start/stop/restart dev servers, watchers,
// daemons in their own process groups. Ring-buffer + log file per job. Killed
// with the session.
//
// Wired directly into AgentSession; no extension layer.

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "../core/extensions/types.ts";

const RING_MAX = 500;
const LINE_MAX = 500;
const KILL_GRACE_MS = 5000;
const RESTART_MAX = 5;

type JobStatus = "running" | "exited" | "failed" | "stopped" | "restarting";

interface Job {
	id: string;
	name: string;
	cmd: string;
	cwd: string;
	status: JobStatus;
	pid?: number;
	started: number;
	ended?: number;
	exitCode?: number | null;
	signal?: string | null;
	restart: boolean;
	restarts: number;
	url?: string;
	ring: string[];
	logPath: string;
	child?: ChildProcess;
	killTimer?: ReturnType<typeof setTimeout>;
	backoffTimer?: ReturnType<typeof setTimeout>;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\S*/i;

export class LaunchManager {
	private _jobs = new Map<string, Job>();
	private _seq = 0;
	private _cwd = process.cwd();
	private _onStatusChange?: () => void;

	setCwd(cwd: string): void {
		this._cwd = cwd;
	}

	setOnStatusChange(cb: () => void): void {
		this._onStatusChange = cb;
	}

	get jobs(): ReadonlyMap<string, Job> {
		return this._jobs;
	}

	get liveJobs(): Job[] {
		return [...this._jobs.values()].filter((j) => j.status === "running" || j.status === "restarting");
	}

	get statusLine(): string | undefined {
		const all = [...this._jobs.values()];
		if (!all.length) return undefined;
		const up = this.liveJobs.length;
		const bad = all.filter((j) => j.status === "failed").length;
		const parts: string[] = [];
		if (up) parts.push(`${up} up`);
		if (bad) parts.push(`${bad} failed`);
		return parts.length ? `launch: ${parts.join(", ")}` : `launch: ${all.length} done`;
	}

	find(key: string): Job | undefined {
		if (!key) return undefined;
		for (const j of this._jobs.values()) if (j.name === key) return j;
		return this._jobs.get(key);
	}

	private _newId(): string {
		this._seq += 1;
		return `j${this._seq}`;
	}

	private _logDir(): string {
		const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
		return path.join(state, "pi", "launch");
	}

	private _nameFor(cmd: string, explicit?: string): string {
		if (explicit) return explicit;
		const meaningful = cmd
			.trim()
			.split(/\s+/)
			.filter((t) => !t.startsWith("-"));
		const pick = meaningful.length > 2 ? meaningful[2] : (meaningful[0] ?? "job");
		const base = path.basename(pick).replace(/[^A-Za-z0-9._-]/g, "") || "job";
		if (!this.find(base)) return base;
		let n = 2;
		while (this.find(`${base}${n}`)) n += 1;
		return `${base}${n}`;
	}

	private _push(job: Job, chunk: string): void {
		const clean = chunk.replace(ANSI, "");
		for (const raw of clean.split(/\r?\n/)) {
			const line = raw.replace(/\r/g, "").trimEnd();
			if (!line) continue;
			job.ring.push(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line);
			if (job.ring.length > RING_MAX) job.ring.splice(0, job.ring.length - RING_MAX);
			if (!job.url) {
				const m = line.match(URL_RE);
				if (m) job.url = m[0].replace(/[),.]+$/, "");
			}
		}
	}

	private _signalJob(job: Job, sig: NodeJS.Signals): void {
		const pid = job.child?.pid;
		if (!pid) return;
		try {
			process.kill(-pid, sig);
		} catch {
			try {
				process.kill(pid, sig);
			} catch {
				/* already dead */
			}
		}
	}

	private _spawnJob(job: Job): void {
		let stream: fs.WriteStream | undefined;
		try {
			fs.mkdirSync(this._logDir(), { recursive: true });
			stream = fs.createWriteStream(job.logPath, { flags: "a" });
			stream.write(`\n=== ${new Date().toISOString()} ${job.cmd} ===\n`);
		} catch {
			stream = undefined;
		}

		const child = spawn(job.cmd, {
			shell: true,
			cwd: job.cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
		});
		job.child = child;
		job.pid = child.pid;
		job.status = "running";
		job.started = Date.now();
		job.ended = undefined;
		job.exitCode = undefined;
		job.signal = undefined;

		const onData = (buf: Buffer) => {
			this._push(job, buf.toString());
			stream?.write(buf.toString());
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (e: Error) => {
			this._push(job, `launch: spawn failed: ${e.message}`);
			job.status = "failed";
			job.ended = Date.now();
			stream?.end();
			this._onStatusChange?.();
		});
		child.on("exit", (code, signal) => {
			stream?.end();
			if (job.killTimer) {
				clearTimeout(job.killTimer);
				job.killTimer = undefined;
			}
			job.ended = Date.now();
			job.exitCode = code;
			job.signal = signal ?? null;
			job.child = undefined;
			if (job.status === "stopped") {
				this._onStatusChange?.();
				return;
			}
			const ok = code === 0;
			if (!ok && job.restart && job.restarts < RESTART_MAX) {
				job.restarts += 1;
				job.status = "restarting";
				const delay = Math.min(16000, 1000 * 2 ** (job.restarts - 1));
				job.backoffTimer = setTimeout(() => {
					job.backoffTimer = undefined;
					if (job.status === "restarting") this._spawnJob(job);
					this._onStatusChange?.();
				}, delay);
				job.backoffTimer.unref?.();
			} else {
				job.status = ok ? "exited" : "failed";
				if (!ok) {
					try {
						process.emitWarning(`launch: ${job.name} failed (exit ${code ?? signal})`);
					} catch {
						/* best-effort */
					}
				}
			}
			this._onStatusChange?.();
		});
	}

	private _stopJob(job: Job): void {
		if (job.backoffTimer) {
			clearTimeout(job.backoffTimer);
			job.backoffTimer = undefined;
		}
		if (!job.child) {
			job.status = "stopped";
			job.ended = job.ended ?? Date.now();
			return;
		}
		job.status = "stopped";
		this._signalJob(job, "SIGTERM");
		job.killTimer = setTimeout(() => {
			job.killTimer = undefined;
			this._signalJob(job, "SIGKILL");
		}, KILL_GRACE_MS);
		job.killTimer.unref?.();
	}

	request(text: string, sendFollowUp: (msg: string) => void): { ok: boolean; msg: string } {
		const request = text.trim();
		if (!request) return { ok: false, msg: "usage: /launch <what to run…>  (prefix ! to run it verbatim)" };

		const lines = [
			`/launch request: ${request}`,
			"",
			"Work out what actually has to run, then start it as a background job:",
			"- Inspect the project first if the request is not already a concrete command.",
			"- If it needs a script, write one (a scratch path is fine), make it executable.",
			"- Start it with the `launch` tool: action=start, command=<the command you built>.",
			"- Report the job name and how to read its logs.",
			"Never run it in the foreground and never paste its output into the transcript.",
		];
		sendFollowUp(lines.join("\n"));
		return { ok: true, msg: `launch: working out "${request}"…` };
	}

	start(cmd: string, name?: string, cwd?: string, restart?: boolean): { ok: boolean; msg: string } {
		const resolvedCwd = cwd ? path.resolve(this._cwd, cwd) : this._cwd;
		const cleanCmd = cmd.trim().replace(/^!\s*/, "");
		if (!cleanCmd) return { ok: false, msg: "start needs a command" };
		if (!fs.existsSync(resolvedCwd)) return { ok: false, msg: `launch: no such cwd ${resolvedCwd}` };
		if (name && this.find(name))
			return { ok: false, msg: `launch: ${name} already exists — /launch stop ${name} first` };

		const id = this._newId();
		const jobName = this._nameFor(cleanCmd, name);
		const job: Job = {
			id,
			name: jobName,
			cmd: cleanCmd,
			cwd: resolvedCwd,
			status: "running",
			started: Date.now(),
			restart: restart ?? false,
			restarts: 0,
			ring: [],
			logPath: path.join(this._logDir(), `${jobName}-${id}.log`),
		};
		this._jobs.set(id, job);
		this._spawnJob(job);
		this._onStatusChange?.();
		return {
			ok: true,
			msg: `launch ${jobName} (pid ${job.pid ?? "?"}) — ${cleanCmd}\nlogs: /launch logs ${jobName}   stop: /launch stop ${jobName}`,
		};
	}

	stop(key: string): { ok: boolean; msg: string } {
		if (!key) return { ok: false, msg: "usage: /launch stop <name|all>" };
		const targets = key === "all" ? this.liveJobs : ([this.find(key)].filter(Boolean) as Job[]);
		if (!targets.length) return { ok: true, msg: "launch: nothing to stop" };
		for (const j of targets) this._stopJob(j);
		this._onStatusChange?.();
		return { ok: true, msg: `launch stopped: ${targets.map((j) => j.name).join(", ")}` };
	}

	restart(key: string): { ok: boolean; msg: string } {
		const job = this.find(key);
		if (!job) return { ok: false, msg: `launch: no such job ${key}` };
		if (job.child) {
			this._stopJob(job);
			setTimeout(() => {
				job.restarts = 0;
				job.ring.push(`--- restart ${new Date().toLocaleTimeString()} ---`);
				this._spawnJob(job);
				this._onStatusChange?.();
			}, 300);
		} else {
			job.restarts = 0;
			this._spawnJob(job);
		}
		this._onStatusChange?.();
		return { ok: true, msg: `launch: restarting ${job.name}` };
	}

	list(): string {
		const all = [...this._jobs.values()];
		if (!all.length) return "no jobs";
		return all
			.map((j) => {
				const age = humanMs((j.ended ?? Date.now()) - j.started);
				const cmd = j.cmd.length > 44 ? `${j.cmd.slice(0, 44)}…` : j.cmd;
				const extra =
					j.status === "running"
						? `pid=${j.pid} up=${age}${j.url ? ` ${j.url}` : ""}`
						: `${j.exitCode ?? j.signal ?? "—"} after ${age}`;
				return `${j.name}  ${j.status}  ${extra}  ${cmd}`;
			})
			.join("\n");
	}

	logs(key: string, n = 40): { ok: boolean; msg: string } {
		const job = this.find(key);
		if (!job) return { ok: false, msg: `launch: no such job ${key}` };
		const count = Math.max(1, Math.min(RING_MAX, n));
		const tail = job.ring.slice(-count);
		if (!tail.length) return { ok: true, msg: `${job.name}: no output yet` };
		return {
			ok: true,
			msg: `${job.name} — last ${tail.length} line(s), full log ${job.logPath}\n${tail.join("\n")}`,
		};
	}

	status(key?: string): string {
		const dump = (j: Job) =>
			JSON.stringify(
				{
					id: j.id,
					name: j.name,
					cmd: j.cmd,
					cwd: j.cwd,
					status: j.status,
					pid: j.pid,
					url: j.url,
					restart: j.restart,
					restarts: j.restarts,
					exitCode: j.exitCode,
					signal: j.signal,
					uptimeMs: (j.ended ?? Date.now()) - j.started,
					lines: j.ring.length,
					logPath: j.logPath,
				},
				null,
				2,
			);
		if (key) {
			const job = this.find(key);
			if (!job) return `launch: no such job ${key}`;
			return dump(job);
		}
		const all = [...this._jobs.values()];
		if (!all.length) return "no jobs";
		return all.map(dump).join("\n");
	}

	clear(): { ok: boolean; msg: string } {
		let n = 0;
		for (const [id, j] of [...this._jobs]) {
			if (j.status === "running" || j.status === "restarting") continue;
			this._jobs.delete(id);
			n += 1;
		}
		this._onStatusChange?.();
		return { ok: true, msg: `launch: cleared ${n} finished job(s)` };
	}

	shutdown(): void {
		for (const j of this._jobs.values()) {
			if (j.backoffTimer) clearTimeout(j.backoffTimer);
			if (j.child) {
				j.status = "stopped";
				this._signalJob(j, "SIGTERM");
			}
		}
		setTimeout(() => {
			for (const j of this._jobs.values()) {
				if (j.child) this._signalJob(j, "SIGKILL");
			}
			this._jobs.clear();
		}, KILL_GRACE_MS);
	}
}

function humanMs(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

// ─── tool definition ──────────────────────────────────────────────────

const Action = Type.Union([
	Type.Literal("start"),
	Type.Literal("stop"),
	Type.Literal("restart"),
	Type.Literal("list"),
	Type.Literal("logs"),
	Type.Literal("status"),
	Type.Literal("clear"),
]);

export function createLaunchToolDefinition(mgr: LaunchManager): ToolDefinition {
	return {
		name: "launch",
		label: "Launch",
		description:
			"Run and manage long-lived background jobs owned by this session (tests, dev servers, watchers, tailers). action=start takes a concrete command — resolve the request into one first, writing a script if the job needs one. Output goes to a ring buffer plus a log file, never the transcript — read it back with action=logs. Each job runs in its own process group and is killed when the session ends.",
		promptSnippet: "Background jobs: tests, dev servers, watchers, long-running tasks",
		parameters: Type.Object({
			action: Action,
			command: Type.Optional(
				Type.String({
					description:
						"Concrete shell command to run, already resolved (not a description of the task). start only.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description:
						"Job name: assigned on start (derived from the command when omitted), target for stop/restart/logs/status.",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory. start only." })),
			restart: Type.Optional(
				Type.Boolean({ description: "Respawn on non-zero exit (5 tries, backoff). start only." }),
			),
			lines: Type.Optional(Type.Number({ description: "Tail length for logs (default 40)." })),
		}),
		execute(_id, params) {
			const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			const a = params.action;
			if (a === "start") {
				if (!params.command) return out("start needs a command");
				return out(mgr.start(params.command, params.name, params.cwd, params.restart).msg);
			}
			if (a === "stop") return out(mgr.stop(params.name ?? "all").msg);
			if (a === "restart") return out(mgr.restart(params.name ?? "").msg);
			if (a === "list") return out(mgr.list());
			if (a === "logs") return out(mgr.logs(params.name ?? "", params.lines ?? 40).msg);
			if (a === "status") return out(mgr.status(params.name));
			return out(mgr.clear().msg);
		},
	};
}
