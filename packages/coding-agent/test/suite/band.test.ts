/**
 * Tool band tests — verify deferred (rare) tool loading works correctly.
 *
 * Covers the tool definition contract and the real deferral behaviour of a
 * live AgentSession.
 */
import { describe, expect, it } from "vitest";
import { createAllToolDefinitions } from "../../src/core/tools/index.ts";
import { createHarness } from "./harness.ts";

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

	// These three used to define a local copy of _filterDeferredTools and assert
	// on the copy — deleting the real filter from agent-session.ts left them
	// green. They now drive a real session.

	it("does not activate a rare tool by default, but keeps it reachable", async () => {
		const harness = await createHarness({});
		try {
			await harness.session.bindExtensions({});
			expect(harness.session.getAllTools().map((t) => t.name)).toContain("ls");
			expect(harness.session.getActiveToolNames()).not.toContain("ls");
			expect(harness.session.getDeferredToolNames()).toContain("ls");
		} finally {
			harness.cleanup();
		}
	});

	it("activates a rare tool once it is restored", async () => {
		const harness = await createHarness({});
		try {
			await harness.session.bindExtensions({});
			harness.session.restoreTools(["ls"]);
			expect(harness.session.getActiveToolNames()).toContain("ls");
			expect(harness.session.getDeferredToolNames()).not.toContain("ls");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps non-rare tools active without any restore", async () => {
		const harness = await createHarness({});
		try {
			await harness.session.bindExtensions({});
			const active = harness.session.getActiveToolNames();
			for (const name of ["read", "bash", "edit", "write"]) expect(active).toContain(name);
			expect(harness.session.getDeferredToolNames()).not.toContain("read");
		} finally {
			harness.cleanup();
		}
	});

	it("all seven built-in tool names are present", () => {
		const defs = createAllToolDefinitions("/tmp");
		const names = Object.keys(defs).sort();
		expect(names).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
	});
});
