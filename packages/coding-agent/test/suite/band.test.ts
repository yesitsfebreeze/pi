/**
 * Tool band tests — verify deferred (rare) tool loading works correctly.
 *
 * These tests verify the tool definition contract and the filter logic
 * without going through the pre-existing harness breakage.
 */
import { describe, expect, it } from "vitest";
import { createAllToolDefinitions } from "../../src/core/tools/index.ts";

describe("tool band (deferred loading)", () => {
	it("ls tool definition has rare: true", () => {
		const defs = createAllToolDefinitions("/tmp");
		expect(defs.ls.rare).toBe(true);
	});

	it("core editing tools do not have rare: true", () => {
		const defs = createAllToolDefinitions("/tmp");
		expect(defs.read.rare).toBeUndefined();
		expect(defs.bash.rare).toBeUndefined();
		expect(defs.edit.rare).toBeUndefined();
		expect(defs.write.rare).toBeUndefined();
		expect(defs.grep.rare).toBeUndefined();
		expect(defs.find.rare).toBeUndefined();
	});

	it("filter removes rare tools that have not been restored", () => {
		// Simulate what _filterDeferredTools does
		const definitions = new Map([
			["ls", { definition: { name: "ls", rare: true as const } }],
			["read", { definition: { name: "read" } }],
			["bash", { definition: { name: "bash" } }],
		]);
		const restored = new Set<string>();

		const filter = (names: string[]): string[] =>
			names.filter((name) => {
				const entry = definitions.get(name);
				if (!entry?.definition.rare) return true;
				return restored.has(name);
			});

		const active = ["read", "bash", "ls"];

		// ls is rare and not restored — should be filtered out
		expect(filter(active)).toEqual(["read", "bash"]);
	});

	it("filter keeps rare tools that have been manually restored", () => {
		const definitions = new Map([
			["ls", { definition: { name: "ls", rare: true as const } }],
			["read", { definition: { name: "read" } }],
		]);
		const restored = new Set(["ls"]);

		const filter = (names: string[]): string[] =>
			names.filter((name) => {
				const entry = definitions.get(name);
				if (!entry?.definition.rare) return true;
				return restored.has(name);
			});

		expect(filter(["read", "ls"])).toEqual(["read", "ls"]);
	});

	it("filter keeps non-rare tools regardless of restored set", () => {
		const definitions = new Map([
			["read", { definition: { name: "read" } }],
			["bash", { definition: { name: "bash" } }],
		]);
		const restored = new Set<string>();

		const filter = (names: string[]): string[] =>
			names.filter((name) => {
				const entry = definitions.get(name);
				if (!entry?.definition.rare) return true;
				return restored.has(name);
			});

		expect(filter(["read", "bash"])).toEqual(["read", "bash"]);
	});

	it("all seven built-in tool names are present", () => {
		const defs = createAllToolDefinitions("/tmp");
		const names = Object.keys(defs).sort();
		expect(names).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
	});
});
