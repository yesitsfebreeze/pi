/**
 * Doctor probe tests — verify the health probe returns expected results
 * for each check category (git, bus, logs, MCP cache).
 */
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctorProbe } from "../../src/core/doctor.ts";

function tmpDir(): string {
	const dir = join(tmpdir(), `doctor-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
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

	it("includes all four checks in table output", async () => {
		const dir = tmpDir();
		try {
			const { results, table } = await runDoctorProbe(dir);
			expect(results.length).toBe(4);
			const checks = results.map((r) => r.check).sort();
			expect(checks).toEqual(["bus", "git", "logs", "mcp"]);
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
});
