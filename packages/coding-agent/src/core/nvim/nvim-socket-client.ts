/**
 * Nvim RPC client — high-level access to a running nvim instance.
 *
 * Transport: an `NvimExec` function (created by `createNvimExec` in `nvim.ts`)
 * that evaluates Lua in nvim via `nvim --server <socket> --remote-expr
 * luaeval(...)`. This uses nvim's native msgpack-rpc client-server protocol,
 * which works with any `nvim --listen <socket>` instance — including the pi
 * nvim plugin, which starts pi with `--nvim-socket <vim.v.servername>`.
 *
 * NOTE: nvim's `--listen` socket speaks msgpack-rpc, NOT JSON-RPC. Earlier
 * versions of this client sent JSON-RPC over the raw socket, which nvim
 * silently ignored (0-byte responses). All RPC now flows through `exec`,
 * which shells out to `nvim --server`, so we never read the socket directly.
 *
 * Structured data (buffers, diagnostics, LSP locations) is serialized in Lua
 * with `vim.json.encode` and parsed here with `JSON.parse`, so callers get
 * real JS objects instead of `vim.inspect` strings.
 */

import type { NvimExec } from "../nvim.js";
import type {
	NvimBuffer,
	NvimBufferEdit,
	NvimBufferRead,
	NvimBufferState,
	NvimDiagnostic,
	NvimFindReplaceResult,
	NvimLspLocation,
	NvimStateBrief,
	NvimStateFull,
} from "./nvim-transport-types.js";

export interface NvimSocketOptions {
	socketPath: string;
	/** Lua transport. Usually `createNvimExec(socketPath)`. */
	exec: NvimExec;
	onClose?: () => void;
}

export class NvimSocketClient {
	#options: NvimSocketOptions;
	#connected = true;

	constructor(options: NvimSocketOptions) {
		this.#options = options;
	}

	get socketPath(): string {
		return this.#options.socketPath;
	}

	/** True while the underlying exec transport is usable. */
	get connected(): boolean {
		return this.#connected;
	}

	/**
	 * Send a high-level request to the pi nvim plugin.
	 * These are custom methods handled by the Lua plugin bridge (`_G.PI`).
	 */
	async request(method: string, params?: Record<string, unknown>): Promise<any> {
		return this.evalLua(`return require('pi').handle('${method}', ${params ? JSON.stringify(params) : "nil"})`);
	}

