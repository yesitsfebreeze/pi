// doctor — health probe for pi sessions. One tool the agent can call
// (doctor_probe), one slash command the user can run (/doctor). Checks
// git state, walkie-talkie bus health, log rotation, and MCP cache schema
// health. Iterates all installed extensions and runs any health checks they
// registered via pi.registerHealthCheck(). Returns a markdown table sorted by
// severity.
//
// Wired directly into AgentSession via sdk.ts customTools; no extension layer.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	HealthCheckResult,
	RegisteredHealthCheck,
	ToolDefinition,
} from "./extensions/types.ts";
import type { ExtensionRunner } from "./extensions/runner.ts";

const execFileP = promisify(execFile);

const PI_HOME = join(homedir(), ".pi");
const LOG_CAP_BYTES = 5 * 1024 * 1024; // 5MB
const HEALTH_CHECK_DEFAULT_TIMEOUT_MS = 10_000;

// ── probes ───────────────────────────────────────────────────────────

export interface ProbeResult {
	check: string;
	status: "FAIL" | "DIRTY" | "PASS" | "OK" | "SKIP";
	detail: string;
}

async function probeGit(cwd: string): Promise<ProbeResult> {
	try {
		const { stdout } = await execFileP("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf8",
			timeout: 5000,
		});
		const lines = stdout.trim().split("\n").filter(Boolean);
		if (lines.length === 0) return { check: "git", status: "PASS", detail: "clean" };
		return { check: "git", status: "DIRTY", detail: `${lines.length} uncommitted file(s)` };
	} catch {
		return { check: "git", status: "SKIP", detail: "not a git repo" };
	}
}

function probeBus(): ProbeResult {
	const root = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "pi", "walkie-talkie");
	if (!existsSync(root)) return { check: "bus", status: "SKIP", detail: "no walkie-talkie channel yet" };
	try {
		let sessions = 0;
		let channels = 0;
		for (const c of readdirSync(root)) {
			const active = join(root, c, "active");
			if (!existsSync(active)) continue;
			channels++;
			for (const f of readdirSync(active)) {
				if (f.endsWith(".json")) sessions++;
			}
		}
		if (sessions === 0) return { check: "bus", status: "OK", detail: `${channels} channel(s), no active sessions` };
		return { check: "bus", status: "OK", detail: `${sessions} active session(s) on ${channels} channel(s)` };
	} catch {
		return { check: "bus", status: "SKIP", detail: "cannot read channel" };
	}
}

function probeLogs(): ProbeResult {
	let oversized = 0;
	try {
		const dir = join(PI_HOME, "agent");
		if (!existsSync(dir)) return { check: "logs", status: "SKIP", detail: "no pi agent dir" };
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".log")) continue;
			const fp = join(dir, f);
			try {
				const size = readFileSync(fp).length;
				if (size > LOG_CAP_BYTES) oversized++;
			} catch {
				// unreadable
			}
		}
		if (oversized === 0)
			return { check: "logs", status: "PASS", detail: `under ${LOG_CAP_BYTES / 1024 / 1024}MB cap` };
		return { check: "logs", status: "DIRTY", detail: `${oversized} log(s) over ${LOG_CAP_BYTES / 1024 / 1024}MB` };
	} catch {
		return { check: "logs", status: "SKIP", detail: "cannot scan logs" };
	}
}

function probeMcpCache(): ProbeResult {
	const cachePath = join(PI_HOME, "agent", "mcp-cache.json");
	if (!existsSync(cachePath)) return { check: "mcp", status: "SKIP", detail: "no cache — nothing to check" };
	try {
		const doc = JSON.parse(readFileSync(cachePath, "utf8"));
		const servers = doc.servers;
		if (!servers || typeof servers !== "object") return { check: "mcp", status: "PASS", detail: "clean" };
		const BAD = new Set(["anyOf", "oneOf", "allOf"]);
		const stale: string[] = [];
		for (const [name, entry] of Object.entries(servers) as [string, any][]) {
			for (const tool of entry?.tools ?? []) {
				const schema = tool?.inputSchema ?? {};
				for (const k of BAD) {
					if (k in schema) {
						stale.push(`${name}/${tool.name}:${k}`);
						break;
					}
				}
			}
		}
		if (stale.length === 0) return { check: "mcp", status: "PASS", detail: `no root combinators` };
		return {
			check: "mcp",
			status: "FAIL",
			detail: `${stale.length} tool(s) with root anyOf/oneOf/allOf — run pi update to refresh`,
		};
	} catch {
		return { check: "mcp", status: "FAIL", detail: "unreadable cache" };
	}
}

// ── extension health checks ─────────────────────────────────────────

function probeExtensionsOverview(runner: ExtensionRunner | undefined): ProbeResult | undefined {
	if (!runner) return undefined;
	const extensions = runner.getExtensionPaths();
	if (extensions.length === 0) return { check: "extensions", status: "OK", detail: "no extensions installed" };
	return {
		check: "extensions",
		status: "OK",
		detail: `${extensions.length} extension(s) loaded`,
	};
}

