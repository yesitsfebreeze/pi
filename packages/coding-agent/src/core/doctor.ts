// doctor — health probe for pi sessions. One tool the agent can call
// (doctor_probe), one slash command the user can run (/doctor). Checks
// git state, walkie-talkie bus health, log rotation, MCP cache schema health,
// and pi-package test status in the workspace. Iterates all installed
// extensions and runs any health checks they registered via
// pi.registerHealthCheck(). Returns a markdown table sorted by severity.
//
// Wired directly into AgentSession via sdk.ts customTools; no extension layer.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionRunner } from "./extensions/runner.ts";
import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	HealthCheckResult,
	RegisteredHealthCheck,
	ToolDefinition,
} from "./extensions/types.ts";
import { getPiInvocation } from "./pi-invocation.ts";

const execFileP = promisify(execFile);

// Read HOME at call time (not module load) so tests can sandbox pi's state dir.
const getPiHome = (): string => join(homedir(), ".pi");
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
		return {
			check: "git",
			status: "SKIP",
			detail: "not a git repo — without one, memories and .pi artifacts aren't created",
		};
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
		const dir = join(getPiHome(), "agent");
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
	const cachePath = join(getPiHome(), "agent", "mcp-cache.json");
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

/**
 * Find the workspace root for the package probe: walk up from `start` and
 * return the first directory whose package.json declares `workspaces` (a
 * monorepo root), else the highest ancestor that has a package.json at all.
 * The old default `join(cwd, "..")` scanned the repo's *parent* when the
 * session cwd was the repo root — probing unrelated sibling dirs.
 */
function findWorkspaceRoot(start: string): string | null {
	let dir = resolve(start);
	let lastWithPkg: string | null = null;
	while (true) {
		const pkgJson = join(dir, "package.json");
		if (existsSync(pkgJson)) {
			try {
				const manifest = JSON.parse(readFileSync(pkgJson, "utf8"));
				if (manifest.workspaces) return dir;
			} catch {
				/* malformed package.json — keep walking */
			}
			lastWithPkg = dir;
		}
		const parent = dirname(dir);
		if (parent === dir) return lastWithPkg;
		dir = parent;
	}
}

// ── pi packages ─────────────────────────────────────────────────────
// Walk a workspace for pi packages (a `pi` field in package.json) and run each
// one's test suite. A package without tests reports SKIP; a failing suite
// reports FAIL. Ported from the standalone pi-doctor extension.
async function probePackages(workspace: string): Promise<ProbeResult[]> {
	if (!existsSync(workspace)) return [];
	const skip = new Set(["node_modules", "_archive", ".git"]);
	const results: ProbeResult[] = [];
	for (const pkg of readdirSync(workspace)) {
		if (skip.has(pkg) || pkg.startsWith(".")) continue;
		const pkgDir = join(workspace, pkg);
		const pkgJson = join(pkgDir, "package.json");
		if (!existsSync(pkgJson)) continue;
		let manifest: any;
		try {
			manifest = JSON.parse(readFileSync(pkgJson, "utf8"));
		} catch {
			continue;
		}
		if (!manifest.pi) continue;

		const testDir = join(pkgDir, "tests");
		const hasTests = existsSync(testDir) && readdirSync(testDir).some((f) => f.endsWith(".test.mjs"));
		if (!hasTests) {
			results.push({ check: `pkg:${pkg}`, status: "SKIP", detail: "no tests" });
			continue;
		}
		try {
			// maxBuffer: a suite printing more than the 1MB default kills the child
			// with ERR_CHILD_PROCESS_STDIO_MAXBUFFER and reports FAIL — a healthy
			// package would read as broken. 16MB matches runCommand's ceiling.
			await execFileP("npm", ["test"], {
				cwd: pkgDir,
				timeout: 30_000,
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			});
			results.push({ check: `pkg:${pkg}`, status: "PASS", detail: "tests pass" });
		} catch (e: any) {
			const err = (e?.stderr || e?.message || "").slice(0, 80);
			results.push({ check: `pkg:${pkg}`, status: "FAIL", detail: err });
		}
	}
	return results;
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
	/** Workspace to scan for pi packages (default: parent of cwd). */
	workspace?: string;
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

	const workspace = resolved.workspace ?? findWorkspaceRoot(resolved.cwd) ?? "";
	raw.push(...(await probePackages(workspace)));

	const results = sortResults(raw);
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
			"Run a health probe of the current session: git state (clean/dirty), walkie-talkie bus health, pi log sizes, MCP tool-schema health, pi-package test status, plus any health checks registered by installed extensions. Returns a markdown table sorted by severity (FAIL first).",
		promptSnippet:
			"Health probe: git, bus, logs, MCP cache, extension health checks — run before diagnosing an operational problem",
		promptGuidelines: [
			"Call doctor_probe when the user asks about system health, when a tool returns unexpected errors, or before reporting a configuration issue",
		],
		parameters: Type.Object({
			workspace: Type.Optional(
				Type.String({ description: "Path to workspace with pi packages (default: parent of cwd)" }),
			),
		}),
		async execute(
			_id: string,
			_params: unknown,
			signal?: AbortSignal,
			_onUpdate?: AgentToolUpdateCallback,
			ctx?: ExtensionContext,
		) {
			const params = (_params ?? {}) as { workspace?: string };
			const { table } = await runDoctorProbe({
				cwd: ctx?.cwd ?? process.cwd(),
				workspace: params.workspace,
				extensionRunner: getRunner?.(),
				extensionContext: ctx,
				signal,
			});
			return { content: [{ type: "text", text: table }], details: {} };
		},
	};
}

