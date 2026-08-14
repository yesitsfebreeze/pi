/**
 * Nvim-backed Operations implementations.
 *
 * These implement ReadOperations, EditOperations, WriteOperations,
 * FindOperations, GrepOperations, LsOperations using the nvim socket client
 * instead of direct filesystem access.
 *
 * Accept a lazy client getter so tools can be created before the socket
 * connects. Each operation checks at call time whether the client is
 * connected; if not, it falls back to a local filesystem path or throws.
 *
 * Buffer lookup goes through `getBufferState(path)` — which resolves the path
 * via `vim.fn.bufnr()` — never by string-matching `getBuffers()` names:
 * nvim reports the *resolved* path (e.g. /private/tmp/… for a /tmp symlink)
 * while callers pass the path as given, so name equality silently misses
 * open buffers.
 *
 * Read operations: reads buffer content directly from nvim (always in sync).
 * Write operations: writes content to nvim buffer AND saves to disk.
 * Edit operations: applies edits in nvim buffer then saves.
 * Grep/Find operations: delegates to nvim's built-in grep or telescope.
 */

import { constants } from "node:fs";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readFile as fsReadFile,
	readdir,
	stat,
	writeFile,
} from "node:fs/promises";
import type { EditOperations } from "../tools/edit.ts";
import type { FindOperations } from "../tools/find.ts";
import type { GrepOperations } from "../tools/grep.ts";
import type { LsOperations } from "../tools/ls.ts";
import type { ReadOperations } from "../tools/read.ts";
import type { WriteOperations } from "../tools/write.ts";
import { luaQuote, type NvimSocketClient } from "./nvim-socket-client.ts";

type ClientGetter = () => NvimSocketClient | undefined;

/**
 * 1-based index of the first differing line between two texts (for revealing
 * the edit site in the editor). undefined when the texts are identical.
 */
function firstDiffLine(before: string[], after: string[]): number | undefined {
	const n = Math.max(before.length, after.length);
	for (let i = 0; i < n; i++) {
		if (before[i] !== after[i]) return i + 1;
	}
	return undefined;
}

// ── Read ────────────────────────────────────────────────────────────────────

export function createNvimReadOps(getClient: ClientGetter): ReadOperations {
	return {
		readFile: async (absolutePath: string): Promise<Buffer> => {
			const client = getClient();
			if (client) {
				const state = await client.getBufferState(absolutePath);
				if (state) return Buffer.from(state.content, "utf-8");
				// Buffer not loaded: load it into a hidden buffer via bufadd/bufload.
				// Unlike `silent! edit`, this never touches the current window or the
				// visible layout, and bufadd is path-based so it cannot return the
				// wrong buffer.
				await client.evalLua(`
local bufnr = vim.fn.bufadd(${JSON.stringify(absolutePath)})
if bufnr > 0 then vim.fn.bufload(bufnr) end
`);
				const newState = await client.getBufferState(absolutePath);
				if (newState) return Buffer.from(newState.content, "utf-8");
			}
			// Fallback: read from disk so the read tool keeps working even when
			// nvim cannot load the buffer (special paths, huge files, etc.).
			return fsReadFile(absolutePath);
		},
		access: async (absolutePath: string): Promise<void> => {
			const client = getClient();
			if (client) {
				const state = await client.getBufferState(absolutePath);
				if (state) return;
			}
			// Fallback to filesystem
			await fsAccess(absolutePath, constants.R_OK);
		},
		detectImageMimeType: undefined, // images go through filesystem for now
	};
}

// ── Edit ────────────────────────────────────────────────────────────────────

export function createNvimEditOps(getClient: ClientGetter): EditOperations {
	return {
		readFile: async (absolutePath: string): Promise<Buffer> => {
			const client = getClient();
			if (client) {
				const state = await client.getBufferState(absolutePath);
				if (state) return Buffer.from(state.content, "utf-8");
				await client.evalLua(`
local bufnr = vim.fn.bufadd(${JSON.stringify(absolutePath)})
if bufnr > 0 then vim.fn.bufload(bufnr) end
`);
				const newState = await client.getBufferState(absolutePath);
				if (newState) return Buffer.from(newState.content, "utf-8");
			}
			return fsReadFile(absolutePath);
		},
		writeFile: async (absolutePath: string, content: string): Promise<void> => {
			const client = getClient();
			if (!client) throw new Error("nvim: not connected");
			const lines = content.split("\n");
			if (content.endsWith("\n")) lines.pop(); // trailing newline → split creates extra empty line

			// Buffer lookup by path (bufnr-resolved); updates the live buffer when
			// it is open in nvim, and always writes to disk afterwards.
			const state = await client.getBufferState(absolutePath);
			let changedLine: number | undefined;
			if (state) {
				const currentLines = state.content.split("\n");
				changedLine = firstDiffLine(currentLines, lines);
				// Replace entire buffer
				await client.applyEdits(absolutePath, [{ startLine: 0, endLine: currentLines.length, newLines: lines }]);
			}
			// Always also write to disk so the edit tool's contract is fulfilled
			await writeFile(absolutePath, content, "utf-8");
			// Show the user what changed: switch the view to the file and land the
			// cursor on the first edited line (the user watches the editor — edits
			// must be visible, not background-buffer whispers).
			if (changedLine !== undefined) {
				try {
					await client.revealFile(absolutePath, changedLine);
				} catch {
					// best-effort: a stuck reveal must never fail an edit
				}
			}
		},
		access: async (absolutePath: string): Promise<void> => {
			const client = getClient();
			if (client) {
				const state = await client.getBufferState(absolutePath);
				if (state) return;
			}
			await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
		},
	};
}