async function runExtensionHealthCheck(
	registered: RegisteredHealthCheck,
	ctx: ExtensionContext | undefined,
	signal?: AbortSignal,
): Promise<ProbeResult> {
	const { check, sourceInfo } = registered;
	const label = basename(sourceInfo.path) || check.name;
	if (!ctx) {
		return { check: check.name, status: "SKIP", detail: `${label}: no extension context` };
	}
	const timeoutMs = check.timeoutMs ?? HEALTH_CHECK_DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
	// If the caller's signal fires, propagate.
	const onCallerAbort = () => controller.abort(new Error("cancelled"));
	signal?.addEventListener("abort", onCallerAbort, { once: true });
	const cleanup = () => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onCallerAbort);
	};
	try {
		const result = await Promise.race([
			Promise.resolve(check.run(ctx)).then((r) => r as HealthCheckResult),
			new Promise<HealthCheckResult>((_, reject) =>
				controller.signal.addEventListener("abort", () =>
					reject(
						controller.signal.reason instanceof Error
							? controller.signal.reason
							: new Error(String(controller.signal.reason)),
					),
				),
			),
		]);
		return {
			check: check.name,
			status: result.status,
			detail: `${label}: ${result.detail}`,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { check: check.name, status: "FAIL", detail: `${label}: ${msg}` };
	} finally {
		cleanup();
	}
}

async function probeExtensionHealthChecks(
	runner: ExtensionRunner | undefined,
	ctx: ExtensionContext | undefined,
	signal?: AbortSignal,
): Promise<ProbeResult[]> {
	if (!runner) return [];
	const checks = runner.getAllHealthChecks();
	if (checks.length === 0) return [];
	// Run all checks concurrently; each has its own timeout. The overall
	// probe is bounded by the individual check timeouts.
	const results = await Promise.all(checks.map((c) => runExtensionHealthCheck(c, ctx, signal)));
	return results;
}

// ── aggregate probe ─────────────────────────────────────────────────

function sortResults(results: ProbeResult[]): ProbeResult[] {
	const order: Record<string, number> = { FAIL: 0, DIRTY: 1, PASS: 2, OK: 3, SKIP: 4 };
	return [...results].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
}

function formatTable(sorted: ProbeResult[]): string {
	return [
		"| Check | Status | Detail |",
		"|-------|--------|--------|",
		...sorted.map((r) => `| ${r.check} | ${r.status} | ${r.detail} |`),
	].join("\n");
}

export interface DoctorProbeOptions {
	cwd: string;
	extensionRunner?: ExtensionRunner;
	extensionContext?: ExtensionContext;
	signal?: AbortSignal;
}

/** Backward-compatible: accept either a cwd string or the full options object. */
export async function runDoctorProbe(
	opts: DoctorProbeOptions | string,
): Promise<{ results: ProbeResult[]; table: string }> {
	const resolved: DoctorProbeOptions = typeof opts === "string" ? { cwd: opts } : opts;
	const raw: ProbeResult[] = [];
	raw.push(await probeGit(resolved.cwd));
	raw.push(probeBus());
	raw.push(probeLogs());
	raw.push(probeMcpCache());

	const overview = probeExtensionsOverview(resolved.extensionRunner);
	if (overview) raw.push(overview);

	const extensionResults = await probeExtensionHealthChecks(
		resolved.extensionRunner,
		resolved.extensionContext,
		resolved.signal,
	);
	raw.push(...extensionResults);

	// Drop any undefined entries defensively.
	const results = sortResults(raw.filter(Boolean) as ProbeResult[]);
	return { results, table: formatTable(results) };
}

// ── tool definition ─────────────────────────────────────────────────

export interface DoctorProbeToolOptions {
	/** Optional accessor for the live ExtensionRunner, so extension health checks run. */
	getExtensionRunner?: () => ExtensionRunner | undefined;
}

export function createDoctorProbeToolDefinition(options?: DoctorProbeToolOptions): ToolDefinition {
	const getRunner = options?.getExtensionRunner;
	return {
		name: "doctor_probe",
		label: "Doctor Probe",
		description:
			"Run a fast health probe of the current session: git state (clean/dirty), walkie-talkie bus health, pi log sizes, MCP tool-schema health, plus any health checks registered by installed extensions. Returns a markdown table sorted by severity (FAIL first).",
		promptSnippet:
			"Health probe: git, bus, logs, MCP cache, extension health checks — run before diagnosing an operational problem",
		promptGuidelines: [
			"Call doctor_probe when the user asks about system health, when a tool returns unexpected errors, or before reporting a configuration issue",
		],
		parameters: Type.Object({}),
		async execute(
			_id: string,
			_params: unknown,
			signal?: AbortSignal,
			_onUpdate?: AgentToolUpdateCallback,
			ctx?: ExtensionContext,
		) {
			const { table } = await runDoctorProbe({
				cwd: ctx?.cwd ?? process.cwd(),
				extensionRunner: getRunner?.(),
				extensionContext: ctx,
				signal,
			});
			return { content: [{ type: "text", text: table }], details: {} };
		},
	};
}

/**
 * Run the doctor probe with an explicit extension runner and context.
 * Used by the /doctor slash command and other non-tool entry points that
 * have access to the active ExtensionRunner and a real ExtensionContext.
 */
export async function runDoctorProbeFromRunner(
	cwd: string,
	runner?: ExtensionRunner,
	ctx?: ExtensionContext,
): Promise<{ results: ProbeResult[]; table: string }> {
	return runDoctorProbe({ cwd, extensionRunner: runner, extensionContext: ctx });
}
