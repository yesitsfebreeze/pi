// mem/procs.ts — supervised children (mem_run) and valgrind jobs
// (mem_valgrind_run/status). Platform-agnostic; the only moving parts are
// spawn + non-blocking poll. Ported from the pi-mem MCP server.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface ChildRecord {
	child: ChildProcess;
	command: string;
	startTime: number;
}

interface ValgrindRecord {
	child: ChildProcess;
	startTime: number;
	timeoutMs: number;
	output: string;
	done: boolean;
}

const children = new Map<string, ChildRecord>();
const vgJobs = new Map<string, ValgrindRecord>();

const nanos = () => `${process.hrtime.bigint()}`;

// ── supervised children (mem_run / mem_children) ──────────────────────────

export async function spawnChild(
	command: string,
	args: string[],
): Promise<{ ok: true; jobId: string; pid: number } | { ok: false; error: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "ignore" });
		const jobId = `child_${nanos()}`;
		child.once("error", (e) => resolve({ ok: false, error: `spawn ${command}: ${e.message}` }));
		child.once("spawn", () => {
			children.set(jobId, { child, command, startTime: Date.now() });
			resolve({ ok: true, jobId, pid: child.pid ?? -1 });
		});
	});
}

export function listChildren(): Array<{
	jobId: string;
	pid: number;
	command: string;
	status: string;
	elapsedSecs: number;
}> {
	const list: Array<{ jobId: string; pid: number; command: string; status: string; elapsedSecs: number }> = [];
	for (const [id, rec] of children) {
		const status =
			rec.child.exitCode !== null
				? `exited(${rec.child.exitCode})`
				: rec.child.signalCode !== null
					? `killed(${rec.child.signalCode})`
					: "running";
		list.push({
			jobId: id,
			pid: rec.child.pid ?? -1,
			command: rec.command,
			status,
			elapsedSecs: Math.round((Date.now() - rec.startTime) / 1000),
		});
	}
	return list;
}

export function runningChildCount(): number {
	let n = 0;
	for (const rec of children.values()) if (rec.child.exitCode === null && rec.child.signalCode === null) n++;
	return n;
}

/** Kill everything we spawned — called on session_shutdown. */
export function killAllChildren(): void {
	for (const rec of children.values()) {
		try {
			rec.child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
	children.clear();
}

// ── valgrind jobs ─────────────────────────────────────────────────────────

/** Resolve the valgrind binary: explicit path/name, MEM_VALGRIND env, then PATH. */
export function findValgrind(override?: string): string | null {
	if (override) return override; // spawn reports a missing binary cleanly
	const env = process.env.MEM_VALGRIND;
	if (env) return env;
	const dirs = [
		...(process.env.PATH ?? "").split(":").filter(Boolean),
		"/usr/bin",
		"/usr/local/bin",
		"/opt/homebrew/bin",
	];
	for (const dir of dirs) {
		const p = join(dir, "valgrind");
		if (existsSync(p)) return p;
	}
	return null;
}

export async function startValgrind(
	command: string,
	args: string[],
	tool: string,
	timeoutSecs: number,
	valgrindPath?: string,
): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
	const vg = findValgrind(valgrindPath);
	if (!vg) {
		return { ok: false, error: "valgrind not found on PATH — install it or pass valgrind_path" };
	}
	return new Promise((resolve) => {
		const child = spawn(vg, [`--tool=${tool}`, "--", command, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const jobId = `vg_${nanos()}`;
		// Flowing listeners from birth: poll-time drains miss output that arrives
		// between polls (the child can exit before the first poll drains it).
		const job: ValgrindRecord = {
			child,
			startTime: Date.now(),
			timeoutMs: timeoutSecs * 1000,
			output: "",
			done: false,
		};
		for (const stream of [child.stdout, child.stderr]) {
			stream?.on("data", (d: Buffer) => {
				job.output += d.toString("utf8");
			});
		}
		child.once("error", (e) => resolve({ ok: false, error: `spawn valgrind: ${e.message}` }));
		child.once("spawn", () => {
			vgJobs.set(jobId, job);
			resolve({ ok: true, jobId });
		});
	});
}

export function valgrindStatus(
	jobId: string,
):
	| { ok: true; status: string; output: string; exitCode?: number; elapsedSecs?: number }
	| { ok: false; error: string } {
	const job = vgJobs.get(jobId);
	if (!job) return { ok: false, error: `job '${jobId}' not found` };
	if (job.done) return { ok: true, status: "done", output: job.output };
	const elapsed = Date.now() - job.startTime;
	if (elapsed >= job.timeoutMs) {
		try {
			job.child.kill("SIGKILL");
		} catch {
			/* gone */
		}
		job.done = true;
		job.output += "\n[TIMEOUT]";
		return { ok: true, status: "timeout", output: job.output };
	}
	drain(job);
	if (job.child.exitCode !== null) {
		job.done = true;
		job.output += `\n[EXIT CODE: ${job.child.exitCode}]`;
		return { ok: true, status: "done", exitCode: job.child.exitCode, output: job.output };
	}
	return { ok: true, status: "running", elapsedSecs: Math.floor(elapsed / 1000), output: job.output };
}

export function runningValgrindCount(): number {
	let n = 0;
	for (const rec of vgJobs.values()) if (!rec.done) n++;
	return n;
}

export function killAllValgrind(): void {
	for (const rec of vgJobs.values()) {
		try {
			rec.child.kill("SIGKILL");
		} catch {
			/* gone */
		}
	}
	vgJobs.clear();
}

function drain(job: ValgrindRecord): void {
	for (const stream of [job.child.stdout, job.child.stderr]) {
		if (!stream) continue;
		while (true) {
			const chunk = stream.read();
			if (chunk === null) break;
			job.output += chunk.toString("utf8");
		}
	}
}