// ── doctor pass (update/heal/audit) ─────────────────────────────────
// The /doctor slash command runs this pass, not the probe table: bring pi +
// packages + repo deps current, heal local state (logs, mcp cache), and audit
// the cwd repo. Returns a plain ✓/✗/· report — the probe table above stays the
// `doctor_probe` tool's job.

const LOG_KEEP_LINES = 2000;
const UPDATE_TIMEOUT_MS = 300_000;

async function runCommand(
	cwd: string,
	command: string,
	args: string[],
	timeoutMs = 120_000,
): Promise<{ ok: boolean; detail: string }> {
	try {
		await execFileP(command, args, {
			cwd,
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
		});
		return { ok: true, detail: "" };
	} catch (e: any) {
		const detail = String(e?.stderr || e?.message || "failed")
			.trim()
			.split("\n")[0]
			.slice(0, 80);
		return { ok: false, detail };
	}
}

/** Truncate oversized pi logs in place to the last LOG_KEEP_LINES lines.
 * In-place (not mv) so a live pi holding an fd keeps writing the same inode. */
function rotateLogs(): { rotated: number; freedBytes: number } {
	let rotated = 0;
	let freedBytes = 0;
	const dir = join(getPiHome(), "agent");
	if (!existsSync(dir)) return { rotated, freedBytes };
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".log")) continue;
		const fp = join(dir, f);
		let content: string;
		try {
			content = readFileSync(fp, "utf8");
		} catch {
			continue;
		}
		const size = Buffer.byteLength(content);
		if (size <= LOG_CAP_BYTES) continue;
		const kept = content.split("\n").slice(-LOG_KEEP_LINES).join("\n");
		try {
			writeFileSync(fp, kept, "utf8");
		} catch {
			continue;
		}
		freedBytes += size - Buffer.byteLength(kept);
		rotated++;
	}
	return { rotated, freedBytes };
}

/** Drop mcp-cache servers carrying a root anyOf/oneOf/allOf — a stale entry
 * bricks the Anthropic tool API with a hard 400 on every turn. */
