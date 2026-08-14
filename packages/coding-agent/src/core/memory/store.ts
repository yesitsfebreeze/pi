// memory store — thin TypeScript wrapper around the kern CLI.
// Kern handles storage, embedding, and semantic search. This module
// provides a typed interface + the shared store API (globalThis.__kern).
// Fail-open: no kern on PATH degrades to a plain session.

import { execFile } from "node:child_process";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const KERN_BIN = "kern";
// kern one-shot CLI pays ~4.5s of in-process index rebuild at startup (see
// kern docs/plans/RECALL_PLAN.md, F4). Timeouts must clear that before the
// pipeline (11ms) even runs, or every tool call fails as if kern were dead.
const TIMEOUT = 20000;

// execFile kills on timeout with code ETIMEDOUT (and killed: true on older
// Node) — the one failure class that is NOT "kern missing", and must not be
// reported as such.
function isTimeout(e: unknown): boolean {
	const err = e as { code?: string; killed?: boolean };
	return err?.code === "ETIMEDOUT" || err?.killed === true;
}

export interface RunResult {
	out: string;
	timedOut: boolean;
}

export interface IngestResult {
	id: string | undefined;
	timedOut: boolean;
}

export interface ThoughtHit {
	id: string;
	text: string;
}

export interface QueryResult {
	hits: ThoughtHit[];
	// Graph chains from the "--- Connections ---" section the CLI already
	// computes; previously parsed away and dropped.
	chains: string[];
	timedOut: boolean;
}

// ── store base latch ────────────────────────────────────────────────────
// The kern store lives at <repo-root>/.pi/kern (moved from .kern). kern
// resolves its base directory via the KERN_DIR env var; without it kern
// defaults to `.kern` and boots an empty graph in the repo root. Latched on
// session_start and re-asserted per call path (same pattern as
// setOntologyRoot), so a cwd switch can't send a later tool to the wrong store.
let _kernRoot = process.cwd();
export function setKernRoot(root: string): void {
	_kernRoot = root;
}

function kernEnv(): NodeJS.ProcessEnv {
	// A pre-set KERN_DIR pins the store (the shared/home store across repos);
	// otherwise default to the per-repo <root>/.pi/kern (F5: escape hatch).
	const dir = process.env.KERN_DIR || join(_kernRoot, ".pi", "kern");
	return { ...process.env, KERN_DIR: dir };
}

export interface ThoughtRecord {
	id: string;
	text: string;
}

export interface EdgeRecord {
	id: string;
	fromId: string;
	toId: string;
	reason: string;
}

// ── shared API (globalThis.__kern) ──────────────────────────────────────

async function ingest(lines: string[], timeoutMs = TIMEOUT): Promise<IngestResult | undefined> {
	if (!lines.length) return undefined;
	const file = join(tmpdir(), `kern-mem-${process.pid}-${Date.now()}.md`);
	try {
		writeFileSync(file, `${lines.join("\n")}\n`);
	} catch {
		return undefined;
	}
	try {
		const { stdout } = await execFileP(KERN_BIN, ["ingest", "--file", file], {
			timeout: timeoutMs,
			encoding: "utf8",
			env: kernEnv(),
		});
		const stdoutStr = stdout ?? "";
		// kern output: "ingested <text> (status=committed chunks=1)" — no stable ID
		if (stdoutStr.includes("ingested")) return { id: "ok", timedOut: false };
		const idMatch = stdoutStr.match(/id:\s*(\S+)/i) ?? stdoutStr.match(/doc_id:\s*"?(\S+)"?/i);
		return { id: idMatch?.[1] ?? undefined, timedOut: false };
	} catch (e) {
		return { id: undefined, timedOut: isTimeout(e) };
	} finally {
		try {
			rmSync(file, { force: true });
		} catch {
			/* leak */
		}
	}
}

async function run(args: string[], timeoutMs = TIMEOUT): Promise<RunResult> {
	try {
		const { stdout } = await execFileP(KERN_BIN, args, { timeout: timeoutMs, encoding: "utf8", env: kernEnv() });
		return { out: stdout ?? "", timedOut: false };
	} catch (e) {
		return { out: "", timedOut: isTimeout(e) };
	}
}

let kernAvailable_: boolean | null = null;
function kernAvailable(): boolean {
	// Opt-out for tests and sandboxes. `kern` writes an LMDB store into
	// `<root>/.pi/kern/`, and the memory extension probes it from session_start
	// on every session — so a suite that builds sessions in temp dirs behaves
	// differently depending on whether the developer happens to have kern
	// installed, and races its own teardown against the store being created.
	if (process.env.PI_KERN_OFF === "1") return false;
	if (kernAvailable_ !== null) return kernAvailable_;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		try {
			if (statSync(join(dir, KERN_BIN)).isFile()) {
				kernAvailable_ = true;
				return true;
			}
		} catch {}
	}
	kernAvailable_ = false;
	return false;
}

export async function storeDecision(
	title: string,
	text: string,
	conf = 0.9,
	extra?: string[],
): Promise<IngestResult | undefined> {
	if (!kernAvailable()) return undefined;
	const lines = [`# Decision: ${title}`, `confidence: ${conf}`, `at: ${new Date().toISOString()}`, "", text];
	if (extra?.length) lines.push("", ...extra.map((l) => `- ${l}`));
	return ingest(lines);
}

export async function storeObservation(
	title: string,
	text: string,
	extra?: string[],
): Promise<IngestResult | undefined> {
	if (!kernAvailable()) return undefined;
	const lines = [`# Observation: ${title}`, `at: ${new Date().toISOString()}`, "", text];
	if (extra?.length) lines.push("", ...extra.map((l) => `- ${l}`));
	return ingest(lines);
}

