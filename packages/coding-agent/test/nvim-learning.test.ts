/**
 * Unit tests for the nvim learning store: content-hash change detection and
 * notes CRUD. Pure filesystem — no nvim required.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	diffConfigFiles,
	fingerprintFile,
	listNotes,
	readNote,
	recordSeen,
	setNvimLearningRoot,
	writeNote,
} from "../src/core/nvim/nvim-learning.ts";

describe("nvim learning store", () => {
	let root: string;
	let dir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-nvim-learn-"));
		dir = join(root, "cfg");
		mkdirSync(dir, { recursive: true });
		setNvimLearningRoot(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function write(path: string, content: string): string {
		writeFileSync(path, content);
		return path;
	}

	it("fingerprints file content and detects new/changed/unchanged/removed", () => {
		const a = write(join(dir, "a.lua"), "print(1)");
		const b = write(join(dir, "b.lua"), "print(2)");

		// First pass: both are new.
		let diff = diffConfigFiles([a, b]);
		expect(diff.new).toEqual([a, b]);
		expect(diff.changed).toEqual([]);
		expect(diff.unchanged).toEqual([]);
		expect(diff.removed).toEqual([]);

		recordSeen([a, b]);

		// Second pass: nothing changed.
		diff = diffConfigFiles([a, b]);
		expect(diff.new).toEqual([]);
		expect(diff.changed).toEqual([]);
		expect(diff.unchanged).toEqual([a, b]);
		expect(diff.removed).toEqual([]);

		// Change content of a (same path) → changed.
		write(a, "print(111)");
		diff = diffConfigFiles([a, b]);
		expect(diff.changed).toEqual([a]);
		expect(diff.unchanged).toEqual([b]);

		// Drop b → removed.
		diff = diffConfigFiles([a]);
		expect(diff.removed).toEqual([b]);
	});

	it("treats identical content as unchanged even when mtime differs", () => {
		const a = write(join(dir, "a.lua"), "same");
		recordSeen([a]);

		// Rewrite with identical content — hash matches, so unchanged.
		write(a, "same");
		const diff = diffConfigFiles([a]);
		expect(diff.unchanged).toEqual([a]);
		expect(diff.changed).toEqual([]);
	});

	it("stores fingerprints with sha256, mtime and size", () => {
		const a = write(join(dir, "a.lua"), "hello");
		const fp = fingerprintFile(a);
		expect(fp).not.toBeNull();
		expect(fp!.size).toBe(5);
		expect(typeof fp!.sha256).toBe("string");
		expect(fp!.sha256).toHaveLength(64);
		expect(fp!.mtimeMs).toBeGreaterThan(0);
	});

	it("round-trips learned notes and sanitizes names", () => {
		expect(listNotes()).toEqual([]);
		writeNote("keymaps", "# Keymaps\n\n- `<leader>f` -> telescope");
		expect(listNotes()).toEqual(["keymaps"]);
		expect(readNote("keymaps")).toContain("telescope");
		expect(readNote("missing")).toBeUndefined();

		// Path traversal in the name is neutralized.
		writeNote("../../evil", "x");
		expect(readNote("../../evil")).toBeDefined();
		expect(listNotes().some((n) => n.includes("/"))).toBe(false);
	});
});
