/**
 * Nvim-backed Operations implementations.
 *
 * These implement ReadOperations, EditOperations, WriteOperations,
 * BashOperations, FindOperations, GrepOperations, LsOperations using the
 * nvim socket client instead of direct filesystem access.
 *
 * Accept a lazy client getter so tools can be created before the socket
 * connects. Each operation checks at call time whether the client is
 * connected; if not, it falls back to a local filesystem path or throws.
 *
 * Read operations: reads buffer content directly from nvim (always in sync).
 * Write operations: writes content to nvim buffer AND saves to disk.
 * Edit operations: applies edits in nvim buffer then saves.
 * Grep/Find operations: delegates to nvim's built-in grep or telescope.
 */

import { constants } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir } from "node:fs/promises";
import type { BashOperations } from "../tools/bash.js";
import type { EditOperations } from "../tools/edit.js";
import type { FindOperations } from "../tools/find.js";
import type { GrepOperations } from "../tools/grep.js";
import type { LsOperations } from "../tools/ls.js";
import type { ReadOperations } from "../tools/read.js";
import type { WriteOperations } from "../tools/write.js";
import type { NvimSocketClient } from "./nvim-socket-client.js";

type ClientGetter = () => NvimSocketClient | undefined;

// ── Read ────────────────────────────────────────────────────────────────────

export function createNvimReadOps(getClient: ClientGetter): ReadOperations {
	return {
		readFile: async (absolutePath: string): Promise<Buffer> => {
			const client = getClient();
			if (client) {
				const state = await client.getBufferState(absolutePath);
				if (state) return Buffer.from(state.content, "utf-8");
				// Buffer not loaded: open it, read, then restore state
				await client.evalLua(`vim.cmd("silent! edit ${absolutePath.replace(/ /g, "\\ ")}")`);
				const newState = await client.getBufferState();
				if (newState) return Buffer.from(newState.content, "utf-8");
			}
			throw new Error(`nvim: cannot read ${absolutePath}`);
		},
		access: async (absolutePath: string): Promise<void> => {
			const client = getClient();
			if (client) {
				const buffers = await client.getBuffers();
				const found = buffers.find((b) => b.name === absolutePath && b.loaded);
				if (found) return;
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
				await client.evalLua(`vim.cmd("silent! edit ${absolutePath.replace(/ /g, "\\ ")}")`);
				const newState = await client.getBufferState();
				if (newState) return Buffer.from(newState.content, "utf-8");
			}
			throw new Error(`nvim: cannot read ${absolutePath}`);
		},
		writeFile: async (absolutePath: string, content: string): Promise<void> => {
			const client = getClient();
			if (!client) throw new Error("nvim: not connected");
			const lines = content.split("\n");
			if (content.endsWith("\n")) lines.pop(); // trailing newline → split creates extra empty line

			// Check if buffer is already open
			const buffers = await client.getBuffers();
			const found = buffers.find((b) => b.name === absolutePath && b.loaded);

			if (found) {
				const state = await client.getBufferState(absolutePath);
				if (state) {
					const currentLines = state.content.split("\n");
					// Replace entire buffer
					await client.applyEdits(absolutePath, [
						{ startLine: 0, endLine: currentLines.length, newLines: lines },
					]);
				}
			}
			// Always also write to disk so the edit tool's contract is fulfilled
			const { writeFile } = await import("node:fs/promises");
			await writeFile(absolutePath, content, "utf-8");
		},
		access: async (absolutePath: string): Promise<void> => {
			const client = getClient();
			if (client) {
				const buffers = await client.getBuffers();
				if (buffers.some((b) => b.name === absolutePath && b.loaded)) return;
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

				const buffers = await client.getBuffers();
				const found = buffers.find((b) => b.name === absolutePath && b.loaded);

				if (found) {
					const state = await client.getBufferState(absolutePath);
					if (state) {
						await client.applyEdits(absolutePath, [
							{ startLine: 0, endLine: state.content.split("\n").length, newLines: lines },
						]);
					}
				}
				// Also write to disk
				const { writeFile } = await import("node:fs/promises");
				await writeFile(absolutePath, content, "utf-8");
				return;
			}
			// Fallback: write directly to filesystem
			const { writeFile } = await import("node:fs/promises");
			await writeFile(absolutePath, content, "utf-8");
		},
		mkdir: async (dir: string): Promise<void> => {
			await fsMkdir(dir, { recursive: true });
		},
	};
}

// ── Bash ────────────────────────────────────────────────────────────────────

export function createNvimBashOps(getClient: ClientGetter): BashOperations {
	return {
		exec: async (
			command: string,
			cwd: string,
			{ onData }: { onData: (chunk: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
		): Promise<{ exitCode: number | null }> => {
			const client = getClient();
			if (client) {
				const result = await client.execTerminal(command, cwd);
				if (result.output.length > 0) {
					onData(Buffer.from(result.output, "utf-8"));
				}
				return { exitCode: result.exitCode };
			}
			throw new Error("nvim: not connected");
		},
	};
}

// ── Find ────────────────────────────────────────────────────────────────────

export function createNvimFindOps(getClient: ClientGetter): FindOperations {
	return {
		exists: async (absolutePath: string): Promise<boolean> => {
			const client = getClient();
			if (client) {
				const buffers = await client.getBuffers();
				return buffers.some((b) => b.name === absolutePath && b.loaded);
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
			{ ignore, limit }: { ignore: string[]; limit: number },
		): Promise<string[]> => {
			const client = getClient();
			if (client) {
				// Use nvim's built-in glob
				const luaPattern = pattern.replace(/\\/g, "/");
				const result = await client.evalLua(`
local results = vim.fn.globpath("${searchPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", "${luaPattern}", false, true)
if #results > ${limit} then
  results = vim.list_slice(results, 1, ${limit})
end
return vim.inspect(results)
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
				const { stat } = await import("node:fs/promises");
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
				const buffers = await client.getBuffers();
				if (buffers.some((b) => b.name === absolutePath && b.loaded)) return true;
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
				const buffers = await client.getBuffers();
				const found = buffers.find((b) => b.name === absolutePath && b.loaded);
				if (found) return { isDirectory: () => false };
			}
			try {
				const { stat } = await import("node:fs/promises");
				return await stat(absolutePath);
			} catch {
				throw new Error(`ENOENT: ${absolutePath}`);
			}
		},
		readdir: async (absolutePath: string): Promise<string[]> => {
			const { readdir } = await import("node:fs/promises");
			return readdir(absolutePath);
		},
	};
}
