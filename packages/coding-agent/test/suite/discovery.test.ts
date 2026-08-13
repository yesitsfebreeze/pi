/**
 * Discovery map — deterministic region manifest, incremental plan, map update.
 * Uses a temp git repo fixture so planDiscovery/updateNode exercise the real
 * watermark logic without touching this repo.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkBudget,
	generateManifest,
	planDiscovery,
	readMap,
	updateNode,
	writeMap,
} from "../../src/core/crew/discovery.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-discovery-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function seedMonorepo(): void {
	for (const p of ["a", "b"]) {
		mkdirSync(join(dir, "packages", p, "src"), { recursive: true });
		writeFileSync(join(dir, "packages", p, "src", "index.ts"), "export {};\n");
	}
	mkdirSync(join(dir, "standalone", "src"), { recursive: true });
	writeFileSync(join(dir, "standalone", "src", "index.ts"), "export {};\n");
	// plain dir with no src/ — must be ignored
	mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(join(dir, "docs", "readme.md"), "# docs\n");
}

describe("generateManifest", () => {
	it("detects monorepo packages and standalone packages", () => {
		seedMonorepo();
		const ids = generateManifest(dir)
			.map((n) => n.id)
			.sort();
		expect(ids).toEqual(["packages/a", "packages/b", "standalone"]);
	});

	it("ignores dirs without src and dotfiles", () => {
		seedMonorepo();
		mkdirSync(join(dir, ".hidden", "src"), { recursive: true });
		mkdirSync(join(dir, "node_modules", "x", "src"), { recursive: true });
		const ids = generateManifest(dir).map((n) => n.id);
		expect(ids).not.toContain("node_modules");
		expect(ids.every((id) => !id.startsWith("."))).toBe(true);
	});
});

describe("planDiscovery + updateNode", () => {
	it("marks every region new on first run, then only updated nodes are current", () => {
		seedMonorepo();
		git("init", "-q");
		git("add", "-A");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

		const plan = planDiscovery(dir);
		expect(plan.every((t) => t.needsDiscovery)).toBe(true);

		updateNode(dir, "packages/a", "memory/packages-a.md");
		const map = readMap(dir);
		expect(map?.nodes).toHaveLength(1);
		expect(map?.nodes[0].id).toBe("packages/a");
		expect(map?.nodes[0].notePath).toBe("memory/packages-a.md");

		const plan2 = planDiscovery(dir);
		const a = plan2.find((t) => t.node.id === "packages/a");
		const b = plan2.find((t) => t.node.id === "packages/b");
		expect(a?.needsDiscovery).toBe(false);
		expect(b?.needsDiscovery).toBe(true);
	});
});

describe("writeMap budget", () => {
	it("rejects an oversized index", () => {
		const nodes = Array.from({ length: 5000 }, (_, i) => ({
			id: `n${i}`,
			label: `Node ${i}`,
			globs: [`n${i}/`],
			gitWatermark: "x",
			notePath: `n${i}.md`,
			lastDiscovered: "2026-01-01",
		}));
		expect(() => writeMap(dir, { version: 1, nodes })).toThrow(/exceeds/);
	});

	it("checkBudget is null for a small map", () => {
		expect(checkBudget(dir)).toBeNull();
	});
});