function healMcpCache(): number {
	const cachePath = join(getPiHome(), "agent", "mcp-cache.json");
	if (!existsSync(cachePath)) return 0;
	try {
		const doc = JSON.parse(readFileSync(cachePath, "utf8"));
		const servers = doc.servers;
		if (!servers || typeof servers !== "object") return 0;
		const BAD = ["anyOf", "oneOf", "allOf"];
		let dropped = 0;
		for (const [name, entry] of Object.entries(servers) as [string, any][]) {
			for (const tool of entry?.tools ?? []) {
				const schema = tool?.inputSchema ?? {};
				if (BAD.some((k) => k in schema)) {
					delete servers[name];
					dropped++;
					break;
				}
			}
		}
		if (dropped > 0) writeFileSync(cachePath, JSON.stringify(doc, null, 2), "utf8");
		return dropped;
	} catch {
		return 0;
	}
}

export interface DoctorPassReport {
	report: string;
	ok: boolean;
}

export async function runDoctorPass(cwd: string): Promise<DoctorPassReport> {
	const lines: string[] = [];
	let oks = 0;
	let fails = 0;
	let notes = 0;
	const push = (mark: "✓" | "✗" | "·", text: string) => {
		lines.push(`${mark} ${text}`);
		if (mark === "✓") oks++;
		else if (mark === "✗") fails++;
		else notes++;
	};
	const section = (title: string) => lines.push(`\n❯ ${title}`);

	// update
	section("update");
	const update = getPiInvocation(["update", "--all"]);
	const upd = await runCommand(cwd, update.command, update.args, UPDATE_TIMEOUT_MS);
	push(upd.ok ? "✓" : "✗", upd.ok ? "pi + packages" : `pi update --all: ${upd.detail}`);

	const models = getPiInvocation(["update", "--models"]);
	const mod = await runCommand(cwd, models.command, models.args, UPDATE_TIMEOUT_MS);
	push(mod.ok ? "✓" : "✗", mod.ok ? "model catalogs" : `pi update --models: ${mod.detail}`);

	const repoUpdate = join(cwd, ".pi", "update.sh");
	if (existsSync(repoUpdate)) {
		const r = await runCommand(cwd, "bash", [repoUpdate]);
		push(r.ok ? "✓" : "✗", r.ok ? ".pi/update.sh" : `.pi/update.sh: ${r.detail}`);
	} else {
		push("·", "no .pi/update.sh in this repo");
	}

	// heal
	section("heal");
	const logs = rotateLogs();
	if (logs.rotated > 0) {
		push(
			"✓",
			`rotated ${logs.rotated} log(s) to last ${LOG_KEEP_LINES} lines — ${Math.round(logs.freedBytes / 1048576)}MB reclaimed`,
		);
	} else {
		push("✓", `no log over ${LOG_CAP_BYTES / 1048576}MB`);
	}
	const dropped = healMcpCache();
	if (dropped > 0) {
		push("✓", `mcp cache healed — dropped ${dropped} stale server(s), re-listed on next start`);
	} else {
		push("✓", "mcp cache clean (no root anyOf/oneOf/allOf)");
	}

	// audit
	section("audit");
	const git = await probeGit(cwd);
	if (git.status === "PASS") push("✓", "git clean");
	else push("·", git.detail);

	const preventions = join(cwd, ".preventions", "check.sh");
	if (existsSync(preventions)) {
		const r = await runCommand(cwd, "bash", [preventions]);
		push(r.ok ? "✓" : "✗", r.ok ? "preventions clean" : `preventions: ${r.detail}`);
	} else {
		push("·", "no .preventions — nothing ledgered");
	}

	const happiness = fails >= 3 ? 1 : fails === 2 ? 2 : fails === 1 ? 3 : notes > 0 ? 4 : 5;
	const word =
		happiness === 5
			? "perfect"
			: happiness === 4
				? "great"
				: happiness === 3
					? "okay"
					: happiness === 2
						? "bad"
						: "really bad";
	lines.push(`\n=== happiness: ${happiness}/5 (${word}) — ${oks} ok, ${fails} fail, ${notes} note ===`);
	lines.push(`=== /doctor done (rc=${fails > 0 ? 1 : 0}) ===`);

	return { report: lines.join("\n"), ok: fails === 0 };
}

