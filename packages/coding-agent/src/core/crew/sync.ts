import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPiInvocation } from "../pi-invocation.ts";
import type { CrewProfile, SyncOptions, SyncResult, SyncTask, SyncUsage } from "./types.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

async function runSingle(
	profile: CrewProfile,
	task: string,
	opts: SyncOptions,
	signal?: AbortSignal,
): Promise<SyncResult> {
	const cwd = opts.cwdOverride ?? opts.cwd;
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const model = opts.model ?? opts.resolveModel?.(profile) ?? profile.model;
	if (model) args.push("--model", model);
	const thinking = opts.thinking ?? profile.thinking;
	if (thinking) args.push("--thinking", thinking);
	if (profile.tools?.length) args.push("--tools", profile.tools.join(","));

	const briefingParts = [profile.prompt, "", `Task: ${task}`];
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-crew-sync-"));
	const promptPath = path.join(tmpDir, "prompt.md");
	await fs.promises.writeFile(promptPath, briefingParts.join("\n"), { encoding: "utf-8", mode: 0o600 });
	args.push(`@${promptPath}`);

	const invocation = getPiInvocation(args);
	const usage: SyncUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	let modelName: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let stderr = "";
	let finalText = "";

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";
		const processLine = (line: string): void => {
			if (!line.trim()) return;
			let event: Record<string, unknown> | undefined;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				return;
			}
			if (event.type === "message_end" && (event.message as Record<string, unknown>)?.role === "assistant") {
				const msg = event.message as Record<string, unknown>;
				usage.turns++;
				if (msg.usage) {
					const u = msg.usage as Record<string, number>;
					usage.input += u.input || 0;
					usage.output += u.output || 0;
					usage.cacheRead += u.cacheRead || 0;
					usage.cacheWrite += u.cacheWrite || 0;
					usage.cost += (u.cost as unknown as Record<string, number>)?.total || 0;
					usage.contextTokens = u.totalTokens || 0;
				}
				if (msg.model) modelName = String(msg.model);
				if (msg.stopReason) stopReason = String(msg.stopReason);
				if (msg.errorMessage) errorMessage = String(msg.errorMessage);
				const textParts = (msg.content as Array<{ type: string; text: string }>)
					?.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				if (textParts) finalText = textParts;
			}
		};

		proc.stdout!.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr!.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code: number | null) => {
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});

		proc.on("error", () => resolve(1));

		if (signal) {
			const killProc = (): void => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}
	});

	try {
		fs.unlinkSync(promptPath);
		fs.rmdirSync(tmpDir);
	} catch {
		/* cleanup best-effort */
	}

	return {
		agent: profile.name,
		task,
		exitCode,
		output: finalText || "(no output)",
		stderr,
		usage,
		model: modelName,
		stopReason,
		errorMessage,
	};
}

async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function isFailed(r: SyncResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

/** Render the collected usage/model counters as a trailing resource line — the
 *  only place SyncResult.usage/.model are consumed (they were collected on
 *  every run and then discarded). */
function formatSyncUsage(r: SyncResult): string {
	const u = r.usage;
	const parts: string[] = [];
	if (r.model) parts.push(`model: ${r.model}`);
	const tokens = u.input + u.output;
	if (tokens > 0) parts.push(`tokens: ↑${u.input} ↓${u.output}`);
	if (u.cost > 0) parts.push(`cost: $${u.cost.toFixed(4)}`);
	if (u.cacheRead + u.cacheWrite > 0) parts.push(`cache: ${u.cacheRead}r/${u.cacheWrite}w`);
	if (u.turns > 0) parts.push(`turns: ${u.turns}`);
	return parts.length > 0 ? parts.join("  ") : "";
}

export async function runSingleSync(
	profile: CrewProfile,
	task: string,
	opts: SyncOptions,
	signal?: AbortSignal,
): Promise<string> {
	const r = await runSingle(profile, task, opts, signal);
	if (isFailed(r)) {
		const err = r.errorMessage || r.stderr || r.output;
		return `Agent ${r.stopReason || "failed"}: ${err}`;
	}
	const usageLine = formatSyncUsage(r);
	return usageLine ? `${r.output}\n\n${usageLine}` : r.output;
}

export async function runParallelSync(
	profiles: Map<string, CrewProfile>,
	tasks: SyncTask[],
	opts: SyncOptions,
	signal?: AbortSignal,
): Promise<string> {
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`;
	}
	const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t) => {
		const profile = profiles.get(t.agent);
		if (!profile)
			return {
				agent: t.agent,
				task: t.task,
				exitCode: 1,
				output: `Unknown agent: "${t.agent}"`,
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			} satisfies SyncResult;
		return runSingle(profile, t.task, { ...opts, cwdOverride: t.cwd }, signal);
	});

	const successCount = results.filter((r) => !isFailed(r)).length;
	const summaries = results.map((r) => {
		const status = isFailed(r) ? `failed${r.stopReason ? ` (${r.stopReason})` : ""}` : "completed";
		return `### [${r.agent}] ${status}\n\n${r.output}`;
	});
	return `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
}

export async function runChainSync(
	profiles: Map<string, CrewProfile>,
	chain: SyncTask[],
	opts: SyncOptions,
	signal?: AbortSignal,
): Promise<string> {
	let previousOutput = "";
	const allResults: SyncResult[] = [];
	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
		const profile = profiles.get(step.agent);
		if (!profile) {
			const available = [...profiles.keys()].join(", ") || "none";
			return `Unknown agent "${step.agent}" at step ${i + 1}. Available: ${available}`;
		}
		const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
		const r = await runSingle(profile, taskWithContext, { ...opts, cwdOverride: step.cwd }, signal);
		allResults.push(r);
		if (isFailed(r)) {
			const err = r.errorMessage || r.stderr || r.output;
			return `Chain stopped at step ${i + 1} (${step.agent}): ${err}`;
		}
		previousOutput = r.output;
	}
	return allResults[allResults.length - 1].output;
}
