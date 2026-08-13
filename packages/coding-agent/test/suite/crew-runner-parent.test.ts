/**
 * Crew runner — parentSessionId persistence. The session-tree nests sub-agents
 * under their parent by `run.parentSessionId`, which the runner persists to
 * meta.json and restores on load(). This guards the round-trip so a restarted
 * host still nests sub-agents under the right parent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { load, runs, stopAll } from "../../src/core/crew/runner.ts";

describe("crew runner — parentSessionId persistence", () => {
	let stateDir: string;
	const origXdg = process.env.XDG_STATE_HOME;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "pi-crew-state-"));
		process.env.XDG_STATE_HOME = stateDir;
	});

	afterEach(() => {
		stopAll();
		// Clear any runs that load() may have inserted.
		for (const k of [...runs.keys()]) runs.delete(k);
		if (origXdg === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = origXdg;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("load() restores parentSessionId from a persisted meta.json", () => {
		// The repo slug is derived from the repo path; write meta under that slug.
		const repo = "/tmp/myrepo";
		// Mirror repoDir(): stateRoot()/slug(repo). slug strips leading slashes
		// and replaces non-word chars with "-".
		const slug = "tmp-myrepo";
		const runDir = join(stateDir, "pi", "crew", slug, "worker-42");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "meta.json"),
			JSON.stringify({
				handle: "worker-42",
				agent: "worker",
				task: "do something",
				cwd: repo,
				sessionId: "crew-worker-42-deadbeef",
				state: "done",
				started: Date.now(),
				ended: Date.now(),
				tools: 0,
				turns: 0,
				resumes: 0,
				depth: 1,
				parentSessionId: "parent-session-id-xyz",
			}),
		);

		const n = load(repo);
		expect(n).toBe(1);
		const run = runs.get("worker-42");
		expect(run).toBeDefined();
		expect(run!.parentSessionId).toBe("parent-session-id-xyz");
		// A persisted "done" state is restored verbatim (not downgraded).
		expect(run!.state).toBe("done");
	});

	it("load() restores a persisted running run as interrupted (not resumed as live)", () => {
		const repo = "/tmp/runningrepo";
		const slug = "tmp-runningrepo";
		const runDir = join(stateDir, "pi", "crew", slug, "worker-7");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "meta.json"),
			JSON.stringify({
				handle: "worker-7",
				agent: "worker",
				task: "was running when host died",
				cwd: repo,
				sessionId: "crew-worker-7-aaaa",
				state: "running",
				started: Date.now(),
				tools: 3,
				turns: 2,
				resumes: 0,
				depth: 1,
				parentSessionId: "host-session-123",
			}),
		);

		load(repo);
		const run = runs.get("worker-7");
		expect(run).toBeDefined();
		// A run that was "running" when the host died is marked interrupted, so
		// it does NOT reappear in live() (which only returns running/queued).
		expect(run!.state).toBe("interrupted");
		expect(run!.parentSessionId).toBe("host-session-123");
	});

	it("load() tolerates a meta.json without parentSessionId (old runs)", () => {
		const repo = "/tmp/legacyrepo";
		const slug = "tmp-legacyrepo";
		const runDir = join(stateDir, "pi", "crew", slug, "worker-1");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "meta.json"),
			JSON.stringify({
				handle: "worker-1",
				agent: "worker",
				task: "old run from before parentSessionId existed",
				cwd: repo,
				sessionId: "crew-worker-1-old",
				state: "done",
				started: Date.now(),
				ended: Date.now(),
				tools: 0,
				turns: 0,
				resumes: 0,
				depth: 1,
				// no parentSessionId field
			}),
		);

		load(repo);
		const run = runs.get("worker-1");
		expect(run).toBeDefined();
		expect(run!.parentSessionId).toBeUndefined();
	});
});
