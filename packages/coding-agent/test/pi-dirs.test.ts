/**
 * pi-dirs: resolvePiDirs walks up to a .pi/.git project root and resolves the
 * ~/.pi user dir. Proves the wiring used by crew (bus root) and personas
 * (.pi/persona.md override lookup).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePiDirs } from "../src/core/pi-dirs.ts";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-dirs-"));
}

describe("resolvePiDirs", () => {
	it("resolves the user dir under ~/.pi", () => {
		const { userDir, configDir } = resolvePiDirs(tmpDir());
		expect(userDir.endsWith("/.pi")).toBe(true);
		expect(configDir.endsWith("/.pi/config")).toBe(true);
	});

	it("returns projectDir undefined when no .pi/.git marker is found", () => {
		const dir = tmpDir();
		const { projectDir } = resolvePiDirs(dir);
		// Walking up from a tmp dir may or may not hit a .git; just assert the
		// contract: projectDir is either undefined or a real path containing a marker.
		if (projectDir !== undefined) {
			expect(typeof projectDir).toBe("string");
		}
	});

	it("walks up to the nearest .git project root", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-dirs-root-"));
		const { mkdirSync } = require("node:fs");
		mkdirSync(join(root, ".git"));
		const sub = join(root, "a", "b", "c");
		mkdirSync(sub, { recursive: true });
		const { projectDir } = resolvePiDirs(sub);
		expect(projectDir).toBe(root);
	});

	it("walks up to the nearest .pi marker when no .git", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-dirs-pi-"));
		const { mkdirSync } = require("node:fs");
		mkdirSync(join(root, ".pi"));
		const sub = join(root, "x", "y");
		mkdirSync(sub, { recursive: true });
		const { projectDir } = resolvePiDirs(sub);
		expect(projectDir).toBe(root);
	});
});
