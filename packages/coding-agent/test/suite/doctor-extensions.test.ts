/**
 * Doctor probe extension integration tests — verifies that health checks
 * registered by extensions via pi.registerHealthCheck() are discovered and
 * run by the doctor probe, with timeout and error handling.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDoctorProbe } from "../../src/core/doctor.ts";
import type { ExtensionContext, HealthCheck, RegisteredHealthCheck } from "../../src/core/extensions/types.ts";
import type { ExtensionRunner } from "../../src/core/extensions/runner.ts";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "doctor-ext-"));
}

/** Minimal fake runner exposing only what the doctor probe uses. */
function fakeRunner(checks: RegisteredHealthCheck[], paths: string[] = ["<inline:fake>"]): ExtensionRunner {
	return {
		getExtensionPaths: () => paths,
		getAllHealthChecks: () => checks,
	} as unknown as ExtensionRunner;
}

function registered(name: string, run: HealthCheck["run"], timeoutMs?: number): RegisteredHealthCheck {
	return {
		check: { name, run, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
		sourceInfo: {
			path: `ext-${name}.ts`,
			source: "local",
			scope: "user",
			origin: "top-level",
		},
	};
}

const fakeCtx = { cwd: tmpDir() } as unknown as ExtensionContext;

describe("doctor probe — extension health checks", () => {
	it("runs a passing extension health check and includes it in the table", async () => {
		const dir = tmpDir();
		try {
			const runner = fakeRunner([
				registered("myext:config", () => ({ status: "PASS", detail: "configured" })),
			]);
			const { results, table } = await runDoctorProbe({ cwd: dir, extensionRunner: runner, extensionContext: fakeCtx });
			const ext = results.find((r) => r.check === "myext:config");
			expect(ext?.status).toBe("PASS");
			expect(ext?.detail).toContain("configured");
			expect(table).toContain("myext:config");
			expect(table).toContain("extensions");
		} finally {
		}
	});

	it("reports FAIL when an extension health check throws", async () => {
		const dir = tmpDir();
		const runner = fakeRunner([
			registered("boom:check", () => {
				throw new Error("kaboom");
			}),
		]);
		const { results } = await runDoctorProbe({ cwd: dir, extensionRunner: runner, extensionContext: fakeCtx });
		const ext = results.find((r) => r.check === "boom:check");
		expect(ext?.status).toBe("FAIL");
		expect(ext?.detail).toContain("kaboom");
	});

	it("times out a slow health check and reports FAIL", async () => {
		const dir = tmpDir();
		const runner = fakeRunner([
			registered(
				"slow:check",
				async () => {
					await new Promise((r) => setTimeout(r, 1000));
					return { status: "PASS", detail: "never" };
				},
				50,
			),
		]);
		const { results } = await runDoctorProbe({ cwd: dir, extensionRunner: runner, extensionContext: fakeCtx });
		const ext = results.find((r) => r.check === "slow:check");
		expect(ext?.status).toBe("FAIL");
		expect(ext?.detail).toContain("timeout");
	});

	it("accepts a HealthCheckResult returned from an async check", async () => {
		const dir = tmpDir();
		const runner = fakeRunner([
			registered("async:ok", async () => ({ status: "OK", detail: "async fine" })),
		]);
		const { results } = await runDoctorProbe({ cwd: dir, extensionRunner: runner, extensionContext: fakeCtx });
		const ext = results.find((r) => r.check === "async:ok");
		expect(ext?.status).toBe("OK");
		expect(ext?.detail).toContain("async fine");
	});

	it("runs multiple extension checks concurrently", async () => {
		const dir = tmpDir();
		const runner = fakeRunner([
			registered("a:check", async () => {
				await new Promise((r) => setTimeout(r, 50));
				return { status: "PASS", detail: "a" };
			}),
			registered("b:check", async () => {
				await new Promise((r) => setTimeout(r, 50));
				return { status: "PASS", detail: "b" };
			}),
		]);
		const start = Date.now();
		const { results } = await runDoctorProbe({ cwd: dir, extensionRunner: runner, extensionContext: fakeCtx });
		const elapsed = Date.now() - start;
		// Both ~50ms checks run concurrently, so total should be well under 100ms.
		expect(elapsed).toBeLessThan(150);
		const names = results.map((r) => r.check).filter((n) => n.startsWith("a:check") || n.startsWith("b:check"));
		expect(names).toHaveLength(2);
	});

	it("shows extensions overview row even with no health checks", async () => {
		const dir = tmpDir();
		const runner = fakeRunner([]);
		const { results } = await runDoctorProbe({ cwd: dir, extensionRunner: runner });
		const overview = results.find((r) => r.check === "extensions");
		expect(overview?.status).toBe("OK");
		expect(overview?.detail).toContain("1 extension");
	});

	it("skips extension checks gracefully when no context is provided", async () => {
		const dir = tmpDir();
		const runner = fakeRunner([registered("noctx:check", () => ({ status: "PASS", detail: "x" }))]);
		const { results } = await runDoctorProbe({ cwd: dir, extensionRunner: runner, extensionContext: undefined });
		const ext = results.find((r) => r.check === "noctx:check");
		expect(ext?.status).toBe("SKIP");
		expect(ext?.detail).toContain("no extension context");
	});
});
