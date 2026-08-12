/**
 * Nvim socket client — connects to nvim's built-in --listen socket for API access.
 * Uses JSON-RPC over unix socket for LSP queries, buffer state, diagnostics.
 *
 * When running with the pi nvim plugin, the plugin listens on the same socket
 * and handles higher-level `request` methods (getBufferState, getBuffers,
 * applyEdits, getDiagnostics, lspReferences, lspDefinition, lspHover, tsQuery,
 * execTerminal, nvimConfig).
 *
 * Without the plugin, falls back to direct nvim RPC API calls via
 * `nvim_exec_lua`.
 */

import { connect, Socket } from "node:net";
import { createInterface, Interface } from "node:readline";
import type {
	NvimBuffer,
	NvimBufferEdit,
	NvimBufferState,
	NvimDiagnostic,
	NvimLspLocation,
} from "./nvim-transport-types.js";

export interface NvimSocketOptions {
	socketPath: string;
	onClose?: () => void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
}

export class NvimSocketClient {
	#socket: Socket | null = null;
	#rl: Interface | null = null;
	#pending = new Map<number, PendingRequest>();
	#nextId = 1;
	#options: NvimSocketOptions;

	constructor(options: NvimSocketOptions) {
		this.#options = options;
	}

	get socketPath(): string {
		return this.#options.socketPath;
	}

	get connected(): boolean {
		return this.#socket !== null && !this.#socket.destroyed;
	}

	async connect(): Promise<void> {
		// Retry up to 3 seconds for nvim to create the socket
		const deadline = Date.now() + 3000;
		let lastError: Error | undefined;
		while (Date.now() < deadline) {
			try {
				await this.#doConnect();
				return;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if ((lastError as NodeJS.ErrnoException).code !== "ENOENT") throw lastError;
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		throw lastError ?? new Error("Failed to connect to nvim socket");
	}

	async #doConnect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const sock = connect({ path: this.#options.socketPath });
			sock.on("error", (err) => reject(err));
			sock.on("connect", () => {
				this.#socket = sock;
				sock.on("close", () => this.#options.onClose?.());
				const rl = createInterface({ input: sock });
				this.#rl = rl;
				rl.on("line", (line: string) => {
					try {
						const msg = JSON.parse(line);
						if (msg.id !== undefined && this.#pending.has(msg.id)) {
							const handler = this.#pending.get(msg.id)!;
							this.#pending.delete(msg.id);
							if (msg.error) handler.reject(new Error(msg.error.message ?? "unknown"));
							else handler.resolve(msg.result);
						}
					} catch {
						// ignore parse errors (could be non-JSON output)
					}
				});
				resolve();
			});
		});
	}

