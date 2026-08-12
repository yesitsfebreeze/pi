/**
 * FileTouchTracker — stamps reads, detects external edits.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileTouchTracker } from "../../src/core/file-touch-tracker.ts";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "pi-ftt-"));
}

describe("FileTouchTracker", () => {
	it("reports no changes right after stamping", () => {
		const dir = tmp();
		try {
			const f = join(dir, "a.txt");
			writeFileSync(f, "hello");
			const t = new FileTouchTracker();
			t.stamp(f);
			expect(t.getChangedFiles()).toEqual([]);
			expect(t.size).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detects a file changed externally after stamping", () => {
		const dir = tmp();
		try {
			const f = join(dir, "a.txt");
			writeFileSync(f, "v1");
			const t = new FileTouchTracker();
			t.stamp(f);
			// Simulate external edit: bump mtime into the future.
			const future = Date.now() / 1000 + 10;
			utimesSync(f, future, future);
			expect(t.getChangedFiles()).toEqual([f]);
			// Reported once; second check is quiet until the next change.
			expect(t.getChangedFiles()).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a deleted file as changed", () => {
		const dir = tmp();
		try {
			const f = join(dir, "gone.txt");
			writeFileSync(f, "x");
			const t = new FileTouchTracker();
			t.stamp(f);
			rmSync(f, { force: true });
			expect(t.getChangedFiles()).toEqual([f]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stamps a missing file without throwing", () => {
		const t = new FileTouchTracker();
		t.stamp("/nonexistent/pi-test-path");
		expect(t.size).toBe(1);
		// A missing file is not re-reported as changed (already -1).
		expect(t.getChangedFiles()).toEqual([]);
	});
});
