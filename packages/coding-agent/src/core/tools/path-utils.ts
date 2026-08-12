import { execSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";

/** Cache of resolved git roots, keyed by cwd. Lazy, one-shot per session. */
const gitRootCache = new Map<string, string | undefined>();

/** Resolve the git repository root for a given cwd. Returns undefined outside a repo. */
export function resolveGitRoot(cwd: string): string | undefined {
	const cached = gitRootCache.get(cwd);
	if (cached !== undefined) return cached;
	try {
		const root = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8", timeout: 5000 }).trim();
		gitRootCache.set(cwd, root);
		return root;
	} catch {
		gitRootCache.set(cwd, undefined);
		return undefined;
	}
}

/**
 * Check whether an absolute path is within an allowed scope prefix.
 * Returns the scope prefix if the path is outside all prefixes, undefined if allowed.
 */
export function checkWriteScope(absolutePath: string, scopePrefixes: string[]): string | undefined {
	for (const prefix of scopePrefixes) {
		const rel = relative(prefix, absolutePath);
		if (!rel.startsWith("..") && !isAbsolute(rel)) return undefined;
	}
	return scopePrefixes[0];
}

/** Redirect extraction patterns for bash command scope checking. */
const REDIR_PATTERNS = [
	/(?<![\d\->])&?\d?>>?\s*([^\s;&|<>()]+)/g,
	/\btee\b(?:\s+-[a-zA-Z]*)*\s+([^\s;&|<>()]+)/g,
	/\b(?:cp|mv|rsync|install|ln)\b(?:\s+-[a-zA-Z0-9./]+)*(?<!-t|-T)\s+[^\s;&|<>()-]+\s+([^\s;&|<>()]+)/g,
	/\bdd\b[^;&|]*?\bof=([^\s;&|<>()]+)/g,
	/\bsed\s+(-[^\s;&|]*i[^\s;&|]*)((?:\s+[^\s;&|<>()]+)+)/g,
];

/** Extract potential write destination paths from a bash command string. */
export function extractBashRedirectPaths(command: string): string[] {
	const paths = new Set<string>();
	for (const pattern of REDIR_PATTERNS) {
		for (const match of command.matchAll(pattern)) {
			const captures = match.slice(1).filter(Boolean) as string[];
			for (const cap of captures) {
				// split multi-arg groups (sed -i, cp/mv targets, tee)
				for (const part of cap.split(/\s+/)) {
					if (part && !part.startsWith("-")) paths.add(part);
				}
			}
		}
	}
	return [...paths];
}

const NARROW_NO_BREAK_SPACE = "\u202F";

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);

	if (await pathExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && (await pathExists(amPmVariant))) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && (await pathExists(nfdVariant))) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && (await pathExists(curlyVariant))) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
		return nfdCurlyVariant;
	}

	return resolved;
}
