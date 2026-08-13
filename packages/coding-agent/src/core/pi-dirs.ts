// Resolves pi directory structure: config dir, project dir, etc.
// Used by crew (walkie-talkie bus roots at project root) and personas
// (.pi/persona.md override lookup walks up to the project root).

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PiDirs {
	configDir: string;
	userDir: string;
	projectDir?: string;
}

export function resolvePiDirs(cwd: string): PiDirs {
	const home = homedir() || process.env.HOME || process.env.USERPROFILE || "/tmp";
	const userDir = join(home, ".pi");
	const configDir = join(userDir, "config");

	// Walk up from cwd to find .pi or .git as the project root marker.
	// Each marker is checked independently so a missing .pi does not mask a .git.
	let dir = cwd;
	let projectDir: string | undefined;
	while (dir && dir !== "/" && dir !== ".") {
		if (isMarkerDir(dir, ".pi") || isMarkerDir(dir, ".git")) {
			projectDir = dir;
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return { configDir, userDir, projectDir };
}

function isMarkerDir(dir: string, name: string): boolean {
	try {
		return statSync(join(dir, name)).isDirectory();
	} catch {
		return false;
	}
}