	/** Send a JSON-RPC request and wait for the response. */
	async call(method: string, params?: unknown[]): Promise<unknown> {
		if (!this.#socket) throw new Error("Not connected");
		const id = this.#nextId++;
		const request = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#socket!.write(request);
		});
	}

	/**
	 * Send a high-level request to the pi nvim plugin.
	 * These are custom methods handled by the Lua plugin bridge.
	 */
	async request(method: string, params?: Record<string, unknown>): Promise<any> {
		return this.call("nvim_exec_lua", [
			`return require('pi').handle('${method}', ${params ? JSON.stringify(params) : "nil"})`,
		]);
	}

	/**
	 * Evaluate arbitrary Lua in nvim and return the result.
	 * Falls back to direct nvim_exec_lua when plugin is not available.
	 */
	async evalLua(code: string): Promise<string> {
		try {
			const result = await this.call("nvim_exec_lua", [code, []]);
			return String(result ?? "");
		} catch (e) {
			throw new Error(`nvim Lua eval failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ── High-level buffer operations ──

	/** Get state of the current nvim buffer: path, content, cursor, selection. */
	async getBufferState(name?: string): Promise<NvimBufferState | null> {
		try {
			if (name) {
				const bufnr = await this.call("nvim_exec_lua", [
					`local bufnr = vim.fn.bufnr("${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")
return bufnr == -1 and nil or bufnr`,
				]);
				if (bufnr === null || bufnr === undefined) return null;
				return this.#buildBufferState(bufnr as number);
			}
			const currentBuf = await this.call("nvim_get_current_buf");
			if (typeof currentBuf !== "number") return null;
			return this.#buildBufferState(currentBuf);
		} catch {
			return null;
		}
	}

	async #buildBufferState(bufnr: number): Promise<NvimBufferState> {
		const [name, lines, cursor, modified, filetype] = await Promise.all([
			this.call("nvim_buf_get_name", [bufnr]) as Promise<string>,
			this.call("nvim_buf_get_lines", [bufnr, 0, -1, false]) as Promise<string[]>,
			this.call("nvim_win_get_cursor", [0]) as Promise<[number, number]>,
			this.call("nvim_buf_get_option", [bufnr, "modified"]) as Promise<boolean>,
			this.call("nvim_buf_get_option", [bufnr, "filetype"]) as Promise<string>,
		]);
		return {
			path: typeof name === "string" ? name : "",
			content: Array.isArray(lines) ? lines.join("\n") : "",
			cursor: [cursor[0] - 1, cursor[1]], // 1-indexed → 0-indexed
			modified: Boolean(modified),
			filetype: String(filetype ?? ""),
		};
	}

	/** List all open buffers. */
	async getBuffers(): Promise<NvimBuffer[]> {
		try {
			const result = await this.evalLua(`
local bufs = vim.api.nvim_list_bufs()
local out = {}
for _, bufnr in ipairs(bufs) do
  table.insert(out, {
    bufnr = bufnr,
    name = vim.api.nvim_buf_get_name(bufnr),
    loaded = vim.api.nvim_buf_is_loaded(bufnr),
    modified = vim.api.nvim_buf_get_option(bufnr, "modified"),
    filetype = vim.api.nvim_buf_get_option(bufnr, "filetype") or "",
  })
end
return vim.inspect(out)
`);
			// Parse Lua table output. Simple approach: use JSON fallback when available.
			return JSON.parse(result) as NvimBuffer[];
		} catch {
			// Fallback: parse vim.inspect output
			return [];
		}
	}

	/** Apply edits to a buffer by name. */
	async applyEdits(name: string, edits: NvimBufferEdit[]): Promise<void> {
		await this.evalLua(`
local bufnr = vim.fn.bufnr("${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")
if bufnr == -1 then error("Buffer not found: ${name}") end
vim.bo[bufnr].undolevels = vim.bo[bufnr].undolevels
for _, edit in ipairs(${JSON.stringify(edits)}) do
  vim.api.nvim_buf_set_lines(bufnr, edit.startLine, edit.endLine, false, edit.newLines)
end
`);
	}

	/** Get diagnostics for a buffer (or all buffers). */
	async getDiagnostics(name?: string): Promise<NvimDiagnostic[]> {
		try {
			const bufnrArg = name
				? `vim.fn.bufnr("${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`
				: "0";
			const result = await this.call("nvim_exec_lua", [
				`return vim.diagnostic.get(${bufnrArg})`,
				[],
			]);
			return (result as NvimDiagnostic[]) ?? [];
		} catch {
			return [];
		}
	}

	/** Get LSP references for position. */
	async getLspReferences(
		name: string,
		lnum: number,
		col: number,
	): Promise<NvimLspLocation[]> {
		try {
			const bufnr = await this.#getBufnr(name);
			if (bufnr === null) return [];
			const result = await this.call("nvim_exec_lua", [
				`local params = vim.lsp.util.make_position_params()
return vim.lsp.buf_request_sync(${bufnr}, 'textDocument/references', params, 1000)`,
				[],
			]);
			// Extract locations from response
			const locations: NvimLspLocation[] = [];
			if (Array.isArray(result)) {
				for (const item of result) {
					if (item?.result && Array.isArray(item.result)) {
						for (const loc of item.result) {
							if (loc.uri && loc.range) locations.push(loc);
						}
					}
				}
			}
			return locations;
		} catch {
			return [];
		}
	}

	/** Get LSP definition for position. */
	async getLspDefinition(
		name: string,
		lnum: number,
		col: number,
	): Promise<NvimLspLocation[]> {
		try {
			const bufnr = await this.#getBufnr(name);
			if (bufnr === null) return [];
			const result = await this.call("nvim_exec_lua", [
				`local params = vim.lsp.util.make_position_params()
return vim.lsp.buf_request_sync(${bufnr}, 'textDocument/definition', params, 1000)`,
				[],
			]);
			const locations: NvimLspLocation[] = [];
			if (Array.isArray(result)) {
				for (const item of result) {
					if (item?.result) {
						const locs = Array.isArray(item.result) ? item.result : [item.result];
						for (const loc of locs) {
							if (loc.uri && loc.range) locations.push(loc);
						}
					}
				}
			}
			return locations;
		} catch {
			return [];
		}
	}

	/** Get LSP hover for position. */
	async getLspHover(
		name: string,
		lnum: number,
		col: number,
	): Promise<{ contents: Array<string | { language: string; value: string }> } | null> {
		try {
			const bufnr = await this.#getBufnr(name);
			if (bufnr === null) return null;
			const result = await this.call("nvim_exec_lua", [
				`local params = vim.lsp.util.make_position_params()
local result = vim.lsp.buf_request_sync(${bufnr}, 'textDocument/hover', params, 1000)
return result`,
				[],
			]);
			if (Array.isArray(result) && result.length > 0 && result[0]?.result) {
				const hover = result[0].result as any;
				if (hover?.contents) return hover;
			}
			return null;
		} catch {
			return null;
		}
	}

	/** Run a treesitter query on a buffer. */
	async tsQuery(name: string, query: string): Promise<string> {
		return this.evalLua(`
local bufnr = vim.fn.bufnr("${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")
if bufnr == -1 then return "Buffer not found" end
local parser = vim.treesitter.get_parser(bufnr)
if not parser then return "No treesitter parser available" end
local tree = parser:parse()[1]
local root = tree:root()
local q = vim.treesitter.query.parse(vim.bo[bufnr].filetype, [[${query.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}]])
local results = {}
for id, node, metadata in q:iter_captures(root, bufnr) do
  local name = q.captures[id]
  local start_row, start_col, end_row, end_col = node:range()
  local text = vim.treesitter.get_node_text(node, bufnr)
  table.insert(results, string.format("%s @ %d:%d-%d:%d: %s", name, start_row, start_col, end_row, end_col, text))
end
return table.concat(results, "\\n")
`);
	}

	/** Execute a command in nvim's built-in terminal. */
	async execTerminal(command: string, cwd: string): Promise<{ output: string; exitCode: number }> {
		return this.evalLua(`
local output = {}
local exitCode = 0
local job = vim.fn.jobstart(${JSON.stringify(command)}, {
  cwd = "${cwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}",
  on_stdout = function(_, data) for _, line in ipairs(data or {}) do table.insert(output, line) end end,
  on_stderr = function(_, data) for _, line in ipairs(data or {}) do table.insert(output, line) end end,
  on_exit = function(_, code) exitCode = code end,
  stdout_buffered = true,
  stderr_buffered = true,
})
vim.fn.jobwait({job})
return vim.inspect({ output = table.concat(output, "\\n"), exitCode = exitCode })
`) as unknown as Promise<{ output: string; exitCode: number }>;
	}

	/** Get nvim configuration info. */
	async getNvimConfig(section: string): Promise<unknown> {
		switch (section) {
			case "keymaps": {
				const result = await this.evalLua(`
local keymaps = {}
for _, mode in ipairs({"n", "v", "i", "x", "s", "o", "t", "c"}) do
  for _, km in ipairs(vim.api.nvim_get_keymap(mode)) do
    if km.desc and km.desc ~= "" and not km.desc:match("^@") then
      table.insert(keymaps, { lhs = km.lhs, rhs = km.rhs or "", mode = mode, desc = km.desc })
    end
  end
end
return vim.inspect(keymaps)
`);
				return JSON.parse(result);
			}
			case "options": {
				const result = await this.evalLua(`
local opts = {}
for _, opt in ipairs({"expandtab","tabstop","shiftwidth","softtabstop","textwidth",
  "colorcolumn","number","relativenumber","list","wrap","linebreak",
  "foldmethod","foldlevel","scrolloff","sidescrolloff","mouse","clipboard",
  "completeopt","pumblend","winblend","shell","shellcmdflag","formatoptions"}) do
  local ok, val = pcall(vim.api.nvim_get_option, opt)
  if ok then opts[opt] = val end
end
return vim.inspect(opts)
`);
				return JSON.parse(result);
			}
			case "lsp": {
				const result = await this.evalLua(`
local clients = vim.lsp.get_clients()
local servers = {}
for _, c in ipairs(clients) do
  local caps = {}
  if c.server_capabilities then
    for k, v in pairs(c.server_capabilities) do
      if v and k:match("Provider$") then table.insert(caps, k:gsub("Provider$", "")) end
    end
  end
  table.insert(servers, { name = c.name, root_dir = c.config.root_dir or "?", capabilities = caps })
end
return vim.inspect(servers)
`);
				return JSON.parse(result);
			}
			case "plugins": {
				const result = await this.evalLua(`
if pcall(require, "lazy") then
  return vim.inspect(vim.tbl_map(function(spec) return spec.name or spec[1] or "?" end, require("lazy").plugins()))
else
  local dirs = {}
  for _, pp in ipairs(vim.opt.packpath:get()) do
    for _, sub in ipairs({"pack/*/opt", "pack/*/start"}) do
      local p = vim.fn.glob(pp .. "/" .. sub .. "/*", false, true)
      for _, d in ipairs(p) do table.insert(dirs, vim.fn.fnamemodify(d, ":t")) end
    end
  end
  return vim.inspect(dirs)
end
`);
				return JSON.parse(result);
			}
			default:
				return [];
		}
	}

	async #getBufnr(name: string): Promise<number | null> {
		const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const bufnr = await this.call("nvim_exec_lua", [
			`return vim.fn.bufnr("${escaped}")`,
		]);
		const num = Number(bufnr);
		return num === -1 ? null : num;
	}

	disconnect(): void {
		this.#socket?.destroy();
		this.#socket = null;
		this.#rl?.close();
		this.#rl = null;
	}
}
