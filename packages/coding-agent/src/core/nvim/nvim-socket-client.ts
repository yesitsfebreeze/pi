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

import type { NvimExec } from "../nvim.ts";
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
} from "./nvim-transport-types.ts";

export interface NvimSocketOptions {
	socketPath: string;
	/** Lua transport. Usually `createNvimExec(socketPath)`. */
	exec: NvimExec;
	onClose?: () => void;
}

/** Escape a string for safe embedding inside a Lua double-quoted string. */
export function luaQuote(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/**
 * Lua: position-params builders for LSP requests on *any* buffer, not just
 * the current one. Resolves the offset encoding from the buffer's first
 * attached client and converts byte columns to utf-16 characters — the same
 * conversion vim.lsp.util.make_position_params does internally, but that
 * helper is hard-wired to the current window/buffer.
 *
 * line/col are 0-indexed byte positions (the nvim cursor convention); when
 * either is nil the current cursor position is used (or {0,0} for a buffer
 * that is not displayed).
 */
function positionParamsLua(): string {
	return `
local function lsp_offset_encoding(bufnr)
  local clients = vim.lsp.get_clients({ bufnr = bufnr })
  if clients[1] and clients[1].offset_encoding then return clients[1].offset_encoding end
  return "utf-16"
end
local function to_lsp_col(bufnr, line, byte_col)
  if lsp_offset_encoding(bufnr) == "utf-16" then
    local text = vim.api.nvim_buf_get_lines(bufnr, line, line + 1, false)[1] or ""
    -- str_utfindex throws "index out of range" past the line end; clamp so a
    -- caller-supplied col beyond EOL resolves to end-of-line instead of erroring.
    local ok, u16 = pcall(vim.str_utfindex, text, math.min(byte_col, #text))
    if ok then return u16 end
  end
  return byte_col
end
local function lsp_position(bufnr, line, col)
  if line ~= nil and col ~= nil then
    return { line = line, character = to_lsp_col(bufnr, line, col) }
  end
  if bufnr == vim.api.nvim_get_current_buf() then
    local c = vim.api.nvim_win_get_cursor(0)
    return { line = c[1] - 1, character = to_lsp_col(bufnr, c[1] - 1, c[2]) }
  end
  return { line = 0, character = 0 }
end
local function make_position_params(bufnr, line, col)
  return {
    textDocument = { uri = vim.uri_from_bufnr(bufnr) },
    position = lsp_position(bufnr, line, col),
  }
end
local function make_range_params(bufnr, line, col)
  local pos = lsp_position(bufnr, line, col)
  return { textDocument = { uri = vim.uri_from_bufnr(bufnr) }, range = { start = pos, ["end"] = pos } }
end
`;
}

/**
 * Lua: resolve a buffer name (or current buffer when absent) to a loaded
 * bufnr, bufadd/bufload'ing files that exist on disk but are not open.
 */
function resolveBufnrLua(nameArg: string): string {
	return `
local bufnr
if ${nameArg} and ${nameArg} ~= "" then
  bufnr = vim.fn.bufnr(${nameArg})
  if bufnr == -1 then bufnr = vim.fn.bufadd(${nameArg}) end
  if bufnr > 0 and not vim.api.nvim_buf_is_loaded(bufnr) then vim.fn.bufload(bufnr) end
else
  bufnr = vim.api.nvim_get_current_buf()
end
if bufnr == -1 then
  return vim.json.encode({ error = "Buffer not found: " .. tostring(${nameArg}) })
end
`;
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
		return luaQuote(s);
	}

	// ── High-level buffer operations ──

	/** Get state of the current nvim buffer: path, content, cursor, selection. */
	async getBufferState(name?: string): Promise<NvimBufferState | null> {
		try {
			// Resolve the name to a buffer number first: nvim API functions reject
			// string buffer names in `nvim_buf_*` calls ("Expected Lua number").
			// vim.fn.bufnr handles strings and returns -1 for unloaded paths.
			const nameArg = name ? `vim.fn.bufnr("${NvimSocketClient.#luaQuote(name)}")` : "nil";
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
		// JSON.stringify of a string array produces ["a","b"] — invalid Lua
		// (a bare [ starts a keyed entry and expects `=`). Build each edit as a
		// proper Lua table with a quoted string array for newLines.
		const luaArray = (arr: string[]) => `{ ${arr.map((s) => `"${q(s)}"`).join(", ")} }`;
		const editsLua = edits
			.map((e) => `{ startLine = ${e.startLine}, endLine = ${e.endLine}, newLines = ${luaArray(e.newLines)} }`)
			.join(", ");
		await this.evalLua(`
local bufnr = vim.fn.bufnr("${q(name)}")
if bufnr == -1 then error("Buffer not found: ${q(name)}") end
for _, edit in ipairs({${editsLua}}) do
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

	/** Get LSP references for position (target buffer; line/col 0-indexed byte positions). */
	async getLspReferences(
		name: string | undefined,
		line: number | undefined,
		col: number | undefined,
	): Promise<NvimLspLocation[]> {
		try {
			const q = NvimSocketClient.#luaQuote;
			const nameArg = name ? `"${q(name)}"` : "nil";
			return await this.evalLuaJson<NvimLspLocation[]>(`
${resolveBufnrLua(nameArg)}
${positionParamsLua()}
local params = make_position_params(bufnr, ${line ?? "nil"}, ${col ?? "nil"})
local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/references', params, 1000)
local out = {}
-- buf_request_sync returns a MAP keyed by client id ({[2]={result=...}}), not a
-- list — ipairs finds nothing when ids are non-contiguous (e.g. one client).
local ids = vim.tbl_keys(results or {})
table.sort(ids)
for _, id in ipairs(ids) do
  local resp = results[id]
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

	/** Get LSP definition for position (target buffer; line/col 0-indexed byte positions). */
	async getLspDefinition(
		name: string | undefined,
		line: number | undefined,
		col: number | undefined,
	): Promise<NvimLspLocation[]> {
		try {
			const q = NvimSocketClient.#luaQuote;
			const nameArg = name ? `"${q(name)}"` : "nil";
			return await this.evalLuaJson<NvimLspLocation[]>(`
${resolveBufnrLua(nameArg)}
${positionParamsLua()}
local params = make_position_params(bufnr, ${line ?? "nil"}, ${col ?? "nil"})
local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/definition', params, 1000)
local out = {}
local ids = vim.tbl_keys(results or {})
table.sort(ids)
for _, id in ipairs(ids) do
  local resp = results[id]
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

	/** Get LSP hover for position (target buffer; line/col 0-indexed byte positions). */
	async getLspHover(
		name: string | undefined,
		line: number | undefined,
		col: number | undefined,
	): Promise<{ contents: Array<string | { language: string; value: string }> } | null> {
		try {
			const q = NvimSocketClient.#luaQuote;
			const nameArg = name ? `"${q(name)}"` : "nil";
			const raw = await this.evalLua(`
${resolveBufnrLua(nameArg)}
${positionParamsLua()}
local params = make_position_params(bufnr, ${line ?? "nil"}, ${col ?? "nil"})
local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/hover', params, 1000)
local ids = vim.tbl_keys(results or {})
table.sort(ids)
for _, id in ipairs(ids) do
  local resp = results[id]
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

	/**
	 * Rename the symbol at position via LSP, applying edits to the live
	 * buffers (and writing them by default, so disk matches the editor).
	 */
	async renameSymbol(
		name: string | undefined,
		line: number | undefined,
		col: number | undefined,
		newName: string,
		write = true,
	): Promise<{ error?: string; renamed?: boolean; edits?: number; files?: string[]; wrote?: boolean }> {
		const q = NvimSocketClient.#luaQuote;
		const nameArg = name ? `"${q(name)}"` : "nil";
		try {
			return await this.evalLuaJson(`
${resolveBufnrLua(nameArg)}
${positionParamsLua()}
local params = make_position_params(bufnr, ${line ?? "nil"}, ${col ?? "nil"})
params.newName = "${q(newName)}"
local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/rename', params, 3000)
local responded = 0
local changed = 0
local files = {}
-- buf_request_sync returns a MAP keyed by client id, not a list.
local ids = vim.tbl_keys(results or {})
table.sort(ids)
for _, id in ipairs(ids) do
  local resp = results[id]
  if resp.err then
    return vim.json.encode({ error = resp.err.message or "LSP rename failed" })
  end
  if resp.result then
    responded = responded + 1
    -- Server may answer with { changes } (uri -> edits) or { documentChanges }.
    local function apply(edit_uri, text_edits)
      local b = vim.uri_to_bufnr(edit_uri)
      if not vim.api.nvim_buf_is_loaded(b) then vim.fn.bufload(b) end
      -- nvim 0.12 requires the position_encoding arg (utf-16 vs utf-8).
      vim.lsp.util.apply_text_edits(text_edits, b, lsp_offset_encoding(b))
      changed = changed + #text_edits
      local fname = vim.api.nvim_buf_get_name(b)
      if not vim.tbl_contains(files, fname) then files[#files + 1] = fname end
    end
    if resp.result.changes then
      for edit_uri, text_edits in pairs(resp.result.changes) do apply(edit_uri, text_edits) end
    elseif resp.result.documentChanges then
      for _, dc in ipairs(resp.result.documentChanges) do
        if dc.textDocument and dc.edits then apply(dc.textDocument.uri, dc.edits) end
      end
    end
  end
end
if responded == 0 then
  return vim.json.encode({ error = "No LSP client attached to this buffer (rename needs one)" })
end
local wrote = false
if ${write ? "true" : "false"} then
  for _, f in ipairs(files) do
    local b = vim.fn.bufnr(f)
    if b > 0 then pcall(vim.api.nvim_buf_call, b, function() vim.cmd("silent! update") end) end
  end
  wrote = true
end
return vim.json.encode({ renamed = changed > 0, edits = changed, files = files, wrote = wrote })
`);
		} catch {
			return { error: "nvim RPC failed" };
		}
	}

	/**
	 * List or apply LSP code actions at a position. Without `actionIndex` this
	 * returns the numbered list of available actions; with it, the 1-based
	 * action is applied (workspace edit + command) and touched buffers are
	 * written.
	 */
	async codeActions(
		name: string | undefined,
		line: number | undefined,
		col: number | undefined,
		actionIndex?: number | string,
	): Promise<{
		error?: string;
		actions?: Array<{ title: string; kind: string; is_preferred: boolean }>;
		count?: number;
		applied?: string;
		kind?: string;
		edit?: boolean;
		command?: boolean;
		wrote?: number;
	}> {
		const q = NvimSocketClient.#luaQuote;
		const nameArg = name ? `"${q(name)}"` : "nil";
		const wantArg =
			actionIndex === undefined
				? "nil"
				: typeof actionIndex === "number"
					? String(actionIndex)
					: `"${q(actionIndex)}"`;
		try {
			return await this.evalLuaJson(`
${resolveBufnrLua(nameArg)}
${positionParamsLua()}
local params = make_range_params(bufnr, ${line ?? "nil"}, ${col ?? "nil"})
-- Diagnostic quickfixes (remove unused, fix all, …) only appear when the
-- request carries the diagnostics overlapping the position in context. The
-- diagnostics must be in LSP shape: vim.diagnostic.get returns byte lnum/col,
-- servers expect range in their offset encoding — ts_ls errors with "Cannot
-- destructure property 'start' of 'diagnostic.range'" otherwise.
local function to_lsp_diag(d)
  return {
    range = {
      start = { line = d.lnum, character = to_lsp_col(bufnr, d.lnum, d.col) },
      ["end"] = { line = d.end_lnum or d.lnum, character = to_lsp_col(bufnr, d.end_lnum or d.lnum, d.end_col or d.col) },
    },
    severity = d.severity,
    code = d.code,
    source = d.source,
    message = d.message,
    tags = d.tags,
  }
end
params.context = {
  diagnostics = vim.tbl_map(to_lsp_diag, vim.diagnostic.get(bufnr, { lnum = params.range.start.line, end_lnum = params.range.start.line })),
}
local want = ${wantArg}
local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/codeAction', params, 3000)
-- buf_request_sync returns a MAP keyed by client id, not a list; sort ids so
-- the 1-based action index is deterministic across clients.
local ids = vim.tbl_keys(results or {})
table.sort(ids)
local raw = {}
local actions = {}
for _, id in ipairs(ids) do
  local resp = results[id]
  if resp.result and vim.tbl_islist(resp.result) then
    for _, a in ipairs(resp.result) do
      if a and a.title then
        raw[#raw + 1] = a
        table.insert(actions, { title = a.title, kind = a.kind or "", is_preferred = a.isPreferred or false })
      end
    end
  end
end
if #actions == 0 then return vim.json.encode({ error = "No code actions at the cursor" }) end
if want == nil then
  return vim.json.encode({ actions = actions, count = #actions })
end
-- Apply: match by 1-based index across all clients, or by exact title.
local picked
if type(want) == "number" then
  picked = raw[want]
else
  for _, a in ipairs(raw) do
    if a.title == want then picked = a end
  end
end
if not picked then return vim.json.encode({ error = "Action not found: " .. tostring(want) }) end
if picked.edit then
  vim.lsp.util.apply_workspace_edit(picked.edit, lsp_offset_encoding(bufnr))
end
if picked.command then
  vim.lsp.buf.execute_command({ command = picked.command.command, arguments = picked.command.arguments or {} })
end
-- Write buffers the workspace edit touched so disk matches the editor.
local touched = {}
if picked.edit then
  if picked.edit.changes then
    for uri in pairs(picked.edit.changes) do touched[#touched + 1] = vim.uri_to_bufnr(uri) end
  end
  if picked.edit.documentChanges then
    for _, dc in ipairs(picked.edit.documentChanges) do
      if dc.textDocument and dc.textDocument.uri then touched[#touched + 1] = vim.uri_to_bufnr(dc.textDocument.uri) end
    end
  end
end
for _, b in ipairs(touched) do
  if b > 0 and vim.api.nvim_buf_is_loaded(b) then
    pcall(vim.api.nvim_buf_call, b, function() vim.cmd("silent! update") end)
  end
end
return vim.json.encode({ applied = picked.title, kind = picked.kind or "", edit = picked.edit ~= nil, command = picked.command ~= nil, wrote = #touched })
`);
		} catch {
			return { error: "nvim RPC failed" };
		}
	}

	/**
	 * Format a buffer. Prefers the conform.nvim plugin (it resolves the
	 * filetype's formatter list and falls back to LSP formatting); without
	 * conform, falls back to plain vim.lsp.buf.format.
	 */
	async formatBuffer(
		name: string | undefined,
		formatter: string | undefined,
	): Promise<{
		error?: string;
		backend?: "conform" | "lsp" | "none";
		formatters?: string[];
		changed?: boolean;
	}> {
		const q = NvimSocketClient.#luaQuote;
		const nameArg = name ? `"${q(name)}"` : "nil";
		const formatterArg = formatter ? `"${q(formatter)}"` : "nil";
		try {
			return await this.evalLuaJson(`
${resolveBufnrLua(nameArg)}
local formatter = ${formatterArg}
local ok, conform = pcall(require, "conform")
if ok and conform.format then
  local opts = { bufnr = bufnr, lsp_format = "fallback", async = false, timeout_ms = 5000, quiet = true }
  if formatter then opts.formatters = { formatter } end
  local done, err, did_edit = false, nil, false
  conform.format(opts, function(e, d)
    err, did_edit, done = e, d or false, true
  end)
  -- async=false fires the callback synchronously; wait defensively anyway.
  if not done then vim.wait(6000, function() return done end) end
  local used = {}
  local ok2, fts = pcall(conform.list_formatters_to_run, bufnr)
  if ok2 and fts then
    for _, f in ipairs(fts) do used[#used + 1] = f.name end
  end
  return vim.json.encode({ backend = "conform", formatters = used, changed = did_edit, error = err or nil })
end
local requested = vim.lsp.buf.format({ bufnr = bufnr, async = false })
return vim.json.encode({ backend = "lsp", changed = requested, error = nil })
`);
		} catch {
			return { error: "nvim RPC failed" };
		}
	}

	/**
	 * Realign the markdown table at a 1-based line via vim-table-mode's
	 * autoload function (works without the plugin being explicitly loaded:
	 * autoload pulls it in on first call). No-op when the line is not inside
	 * a table.
	 */
	async realignTable(
		name: string | undefined,
		line: number | undefined,
	): Promise<{
		error?: string;
		realigned?: boolean;
		line?: number;
		filetype?: string;
	}> {
		const q = NvimSocketClient.#luaQuote;
		const nameArg = name ? `"${q(name)}"` : "nil";
		try {
			return await this.evalLuaJson(`
${resolveBufnrLua(nameArg)}
local line = ${line ?? "nil"}
local ft = vim.bo[bufnr].filetype or ""
if ft ~= "markdown" and ft ~= "markdown.mdx" then
  return vim.json.encode({ error = "vim-table-mode only aligns markdown tables (filetype: " .. ft .. ")" })
end
if line == nil then
  line = bufnr == vim.api.nvim_get_current_buf() and vim.api.nvim_win_get_cursor(0)[1] or 1
end
local before = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
local ok, err = pcall(function()
  vim.api.nvim_buf_call(bufnr, function()
    vim.fn["tablemode#table#Realign"](line)
  end)
end)
if not ok then
  return vim.json.encode({ error = "vim-table-mode not available: " .. tostring(err) })
end
local after = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
local changed = #before ~= #after
if not changed then
  for i = 1, #before do
    if before[i] ~= after[i] then changed = true break end
  end
end
return vim.json.encode({ realigned = changed, line = line, filetype = ft })
`);
		} catch {
			return { error: "nvim RPC failed" };
		}
	}

	/**
	 * Make a file visible in nvim: activate its window (opening a split or
	 * replacing the current view when not visible), jump the cursor to a
	 * 1-based line/col, and center the view. The user watches the editor —
	 * this is the "show the user what the agent is doing" primitive.
	 */
	async revealFile(
		name: string,
		line?: number,
		col?: number,
		split?: "vsplit" | "split",
	): Promise<{ error?: string; path?: string; bufnr?: number; window?: number; line?: number }> {
		const q = NvimSocketClient.#luaQuote;
		try {
			return await this.evalLuaJson(`
local path, line, col, split = "${q(name)}", ${line ?? "nil"}, ${col ?? "nil"}, ${split ? `"${split}"` : "nil"}
local b = vim.fn.bufnr(path)
if b == -1 then b = vim.fn.bufadd(path) end
if b > 0 and not vim.api.nvim_buf_is_loaded(b) then vim.fn.bufload(b) end
if b == -1 or not vim.api.nvim_buf_is_loaded(b) then
  return vim.json.encode({ error = "Cannot load buffer: " .. path })
end
-- Activate the buffer in a visible window (or open one, optionally split).
local winid = vim.fn.bufwinid(b)
if winid == -1 then
  if split == "vsplit" then vim.cmd("vsplit") elseif split == "split" then vim.cmd("split") end
  vim.api.nvim_set_current_buf(b)
else
  vim.api.nvim_set_current_win(winid)
end
-- Jump to the requested position and center the view (scroll follows).
if line then
  local maxline = vim.api.nvim_buf_line_count(b)
  local l = math.min(math.max(1, line), maxline)
  local text = vim.api.nvim_buf_get_lines(b, l - 1, l, false)[1] or ""
  local c = math.min(math.max(0, (col or 1) - 1), #text)
  pcall(vim.api.nvim_win_set_cursor, 0, { l, c })
  vim.cmd("normal! zz")
end
vim.cmd("redraw")
return vim.json.encode({ path = path, bufnr = b, window = vim.api.nvim_get_current_win(), line = line and vim.api.nvim_win_get_cursor(0)[1] or nil })
`);
		} catch {
			return { error: "nvim RPC failed" };
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
local function collect_lsp_clients()
  local clients = {}
  for _, c in ipairs(vim.lsp.get_clients()) do
    local fts = {}
    local ft_cfg = c.config and c.config.filetypes
    if type(ft_cfg) == "table" then
      for _, ft in ipairs(ft_cfg) do table.insert(fts, tostring(ft)) end
    end
    table.insert(clients, {
      name = c.name,
      root_dir = c.config and c.config.root_dir or "?",
      filetypes = fts,
    })
  end
  return clients
end
local function attach_diagnostics(winfo, b)
  if not winfo or not b then return end
  local diags = vim.diagnostic.get(b)
  local out = {}
  local diag_limit = 8
  for _, d in ipairs(diags) do
    if #out >= diag_limit then break end
    table.insert(out, {
      lnum = d.lnum,
      col = d.col,
      severity = d.severity,
      source = d.source or "",
      message = d.message or "",
    })
  end
  winfo.diagnostics = out
  winfo.diagnostics_total = #diags
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
local lsp_clients = collect_lsp_clients()
attach_diagnostics(active, b)
if alternate then attach_diagnostics(alternate, vim.api.nvim_win_get_buf(alt_win)) end
return vim.json.encode({
  mode = mode_names[vim.fn.mode()] or vim.fn.mode(),
  cwd = cwd,
  modified_buffers = modified,
  buffers = buffers,
  current_tab = vim.fn.tabpagenr(),
  tab_count = vim.fn.tabpagenr('$'),
  active = active,
  alternate = alternate,
  lsp_clients = lsp_clients,
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
