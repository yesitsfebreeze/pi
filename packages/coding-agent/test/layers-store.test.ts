import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CommitMeta,
	createLayer,
	deleteLayer,
	diff,
	editFile,
	listFiles,
	listLayers,
	logCommits,
	materialize,
	mergeLayer,
	readFile,
	readText,
	relPath,
	removeFile,
	removeWorktree,
	tip,
	validateName,
	writeFile,
} from "../src/core/layers/store.ts";

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

const meta = (tool: string): CommitMeta => ({
	agent: "worker-3",
	session: "sess-1",
	purpose: "fix race",
	tool,
	turn: 17,
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "layers-"));
	sh(["init", "-q", "-b", "main"]);
	writeFileSync(join(dir, "base.txt"), "hello\n");
	sh(["add", "base.txt"]);
	sh(["commit", "-q", "-m", "base"]);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("layers store", () => {
	it("creates a layer forked from HEAD and lists it", () => {
		const { base, baseCommit } = createLayer(dir, "feat");
		expect(base).toBe("main");
		expect(baseCommit).toBe(sh(["rev-parse", "HEAD"]));
		expect(listLayers(dir)).toContain("feat");
		expect(tip(dir, "feat")).toBe(baseCommit);
	});

	it("writeFile then readText reads from the layer (read-your-writes)", () => {
		createLayer(dir, "feat");
		writeFile(dir, "feat", "a.txt", "layer content\n", meta("layer_write"));
		const r = readText(dir, "feat", "a.txt");
		expect(r?.text).toBe("layer content\n");
		expect(r?.from).toBe("layer");
	});

	it("readText falls back to disk for files not in the layer tree", () => {
		createLayer(dir, "feat");
		writeFileSync(join(dir, "untracked.txt"), "disk only\n"); // untracked, not in base
		const r = readText(dir, "feat", "untracked.txt");
		expect(r?.text).toBe("disk only\n");
		expect(r?.from).toBe("disk");
	});

	it("editFile replaces exactly one occurrence and stacks on prior writes", () => {
		createLayer(dir, "feat");
		writeFile(dir, "feat", "a.txt", "one two\n", meta("layer_write"));
		editFile(dir, "feat", "a.txt", "one", "three", meta("layer_edit"));
		expect(readText(dir, "feat", "a.txt")?.text).toBe("three two\n");
		expect(readText(dir, "feat", "a.txt")?.from).toBe("layer");
	});

	it("editFile rejects zero or multiple matches", () => {
		createLayer(dir, "feat");
		writeFile(dir, "feat", "a.txt", "x x\n", meta("layer_write"));
		expect(() => editFile(dir, "feat", "a.txt", "zzz", "y", meta("layer_edit"))).toThrow(/exactly one/);
	});

	it("removeFile deletes from the layer only", () => {
		createLayer(dir, "feat");
		writeFile(dir, "feat", "a.txt", "x\n", meta("layer_write"));
		removeFile(dir, "feat", "a.txt", meta("layer_rm"));
		expect(readText(dir, "feat", "a.txt")).toBeNull();
		expect(listFiles(dir, "feat")).toEqual([]);
	});

	it("diff shows only the layer's changes vs its fork point", () => {
		createLayer(dir, "feat");
		writeFile(dir, "feat", "a.txt", "new\n", meta("layer_write"));
		const d = diff(dir, "feat", sh(["rev-parse", "HEAD"]));
		expect(d).toContain("a.txt");
		expect(d).toContain("+new");
	});

	it("logCommits parses provenance trailers", () => {
		createLayer(dir, "feat");
		writeFile(dir, "feat", "a.txt", "x\n", meta("layer_write"));
		const commits = logCommits(dir, ["refs/layers/feat"]);
		expect(commits.length).toBe(1);
		expect(commits[0].trailers.Agent).toBe("worker-3");
		expect(commits[0].trailers.Session).toBe("sess-1");
		expect(commits[0].trailers.Purpose).toBe("fix race");
		expect(commits[0].trailers.Turn).toBe("17");
	});

	it("mergeLayer squash-merges onto main as one checkpoint commit", () => {
		createLayer(dir, "feat");
		writeFile(dir, "feat", "a.txt", "new\n", meta("layer_write"));
		const r = mergeLayer(dir, "feat", "merge layer feat\n\nLayer: feat\nPurpose: fix race");
		expect("commit" in r).toBe(true);
		expect(sh(["log", "-1", "--format=%s"])).toBe("merge layer feat");
		expect(sh(["show", "HEAD:a.txt"]).trim()).toBe("new");
	});

	it("mergeLayer reports conflicts when both sides touch the same file", () => {
		createLayer(dir, "feat");
		writeFile(dir, "feat", "base.txt", "layer version\n", meta("layer_write"));
		writeFileSync(join(dir, "base.txt"), "main version\n");
		sh(["add", "base.txt"]);
		sh(["commit", "-q", "-m", "main change"]);
		const r = mergeLayer(dir, "feat", "merge");
		expect("error" in r).toBe(true);
		expect((r as { conflicts: string[] }).conflicts).toContain("base.txt");
	});

	it("materialize then removeWorktree creates and cleans a worktree", () => {
		createLayer(dir, "feat");
		writeFile(dir, "feat", "a.txt", "new\n", meta("layer_write"));
		const r = materialize(dir, "feat");
		expect("path" in r).toBe(true);
		const wpath = (r as { path: string }).path;
		expect(readFileSync(join(wpath, "a.txt"), "utf8")).toBe("new\n");
		expect(removeWorktree(dir, "feat")).toBe(true);
	});

	it("deleteLayer drops the ref", () => {
		createLayer(dir, "feat");
		expect(deleteLayer(dir, "feat")).toBe(true);
		expect(listLayers(dir)).toEqual([]);
	});

	it("relPath normalizes and rejects escapes", () => {
		expect(relPath(dir, "a/b.txt")).toBe("a/b.txt");
		expect(relPath(dir, join(dir, "a", "b.txt"))).toBe("a/b.txt");
		expect(relPath(dir, "../outside")).toBeNull();
		expect(relPath(dir, "/absolute/elsewhere")).toBeNull();
	});

	it("validateName accepts kebab-case and rejects names git refuses", () => {
		expect(validateName(dir, "auth-rewrite")).toBeNull();
		expect(validateName(dir, "a..")).not.toBeNull();
		expect(validateName(dir, "a.")).not.toBeNull();
		expect(validateName(dir, "foo.lock")).not.toBeNull();
		expect(validateName(dir, "")).not.toBeNull();
	});

	it("writeFile throws on a nonexistent layer", () => {
		expect(() => writeFile(dir, "nope", "a.txt", "x", meta("layer_write"))).toThrow(/no such layer/);
	});

	it("editFile throws on a nonexistent file", () => {
		createLayer(dir, "feat");
		expect(() => editFile(dir, "feat", "missing.txt", "a", "b", meta("layer_edit"))).toThrow(/no such file/);
	});

	it("mergeLayer reports an error for a missing layer", () => {
		const r = mergeLayer(dir, "nope", "merge");
		expect("error" in r).toBe(true);
	});

	it("removeFile throws on a file not in the layer (no silent no-op commit)", () => {
		createLayer(dir, "feat");
		expect(() => removeFile(dir, "feat", "never-existed.txt", meta("layer_rm"))).toThrow(/no such file in layer/);
	});

	it("writeFile preserves the executable bit on overwrite", () => {
		createLayer(dir, "feat");
		// seed an executable file into base, then advance base so the layer forks over it
		writeFileSync(join(dir, "bin.sh"), "#!/bin/sh\necho hi\n");
		sh(["update-index", "--add", "--chmod=+x", "bin.sh"]);
		sh(["commit", "-q", "-m", "exec"]);
		// re-fork the layer over the new base so bin.sh is in its tree as 100755
		createLayer(dir, "exec");
		writeFile(dir, "exec", "bin.sh", "#!/bin/sh\necho bye\n", meta("layer_write"));
		const mode = sh(["ls-tree", "refs/layers/exec", "--", "bin.sh"]).split(" ")[0];
		expect(mode).toBe("100755");
	});

	it("binary files round-trip through readFile unchanged", () => {
		createLayer(dir, "feat");
		const bin = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x00, 0x80]);
		writeFile(dir, "feat", "blob.bin", bin, meta("layer_write"));
		const r = readFile(dir, "feat", "blob.bin");
		expect(r?.from).toBe("layer");
		expect(Buffer.compare(r?.bytes ?? Buffer.alloc(0), bin)).toBe(0);
	});

	it("mergeLayer refuses a detached HEAD", () => {
		createLayer(dir, "feat");
		writeFile(dir, "feat", "a.txt", "x\n", meta("layer_write"));
		// detach HEAD at the base commit
		sh(["checkout", "-q", sh(["rev-parse", "HEAD"])]);
		const r = mergeLayer(dir, "feat", "merge");
		expect("error" in r).toBe(true);
		expect((r as { error: string }).error).toMatch(/detached HEAD/);
		// restore so afterEach cleanup is clean
		sh(["checkout", "-q", "main"]);
	});
});
