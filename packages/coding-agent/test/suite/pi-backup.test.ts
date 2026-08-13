/**
 * pi-backup tests — orphan-branch backup of .pi via an inverse gitignore.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pullPiBackup, pushPiBackup, setupPiBackup } from "../../src/core/pi-backup.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tmpRepo(): string {
	const dir = join(tmpdir(), `pi-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	git(dir, "init");
	git(dir, "config", "user.email", "test@test");
	git(dir, "config", "user.name", "test");
	writeFileSync(join(dir, "README.md"), "# test");
	git(dir, "add", "README.md");
	git(dir, "commit", "-m", "init");
	return dir;
}

describe("pi-backup", () => {
	it("sets up an orphan branch holding .pi, ignoring it on main", async () => {
		const dir = tmpRepo();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(join(dir, ".pi", "memory.txt"), "agent state");
			mkdirSync(join(dir, ".pi", "docs"), { recursive: true });
			writeFileSync(join(dir, ".pi", "docs", "guide.md"), "# guide");

			// Commit the data dir on main first, to prove setup untracks it.
			git(dir, "add", ".pi");
			git(dir, "commit", "-m", "add data");

			const result = await setupPiBackup(dir);
			expect(result.ok).toBe(true);

			// main ignores it.
			const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
			expect(gitignore).toContain(".pi/");

			// main no longer tracks it.
			expect(git(dir, "ls-files", ".pi")).toBe("");

			// orphan branch exists and tracks everything under .pi (docs included).
			const ls = git(dir, "ls-tree", "-r", "--name-only", "pi");
			expect(ls).toContain(".pi/memory.txt");
			expect(ls).toContain(".pi/docs/guide.md");
			expect(ls).toContain(".gitignore");
			expect(ls).not.toContain("README.md");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("backs up all data including LMDB databases (main-ignore doesn't apply on the orphan branch)", async () => {
		const dir = tmpRepo();
		try {
			// Simulate the real repo: .pi/kern is ignored on main.
			writeFileSync(join(dir, ".gitignore"), "# existing rules\n.pi/kern/\n");
			git(dir, "add", ".gitignore");
			git(dir, "commit", "-m", "ignore kern on main");

			mkdirSync(join(dir, ".pi", "kern"), { recursive: true });
			writeFileSync(join(dir, ".pi", "kern", "data.mdb"), "binary lmdb");
			writeFileSync(join(dir, ".pi", "memory.txt"), "agent state");

			await setupPiBackup(dir);

			const ls = git(dir, "ls-tree", "-r", "--name-only", "pi");
			expect(ls).toContain(".pi/memory.txt");
			// The database is backed up on the orphan branch even though it's
			// ignored on main.
			expect(ls).toContain(".pi/kern/data.mdb");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("excludes nested git worktrees from the orphan branch", async () => {
		const dir = tmpRepo();
		try {
			mkdirSync(join(dir, ".pi", "trees"), { recursive: true });
			writeFileSync(join(dir, ".pi", "trees", ".git"), "gitdir: somewhere");
			writeFileSync(join(dir, ".pi", "trees", "secret.js"), "nested repo content");
			writeFileSync(join(dir, ".pi", "memory.txt"), "agent state");

			await setupPiBackup(dir);

			const ls = git(dir, "ls-tree", "-r", "--name-only", "pi");
			expect(ls).toContain(".pi/memory.txt");
			expect(ls).not.toContain(".pi/trees/secret.js");
			expect(ls).not.toContain(".pi/trees/.git");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pushes new data and pulls it back after local removal", async () => {
		const dir = tmpRepo();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(join(dir, ".pi", "memory.txt"), "v1");
			await setupPiBackup(dir);

			// Update and push.
			writeFileSync(join(dir, ".pi", "memory.txt"), "v2");
			const push = await pushPiBackup(dir);
			expect(push.ok).toBe(true);
			expect(git(dir, "show", "pi:.pi/memory.txt")).toBe("v2");

			// Wipe local and pull.
			rmSync(join(dir, ".pi"), { recursive: true, force: true });
			const pull = await pullPiBackup(dir);
			expect(pull.ok).toBe(true);
			expect(readFileSync(join(dir, ".pi", "memory.txt"), "utf8")).toBe("v2");
			// Materialized files must stay ignored/untracked on main.
			expect(git(dir, "status", "--porcelain")).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves negation-re-included files tracked on main (gantt board pattern)", async () => {
		const dir = tmpRepo();
		try {
			// The llm-repo pattern: .pi is ignored, but the gantt board is
			// re-included so claim/release lock commits can carry it on main.
			writeFileSync(join(dir, ".gitignore"), ".pi/\n!.pi/\n.pi/*\n!.pi/gantt/\n.pi/gantt/*\n!.pi/gantt/**\n");
			git(dir, "add", ".gitignore");
			git(dir, "commit", "-m", "ignore .pi but keep gantt add-able");
			mkdirSync(join(dir, ".pi", "gantt"), { recursive: true });
			writeFileSync(join(dir, ".pi", "gantt", "map.md"), "# board");
			git(dir, "add", ".pi/gantt/map.md");
			git(dir, "commit", "-m", "track gantt board");

			const result = await setupPiBackup(dir);
			expect(result.ok).toBe(true);

			// The deliberately-tracked gantt file survives setup, which made no
			// commit of its own.
			expect(git(dir, "ls-files", ".pi")).toBe(".pi/gantt/map.md");
			expect(git(dir, "log", "-1", "--format=%s")).toBe("track gantt board");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("untracks only ignored tracked files, leaving user-staged work alone", async () => {
		const dir = tmpRepo();
		try {
			writeFileSync(join(dir, ".gitignore"), ".pi/\n!.pi/\n.pi/*\n!.pi/gantt/\n.pi/gantt/*\n!.pi/gantt/**\n");
			git(dir, "add", ".gitignore");
			git(dir, "commit", "-m", "ignore .pi but keep gantt add-able");
			mkdirSync(join(dir, ".pi", "gantt"), { recursive: true });
			mkdirSync(join(dir, ".pi", "kern"), { recursive: true });
			writeFileSync(join(dir, ".pi", "gantt", "map.md"), "# board");
			writeFileSync(join(dir, ".pi", "kern", "data.mdb"), "lmdb");
			git(dir, "add", ".pi/gantt/map.md");
			git(dir, "add", "-f", ".pi/kern/data.mdb");
			git(dir, "commit", "-m", "track board + stray kern file");

			// User stages a new gantt ticket — an in-progress claim.
			writeFileSync(join(dir, ".pi", "gantt", "ticket.md"), "# t");
			git(dir, "add", ".pi/gantt/ticket.md");

			await setupPiBackup(dir);

			// The stray ignored kern file was staged for removal; the board is
			// untouched; the user's staged ticket is untouched — setup committed
			// nothing and swept nothing.
			const status = git(dir, "status", "--porcelain");
			expect(status).toContain(".pi/gantt/ticket.md");
			expect(status).toContain(".pi/kern/data.mdb");
			expect(status).not.toContain(".pi/gantt/map.md");
			expect(git(dir, "log", "-1", "--format=%s")).toBe("track board + stray kern file");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pushes without mutating the working-tree .gitignore", async () => {
		const dir = tmpRepo();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(join(dir, ".pi", "memory.txt"), "v1");
			writeFileSync(join(dir, ".gitignore"), "# user rules\n.pi/\n");
			git(dir, "add", ".gitignore");
			git(dir, "commit", "-m", "main gitignore");

			const before = readFileSync(join(dir, ".gitignore"), "utf8");
			await setupPiBackup(dir);
			await pushPiBackup(dir);

			expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(before);
			expect(git(dir, "status", "--porcelain", "--", ".gitignore")).toBe("");
			// The orphan branch carries the inverted .gitignore, not main's.
			expect(git(dir, "show", "pi:.gitignore")).toContain("!/.pi/");
			expect(git(dir, "show", "pi:.gitignore")).not.toContain("user rules");
			// No temp index files left behind.
			const leftovers = readdirSync(join(dir, ".git")).filter((f) => f.startsWith("pi-backup-index-"));
			expect(leftovers).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not commit unrelated staged changes", async () => {
		const dir = tmpRepo();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(join(dir, ".pi", "memory.txt"), "v1");
			// Stage an unrelated file the user is working on.
			writeFileSync(join(dir, "work-in-progress.txt"), "wip");
			git(dir, "add", "work-in-progress.txt");

			await setupPiBackup(dir);

			// The unrelated file stays staged, not committed by setup.
			const status = git(dir, "status", "--porcelain");
			expect(status).toContain("work-in-progress.txt");
			expect(git(dir, "log", "-1", "--format=%s")).toBe("init");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("handles a non-git directory", async () => {
		const nonGit = join(tmpdir(), `pi-backup-nongit-${Date.now()}`);
		mkdirSync(nonGit, { recursive: true });
		try {
			const result = await pushPiBackup(nonGit);
			expect(result.ok).toBe(false);
			expect(result.text).toContain("not a git repo");
		} finally {
			rmSync(nonGit, { recursive: true, force: true });
		}
	});
});
