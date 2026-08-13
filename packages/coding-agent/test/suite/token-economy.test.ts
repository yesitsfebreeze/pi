/**
 * Token-economy tests — the three levers that keep a request small:
 *
 *  - band:        extension tool schemas are cold by default, listed hot
 *  - search-guard: unbounded shell searches never run
 *  - recap strip:  <recap> overlay blocks are not shipped back every turn
 *
 * Each lever has the same invariant: nothing is lost, only deferred. The band
 * lists what it withholds, the guard explains what to run instead, and the
 * session file keeps every recap the wire never sees.
 */
import { describe, expect, it } from "vitest";
import { createVolatileChannel } from "../../src/core/context-injection.ts";
import { getCoreInlineExtensions } from "../../src/core/core-inline-extensions.ts";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { checkCommand, segments } from "../../src/core/search-guard.ts";
import { formatDeferredTools } from "../../src/core/system-prompt.ts";
import { bandTool, deferredSnippet, HOT_TOOLS } from "../../src/core/tools/band.ts";

/**
 * Collect every tool the core inline extensions register at load time, banded
 * the way `createExtensionApi` bands it — this is the surface a real session
 * pays for.
 */
function registeredCoreTools(): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	const pi = new Proxy({} as ExtensionAPI, {
		get(_target, prop: string) {
			if (prop === "registerTool") return (tool: ToolDefinition) => tools.push(bandTool(tool));
			if (prop === "getAllTools" || prop === "getActiveTools") return () => [];
			return () => undefined;
		},
	});
	for (const ext of getCoreInlineExtensions()) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		try {
			factory(pi);
		} catch {
			// A factory that needs a real session is not this test's business.
		}
	}
	return tools;
}

/** A minimal registrable tool. Only the band's view of it matters here. */
function stubTool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		label: name[0].toUpperCase(),
		description: name,
		parameters: {} as never,
		execute: async () => ({ content: [] }),
		...extra,
	} as ToolDefinition;
}

describe("band — cold by default", () => {
	it("defers a tool that is not in the hot set", () => {
		expect(bandTool(stubTool("gantt")).rare).toBe(true);
	});

	it("leaves hot tools and explicit opt-outs alone", () => {
		expect(bandTool(stubTool("crew")).rare).toBeUndefined();
		expect(bandTool(stubTool("custom", { rare: false })).rare).toBe(false);
		// An explicit `rare: true` survives — the band defers, it never un-defers.
		expect(bandTool(stubTool("custom", { rare: true })).rare).toBe(true);
	});

	it("is a no-op when PI_BAND_OFF is set", () => {
		const prev = process.env.PI_BAND_OFF;
		process.env.PI_BAND_OFF = "1";
		try {
			expect(bandTool(stubTool("gantt")).rare).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.PI_BAND_OFF;
			else process.env.PI_BAND_OFF = prev;
		}
	});

	it("bands the core inline extension surface, keeping the hot set callable", () => {
		const tools = registeredCoreTools();
		expect(tools.length).toBeGreaterThan(20);
		const hot = tools.filter((t) => !t.rare).map((t) => t.name);
		expect(hot.length).toBeGreaterThan(0);
		for (const name of hot) expect(HOT_TOOLS.has(name)).toBe(true);
		// The point of the exercise: most of the surface is deferred.
		expect(tools.filter((t) => t.rare).length).toBeGreaterThan(hot.length * 3);
	});

	it("gives every deferred tool a one-liner so it stays discoverable", () => {
		for (const tool of registeredCoreTools().filter((t) => t.rare)) {
			expect(deferredSnippet(tool).length).toBeGreaterThan(0);
		}
	});

	it("renders deferred tools with the restore instruction", () => {
		const block = formatDeferredTools([
			{ name: "gantt", snippet: "routine board" },
			{ name: "crawl", snippet: "web research" },
		]);
		expect(block).toContain('tools({ action: "on", names: ["<tool-name>"] })');
		expect(block).toContain("- crawl — web research");
		// Sorted, so the block is byte-stable across turns and stays cached.
		expect(block.indexOf("- crawl")).toBeLessThan(block.indexOf("- gantt"));
		expect(formatDeferredTools([])).toBe("");
	});
});

describe("search-guard", () => {
	it("blocks find rooted at / without a depth bound", () => {
		expect(checkCommand("find / -name pi.json")).toMatch(/maxdepth/);
		expect(checkCommand("find / -maxdepth 3 -name pi.json")).toBeNull();
		expect(checkCommand("find ~/.config -name pi.json")).toBeNull();
	});

	it("blocks recursive grep over the whole tree without excludes", () => {
		expect(checkCommand("grep -r TODO .")).toMatch(/exclude-dir/);
		expect(checkCommand("grep -rn TODO")).toMatch(/exclude-dir/);
		expect(checkCommand("grep -r TODO src/")).toBeNull();
		expect(checkCommand("grep -r TODO . --exclude-dir=.git --exclude-dir=node_modules")).toBeNull();
		expect(checkCommand("grep TODO file.ts")).toBeNull();
	});

	it("sees a search buried in a compound command", () => {
		expect(checkCommand("ls; find / -name x | head -5")).toMatch(/maxdepth/);
		expect(segments("a; b && c | d")).toHaveLength(4);
		expect(segments("echo 'a; b' | wc")).toHaveLength(2);
	});

	it("honours the per-command override", () => {
		expect(checkCommand("# guard-off\nfind / -name x")).toBeNull();
	});
});

describe("volatile context channel", () => {
	it("emits a custom message, not a system-prompt patch", () => {
		const channel = createVolatileChannel("test");
		const result = channel.emit("hello");
		expect(result?.message?.customType).toBe("test");
		expect(result?.message?.display).toBe(false);
		expect((result as { systemPrompt?: string }).systemPrompt).toBeUndefined();
	});

	it("stays quiet while the content is unchanged", () => {
		const channel = createVolatileChannel("test");
		expect(channel.emit("same")).toBeDefined();
		expect(channel.emit("same")).toBeUndefined();
		expect(channel.emit("different")).toBeDefined();
		channel.reset();
		expect(channel.emit("different")).toBeDefined();
	});

	it("ignores empty content", () => {
		const channel = createVolatileChannel("test");
		expect(channel.emit("")).toBeUndefined();
		expect(channel.emit(undefined)).toBeUndefined();
	});
});

describe("recap stripping", () => {
	const assistant = (text: string) =>
		({ role: "assistant" as const, content: [{ type: "text" as const, text }], timestamp: 0 }) as never;

	it("removes recap blocks from what the model sees", () => {
		const [converted] = convertToLlm([assistant("Done.\n<recap>\nMISSION: x\nTASK: y\nNEXT: z\n</recap>")]);
		expect(JSON.stringify(converted)).not.toContain("MISSION");
		expect(JSON.stringify(converted)).toContain("Done.");
	});

	it("never produces an empty assistant message", () => {
		const [converted] = convertToLlm([assistant("<recap>\nMISSION: x\n</recap>")]);
		expect(converted.content.length).toBeGreaterThan(0);
	});

	it("leaves messages without a recap untouched", () => {
		const original = assistant("plain text");
		const [converted] = convertToLlm([original]);
		expect(converted).toBe(original);
	});
});
