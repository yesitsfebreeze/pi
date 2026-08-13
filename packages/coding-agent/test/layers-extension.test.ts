// layers-extension.test.ts — behavior tests for the layers inline-extension
// (src/core/layers/index.ts). The store.ts plumbing is covered by
// layers-store.test.ts; this file proves the EXTENSION LAYER: that the factory
// registers the expected tools, that tool wrappers route to the store, that
// the cwd/session/agent latch re-asserts on every execute (the gantt/crawl
// pitfall), that metaFor's purpose fallback works, and that the /layers
// command renders the board.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	RegisteredCommand,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { createLayersExtension } from "../src/core/layers/index.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

let dir: string;

const IDENT = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@test",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@test",
};

function sh(args: string[]): string {
	return execFileSync("git", args, { cwd: dir, env: { ...process.env, ...IDENT }, encoding: "utf8" }).trim();
}

/** Like sh but returns "" instead of throwing when the ref doesn't exist. */
function shQuiet(args: string[]): string {
	try {
		return execFileSync("git", args, { cwd: dir, env: { ...process.env, ...IDENT }, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

/** Minimal fake ExtensionAPI that captures tool + command registrations. */
function fakeApi(): ExtensionAPI & {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, RegisteredCommand>;
	handlers: { session_start: ((e: unknown, ctx: ExtensionContext) => void) | null; turn_start: (() => void) | null };
} {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, RegisteredCommand>();
	const handlers = {
		session_start: null as ((e: unknown, ctx: ExtensionContext) => void) | null,
		turn_start: null as (() => void) | null,
	};
	const api = {
		tools,
		commands,
		handlers,
		on(event: string, handler: any) {
			if (event === "session_start") handlers.session_start = handler;
			if (event === "turn_start") handlers.turn_start = handler;
		},
		registerTool(t: ToolDefinition) {
			tools.set(t.name, t);
		},
		registerCommand(name: string, opts: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, { name, sourceInfo: createSyntheticSourceInfo("layers", { source: "inline" }), ...opts });
		},
	} as unknown as ExtensionAPI;
	return api as any;
}

/** Build an ExtensionContext pointing at `dir`, optionally overriding cwd. */
function ctx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		ui: {} as any,
		mode: "tui",
		hasUI: true,
		cwd: dir,
		sessionManager: { getSessionId: () => "sess-x" } as any,
		modelRegistry: {} as any,
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact() {},
		getSystemPrompt: () => "",
		...overrides,
	} as ExtensionContext;
}

function textOf(r: any): string {
	return r.content?.[0]?.text ?? "";
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "layers-ext-"));
	sh(["init", "-q", "-b", "main"]);
	writeFileSync(join(dir, "base.txt"), "hello\n");
	sh(["add", "base.txt"]);
	sh(["commit", "-q", "-m", "base"]);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("layers extension: registration", () => {
	it("registers all ten layer_* tools plus the /layers command", () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const names = [...api.tools.keys()];
		expect(names).toContain("layer_new");
		expect(names).toContain("layer_write");
		expect(names).toContain("layer_edit");
		expect(names).toContain("layer_read");
		expect(names).toContain("layer_rm");
		expect(names).toContain("layer_diff");
		expect(names).toContain("layer_log");
		expect(names).toContain("layer_list");
		expect(names).toContain("layer_test");
		expect(names).toContain("layer_merge");
		expect(names).toContain("layer_discard");
		expect(api.commands.has("layers")).toBe(true);
	});
});

