// memory store tests — thin wrapper around kern CLI.
// These tests assume kern is available on PATH. When kern is absent,
// they verify graceful degradation (null/empty returns, no throws).
import { describe, expect, it } from "vitest";
import {
	forgetSource,
	ingestBlock,
	ingestOne,
	kernAvailable,
	memoryHealth,
	queryThoughts,
	storeDecision,
	storeLink,
	storeObservation,
} from "../../src/core/memory/store.ts";

describe("memory store (kern wrapper)", () => {
	const SKIP = !kernAvailable();

	it("kernAvailable detects kern on PATH", () => {
		// Just verify the function doesn't throw
		const ok = kernAvailable();
		expect(typeof ok === "boolean").toBe(true);
	});

	it("storeDecision returns id when kern is present, undefined otherwise", async () => {
		const id = await storeDecision("test decision", "we chose X", 0.9);
		if (SKIP) {
			expect(id).toBeUndefined();
		} else {
			expect(id).toBeTruthy();
			expect(typeof id === "string").toBe(true);
		}
	});

	it("storeObservation returns id when kern is present, undefined otherwise", async () => {
		const id = await storeObservation("test obs", "noted: Y happens");
		if (SKIP) {
			expect(id).toBeUndefined();
		} else {
			expect(id).toBeTruthy();
			expect(typeof id === "string").toBe(true);
		}
	});

	it("storeLink does not throw when kern is absent", async () => {
		// Should not throw even without kern
		await expect(storeLink("fake-from", "fake-to", "test reason")).resolves.toBeUndefined();
	});

	it("ingestBlock returns line count when kern is present, 0 otherwise", async () => {
		const n = await ingestBlock(["test fact one", "test fact two"]);
		if (SKIP) {
			expect(n).toBe(0);
		} else {
			expect(n).toBe(2);
		}
	});

	it("ingestOne returns id when kern is present, undefined otherwise", async () => {
		const id = await ingestOne("test single fact");
		if (SKIP) {
			expect(id).toBeUndefined();
		} else {
			expect(typeof id === "string" || id === "ok").toBe(true);
		}
	});

	it("queryThoughts returns results when kern is present, empty otherwise", async () => {
		const results = await queryThoughts("something", 5);
		if (SKIP) {
			expect(results.length).toBe(0);
		} else {
			expect(Array.isArray(results)).toBe(true);
			// May or may not have results depending on what's in the graph
		}
	});

	it("queryThoughts returns empty for empty query", async () => {
		const results = await queryThoughts("", 5);
		expect(results.length).toBe(0);
	});

	it("queryThoughts returns empty for short query", async () => {
		const results = await queryThoughts("ab", 5);
		expect(results.length).toBe(0);
	});

	it("forgetSource does not throw when kern is absent", async () => {
		const n = await forgetSource("nonexistent-source");
		if (SKIP) {
			expect(n).toBe(0);
		} else {
			expect(typeof n === "number").toBe(true);
		}
	});

	it("memoryHealth returns null when kern is absent, object otherwise", async () => {
		const h = await memoryHealth();
		if (SKIP) {
			expect(h).toBeNull();
		} else {
			expect(h).not.toBeNull();
			expect(typeof h!.thoughts === "number").toBe(true);
			expect(typeof h!.edges === "number").toBe(true);
		}
	});
});
