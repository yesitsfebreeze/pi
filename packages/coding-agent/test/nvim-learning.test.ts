/**
 * Unit tests for the nvim learning store: content-hash change detection and
 * notes CRUD. Pure filesystem — no nvim required.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AUDIT_NOTE_NAMES,
	configTreeHash,
	diffConfigFiles,
	fingerprintFile,
	learnedNotesBlock,
	listNotes,
	memoryBankStatus,
	readNote,
	recordSeen,
	setNvimLearningRoot,
	writeAuditNote,
	writeAuditStamp,
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

	it("learnedNotesBlock is empty with nothing learned, else names the notes", () => {
		expect(learnedNotesBlock()).toBe("");

		writeNote("tools", "# Tool map");
		writeNote("keymaps", "# Keymaps");
		const block = learnedNotesBlock();
		expect(block).toContain("tools");
		expect(block).toContain("keymaps");
		expect(block).toContain("nvim_learn note_read");
	});
});
describe("memory bank audit stamp & gate", () => {
	let root: string;
	let dir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-nvim-audit-"));
		dir = join(root, "cfg");
		mkdirSync(dir, { recursive: true });
		setNvimLearningRoot(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("gate says audit needed when the required notes are missing", () => {
		writeFileSync(join(dir, "init.lua"), "-- init");
		const files = [join(dir, "init.lua")];
		recordSeen(files);

		const status = memoryBankStatus(files, [], null);
		expect(status.needsAudit).toBe(true);
		expect(status.reason).toContain("notes missing");
	});

	it("gate says audit needed when no stamp exists even with all notes present", () => {
		writeFileSync(join(dir, "init.lua"), "-- init");
		const files = [join(dir, "init.lua")];
		recordSeen(files);
		for (const n of AUDIT_NOTE_NAMES) writeNote(n, "# " + n);

		const status = memoryBankStatus(files, listNotes(), null);
		expect(status.needsAudit).toBe(true);
		expect(status.reason).toContain("never audited");
	});

	it("gate is fresh when notes exist and the stamp matches the config tree", () => {
		writeFileSync(join(dir, "init.lua"), "-- init");
		const files = [join(dir, "init.lua")];
		recordSeen(files);
		for (const n of AUDIT_NOTE_NAMES) writeNote(n, "# " + n);
		writeAuditStamp(configTreeHash(files), "probe-hash");

		const status = memoryBankStatus(files);
		expect(status.needsAudit).toBe(false);
	});

	it("gate flags audit when a config file changes after the stamp", () => {
		const file = join(dir, "init.lua");
		writeFileSync(file, "-- init");
		const files = [file];
		recordSeen(files);
		for (const n of AUDIT_NOTE_NAMES) writeNote(n, "# " + n);
		writeAuditStamp(configTreeHash(files), "probe-hash");

		// Content change (mtime preserved is fine — hash is authoritative).
		writeFileSync(file, "-- init changed");
		const status = memoryBankStatus(files);
		expect(status.needsAudit).toBe(true);
		expect(status.reason).toContain("config changed");
	});

	it("configTreeHash changes when any file's content changes", () => {
		const a = join(dir, "a.lua");
		const b = join(dir, "b.lua");
		writeFileSync(a, "a");
		writeFileSync(b, "b");
		const h1 = configTreeHash([a, b]);
		writeFileSync(a, "a2");
		const h2 = configTreeHash([a, b]);
		expect(h1).not.toBe(h2);
		expect(h1).toHaveLength(64);
	});
});

describe("writeAuditNote merge semantics", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-nvim-merge-"));
		setNvimLearningRoot(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("writes fresh when the note does not exist", () => {
		writeAuditNote("plugins", "# Plugins (audited)\n\n- ✅ conform");
		expect(readNote("plugins")).toContain("# Plugins (audited)");
	});

	it("replaces an audit-owned note", () => {
		writeAuditNote("plugins", "# Plugins (audited)\n\nold");
		writeAuditNote("plugins", "# Plugins (audited)\n\nnew");
		expect(readNote("plugins")).toContain("new");
		expect(readNote("plugins")).not.toContain("old");
	});

	it("preserves agent-curated content and appends the audited section", () => {
		writeNote("plugins", "# My plugin notes\n\nagent knowledge");
		writeAuditNote("plugins", "# Plugins (audited)\n\n- ✅ conform");

		const note = readNote("plugins")!;
		expect(note).toContain("agent knowledge");
		expect(note).toContain("## Plugins (audited)");
		expect(note).toContain("- ✅ conform");
	});

	it("does not stack duplicate audit sections on repeated audits", () => {
		writeNote("plugins", "# My plugin notes\n\nagent knowledge");
		writeAuditNote("plugins", "# Plugins (audited)\n\nv1");
		writeAuditNote("plugins", "# Plugins (audited)\n\nv2");

		const note = readNote("plugins")!;
		expect(note).toContain("agent knowledge");
		expect(note).toContain("v2");
		expect(note).not.toContain("v1");
		expect(note.split("## Plugins (audited)").length - 1).toBe(1);
	});
});