describe("layers extension: layer_new + metadata", () => {
	it("creates a layer ref and persists .pi/layers/<name>.json with purpose", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		const r = await api.tools
			.get("layer_new")!
			.execute("id", { name: "feat", purpose: "add login" }, undefined as any, undefined, c);
		expect(textOf(r)).toMatch(/layer feat created/);
		expect(textOf(r)).toContain("add login");
		// ref exists
		expect(shQuiet(["rev-parse", "--verify", "-q", "refs/layers/feat"])).toBe(sh(["rev-parse", "HEAD"]));
		// metadata persisted
		const meta = JSON.parse(readFileSync(join(dir, ".pi", "layers", "feat.json"), "utf8"));
		expect(meta.name).toBe("feat");
		expect(meta.purpose).toBe("add login");
		expect(meta.state).toBe("developing");
	});

	it("rejects a duplicate layer name with a clear message", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		await api.tools.get("layer_new")!.execute("id", { name: "feat", purpose: "x" }, undefined as any, undefined, c);
		const r = await api.tools
			.get("layer_new")!
			.execute("id", { name: "feat", purpose: "y" }, undefined as any, undefined, c);
		expect(textOf(r)).toMatch(/already exists/);
	});

	it("rejects an invalid layer name", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		const r = await api.tools
			.get("layer_new")!
			.execute("id", { name: "", purpose: "x" }, undefined as any, undefined, c);
		expect(textOf(r)).toMatch(/required/);
	});
});

describe("layers extension: write/read/edit/rm wrappers", () => {
	it("layer_write then layer_read round-trips content and reports layer source", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		await api.tools.get("layer_new")!.execute("id", { name: "feat", purpose: "p" }, undefined as any, undefined, c);
		const w = await api.tools
			.get("layer_write")!
			.execute("id", { layer: "feat", path: "a.txt", content: "layer body\n" }, undefined as any, undefined, c);
		expect(textOf(w)).toMatch(/wrote a\.txt to layer feat/);
		const r = await api.tools
			.get("layer_read")!
			.execute("id", { layer: "feat", path: "a.txt" }, undefined as any, undefined, c);
		expect(textOf(r)).toBe("layer body\n");
	});

	it("layer_edit replaces one occurrence and reports the read source", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		await api.tools.get("layer_new")!.execute("id", { name: "feat", purpose: "p" }, undefined as any, undefined, c);
		await api.tools
			.get("layer_write")!
			.execute("id", { layer: "feat", path: "a.txt", content: "one two\n" }, undefined as any, undefined, c);
		const e = await api.tools
			.get("layer_edit")!
			.execute("id", { layer: "feat", path: "a.txt", old: "one", new: "three" }, undefined as any, undefined, c);
		expect(textOf(e)).toMatch(/edited a\.txt in layer feat/);
		const r = await api.tools
			.get("layer_read")!
			.execute("id", { layer: "feat", path: "a.txt" }, undefined as any, undefined, c);
		expect(textOf(r)).toBe("three two\n");
	});

	it("layer_write on a nonexistent layer fails (no silent no-op)", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		const r = await api.tools
			.get("layer_write")!
			.execute("id", { layer: "nope", path: "a.txt", content: "x" }, undefined as any, undefined, c);
		expect(textOf(r)).toMatch(/no such layer/);
	});

	it("layer_rm removes a file and reports the commit", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		await api.tools.get("layer_new")!.execute("id", { name: "feat", purpose: "p" }, undefined as any, undefined, c);
		await api.tools
			.get("layer_write")!
			.execute("id", { layer: "feat", path: "a.txt", content: "x\n" }, undefined as any, undefined, c);
		const r = await api.tools
			.get("layer_rm")!
			.execute("id", { layer: "feat", path: "a.txt" }, undefined as any, undefined, c);
		expect(textOf(r)).toMatch(/removed a\.txt from layer feat/);
		const after = await api.tools
			.get("layer_read")!
			.execute("id", { layer: "feat", path: "a.txt" }, undefined as any, undefined, c);
		expect(textOf(after)).toMatch(/no such file/);
	});
});

