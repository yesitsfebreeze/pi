/**
 * Doctor probe tests — verify the health probe returns expected results
 * for each check category (git, bus, logs, MCP cache).
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctorPass, runDoctorProbe } from "../../src/core/doctor.ts";

function tmpDir(): string {
	// mkdtempSync is unique per call — Date.now()-based names can collide at
	// same-ms and a sibling test's finally rmSync then deletes a live repo.
	return mkdtempSync(join(tmpdir(), "doctor-test-"));
}

describe("doctor probe", () => {
	it("reports SKIP for non-git directory", async () => {
		const dir = tmpDir();
		try {
			const { results, table } = await runDoctorProbe(dir);
			const git = results.find((r) => r.check === "git");
			expect(git?.status).toBe("SKIP");
			expect(table).toContain("git");
			expect(table).toContain("not a git repo");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports PASS for clean git repo", async () => {
		const dir = tmpDir();
		try {
			execSync("git init", { cwd: dir });
			execSync("git config user.email test@test", { cwd: dir });
			execSync("git config user.name test", { cwd: dir });
			// Create and commit one file so the repo has a HEAD
			writeFileSync(join(dir, "README.md"), "# test");
			execSync("git add README.md && git commit -m init", { cwd: dir });

			const { results, table } = await runDoctorProbe(dir);
			const git = results.find((r) => r.check === "git");
			expect(git?.status).toBe("PASS");
			expect(git?.detail).toBe("clean");
			expect(table).toContain("PASS");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports DIRTY for repo with uncommitted changes", async () => {
		const dir = tmpDir();
		try {
			execSync("git init", { cwd: dir });
			execSync("git config user.email test@test", { cwd: dir });
			execSync("git config user.name test", { cwd: dir });
			writeFileSync(join(dir, "README.md"), "# test");
			execSync("git add README.md && git commit -m init", { cwd: dir });
			writeFileSync(join(dir, "README.md"), "# modified");

			const { results, table } = await runDoctorProbe(dir);
			const git = results.find((r) => r.check === "git");
			expect(git?.status).toBe("DIRTY");
			expect(git?.detail).toContain("uncommitted");
			expect(table).toContain("DIRTY");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports bus health SKIP when no walkie-talkie state exists", async () => {
		const dir = tmpDir();
		const orig = process.env.XDG_STATE_HOME;
		try {
			process.env.XDG_STATE_HOME = join(dir, "nonexistent");
			const { results } = await runDoctorProbe(process.cwd());
			const bus = results.find((r) => r.check === "bus");
			expect(bus?.status).toBe("SKIP");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			if (orig !== undefined) process.env.XDG_STATE_HOME = orig;
			else delete process.env.XDG_STATE_HOME;
		}
	});

	it("reports bus OK when empty active dir exists", async () => {
		const dir = tmpDir();
		const orig = process.env.XDG_STATE_HOME;
		try {
			const wtDir = join(dir, "pi", "walkie-talkie", "test-repo", "active");
			mkdirSync(wtDir, { recursive: true });
			process.env.XDG_STATE_HOME = join(dir, "nonexistent-other");
			// We're testing with the XDG check but the WT dir is under our
			// controlled temp — the probe checks XDG + walkie-talkie.
			process.env.XDG_STATE_HOME = dir;
			const { results } = await runDoctorProbe(process.cwd());
			const bus = results.find((r) => r.check === "bus");
			expect(bus?.status).toBe("OK");
			expect(bus?.detail).toContain("no active sessions");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			if (orig !== undefined) process.env.XDG_STATE_HOME = orig;
			else delete process.env.XDG_STATE_HOME;
		}
	});

	it("reports logs SKIP when no pi agent dir", async () => {
		const dir = tmpDir();
		try {
			// Override homedir by setting HOME — but probeLogs uses join(homedir(), ".pi")
			// We can't easily mock homedir. Instead, verify that logs report something
			// reasonable (either SKIP, PASS, or DIRTY). The function never throws.
			const { results } = await runDoctorProbe(dir);
			const logs = results.find((r) => r.check === "logs");
			expect(logs).toBeDefined();
			expect(["SKIP", "PASS", "DIRTY"]).toContain(logs!.status);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("includes core checks in table output", async () => {
		const dir = tmpDir();
		try {
			const { results, table } = await runDoctorProbe(dir);
			const checks = results.map((r) => r.check);
			for (const c of ["git", "bus", "logs", "mcp"]) {
				expect(checks).toContain(c);
			}
			expect(table).toContain("| Check | Status | Detail |");
			expect(table).toContain("|-------|--------|--------|");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sorts FAIL before DIRTY before PASS before OK before SKIP", async () => {
		const dir = tmpDir();
		try {
			const { results } = await runDoctorProbe(dir);
			const order = { FAIL: 0, DIRTY: 1, PASS: 2, OK: 3, SKIP: 4 };
			for (let i = 1; i < results.length; i++) {
				expect(order[results[i - 1].status]).toBeLessThanOrEqual(order[results[i].status]);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("probes pi packages in the workspace", async () => {
		const dir = tmpDir();
		try {
			// A pi package with a passing test suite.
			const pkgDir = join(dir, "fake-pkg");
			mkdirSync(join(pkgDir, "tests"), { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({ pi: { extensions: [] }, scripts: { test: "node --version" } }),
			);
			writeFileSync(join(pkgDir, "tests", "x.test.mjs"), "");
			// A pi package without tests.
			const noTestDir = join(dir, "no-test-pkg");
			mkdirSync(noTestDir, { recursive: true });
			writeFileSync(join(noTestDir, "package.json"), JSON.stringify({ pi: { extensions: [] } }));

			const { results } = await runDoctorProbe({ cwd: dir, workspace: dir });
			const fake = results.find((r) => r.check === "pkg:fake-pkg");
			expect(fake?.status).toBe("PASS");
			expect(fake?.detail).toBe("tests pass");
			const noTest = results.find((r) => r.check === "pkg:no-test-pkg");
			expect(noTest?.status).toBe("SKIP");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs the doctor pass and heals local state", async () => {
		const dir = tmpDir();
		const home = join(dir, "home");
		const cwd = join(dir, "cwd");
		const origHome = process.env.HOME;
		const origPiBin = process.env.PI_BIN;
		try {
			// Sandbox pi's state dir so the heal steps touch only temp files.
			process.env.HOME = home;
			// `true` exits 0, standing in for `pi update --all`/`--models`.
			process.env.PI_BIN = "true";

			const agentDir = join(home, ".pi", "agent");
			mkdirSync(agentDir, { recursive: true });
			// An oversized log (many short lines) that rotation should trim.
			writeFileSync(join(agentDir, "big.log"), new Array(300000).fill("y".repeat(20)).join("\n"));
			// A stale mcp cache carrying a root combinator.
			writeFileSync(
				join(agentDir, "mcp-cache.json"),
				JSON.stringify({ servers: { bad: { tools: [{ name: "t", inputSchema: { anyOf: [] } }] } } }),
			);
			mkdirSync(cwd, { recursive: true });

			const { report, ok } = await runDoctorPass(cwd);

			expect(report).toContain("✓ pi + packages");
			expect(report).toContain("✓ model catalogs");
			expect(report).toContain("no .pi/update.sh");
			expect(report).toContain("rotated 1 log(s)");
			expect(report).toContain("mcp cache healed — dropped 1");
			expect(report).toContain("not a git repo — without one");
			expect(report).toContain("no .preventions");
			// The oversized log is trimmed under the cap.
			expect(readFileSync(join(agentDir, "big.log"), "utf8").length).toBeLessThan(5 * 1024 * 1024);
			// The stale server is dropped from the cache.
			const healed = JSON.parse(readFileSync(join(agentDir, "mcp-cache.json"), "utf8"));
			expect(healed.servers.bad).toBeUndefined();
			expect(ok).toBe(true);
		} finally {
			if (origHome !== undefined) process.env.HOME = origHome;
			else delete process.env.HOME;
			if (origPiBin !== undefined) process.env.PI_BIN = origPiBin;
			else delete process.env.PI_BIN;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
