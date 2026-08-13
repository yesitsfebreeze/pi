/**
 * init — one-time project setup. Tests the pure orchestrator (runInit) on a
 * fresh directory and on an existing repo, verifying idempotency and that
 * every expected artifact lands.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../../src/core/init.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tmpDir(): string {
	const dir = join(tmpdir(), `pi-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("init", () => {
	it("bootstraps a fresh directory", async () => {
		const dir = tmpDir();
		try {
			const lines = await runInit(dir);
			const text = lines.join("\n");

			// git repo created
			expect(() => git(dir, "rev-parse", "--is-inside-work-tree")).not.toThrow();
			expect(text).toContain("git init");

			// HEAD exists
			const head = git(dir, "rev-parse", "--short", "HEAD");
			expect(head).toBeTruthy();

			// AGENTS.md created
			expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
			const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
			expect(agents).toContain(`# ${basename(dir)}`);
			expect(agents).toContain("## Conventions");
			expect(agents).toContain("## Commands");

			// ontology digest
			expect(existsSync(join(dir, ".pi", "ontology", "digest.md"))).toBe(true);
			const digest = readFileSync(join(dir, ".pi", "ontology", "digest.md"), "utf8");
			expect(digest).toContain("Ontology digest");

			// crawl topics
			expect(existsSync(join(dir, ".pi", "crawl", "topics.json"))).toBe(true);
			const topics = JSON.parse(readFileSync(join(dir, ".pi", "crawl", "topics.json"), "utf8"));
			expect(topics).toEqual([]);

			// store dirs
			expect(existsSync(join(dir, ".pi", "agents"))).toBe(true);
			expect(existsSync(join(dir, ".pi", "recipes"))).toBe(true);
			expect(existsSync(join(dir, ".pi", "context"))).toBe(true);

			// orphan branch exists
			const branches = git(dir, "branch", "--list");
			expect(branches).toContain("pi");

			// orphan branch tracks .pi/ but not AGENTS.md
			const ls = git(dir, "ls-tree", "-r", "--name-only", "pi");
			expect(ls).toContain(".pi/ontology/digest.md");
			expect(ls).toContain(".pi/crawl/topics.json");
			expect(ls).not.toContain("AGENTS.md");

			// main branch ignores .pi/
			const mainFiles = git(dir, "ls-files");
			expect(mainFiles).not.toContain(".pi/");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is idempotent — second run skips existing files", async () => {
		const dir = tmpDir();
		try {
			const first = await runInit(dir);
			expect(first.length).toBeGreaterThan(0);

			const second = await runInit(dir);
			const text = second.join("\n");
			expect(text).toContain("already present");
			expect(text).toContain("nothing new to back up");

			// AGENTS.md unchanged
			const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
			expect(agents).toContain("## Conventions");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not touch an existing repo with history", async () => {
		const dir = tmpDir();
		try {
			// Set up a repo with an existing commit
			git(dir, "init", "-b", "main");
			git(dir, "config", "user.email", "test@test");
			git(dir, "config", "user.name", "test");
			writeFileSync(join(dir, "README.md"), "# existing");
			git(dir, "add", "README.md");
			git(dir, "commit", "-m", "first");

			const lines = await runInit(dir);
			const text = lines.join("\n");
			expect(text).toContain("already present");

			// Existing file not clobbered
			expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# existing");

			// Orphan branch still set up
			expect(git(dir, "branch", "--list")).toContain("pi");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