describe("layers extension: diff / list / log / merge / discard", () => {
	it("layer_diff shows the layer's changes vs its fork point", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		await api.tools.get("layer_new")!.execute("id", { name: "feat", purpose: "p" }, undefined as any, undefined, c);
		await api.tools
			.get("layer_write")!
			.execute("id", { layer: "feat", path: "a.txt", content: "new\n" }, undefined as any, undefined, c);
		const r = await api.tools.get("layer_diff")!.execute("id", { layer: "feat" }, undefined as any, undefined, c);
		expect(textOf(r)).toContain("+new");
	});

	it("layer_list reports state, file count, and purpose", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		await api.tools
			.get("layer_new")!
			.execute("id", { name: "feat", purpose: "do thing" }, undefined as any, undefined, c);
		await api.tools
			.get("layer_write")!
			.execute("id", { layer: "feat", path: "a.txt", content: "x\n" }, undefined as any, undefined, c);
		const r = await api.tools.get("layer_list")!.execute("id", {}, undefined as any, undefined, c);
		expect(textOf(r)).toMatch(/feat\s+\[developing\]\s+1 file\(s\)/);
		expect(textOf(r)).toContain("do thing");
	});

	it("layer_list with no layers reports the empty state", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		const r = await api.tools.get("layer_list")!.execute("id", {}, undefined as any, undefined, c);
		expect(textOf(r)).toBe("(no layers)");
	});

	it("layer_log surfaces provenance trailers and filters by purpose", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		await api.tools
			.get("layer_new")!
			.execute("id", { name: "feat", purpose: "fix bug" }, undefined as any, undefined, c);
		await api.tools
			.get("layer_write")!
			.execute("id", { layer: "feat", path: "a.txt", content: "x\n" }, undefined as any, undefined, c);
		const all = await api.tools.get("layer_log")!.execute("id", {}, undefined as any, undefined, c);
		expect(textOf(all)).toMatch(/fix bug/);
		const filtered = await api.tools
			.get("layer_log")!
			.execute("id", { purpose: "nope" }, undefined as any, undefined, c);
		expect(textOf(filtered)).toBe("(no matching commits)");
	});

	it("layer_merge squash-merges onto the current branch and cleans up the layer", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		await api.tools
			.get("layer_new")!
			.execute("id", { name: "feat", purpose: "ship" }, undefined as any, undefined, c);
		await api.tools
			.get("layer_write")!
			.execute("id", { layer: "feat", path: "a.txt", content: "merged\n" }, undefined as any, undefined, c);
		const r = await api.tools.get("layer_merge")!.execute("id", { layer: "feat" }, undefined as any, undefined, c);
		expect(textOf(r)).toMatch(/merged layer feat onto main/);
		expect(sh(["show", "HEAD:a.txt"]).trim()).toBe("merged");
		// layer ref + metadata gone
		expect(shQuiet(["rev-parse", "--verify", "-q", "refs/layers/feat"])).toBe("");
		expect(existsSync(join(dir, ".pi", "layers", "feat.json"))).toBe(false);
	});

	it("layer_merge on a missing layer fails with metadata-not-found", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		const r = await api.tools.get("layer_merge")!.execute("id", { layer: "ghost" }, undefined as any, undefined, c);
		expect(textOf(r)).toMatch(/no such layer/);
	});

	it("layer_discard drops the ref and metadata", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		await api.tools.get("layer_new")!.execute("id", { name: "feat", purpose: "p" }, undefined as any, undefined, c);
		const r = await api.tools.get("layer_discard")!.execute("id", { layer: "feat" }, undefined as any, undefined, c);
		expect(textOf(r)).toMatch(/discarded layer feat/);
		expect(shQuiet(["rev-parse", "--verify", "-q", "refs/layers/feat"])).toBe("");
		expect(existsSync(join(dir, ".pi", "layers", "feat.json"))).toBe(false);
	});
});

