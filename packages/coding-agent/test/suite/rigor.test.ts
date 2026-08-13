import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Rigor uses module-level state keyed by `root`. We import the factory and
// invoke it against an ExtensionAPI stub that captures registerTool calls and
// forwards session_start to set the root + status setter.
function makeApi(_cwd: string) {
	let setStatus: ((key: string, text: string | undefined) => void) | undefined;
	const tools: { name: string; execute: (...args: any[]) => any }[] = [];
	const handlers: Record<string, Array<(...args: any[]) => any>> = {};
	const api: any = {
		on(event: string, h: (...args: any[]) => any) {
			handlers[event] ??= [];
			handlers[event].push(h);
		},
		registerTool(t: any) {
			tools.push(t);
		},
		registerCommand() {},
		sendUserMessage() {},
	};
	async function fire(event: string, ev: any, ctx?: any) {
		let last: any;
		for (const h of handlers[event] ?? []) {
			last = await h(ev, ctx);
		}
		return last;
	}
	return {
		api,
		tools,
		fire,
		setStatusSetter: (fn: typeof setStatus) => {
			setStatus = fn;
		},
	};
}

async function withRigor(cwd: string, fn: (h: ReturnType<typeof makeApi>) => Promise<void>) {
	const { createRigorExtension } = await import("../../src/core/rigor/index.ts");
	const h = makeApi(cwd);
	const ext = createRigorExtension() as any;
	const factory = typeof ext === "function" ? ext : ext.factory;
	factory(h.api);
	await h.fire(
		"session_start",
		{ type: "session_start" },
		{
			cwd,
			ui: { setStatus: () => {} },
		},
	);
	await fn(h);
	await h.fire("session_shutdown", { type: "session_shutdown" }, {});
}

describe("rigor", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("discovers npm script checks and writes plans", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-rigor-"));
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "x", scripts: { test: "vitest --run", build: "tsc", lint: "eslint ." } }),
		);
		writeFileSync(join(dir, "Makefile"), "test:\n\techo hi\ncheck:\n\techo ok\n");

		await withRigor(dir, async (h) => {
			const rigorTool = h.tools.find((t) => t.name === "rigor")!;
			const res = await rigorTool.execute("1", { action: "scan" });
			const text = res.content[0].text;
			expect(text).toContain("check(s)");

			// checks.json + three plan files written
			expect(existsSync(join(dir, ".pi", "rigor", "checks.json"))).toBe(true);
			expect(existsSync(join(dir, ".pi", "rigor", "plan-full.md"))).toBe(true);
			expect(existsSync(join(dir, ".pi", "rigor", "plan-integration.md"))).toBe(true);
			expect(existsSync(join(dir, ".pi", "rigor", "plan-fast.md"))).toBe(true);

			const checks = JSON.parse(readFileSync(join(dir, ".pi", "rigor", "checks.json"), "utf8"));
			const names = checks.discovered.map((c: any) => c.name);
			expect(names).toContain("repo:test");
			expect(names).toContain("repo:build");
			expect(names).toContain("repo:lint");
			expect(names).toContain("repo:make-test");
		});
	});

	it("records a mistake and folds it into plans", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-rigor-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));

		await withRigor(dir, async (h) => {
			const rigorTool = h.tools.find((t) => t.name === "rigor")!;
			await rigorTool.execute("1", { action: "scan" });
			const res = await rigorTool.execute("1", { action: "mistake", text: "forgot to update the snapshot" });
			expect(res.content[0].text).toContain("pitfall(s) on file");

			const plan = readFileSync(join(dir, ".pi", "rigor", "plan-full.md"), "utf8");
			expect(plan).toContain("forgot to update the snapshot");
		});
	});

	it("status reports check counts and auto state", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-rigor-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));

		await withRigor(dir, async (h) => {
			const rigorTool = h.tools.find((t) => t.name === "rigor")!;
			await rigorTool.execute("1", { action: "scan" });
			const res = await rigorTool.execute("1", { action: "status" });
			const text = res.content[0].text;
			expect(text).toContain("checks:");
			expect(text).toMatch(/auto fast check: off/);
		});
	});

	it("reports no checks before a scan", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-rigor-"));
		await withRigor(dir, async (h) => {
			const rigorTool = h.tools.find((t) => t.name === "rigor")!;
			const res = await rigorTool.execute("1", { action: "run", tier: "fast", section: "." });
			expect(res.content[0].text).toContain("rigor: no checks");
		});
	});
});