// ── Write ───────────────────────────────────────────────────────────────────

export function createNvimWriteOps(getClient: ClientGetter): WriteOperations {
	return {
		writeFile: async (absolutePath: string, content: string): Promise<void> => {
			const client = getClient();
			if (client) {
				const lines = content.split("\n");
				if (content.endsWith("\n")) lines.pop();

				const state = await client.getBufferState(absolutePath);
				let changedLine: number | undefined;
				if (state) {
					changedLine = firstDiffLine(state.content.split("\n"), lines);
					await client.applyEdits(absolutePath, [
						{ startLine: 0, endLine: state.content.split("\n").length, newLines: lines },
					]);
				}
				// Also write to disk
				await writeFile(absolutePath, content, "utf-8");
				// Reveal the edited site so the user sees the write happen.
				if (changedLine !== undefined) {
					try {
						await client.revealFile(absolutePath, changedLine);
					} catch {
						// best-effort
					}
				}
				return;
			}
			// Fallback: write directly to filesystem
			await writeFile(absolutePath, content, "utf-8");
		},
		mkdir: async (dir: string): Promise<void> => {
			await fsMkdir(dir, { recursive: true });
		},
	};
}

// ── Find ────────────────────────────────────────────────────────────────────

export function createNvimFindOps(getClient: ClientGetter): FindOperations {
	return {
		exists: async (absolutePath: string): Promise<boolean> => {
			const client = getClient();
			if (client) {
				const state = await client.getBufferState(absolutePath);
				if (state) return true;
			}
			// Fallback
			try {
				await fsAccess(absolutePath, constants.F_OK);
				return true;
			} catch {
				return false;
			}
		},
		glob: async (
			pattern: string,
			searchPath: string,
			// `ignore` is not honoured on this path: vim.fn.globpath has no exclude
			// argument, so nvim-backed find returns matches the local backend would
			// have filtered. Applying the patterns here would need a client-side pass.
			{ ignore: _ignore, limit }: { ignore: string[]; limit: number },
		): Promise<string[]> => {
			const client = getClient();
			if (client) {
				// Use nvim's built-in glob
				const luaPattern = pattern.replace(/\\/g, "/");
				const result = await client.evalLua(`
local results = vim.fn.globpath("${luaQuote(searchPath)}", "${luaPattern}", false, true)
if #results > ${limit} then
  results = vim.list_slice(results, 1, ${limit})
end
return vim.fn.json_encode(results)
`);
				try {
					return JSON.parse(result) as string[];
				} catch {
					return [];
				}
			}
			return [];
		},
	};
}

// ── Grep ────────────────────────────────────────────────────────────────────

export function createNvimGrepOps(getClient: ClientGetter): GrepOperations {
	return {
		isDirectory: async (absolutePath: string): Promise<boolean> => {
			try {
				const s = await stat(absolutePath);
				return s.isDirectory();
			} catch {
				return false;
			}
		},
		readFile: async (absolutePath: string): Promise<string> => {
			const client = getClient();
			if (client) {
				const state = await client.getBufferState(absolutePath);
				if (state) return state.content;
			}
			throw new Error(`nvim: buffer not available for ${absolutePath}`);
		},
	};
}

// ── Ls ──────────────────────────────────────────────────────────────────────

export function createNvimLsOps(getClient: ClientGetter): LsOperations {
	return {
		exists: async (absolutePath: string): Promise<boolean> => {
			const client = getClient();
			if (client) {
				const state = await client.getBufferState(absolutePath);
				if (state) return true;
			}
			try {
				await fsAccess(absolutePath, constants.F_OK);
				return true;
			} catch {
				return false;
			}
		},
		stat: async (absolutePath: string): Promise<{ isDirectory: () => boolean }> => {
			const client = getClient();
			if (client) {
				const state = await client.getBufferState(absolutePath);
				if (state) return { isDirectory: () => false };
			}
			try {
				return await stat(absolutePath);
			} catch {
				throw new Error(`ENOENT: ${absolutePath}`);
			}
		},
		readdir: async (absolutePath: string): Promise<string[]> => {
			return readdir(absolutePath);
		},
	};
}
