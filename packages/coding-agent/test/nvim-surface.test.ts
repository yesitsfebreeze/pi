/**
 * End-to-end test of the nvim surface auto-injection feature.
 *
 * Spawns a real headless `nvim --listen` instance, connects via the real
 * `connectNvim` transport, opens buffers, and verifies:
 *   1. `NvimSocketClient.getStateBrief()` returns a real structured snapshot.
 *   2. The `nvim-surface` inline extension's `before_agent_start` handler
 *      appends a `<auto-injected-context>` block to the system prompt whose
 *      contents match the live nvim state (mode, cwd, buffers, active file).
 *   3. The handler skips cleanly when disconnected and for slash commands.
 *
 * Skips the whole suite if `nvim` is not on PATH.
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createNvimSurfaceExtension, setNvimSurfaceClient } from "../src/core/nvim/nvim-surface-context.ts";
import { connectNvim } from "../src/core/nvim.ts";

type BeforeAgentStartHandler = (event: {
	prompt: string;
	systemPrompt: string;
}) => Promise<{ systemPrompt?: string } | undefined> | { systemPrompt?: string } | undefined;

function hasNvim(): boolean {
	try {
		const { status } = spawnSync("nvim", ["--version"], { stdio: "ignore" });
		return status === 0;
	} catch {
		return false;
	}
}

// Avoid importing spawnSync at module top just for the guard.
import { spawnSync } from "node:child_process";

const itOrSkip = hasNvim() ? it : it.skip;

describe("nvim surface end-to-end", { timeout: 60_000 }, () => {
	let sock: string;
	let nvimProc: ReturnType<typeof spawn> | undefined;
	let cleanupClient: (() => Promise<void>) | undefined;

	beforeEach(() => {
		sock = join(tmpdir(), `pi-nvim-surface-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
		if (existsSync(sock)) rmSync(sock);
		// Reset the shared holder between tests.
		setNvimSurfaceClient(undefined);
	});

	afterEach(async () => {
		await cleanupClient?.();
		cleanupClient = undefined;
		if (nvimProc && !nvimProc.killed) {
			nvimProc.kill("SIGTERM");
			nvimProc = undefined;
		}
		if (existsSync(sock)) rmSync(sock);
	});

	async function startNvimWithFiles(files: { name: string; content: string }[]): Promise<void> {
		// Create fixture files.
		const dir = join(tmpdir(), `pi-nvim-fix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		for (const f of files) {
			const path = join(dir, f.name);
			spawnSync("mkdir", ["-p", path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : dir], {});
			// Use a small node-free write via printf.
			spawnSync(
				"sh",
				["-c", `mkdir -p '${dir}' && printf '%s' '${f.content.replace(/'/g, "'\\''")}' > '${dir}/${f.name}'`],
				{},
			);
		}
		// Build a startup lua that opens each file and leaves cursor on the first.
		const openCmds = files.map((f) => `vim.cmd.edit('${dir}/${f.name}')`).join(" ");
		nvimProc = spawn("nvim", ["--headless", "--listen", sock, "--cmd", `lua ${openCmds}; vim.cmd('1')`], {
			stdio: "ignore",
		});
		// Wait for socket to appear (nvim startup).
		const ok = await waitForFile(sock, 5000);
		if (!ok) throw new Error("nvim listen socket never appeared");
	}

	itOrSkip("getStateBrief returns live buffers + active window", async () => {
		await startNvimWithFiles([
			{ name: "a.ts", content: "line one\nline two\nline three\n" },
			{ name: "b.ts", content: "hello\nworld\n" },
		]);
		const conn = await connectNvim(sock);
		cleanupClient = async () => {};
		const brief = await conn.client.getStateBrief(2);
		expect(brief, "getStateBrief must not return null").not.toBeNull();
		expect(brief!.mode).toBe("normal");
		expect(brief!.buffers.length).toBeGreaterThanOrEqual(2);
		expect(brief!.buffers.some((b) => b.endsWith("a.ts"))).toBe(true);
		expect(brief!.buffers.some((b) => b.endsWith("b.ts"))).toBe(true);
		expect(brief!.active).toBeTruthy();
		expect(brief!.active?.file.endsWith("b.ts")).toBe(true);
		expect(brief!.active?.line).toBe(1);
		expect(brief!.active?.total_lines).toBe(2);
	});

	itOrSkip("extension injects live surface into system prompt", async () => {
		await startNvimWithFiles([{ name: "inject.ts", content: "alpha\nbeta\ngamma\n" }]);

		const conn = await connectNvim(sock);
		cleanupClient = async () => {};
		// Publish the client so the extension sees it.
		setNvimSurfaceClient(conn.client);

		// Capture the before_agent_start handler via a fake `pi`.
		let captured: BeforeAgentStartHandler | undefined;
		const fakePi = {
			on(_event: string, handler: BeforeAgentStartHandler) {
				captured = handler;
			},
		} as unknown as ExtensionAPI;

		const ext = createNvimSurfaceExtension(2500);
		// InlineExtension may be a bare factory or {name, factory}.
		const factory = "factory" in ext ? ext.factory : ext;
		factory(fakePi);
		expect(captured, "handler must be registered").toBeDefined();

		const result = await captured!({
			prompt: "what file is open?",
			systemPrompt: "BASE",
		});
		expect(result?.systemPrompt, "must return a systemPrompt").toBeDefined();
		const prompt = result!.systemPrompt!;
		expect(prompt.startsWith("BASE\n")).toBe(true);
		expect(prompt).toContain("<auto-injected-context>");
		expect(prompt).toContain("nvim surface (live snapshot at turn start)");
		expect(prompt).toContain("mode: normal");
		expect(prompt).toContain("inject.ts");
	});

	itOrSkip("extension skips when disconnected", async () => {
		// No nvim started; holder stays undefined.
		let captured: BeforeAgentStartHandler | undefined;
		const fakePi = {
			on(_event: string, handler: BeforeAgentStartHandler) {
				captured = handler;
			},
		} as unknown as ExtensionAPI;
		const ext = createNvimSurfaceExtension();
		const factory = "factory" in ext ? ext.factory : ext;
		factory(fakePi);

		const result = await captured!({ prompt: "hi", systemPrompt: "BASE" });
		expect(result).toBeUndefined();
	});

	itOrSkip("extension skips for slash commands", async () => {
		await startNvimWithFiles([{ name: "s.ts", content: "x\n" }]);
		const conn = await connectNvim(sock);
		cleanupClient = async () => {};
		setNvimSurfaceClient(conn.client);

		let captured: BeforeAgentStartHandler | undefined;
		const fakePi = {
			on(_event: string, handler: BeforeAgentStartHandler) {
				captured = handler;
			},
		} as unknown as ExtensionAPI;
		const ext = createNvimSurfaceExtension();
		const factory = "factory" in ext ? ext.factory : ext;
		factory(fakePi);

		const result = await captured!({ prompt: "/nvim", systemPrompt: "BASE" });
		expect(result).toBeUndefined();
	});
});

function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	return new Promise((resolve) => {
		const tick = () => {
			if (existsSync(path)) return resolve(true);
			if (Date.now() - start > timeoutMs) return resolve(false);
			setTimeout(tick, 50);
		};
		tick();
	});
}
