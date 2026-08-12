// Resolves pi directory structure: config dir, project dir, etc.
// Re-exported for crew and personas subsystems.

export interface PiDirs {
	configDir: string;
	userDir: string;
	projectDir?: string;
}

export function resolvePiDirs(cwd: string): PiDirs {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
	const userDir = `${home}/.pi`;
	const configDir = `${userDir}/config`;

	// Walk up from cwd to find .pi or .git as project root marker
	let dir = cwd;
	let projectDir: string | undefined;
	while (dir !== "/" && dir !== ".") {
		try {
			const { statSync } = require("node:fs");
			if (statSync(`${dir}/.pi`).isDirectory() || statSync(`${dir}/.git`).isDirectory()) {
				projectDir = dir;
				break;
			}
		} catch {}
		const parent = dir.substring(0, dir.lastIndexOf("/")) || "/";
		if (parent === dir) break;
		dir = parent;
	}

	return { configDir, userDir, projectDir };
}