export async function storeLink(fromId: string, toId: string, reason: string): Promise<void> {
	if (!kernAvailable()) return;
	await run(["link", fromId, toId, "--reason", reason]);
}

// ── tool-facing operations ──────────────────────────────────────────────

export async function ingestBlock(lines: string[]): Promise<number> {
	if (!kernAvailable() || !lines.length) return 0;
	const file = join(tmpdir(), `kern-block-${process.pid}-${Date.now()}.md`);
	try {
		writeFileSync(file, `${lines.join("\n")}\n`);
	} catch {
		return 0;
	}
	try {
		await execFileP(KERN_BIN, ["ingest", "--file", file], {
			timeout: TIMEOUT + lines.length * 500,
			encoding: "utf8",
			env: kernEnv(),
		});
		return lines.length;
	} catch {
		return 0;
	} finally {
		try {
			rmSync(file, { force: true });
		} catch {}
	}
}

export async function ingestOne(
	text: string,
	opts?: {
		objectId?: string;
		source?: string;
	},
): Promise<IngestResult | undefined> {
	if (!kernAvailable()) return undefined;
	const file = join(tmpdir(), `kern-one-${process.pid}-${Date.now()}.md`);
	try {
		writeFileSync(file, `${text}\n`);
	} catch {
		return undefined;
	}
	try {
		const args = ["ingest", "--file", file];
		if (opts?.objectId) args.push("--object-id", opts.objectId);
		const { stdout } = await execFileP(KERN_BIN, args, { timeout: TIMEOUT, encoding: "utf8", env: kernEnv() });
		const out = stdout ?? "";
		if (out.includes("ingested")) return { id: "ok", timedOut: false };
		const idMatch = out.match(/id:\s*(\S+)/i);
		return { id: idMatch?.[1] ?? undefined, timedOut: false };
	} catch (e) {
		return { id: undefined, timedOut: isTimeout(e) };
	} finally {
		try {
			rmSync(file, { force: true });
		} catch {}
	}
}

export async function queryThoughts(query: string, limit = 10): Promise<QueryResult> {
	if (!kernAvailable() || !query.trim() || query.trim().length < 3) return { hits: [], chains: [], timedOut: false };
	const { out, timedOut } = await run(["query", query], TIMEOUT);
	if (timedOut) return { hits: [], chains: [], timedOut: true };
	if (!out || out.includes("no results")) return { hits: [], chains: [], timedOut: false };
	const lines = out.split("\n");
	// parse output: "1. [1.2420] b94d27b9934d  hello world"
	const hits: ThoughtHit[] = lines
		.filter((l) => /^\d+\.\s+\[[\d.]+\]\s+/.test(l))
		.slice(0, limit)
		.map((l) => {
			const m = l.match(/^\d+\.\s+\[([\d.]+)\]\s+(\S+)\s+(.*)/);
			return { id: m?.[2] ?? "", text: m?.[3] ?? l };
		});
	return { hits, chains: extractChains(lines), timedOut: false };
}

// The CLI prints "--- Connections ---" then one "Chain N:" block per path.
// Keep the chain headers' indented body so the graph shape survives delivery.
function extractChains(lines: string[]): string[] {
	const idx = lines.findIndex((l) => l.trim().startsWith("--- Connections ---"));
	if (idx < 0) return [];
	const chains: string[] = [];
	let cur: string[] = [];
	for (const l of lines.slice(idx + 1)) {
		if (/^Chain \d+:/.test(l.trim())) {
			if (cur.length) chains.push(cur.join("\n"));
			cur = [l.trim()];
		} else if (cur.length) {
			const t = l.trim();
			if (t) cur.push(t);
		}
	}
	if (cur.length) chains.push(cur.join("\n"));
	return chains;
}

export async function forgetSource(source: string, force = false): Promise<{ removed: number; timedOut: boolean }> {
	if (!kernAvailable()) return { removed: 0, timedOut: false };
	const args = ["forget", "--source", source];
	if (force) args.push("--force");
	const { out, timedOut } = await run(args);
	// kern reports "forgot N thoughts from <source> …" — surface the real count.
	const m = out.match(/forgot\s+(\d+)\s+thoughts/i);
	return { removed: m ? parseInt(m[1], 10) : 0, timedOut };
}

export async function memoryHealth(): Promise<{ thoughts: number; edges: number } | null> {
	if (!kernAvailable()) return null;
	const { out } = await run(["health"]);
	if (!out) return null;
	const tMatch = out.match(/thoughts:\s+(\d+)/);
	const rMatch = out.match(/reasons:\s+(\d+)/);
	if (!tMatch || !rMatch) return null;
	const health = { thoughts: parseInt(tMatch[1], 10), edges: parseInt(rMatch[1], 10) };
	cachedHealth = health;
	return health;
}

export { kernAvailable };

// ── synchronous snapshot for UI surfaces ────────────────────────────────
// The status line (overall thought/reason count) and delta line (thoughts
// ingested by the most recent <kern> block) read these synchronously at
// render time; the memory extension writes them on its lifecycle hooks.
let cachedHealth: { thoughts: number; edges: number } | null = null;
let lastIngestCount = 0;

export function setLastIngestCount(n: number): void {
	lastIngestCount = n;
}

export function getKernSnapshot(): { health: { thoughts: number; edges: number } | null; lastIngested: number } {
	return { health: cachedHealth, lastIngested: lastIngestCount };
}
