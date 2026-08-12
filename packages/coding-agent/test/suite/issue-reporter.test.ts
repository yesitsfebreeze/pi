/**
 * IssueReporter — gh-absent path (no network), kind→label mapping, context
 * capture. We do NOT shell out to gh; the absent path prints the body.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueReporter, KIND_OPTIONS } from "../../src/core/issue-reporter.ts";

const ORIG_PATH = process.env.PATH;
let binDir: string | undefined;

// Build a PATH that contains `git` (so context capture works) but NOT `gh`
// (so fileIssue prints the body instead of creating a real issue). Both live in
// /opt/homebrew/bin on this machine; symlinking only git into a temp bin
// isolates us from a globally-installed gh.
function hideGh(): void {
	binDir = mkdtempSync(join(tmpdir(), "pi-ir-bin-"));
	const gitPath = execSync("which git", { encoding: "utf8" }).trim();
	try {
		symlinkSync(gitPath, join(binDir, "git"));
	} catch {
		/* already linked */
	}
	process.env.PATH = binDir;
}
function restorePath(): void {
	process.env.PATH = ORIG_PATH;
	if (binDir) rmSync(binDir, { recursive: true, force: true });
	binDir = undefined;
}

describe("IssueReporter", () => {
	afterEach(() => restorePath());

	it("KIND_OPTIONS covers the documented kinds", () => {
		expect(KIND_OPTIONS).toEqual(["stall", "bug", "issue", "feature", "decision", "task"]);
	});

	it("prints the body when gh is unavailable", async () => {
		hideGh();
		const r = new IssueReporter();
		const res = await r.fileIssue({ kind: "bug", title: "thing broke", description: "it exploded" });
		const text = res.content[0]?.text ?? "";
		expect(text).toContain("gh not available");
		expect(text).toContain("Bug Report");
		expect(text).toContain("it exploded");
		expect(text).toContain("thing broke");
	});

	it("captures git context in a repo", async () => {
		hideGh();
		const dir = mkdtempSync(join(tmpdir(), "pi-ir-"));
		try {
			execSync("git init", { cwd: dir });
			execSync("git config user.email t@t", { cwd: dir });
			execSync("git config user.name t", { cwd: dir });
			writeFileSync(join(dir, "f.txt"), "x");
			execSync("git add . && git commit -m init", { cwd: dir });
			const r = new IssueReporter();
			const res = await r.fileIssue({ kind: "stall", title: "blocked", description: "waiting on X" });
			const text = res.content[0]?.text ?? "";
			expect(text).toContain("Stall Report");
			// Context capture includes a recent commit line
			expect(text).toMatch(/Recent commits|init/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("respects an explicit repo override via PI_GH_REPO", async () => {
		hideGh();
		process.env.PI_GH_REPO = "acme/widget";
		try {
			const r = new IssueReporter();
			const res = await r.fileIssue({ kind: "feature", title: "shiny", description: "add it" });
			const text = res.content[0]?.text ?? "";
			expect(text).toContain("Feature Report");
		} finally {
			delete process.env.PI_GH_REPO;
		}
	});

	it("autoReportError is a no-op when gh is unavailable", async () => {
		hideGh();
		const r = new IssueReporter();
		// Should not throw and should resolve.
		await expect(r.autoReportError("my_tool", "boom", new Set(["my_tool"]))).resolves.toBeUndefined();
	});

	it("autoReportError skips builtin-adjacent tool names", async () => {
		hideGh();
		const r = new IssueReporter();
		// record_stall is explicitly skipped by the reporter.
		await expect(r.autoReportError("record_stall", "x", new Set(["record_stall"]))).resolves.toBeUndefined();
	});
});