describe("layers extension: cwd latch (the gantt/crawl pitfall)", () => {
	it("tool execute re-asserts cwd from ctx even after session_start latched a stale cwd", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);

		// Simulate session_start in a DIFFERENT directory (the stale latch).
		const staleDir = mkdtempSync(join(tmpdir(), "layers-stale-"));
		try {
			sh_in(staleDir, ["init", "-q", "-b", "main"]);
			writeFileSync(join(staleDir, "x.txt"), "y\n");
			sh_in(staleDir, ["add", "x.txt"]);
			sh_in(staleDir, ["commit", "-q", "-m", "base"]);

			// session_start fires with the WRONG cwd first
			const staleCtx = ctx({ cwd: staleDir, sessionManager: { getSessionId: () => "stale" } as any });
			api.handlers.session_start?.({}, staleCtx as any);

			// Now a tool execute arrives with the CORRECT cwd (dir).
			// The latch must re-assert cwd=dir, so the layer is created in `dir`,
			// not staleDir. Failure mode: the layer ref lands in the stale repo.
			const r = await api.tools
				.get("layer_new")!
				.execute("id", { name: "feat", purpose: "p" }, undefined as any, undefined, ctx({ cwd: dir }));

			expect(textOf(r)).toMatch(/layer feat created/);
			// ref in `dir`, NOT in staleDir
			expect(shQuiet(["rev-parse", "--verify", "-q", "refs/layers/feat"])).not.toBe("");
			expect(sh_inQuiet(staleDir, ["rev-parse", "--verify", "-q", "refs/layers/feat"])).toBe("");
		} finally {
			rmSync(staleDir, { recursive: true, force: true });
		}
	});
});

describe("layers extension: /layers command", () => {
	it("lists layers with state and file count", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		await api.tools.get("layer_new")!.execute("id", { name: "feat", purpose: "p" }, undefined as any, undefined, c);
		await api.tools
			.get("layer_write")!
			.execute("id", { layer: "feat", path: "a.txt", content: "x\n" }, undefined as any, undefined, c);

		const notes: string[] = [];
		const cmdCtx = { ...c, ui: { notify: (t: string) => notes.push(t) } } as any;
		await api.commands.get("layers")!.handler("list", cmdCtx);
		expect(notes.join("\n")).toMatch(/feat\s+\[developing\]\s+1 file\(s\)/);
	});

	it("reports none when there are no layers", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const notes: string[] = [];
		const cmdCtx = { ...ctx(), ui: { notify: (t: string) => notes.push(t) } } as any;
		await api.commands.get("layers")!.handler("list", cmdCtx);
		expect(notes.join("\n")).toMatch(/none/);
	});

	it("log subcommand filters by purpose", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		const c = ctx();
		await api.tools
			.get("layer_new")!
			.execute("id", { name: "feat", purpose: "fix bug" }, undefined as any, undefined, c);
		await api.tools
			.get("layer_write")!
			.execute("id", { layer: "feat", path: "a.txt", content: "x\n" }, undefined as any, undefined, c);

		const notes: string[] = [];
		const cmdCtx = { ...c, ui: { notify: (t: string) => notes.push(t) } } as any;
		await api.commands.get("layers")!.handler("log fix", cmdCtx);
		expect(notes.join("\n")).toMatch(/fix bug/);

		notes.length = 0;
		await api.commands.get("layers")!.handler("log nope", cmdCtx);
		expect(notes.join("\n")).toMatch(/no matching commits/);
	});

	it("unknown subcommand warns", async () => {
		const api = fakeApi();
		createLayersExtension().factory(api);
		let kind = "info";
		const notes: string[] = [];
		const cmdCtx = {
			...ctx(),
			ui: {
				notify: (t: string, k: "info" | "warning" | "error" = "info") => {
					notes.push(t);
					kind = k;
				},
			},
		} as any;
		await api.commands.get("layers")!.handler("frobnicate", cmdCtx);
		expect(notes.join("\n")).toMatch(/unknown/);
		expect(kind).toBe("warning");
	});
});

function sh_in(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, env: { ...process.env, ...IDENT }, encoding: "utf8" }).trim();
}

function sh_inQuiet(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, env: { ...process.env, ...IDENT }, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}
