/**
 * Forest — write-scope enforcement + worktree dispatch/cleanup.
 * Uses a real git repo fixture so `git worktree` operations are exercised.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createForestExtension } from "../../src/core/forest/index.ts";

function makeApi() {
	const tools: { name: string; execute: Function }[] = {};
	const handlers: Record<string, Function[]> = {};
	const api: any = {
		on(event: string, h: Function) {
			(handlers[event] ??= []).push(h);
		},
		registerTool(t: any) {
			tools[t.name] = t;
		},
		registerCommand() {},
		sendUserMessage() {},
	};
	async function fire(event: string, ev: any, ctx?: any) {
		let last: any;
		for (const h of handlers[event] ?? []) last = await h(ev, ctx);
		return last;
	}
	return { api, tools, fire };
}

function initRepo(dir: string): void {
	execSync("git init -b main", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	writeFileSync(join(dir, "README.md"), "# x");
	execSync("git add . && git commit -m init", { cwd: dir });
}

async function withForest(cwd: string, envScope: string | undefined, fn: (h: any) => Promise<void>) {
	const orig = process.env.PI_WRITE_SCOPE;
	if (envScope === undefined) delete process.env.PI_WRITE_SCOPE;
	else process.env.PI_WRITE_SCOPE = envScope;
	const h = makeApi();
	const ext = createForestExtension();
	ext.factory(h.api);
	await h.fire(
		"session_start",
		{ type: "session_start" },
		{
			cwd,
			ui: { notify: () => {} },
		},
	);
	try {
		await fn(h);
	} finally {
		await h.fire("session_shutdown", { type: "session_shutdown" }, {});
		if (orig === undefined) delete process.env.PI_WRITE_SCOPE;
		else process.env.PI_WRITE_SCOPE = orig;
	}
}

describe("forest", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("dispatch creates an isolated worktree under .pi/trees", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-forest-"));
		initRepo(dir);
		await withForest(dir, undefined, async (h) => {
			const res = await h.tools.forest_dispatch.execute("1", { branch: "feat-x" });
			const text = res.content[0].text;
			expect(text).toContain("worktree:");
			expect(text).toContain("branch: feat-x");
			const wpath = join(dir, ".pi", "trees", "feat-x");
			expect(existsSync(wpath)).toBe(true);
			// write-scope file written inside the worktree
			expect(existsSync(join(wpath, ".pi", "write-scope"))).toBe(true);
		});
	});

	it("list shows created trees and marks merged ones", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-forest-"));
		initRepo(dir);
		await withForest(dir, undefined, async (h) => {
			await h.tools.forest_dispatch.execute("1", { branch: "feat-y" });
			const res = await h.tools.forest_cleanup.execute("1", { action: "list" });
			const text = res.content[0].text;
			expect(text).toContain("feat-y");
		});
	});

	it("remove deletes a tree under .pi/trees", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-forest-"));
		initRepo(dir);
		await withForest(dir, undefined, async (h) => {
			await h.tools.forest_dispatch.execute("1", { branch: "gone-z" });
			const wpath = join(dir, ".pi", "trees", "gone-z");
			expect(existsSync(wpath)).toBe(true);
			const res = await h.tools.forest_cleanup.execute("1", { action: "remove", path: wpath });
			expect(res.content[0].text).toContain("removed");
			expect(existsSync(wpath)).toBe(false);
		});
	});

	it("remove refuses paths outside .pi/trees", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-forest-"));
		initRepo(dir);
		await withForest(dir, undefined, async (h) => {
			const res = await h.tools.forest_cleanup.execute("1", { action: "remove", path: dir });
			expect(res.content[0].text).toContain("refusing to remove");
		});
	});

	it("write-scope blocks writes outside the latched scope", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-forest-"));
		initRepo(dir);
		const outside = mkdtempSync(join(tmpdir(), "pi-forest-out-"));
		try {
			await withForest(dir, dir, async (h) => {
				const block = await h.fire("tool_call", {
					toolName: "write",
					input: { path: join(outside, "sneak.txt") },
				});
				expect(block).toEqual({ block: true, reason: expect.stringContaining("outside scope") });
			});
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("write-scope allows writes inside the latched scope", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-forest-"));
		initRepo(dir);
		await withForest(dir, dir, async (h) => {
			const block = await h.fire("tool_call", {
				toolName: "write",
				input: { path: join(dir, "inside.txt") },
			});
			// inside scope -> no block returned
			expect(block).toBeUndefined();
		});
	});

	it("write-scope parses bash redirect targets", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-forest-"));
		initRepo(dir);
		const outside = mkdtempSync(join(tmpdir(), "pi-forest-out2-"));
		try {
			await withForest(dir, dir, async (h) => {
				const block = await h.fire("tool_call", {
					toolName: "bash",
					input: { command: `echo hi > ${join(outside, "o.txt")}` },
				});
				expect(block).toEqual({ block: true, reason: expect.any(String) });
			});
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