	/**
	 * Evaluate arbitrary Lua in nvim and return the result as a string.
	 * `exec` returns the stringified result of the Lua expression.
	 */
	async evalLua(code: string): Promise<string> {
		try {
			const result = await this.#options.exec(code);
			return String(result ?? "");
		} catch (e) {
			throw new Error(`nvim Lua eval failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Evaluate Lua that must return a JSON string (typically via
	 * `vim.json.encode(...)`) and parse it into a JS value.
	 */
	async evalLuaJson<T = unknown>(code: string): Promise<T> {
		const raw = await this.evalLua(code);
		if (raw === "" || raw === "nil" || raw === "vim.NIL") return undefined as unknown as T;
		try {
			return JSON.parse(raw) as T;
		} catch {
			// Not JSON — return the raw string wrapped so callers can detect it.
			return raw as unknown as T;
		}
	}

	/** Escape a string for safe embedding inside a Lua double-quoted string. */
	static #luaQuote(s: string): string {
		return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
	}

	// ── High-level buffer operations ──

	/** Get state of the current nvim buffer: path, content, cursor, selection. */
	async getBufferState(name?: string): Promise<NvimBufferState | null> {
		try {
			const nameArg = name ? `"${NvimSocketClient.#luaQuote(name)}"` : "nil";
			const state = await this.evalLuaJson<NvimBufferState | null>(`
local function build(bufnr)
  if bufnr == nil or bufnr == -1 then return nil end
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local cursor = vim.api.nvim_win_get_cursor(0)
  return {
    path = vim.api.nvim_buf_get_name(bufnr) or "",
    content = table.concat(lines, "\\n"),
    cursor = { cursor[1] - 1, cursor[2] },
    modified = vim.api.nvim_buf_get_option(bufnr, "modified"),
    filetype = vim.api.nvim_buf_get_option(bufnr, "filetype") or "",
  }
end
local bufnr = ${nameArg}
if bufnr == nil then bufnr = vim.api.nvim_get_current_buf() end
local state = build(bufnr)
return state and vim.json.encode(state) or "null"
`);
			return state ?? null;
		} catch {
			return null;
		}
	}

	/** List all open buffers. */
	async getBuffers(): Promise<NvimBuffer[]> {
		try {
			return await this.evalLuaJson<NvimBuffer[]>(`
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
return vim.json.encode(out)
`);
		} catch {
			return [];
		}
	}

	/** Apply edits to a buffer by name. */
	async applyEdits(name: string, edits: NvimBufferEdit[]): Promise<void> {
		const q = NvimSocketClient.#luaQuote;
		await this.evalLua(`
local bufnr = vim.fn.bufnr("${q(name)}")
if bufnr == -1 then error("Buffer not found: ${q(name)}") end
for _, edit in ipairs(${JSON.stringify(edits)}) do
  vim.api.nvim_buf_set_lines(bufnr, edit.startLine, edit.endLine, false, edit.newLines)
end
`);
	}

	/** Get diagnostics for a buffer (or all buffers). */
	async getDiagnostics(name?: string): Promise<NvimDiagnostic[]> {
		try {
			const bufnrArg = name ? `vim.fn.bufnr("${NvimSocketClient.#luaQuote(name)}")` : "0";
			return await this.evalLuaJson<NvimDiagnostic[]>(`
local diags = vim.diagnostic.get(${bufnrArg})
local out = {}
for _, d in ipairs(diags) do
  table.insert(out, {
    bufnr = d.bufnr,
    lnum = d.lnum,
    col = d.col,
    severity = d.severity,
    source = d.source or "",
    message = d.message or "",
  })
end
return vim.json.encode(out)
`);
		} catch {
			return [];
		}
	}

	/** Get LSP references for position. */
	async getLspReferences(_name: string, _lnum: number, _col: number): Promise<NvimLspLocation[]> {
		try {
			return await this.evalLuaJson<NvimLspLocation[]>(`
local params = vim.lsp.util.make_position_params()
local results = vim.lsp.buf_request_sync(0, 'textDocument/references', params, 1000)
local out = {}
for _, resp in ipairs(results or {}) do
  if resp.result then
    for _, loc in ipairs(resp.result) do
      if loc.uri and loc.range then table.insert(out, loc) end
    end
  end
end
return vim.json.encode(out)
`);
		} catch {
			return [];
		}
	}

	/** Get LSP definition for position. */
	async getLspDefinition(_name: string, _lnum: number, _col: number): Promise<NvimLspLocation[]> {
		try {
			return await this.evalLuaJson<NvimLspLocation[]>(`
local params = vim.lsp.util.make_position_params()
local results = vim.lsp.buf_request_sync(0, 'textDocument/definition', params, 1000)
local out = {}
for _, resp in ipairs(results or {}) do
  if resp.result then
    local locs = resp.result
    if not vim.tbl_islist(locs) then locs = { locs } end
    for _, loc in ipairs(locs) do
      if loc.uri and loc.range then table.insert(out, loc) end
    end
  end
end
return vim.json.encode(out)
`);
		} catch {
			return [];
		}
	}

	/** Get LSP hover for position. */
	async getLspHover(
		_name: string,
		_lnum: number,
		_col: number,
	): Promise<{ contents: Array<string | { language: string; value: string }> } | null> {
		try {
			const raw = await this.evalLua(`
local params = vim.lsp.util.make_position_params()
local results = vim.lsp.buf_request_sync(0, 'textDocument/hover', params, 1000)
for _, resp in ipairs(results or {}) do
  if resp.result and resp.result.contents then
    return vim.json.encode(resp.result)
  end
end
return "null"
`);
			if (!raw || raw === "null" || raw === "nil") return null;
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}

	/** Run a treesitter query on a buffer. */
	async tsQuery(name: string, query: string): Promise<string> {
		const q = NvimSocketClient.#luaQuote;
		// Treesitter query strings can contain backslashes/quotes; embed via a
		// Lua long-bracket string to avoid escaping headaches.
		const luaQuery = `[==[${query}]==]`;
		return this.evalLua(`
local bufnr = vim.fn.bufnr("${q(name)}")
if bufnr == -1 then return "Buffer not found" end
local ok, parser = pcall(vim.treesitter.get_parser, bufnr)
if not ok or not parser then return "No treesitter parser available" end
local tree = parser:parse()[1]
local root = tree:root()
local qstr = ${luaQuery}
local ok2, qobj = pcall(vim.treesitter.query.parse, vim.bo[bufnr].filetype, qstr)
if not ok2 then return "Query parse error: " .. tostring(qobj) end
local results = {}
for id, node in qobj:iter_captures(root, bufnr) do
  local cname = qobj.captures[id]
  local sr, sc, er, ec = node:range()
  local text = vim.treesitter.get_node_text(node, bufnr)
  table.insert(results, string.format("%s @ %d:%d-%d:%d: %s", cname, sr, sc, er, ec, text))
end
return table.concat(results, "\\n")
`);
	}

	/** Execute a command in nvim's built-in terminal. */
	async execTerminal(command: string, cwd: string): Promise<{ output: string; exitCode: number }> {
		const q = NvimSocketClient.#luaQuote;
		const result = await this.evalLua(`
local output = {}
local exitCode = 0
local job = vim.fn.jobstart("${q(command)}", {
  cwd = "${q(cwd)}",
  on_stdout = function(_, data) for _, line in ipairs(data or {}) do table.insert(output, line) end end,
  on_stderr = function(_, data) for _, line in ipairs(data or {}) do table.insert(output, line) end end,
  on_exit = function(_, code) exitCode = code end,
  stdout_buffered = true,
  stderr_buffered = true,
})
if job <= 0 then return vim.json.encode({ output = "", exitCode = -1 }) end
vim.fn.jobwait({job})
return vim.json.encode({ output = table.concat(output, "\\n"), exitCode = exitCode })
`);
		try {
			return JSON.parse(result) as { output: string; exitCode: number };
		} catch {
			return { output: result, exitCode: -1 };
		}
	}

	/** Get nvim configuration info. */
	async getNvimConfig(section: string): Promise<unknown> {
		switch (section) {
			case "keymaps": {
				return this.evalLuaJson(`
local keymaps = {}
for _, mode in ipairs({"n", "v", "i", "x", "s", "o", "t", "c"}) do
  for _, km in ipairs(vim.api.nvim_get_keymap(mode)) do
    if km.desc and km.desc ~= "" and not km.desc:match("^@") then
      table.insert(keymaps, { lhs = km.lhs, rhs = km.rhs or "", mode = mode, desc = km.desc })
    end
  end
end
return vim.json.encode(keymaps)
`);
			}
			case "options": {
				return this.evalLuaJson(`
local opts = {}
for _, opt in ipairs({"expandtab","tabstop","shiftwidth","softtabstop","textwidth",
  "colorcolumn","number","relativenumber","list","wrap","linebreak",
  "foldmethod","foldlevel","scrolloff","sidescrolloff","mouse","clipboard",
  "completeopt","pumblend","winblend","shell","shellcmdflag","formatoptions"}) do
  local ok, val = pcall(vim.api.nvim_get_option, opt)
  if ok then opts[opt] = val end
end
return vim.json.encode(opts)
`);
			}
			case "lsp": {
				return this.evalLuaJson(`
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
return vim.json.encode(servers)
`);
			}
			case "plugins": {
				return this.evalLuaJson(`
if pcall(require, "lazy") then
  local names = vim.tbl_map(function(spec) return spec.name or spec[1] or "?" end, require("lazy").plugins())
  return vim.json.encode(names)
else
  local dirs = {}
  for _, pp in ipairs(vim.opt.packpath:get()) do
    for _, sub in ipairs({"pack/*/opt", "pack/*/start"}) do
      local p = vim.fn.glob(pp .. "/" .. sub .. "/*", false, true)
      for _, d in ipairs(p) do table.insert(dirs, vim.fn.fnamemodify(d, ":t")) end
    end
  end
  return vim.json.encode(dirs)
end
`);
			}
			default:
				return [];
		}
	}

	// ── Whole-session surface snapshots ──
	// Ported from paulburgess1357/nvim-mcp GET_STATE_BRIEF / GET_STATE. Two
	// tiers: `brief` is cheap enough to pull every turn; `full` adds every
	// window with folds, visual selection, marks, and per-buffer diagnostics.

	/** Lightweight snapshot: mode, cwd, listed+modified buffers, terminals,
	 * active + alternate window with context lines. */
	async getStateBrief(contextLines = 5): Promise<NvimStateBrief | null> {
		try {
			return await this.evalLuaJson<NvimStateBrief>(`
local cwd = vim.fn.getcwd()
local cwd_slash = cwd:sub(-1) == "/" and cwd or (cwd .. "/")
local function rel_path(p)
  if p:sub(1, #cwd_slash) == cwd_slash then return p:sub(#cwd_slash + 1) end
  return p
end
local function get_context(b, from, to, n)
  local total = vim.api.nvim_buf_line_count(b)
  local s = math.max(1, from - n)
  local e = math.min(total, to + n)
  local lines = vim.api.nvim_buf_get_lines(b, s - 1, e, false)
  for i, l in ipairs(lines) do lines[i] = (s + i - 1) .. ": " .. l end
  return lines
end
local function collect_listed_buffers()
  local modified, buffers = {}, {}
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[b].buflisted and vim.api.nvim_buf_is_loaded(b) then
      local name = vim.api.nvim_buf_get_name(b)
      if name ~= "" then
        local rp = rel_path(name)
        buffers[#buffers + 1] = rp
        if vim.bo[b].modified then modified[#modified + 1] = rp end
      end
    end
  end
  return buffers, modified
end
local function collect_terminals()
  local terms = {}
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buftype == "terminal" then
      terms[#terms + 1] = { buf = b, name = rel_path(vim.api.nvim_buf_get_name(b)), visible = vim.fn.bufwinid(b) ~= -1 }
    end
  end
  return terms
end
local mode_names = {
  n = "normal", i = "insert", v = "visual", V = "visual_line",
  ["\\22"] = "visual_block", R = "replace", Rv = "vreplace",
  c = "command", t = "terminal", s = "select", S = "select_line",
  ["\\19"] = "select_block", no = "operator_pending",
  r = "prompt", rm = "prompt", ["r?"] = "prompt",
}
local function win_info(w)
  local b = vim.api.nvim_win_get_buf(w)
  local cursor = vim.api.nvim_win_get_cursor(w)
  local raw_bt = vim.bo[b].buftype
  return {
    file = rel_path(vim.api.nvim_buf_get_name(b)),
    filetype = vim.bo[b].filetype,
    total_lines = vim.api.nvim_buf_line_count(b),
    modified = vim.bo[b].modified,
    buftype = raw_bt == "" and "file" or raw_bt,
    line = cursor[1],
    col = cursor[2] + 1,
  }
end
local ctx_n = ${contextLines}
local cur_win = vim.api.nvim_get_current_win()
local alt_win = vim.fn.win_getid(vim.fn.winnr('#'))
local b = vim.api.nvim_win_get_buf(cur_win)
local active = win_info(cur_win)
if ctx_n > 0 then active.context = get_context(b, active.line, active.line, ctx_n) end
local alternate = nil
if alt_win ~= 0 and alt_win ~= cur_win then
  alternate = win_info(alt_win)
  if ctx_n > 0 then
    alternate.context = get_context(vim.api.nvim_win_get_buf(alt_win), alternate.line, alternate.line, ctx_n)
  end
end
local buffers, modified = collect_listed_buffers()
local terms = collect_terminals()
return vim.json.encode({
  mode = mode_names[vim.fn.mode()] or vim.fn.mode(),
  cwd = cwd,
  modified_buffers = modified,
  buffers = buffers,
  current_tab = vim.fn.tabpagenr(),
  tab_count = vim.fn.tabpagenr('$'),
  active = active,
  alternate = alternate,
  terminals = #terms > 0 and terms or vim.NIL,
})
`);
		} catch {
			return null;
		}
	}

	/** Full snapshot: every window with folds, visual selection, marks,
	 * per-buffer diagnostics summary, and indent settings. */
	async getStateFull(activeCtx = 20, inactiveCtx = activeCtx): Promise<NvimStateFull | null> {
		try {
			return await this.evalLuaJson<NvimStateFull>(`
local cwd = vim.fn.getcwd()
local cwd_slash = cwd:sub(-1) == "/" and cwd or (cwd .. "/")
local function rel_path(p)
  if p:sub(1, #cwd_slash) == cwd_slash then return p:sub(#cwd_slash + 1) end
  return p
end
local function get_context(b, from, to, n)
  local total = vim.api.nvim_buf_line_count(b)
  local s = math.max(1, from - n)
  local e = math.min(total, to + n)
  local lines = vim.api.nvim_buf_get_lines(b, s - 1, e, false)
  for i, l in ipairs(lines) do lines[i] = (s + i - 1) .. ": " .. l end
  return lines
end
local sev_names = {"error", "warning", "info", "hint"}
local function collect_diag_summary(b)
  local diags = vim.diagnostic.get(b)
  local c = {error = 0, warning = 0, info = 0, hint = 0}
  for _, d in ipairs(diags) do local s = sev_names[d.severity] or "hint"; c[s] = c[s] + 1 end
  if c.error + c.warning + c.info + c.hint > 0 then return c end
end
local function collect_folds(w, b)
  local folds = {}
  vim.api.nvim_win_call(w, function()
    local total = vim.api.nvim_buf_line_count(b)
    local ln = 1
    while ln <= total do
      local fc = vim.fn.foldclosed(ln)
      if fc == ln then
        local fe = vim.fn.foldclosedend(ln)
        folds[#folds + 1] = {fc, fe}
        ln = fe + 1
      else
        ln = ln + 1
      end
    end
  end)
  return #folds > 0 and folds or nil
end
local function collect_marks(b)
  local m = {}
  for c = string.byte('a'), string.byte('z') do
    local mark = vim.api.nvim_buf_get_mark(b, string.char(c))
    if mark[1] > 0 then m[#m + 1] = {mark = string.char(c), line = mark[1], col = mark[2] + 1} end
  end
  return #m > 0 and m or nil
end
local mode_names = {
  n = "normal", i = "insert", v = "visual", V = "visual_line",
  ["\\22"] = "visual_block", R = "replace", Rv = "vreplace",
  c = "command", t = "terminal", s = "select", S = "select_line",
  ["\\19"] = "select_block", no = "operator_pending",
  r = "prompt", rm = "prompt", ["r?"] = "prompt",
}
local function win_info(w, b, is_active, alt_win, cur_mode, ctx_n)
  local cursor = vim.api.nvim_win_get_cursor(w)
  local raw_bt = vim.bo[b].buftype
  local info = {
    file = rel_path(vim.api.nvim_buf_get_name(b)),
    filetype = vim.bo[b].filetype,
    total_lines = vim.api.nvim_buf_line_count(b),
    modified = vim.bo[b].modified,
    buftype = raw_bt == "" and "file" or raw_bt,
    role = is_active and "active" or (w == alt_win and "alternate" or nil),
    line = cursor[1],
    col = cursor[2] + 1,
    indent = { expandtab = vim.bo[b].expandtab, shiftwidth = vim.bo[b].shiftwidth, tabstop = vim.bo[b].tabstop },
  }
  if is_active and (cur_mode == "visual" or cur_mode == "visual_line" or cur_mode == "visual_block") then
    local vpos = vim.fn.getpos('v')
    local cpos = vim.fn.getpos('.')
    local sl, sc, el, ec = vpos[2], vpos[3], cpos[2], cpos[3]
    if sl > el or (sl == el and sc > ec) then sl, sc, el, ec = el, ec, sl, sc end
    info.selection = { start_line = sl, start_col = sc, end_line = el, end_col = ec, mode = cur_mode }
    if ctx_n > 0 then info.context = get_context(b, sl, el, ctx_n) end
  elseif ctx_n > 0 then
    info.context = get_context(b, info.line, info.line, ctx_n)
  end
  info.folds = collect_folds(w, b)
  info.diagnostics_summary = collect_diag_summary(b)
  info.marks = collect_marks(b)
  return info
end
local active_n, inactive_n = ${activeCtx}, ${inactiveCtx}
local cur_win = vim.api.nvim_get_current_win()
local alt_win = vim.fn.win_getid(vim.fn.winnr('#'))
local cur_mode = mode_names[vim.fn.mode()] or vim.fn.mode()
local wins = {}
for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  local b = vim.api.nvim_win_get_buf(w)
  local is_active = (w == cur_win)
  local winfo = win_info(w, b, is_active, alt_win, cur_mode, is_active and active_n or inactive_n)
  if is_active then table.insert(wins, 1, winfo)
  elseif w == alt_win then table.insert(wins, math.min(2, #wins + 1), winfo)
  else wins[#wins + 1] = winfo end
end
local function collect_listed_buffers()
  local modified, buffers = {}, {}
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[b].buflisted and vim.api.nvim_buf_is_loaded(b) then
      local name = vim.api.nvim_buf_get_name(b)
      if name ~= "" then
        local rp = rel_path(name)
        buffers[#buffers + 1] = rp
        if vim.bo[b].modified then modified[#modified + 1] = rp end
      end
    end
  end
  return buffers, modified
end
local function collect_terminals()
  local terms = {}
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buftype == "terminal" then
      terms[#terms + 1] = { buf = b, name = rel_path(vim.api.nvim_buf_get_name(b)), visible = vim.fn.bufwinid(b) ~= -1 }
    end
  end
  return terms
end
local buffers, modified = collect_listed_buffers()
local terms = collect_terminals()
return vim.json.encode({
  mode = cur_mode,
  cwd = cwd,
  modified_buffers = modified,
  buffers = buffers,
  current_tab = vim.fn.tabpagenr(),
  tab_count = vim.fn.tabpagenr('$'),
  windows = wins,
  terminals = #terms > 0 and terms or vim.NIL,
})
`);
		} catch {
			return null;
		}
	}

	// ── Any-buffer read / edit ──

	/** Read any buffer by name/number, whole or by line range (1-indexed, inclusive). Returns numbered lines. */
	async readBuffer(name: string, startLine?: number, endLine?: number): Promise<NvimBufferRead> {
		const q = NvimSocketClient.#luaQuote;
		return this.evalLuaJson<NvimBufferRead>(`
local file, s, e = "${q(name)}", ${startLine ?? "nil"}, ${endLine ?? "nil"}
local b = vim.fn.bufnr(file)
if b == -1 then return vim.json.encode({ error = "Buffer not found: " .. file }) end
local total = vim.api.nvim_buf_line_count(b)
local ls = (type(s) == "number") and s or 1
local le = (type(e) == "number") and e or total
if ls > le then ls, le = le, ls end
if ls < 1 then ls = 1 end
if le > total then le = total end
local lines = vim.api.nvim_buf_get_lines(b, ls - 1, le, false)
for i, l in ipairs(lines) do lines[i] = (ls + i - 1) .. ": " .. l end
return vim.json.encode({ lines = lines, total_lines = total })
`);
	}

	/** Exact-match find-and-replace in any buffer. Rejects multi-match (like the edit tool). */
	async findReplaceInBuffer(name: string, oldStr: string, newStr: string): Promise<NvimFindReplaceResult> {
		const q = NvimSocketClient.#luaQuote;
		return this.evalLuaJson<NvimFindReplaceResult>(`
local file, old_str, new_str = "${q(name)}", "${q(oldStr)}", "${q(newStr)}"
local b = vim.fn.bufnr(file)
if b == -1 then return vim.json.encode({ error = "Buffer not found: " .. file }) end
local lines = vim.api.nvim_buf_get_lines(b, 0, -1, false)
local text = table.concat(lines, "\\n")
local s, e = string.find(text, old_str, 1, true)
if not s then return vim.json.encode({ error = "old_string not found in buffer" }) end
if string.find(text, old_str, e + 1, true) then
  return vim.json.encode({ error = "old_string matches multiple locations; add context to make it unique" })
end
local before = text:sub(1, s - 1)
local start_line = select(2, before:gsub("\\n", ""))
local end_line = start_line + select(2, old_str:gsub("\\n", ""))
local prefix = before:match("[^\\n]*$") or ""
local suffix = (text:sub(e + 1)):match("^[^\\n]*") or ""
local replacement = prefix .. new_str .. suffix
local new_lines = vim.split(replacement, "\\n", { plain = true })
local removed = end_line - start_line + 1
vim.api.nvim_buf_set_lines(b, start_line, end_line + 1, false, new_lines)
return vim.json.encode({ start_line = start_line + 1, lines_removed = removed, lines_added = #new_lines, total_lines = vim.api.nvim_buf_line_count(b) })
`);
	}

	// ── Keystrokes & terminal ──

	/** Send keystrokes to nvim. Auto-prepends <Esc> so the agent never strands in insert mode. */
	async sendKeys(keys: string): Promise<{ sent: string }> {
		const q = NvimSocketClient.#luaQuote;
		await this.evalLua(`return tostring(vim.api.nvim_input("<Esc>${q(keys)}"))`);
		return { sent: keys };
	}

	/** Write to an existing terminal buffer's job channel (not feedkeys/focus). submit=true appends CR. */
	async sendToTerminal(
		terminal: number | string | undefined,
		text: string,
		submit = false,
	): Promise<{ error?: string; terminals?: unknown[]; sent?: string }> {
		const q = NvimSocketClient.#luaQuote;
		const termArg =
			terminal === undefined || terminal === null
				? "nil"
				: typeof terminal === "number"
					? String(terminal)
					: `"${q(terminal)}"`;
		return this.evalLuaJson(`
local term, text, submit = ${termArg}, "${q(text)}", ${submit ? "true" : "false"}
if not submit then
  text = text:gsub("\\r+$", ""):gsub("\\n+$", "")
end
local terms = {}
for _, b in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buftype == "terminal" then
    terms[#terms + 1] = { buf = b, name = vim.api.nvim_buf_get_name(b), visible = vim.fn.bufwinid(b) ~= -1 }
  end
end
if #terms == 0 then return vim.json.encode({ error = "No terminal buffers found" }) end
local target
if term == nil then
  if #terms == 1 then target = terms[1]
  else return vim.json.encode({ error = "Multiple terminals found. Specify one (buffer number or name).", terminals = terms }) end
else
  for _, t in ipairs(terms) do
    if (type(term) == "number" and t.buf == term) or (type(term) == "string" and t.name == term) then target = t; break end
  end
  if not target and type(term) == "string" then
    for _, t in ipairs(terms) do
      if vim.fn.fnamemodify(t.name, ":t") == term then target = t; break end
    end
  end
end
if not target then return vim.json.encode({ error = "Terminal not found", terminals = terms }) end
local job = vim.b[target.buf].terminal_job_id
if not job then return vim.json.encode({ error = "Terminal has no running job" }) end
vim.fn.chansend(job, text .. (submit and "\\r" or ""))
return vim.json.encode({ sent = text })
`);
	}

	// ── Annotations (extmarks; never touch real buffer content) ──

	private static readonly HL_NS = "pi_highlight";
	private static readonly VT_NS = "pi_virtual_text";

	/** Highlight a line range with a hex color (e.g. "#ff0000") or an existing hl group name. */
	async highlightRange(name: string, startLine: number, endLine: number, color: string): Promise<void> {
		const q = NvimSocketClient.#luaQuote;
		await this.evalLua(`
local file, s, e, color = "${q(name)}", ${startLine}, ${endLine}, "${q(color)}"
local b = vim.fn.bufnr(file)
if b == -1 then error("Buffer not found: " .. file) end
local ns = vim.api.nvim_create_namespace("${NvimSocketClient.HL_NS}")
local group = color
if color:match("^#%x+$") then
  group = "PiHl" .. color:sub(2):upper()
  if vim.fn.hlexists(group) == 0 then
    vim.api.nvim_set_hl(0, group, { bg = color })
  end
end
for ln = s, e do
  vim.api.nvim_buf_set_extmark(b, ns, ln - 1, 0, { line_hl_group = group, priority = 100 })
end
`);
	}

	/** Clear all pi highlights from a buffer (or all buffers if name is empty). */
	async clearHighlights(name: string): Promise<void> {
		const q = NvimSocketClient.#luaQuote;
		await this.evalLua(`
local ns = vim.api.nvim_create_namespace("${NvimSocketClient.HL_NS}")
local file = "${q(name)}"
if file == "" then
  for _, b in ipairs(vim.api.nvim_list_bufs()) do vim.api.nvim_buf_clear_namespace(b, ns, 0, -1) end
else
  local b = vim.fn.bufnr(file)
  if b == -1 then return end
  vim.api.nvim_buf_clear_namespace(b, ns, 0, -1)
end
`);
	}

	/** Attach a virtual-text annotation to a buffer line. position: "eol" | "above" | "below". */
	async addVirtualText(
		name: string,
		line: number,
		text: string,
		position: "eol" | "above" | "below" = "eol",
		color?: string,
	): Promise<void> {
		const q = NvimSocketClient.#luaQuote;
		const hl = color ? `"${q(color)}"` : "nil";
		await this.evalLua(`
local file, ln, text, pos, color = "${q(name)}", ${line}, "${q(text)}", "${q(position)}", ${hl}
local b = vim.fn.bufnr(file)
if b == -1 then error("Buffer not found: " .. file) end
local ns = vim.api.nvim_create_namespace("${NvimSocketClient.VT_NS}")
local group = color
if color and color:match("^#%x+$") then
  group = "PiVt" .. color:sub(2):upper()
  if vim.fn.hlexists(group) == 0 then vim.api.nvim_set_hl(0, group, { fg = color }) end
end
local opts = { hl_group = group }
if pos == "eol" then
  opts.virt_text = { { text, group } }
else
  opts.virt_lines = { { { text, group } } }
  opts.virt_lines_above = (pos == "above")
end
vim.api.nvim_buf_set_extmark(b, ns, ln - 1, 0, opts)
`);
	}

	/** Clear all pi virtual text from a buffer (or all buffers if name is empty). */
	async clearVirtualText(name: string): Promise<void> {
		const q = NvimSocketClient.#luaQuote;
		await this.evalLua(`
local ns = vim.api.nvim_create_namespace("${NvimSocketClient.VT_NS}")
local file = "${q(name)}"
if file == "" then
  for _, b in ipairs(vim.api.nvim_list_bufs()) do vim.api.nvim_buf_clear_namespace(b, ns, 0, -1) end
else
  local b = vim.fn.bufnr(file)
  if b == -1 then return end
  vim.api.nvim_buf_clear_namespace(b, ns, 0, -1)
end
`);
	}

	disconnect(): void {
		this.#connected = false;
		this.#options.onClose?.();
	}
}
