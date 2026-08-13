// Tests for cross-session prompt history persistence.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPrompts, recordPrompt } from "../../src/core/prompt-history.ts";

// Fresh unique directory per test — avoids the rm+mkdir-same-path race that
// can leave the scratch dir invisible on macOS APFS under worker threads.
let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "pi-prompt-history-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("loadPrompts", () => {
	it("returns [] for a missing file", async () => {
		expect(await loadPrompts(100, join(scratch, "nope.jsonl"))).toEqual([]);
	});

	it("skips malformed and empty lines", async () => {
		const f = join(scratch, "h.jsonl");
		writeFileSync(
			f,
			`${["not json", "", JSON.stringify({ text: "good one", ts: 1 }), JSON.stringify({ wrong: "shape" }), ""].join(
				"\n",
			)}\n`,
		);
		const entries = await loadPrompts(100, f);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.text).toBe("good one");
	});

	it("dedupes by trimmed text, keeping the most recent occurrence", async () => {
		const f = join(scratch, "h.jsonl");
		writeFileSync(
			f,
			`${[
				JSON.stringify({ text: "dup", ts: 1 }),
				JSON.stringify({ text: "  dup  ", ts: 2 }),
				JSON.stringify({ text: "other", ts: 3 }),
			].join("\n")}\n`,
		);
		const entries = await loadPrompts(100, f);
		expect(entries.map((e) => e.text)).toEqual(["other", "dup"]);
	});

	it("returns most-recent-first", async () => {
		const f = join(scratch, "h.jsonl");
		writeFileSync(
			f,
			`${[
				JSON.stringify({ text: "one", ts: 1 }),
				JSON.stringify({ text: "two", ts: 2 }),
				JSON.stringify({ text: "three", ts: 3 }),
			].join("\n")}\n`,
		);
		const entries = await loadPrompts(100, f);
		expect(entries.map((e) => e.text)).toEqual(["three", "two", "one"]);
	});

	it("respects the limit", async () => {
		const f = join(scratch, "h.jsonl");
		writeFileSync(
			f,
			`${[
				JSON.stringify({ text: "p0", ts: 0 }),
				JSON.stringify({ text: "p1", ts: 1 }),
				JSON.stringify({ text: "p2", ts: 2 }),
				JSON.stringify({ text: "p3", ts: 3 }),
				JSON.stringify({ text: "p4", ts: 4 }),
				JSON.stringify({ text: "p5", ts: 5 }),
				JSON.stringify({ text: "p6", ts: 6 }),
				JSON.stringify({ text: "p7", ts: 7 }),
				JSON.stringify({ text: "p8", ts: 8 }),
				JSON.stringify({ text: "p9", ts: 9 }),
			].join("\n")}\n`,
		);
		const entries = await loadPrompts(3, f);
		expect(entries).toHaveLength(3);
		expect(entries[0]!.text).toBe("p9");
	});
});

describe("recordPrompt", () => {
	it("appends a JSONL entry readable by loadPrompts", async () => {
		const f = join(scratch, "r.jsonl");
		await recordPrompt("  hello world  ", "/tmp", f);
		await recordPrompt("   ", "/tmp", f); // blank — ignored
		const entries = await loadPrompts(100, f);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.text).toBe("hello world");
		expect(entries[0]!.cwd).toBe("/tmp");
		expect(entries[0]!.ts).toBeGreaterThan(0);
	});

	it("appends across multiple records", async () => {
		const f = join(scratch, "r2.jsonl");
		await recordPrompt("one", undefined, f);
		await recordPrompt("two", undefined, f);
		const entries = await loadPrompts(100, f);
		expect(entries.map((e) => e.text)).toEqual(["two", "one"]);
	});

	it("does not throw on an unwritable path", async () => {
		const f = join(scratch, "no", "dir", "nested", "r3.jsonl");
		await expect(recordPrompt("x", undefined, f)).resolves.toBeUndefined();
	});

	it("creates parent directories", async () => {
		const f = join(scratch, "deep", "nested", "r4.jsonl");
		await recordPrompt("dirs", undefined, f);
		const raw = readFileSync(f, "utf8");
		expect(raw).toContain("dirs");
	});
});
