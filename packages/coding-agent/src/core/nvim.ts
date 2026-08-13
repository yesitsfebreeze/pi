/**
 * nvim integration: connect to a running nvim instance via --listen socket,
 * discover its environment, and expose tools for the agent to control it.
 *
 * When nvim is connected, standard filesystem tools (read, write, edit, grep,
 * find, ls) are transparently forwarded through nvim so all edits are visible
 * in real-time and the agent sees exactly what the user sees.
 *
 * The connection uses nvim's native msgpack-rpc socket API via the
 * `nvim --server <socket> --remote-expr` client. No plugin required for basic
 * functionality; the pi nvim plugin (if installed) enables richer operations.
 */

import { execFile } from "node:child_process";
import { statSync, unlinkSync } from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { errorMessage } from "../utils/error.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import {
	diffConfigFiles,
	listNotes,
	readNote,
	recordSeen,
	setNvimLearningRoot,
	writeNote,
} from "./nvim/nvim-learning.ts";
import { createNvimOps, type NvimOps } from "./nvim/nvim-ops.ts";
import { NvimSocketClient } from "./nvim/nvim-socket-client.ts";
import type { NvimBufferEdit, NvimBufferState } from "./nvim/nvim-transport-types.ts";

export { diffConfigFiles, recordSeen, setNvimLearningRoot };
export { createNvimOps, type NvimOps } from "./nvim/nvim-ops.ts";
// Re-export for consumers
export { NvimSocketClient } from "./nvim/nvim-socket-client.ts";
export { createNvimSurfaceToolDefinitions } from "./nvim/nvim-surface.ts";
export {
	createBuffersTool,
	createLspDefinitionTool,
	createLspDiagnosticsTool,
	createLspHoverTool,
	createLspReferencesTool,
	createNvimConfigTool,
	createNvimFindFilesTool,
	createNvimSearchTool,
	createNvimToolDefinitions,
	createTsQueryTool,
} from "./nvim/nvim-tools.ts";
export type { NvimBufferState, NvimBufferEdit };

/** Escape a string for embedding inside a Vim double-quoted luaeval argument. */
function escVim(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

export type NvimExec = (lua: string) => Promise<string>;

/**
 * Create an exec function that evaluates Lua code in a remote nvim instance
 * via `nvim --server <socket> --remote-expr luaeval(...)`. This is the
 * primary transport: it uses nvim's built-in client-server (msgpack-rpc)
 * protocol, which works with any `nvim --listen <socket>` instance —
 * including the pi nvim plugin, which starts pi with `--nvim-socket
 * <vim.v.servername>`.
 *
 * (It does NOT work with `nvim --embed`, which lacks the server side of the
 * protocol — but that is not the supported deployment.)
 */
export function createNvimExec(socketPath: string): NvimExec {
	return (lua: string): Promise<string> =>
		new Promise((resolve, reject) => {
			const wrapped = `(function() ${lua} end)()`;
			const escaped = escVim(wrapped);
			execFile(
				"nvim",
				["--server", socketPath, "--remote-expr", `luaeval("${escaped}")`],
				{ timeout: 10000 },
				(err, stdout, stderr) => {
					if (err) {
						reject(new Error(`nvim RPC failed: ${stderr?.trim() || err.message}`));
						return;
					}
					resolve(stdout.trim());
				},
			);
		});
}

// ─── Connection ─────────────────────────────────────────────────────────────

/**
 * Result of connecting to an nvim instance.
 * - `client`: high-level RPC client (LSP, buffers, diagnostics) backed by `exec`.
 * - `exec`: evaluates Lua in nvim via `nvim --server --remote-expr`.
 * - `ops`: nvim-backed implementations of the standard filesystem tools.
 */
export interface NvimConnection {
	client: NvimSocketClient;
	exec: NvimExec;
	ops: NvimOps;
}

/**
 * Connect to nvim at the given socket path.
 *
 * Transport is `nvim --server <socket> --remote-expr luaeval(...)`, which
 * uses nvim's native msgpack-rpc client-server protocol. This works with any
 * `nvim --listen <socket>` instance (the pi nvim plugin starts pi this way,
 * passing `vim.v.servername`).
 *
 * Stale-socket detection: if the socket file does not exist or the owning
 * nvim process has died, `createNvimExec` fails fast and we unlink stale
 * temp sockets before throwing a clear error.
 */
export async function connectNvim(socketPath: string): Promise<NvimConnection> {
	// Wait briefly for the socket file to appear (nvim may still be starting).
	await waitForSocketFile(socketPath);

	const exec = createNvimExec(socketPath);

	// Verify liveness + protocol by evaluating trivial Lua. A stale socket
	// (dead nvim) makes `nvim --server` fail with a connection error here.
	try {
		const result = await exec("return 1");
		if (result !== "1") {
			throw new Error(`unexpected nvim response: ${JSON.stringify(result)}`);
		}
	} catch (e) {
		cleanupStaleSocket(socketPath);
		throw new Error(
			`Cannot reach nvim at ${socketPath} (${errorMessage(e)}). ` +
				`Make sure nvim is running with --listen ${socketPath}.`,
		);
	}

	const client = new NvimSocketClient({ socketPath, exec });
	const getClient = () => (client.connected ? client : undefined);
	const ops = createNvimOps(getClient);

	return { client, exec, ops };
}

/**
 * Wait up to ~5s for the nvim listen socket file to appear. Throws early if
 * the path is invalid; does not throw on timeout (the exec verification below
 * surfaces a clear error if the socket never comes up).
 */
async function waitForSocketFile(socketPath: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			const { statSync } = await import("node:fs");
			const st = statSync(socketPath);
			if (st.isSocket() || st.size === 0 || st.isFile()) return;
		} catch (err: any) {
			if (err.code !== "ENOENT") throw err;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

/**
 * Remove a stale nvim listen socket if it lives under /tmp and looks like an
 * nvim socket. Best-effort — avoids deleting unrelated files.
 */
function cleanupStaleSocket(socketPath: string): void {
	if (!socketPath.startsWith("/tmp/") || !socketPath.includes("nvim")) return;
	try {
		const st = statSync(socketPath);
		if (st.isSocket() || st.size === 0) unlinkSync(socketPath);
	} catch {
		// best-effort; ignore.
	}
}

// ─── Discovery ─────────────────────────────────────────────────────────────

/**
 * Query nvim for its full environment: server, version, plugins, keymaps,
 * commands, LSP, buffers, autocmds, and config file contents (init.lua,
 * plugin specs, lua/config). Also detects available search backends.
 * Returns a string suitable for the system prompt.
 */
export async function discoverNvim(exec: NvimExec): Promise<string> {
	return exec(DISCOVERY_LUA);
}

// Lua runs inside nvim's process — has filesystem access via io.open.
// Reads config files on-disk so the agent sees how nvim is configured,
// not just what's running.
const DISCOVERY_LUA = `
local parts = {}
local function add(s) parts[#parts+1] = s end

add("# nvim environment")
add("server: " .. vim.v.servername)
add("version: " .. tostring(vim.version()))
add("")

-- Search backends
add("## available search backends")
local backends = {}
if pcall(require, "telescope.builtin") then backends[#backends+1] = "telescope" end
if pcall(require, "fzf-lua") then backends[#backends+1] = "fzf-lua" end
if pcall(require, "snacks.picker") then backends[#backends+1] = "snacks.picker" end
if pcall(require, "mini.pick") then backends[#backends+1] = "mini.pick" end
if vim.fn.exists("*vimgrep") == 1 then backends[#backends+1] = "vimgrep" end
for _, b in ipairs(backends) do add("- " .. b) end
add("")

-- Plugins
add("## plugins")
if package.loaded.lazy then
  for _, spec in ipairs(require('lazy').plugins()) do
    local loaded = package.loaded[spec.name] and "loaded" or "lazy"
    add(string.format("- %s (%s, dir=%s)", spec.name or spec[1], loaded, spec.dir or "?"))
  end
else
  for _, dir in ipairs(vim.opt.packpath:get()) do add("- " .. dir) end
end
add("")

-- Keymaps (normal mode, with descriptions)
add("## keymaps (normal mode)")
for _, km in ipairs(vim.api.nvim_get_keymap('n')) do
  if km.desc and km.desc ~= "" then
    add(string.format("- %-20s -> %-30s %s", km.lhs or "", (km.rhs or ""):sub(1,30), km.desc or ""))
  end
end
add("")

-- User commands
add("## user commands")
for _, cmd in ipairs(vim.api.nvim_get_commands({})) do
  add(string.format("- :%s", cmd.name))
end
add("")

-- LSP
add("## lsp clients")
for _, c in ipairs(vim.lsp.get_clients()) do
  local caps = {}
  if c.server_capabilities then
    for k, v in pairs(c.server_capabilities) do
      if v and k:match("Provider$") then caps[#caps+1] = k:gsub("Provider$", "") end
    end
  end
  add(string.format("- %s (id=%s, root=%s, caps=%s)", c.name, c.id,
    c.config and c.config.root_dir or "?",
    table.concat(caps, ",")))
end
add("")

-- Buffers
add("## open buffers")
for _, b in ipairs(vim.api.nvim_list_bufs()) do
  local mod = vim.api.nvim_buf_get_option(b, 'modified') and " [mod]" or ""
  local ft = vim.api.nvim_buf_get_option(b, 'filetype') or ""
  add(string.format("- %d: %s (%s)%s", b, vim.api.nvim_buf_get_name(b), ft, mod))
end
add("")

-- Config files
add("## config")
local configdir = vim.fn.stdpath('config')
add("path: " .. configdir)

local function read_file(path, max)
  local f = io.open(path)
  if not f then return nil end
  local content = f:read("*a")
  f:close()
  if #content > max then return content:sub(1, max) .. "\\n...(truncated)" end
  return content
end

-- init.lua or init.vim
local init = read_file(configdir .. "/init.lua", 8000) or read_file(configdir .. "/init.vim", 8000)
if init then
  add("\\n### init.lua/init.vim")
  add("<lua>")
  add(init)
  add("</lua>")
end

-- Plugin specs
for _, pdir in ipairs({"/lua/plugins", "/lua/plugin"}) do
  local ppath = configdir .. pdir
  if vim.fn.isdirectory(ppath) == 1 then
    for _, entry in ipairs(vim.fn.readdir(ppath) or {}) do
      if entry:match("%.lua$") then
        local content = read_file(ppath .. "/" .. entry, 4000)
        if content then
          add("\\n### " .. pdir .. "/" .. entry)
          add("<lua>")
          add(content)
          add("</lua>")
        end
      end
    end
  end
end

-- Config files
local cdir = configdir .. "/lua/config"
if vim.fn.isdirectory(cdir) == 1 then
  for _, entry in ipairs(vim.fn.readdir(cdir) or {}) do
    if entry:match("%.lua$") then
      local content = read_file(cdir .. "/" .. entry, 4000)
      if content then
        add("\\n### lua/config/" .. entry)
        add("<lua>")
        add(content)
        add("</lua>")
      end
    end
  end
end

return table.concat(parts, "\\n")
`;

// ─── Basic nvim tools (nvim_exec, nvim_lua) ────────────────────────────────

const renderCall = () => new Text("", 0, 0);
const renderResult = (result: any) => new Text(result?.content?.map((c: any) => c.text ?? "").join("\n") ?? "", 0, 0);

export function nvimBasicToolDefinitions(exec: NvimExec): ToolDefinition[] {
	return [
		{
			name: "nvim_exec",
			label: "nvim exec",
			promptSnippet: "Execute an nvim Ex command (windows, buffers, tabs)",
			description:
				"Execute a nvim Ex command (e.g. 'split file.lua', 'terminal', 'buffer 3', 'vsplit'). Controls nvim windows, buffers, tabs.",
			parameters: Type.Object({
				command: Type.String({ description: "Nvim Ex command" }),
			}),
			execute: async (_: any, { command }: { command: string }) => {
				await exec(`vim.cmd([[${command}]])`);
				return {
					content: [{ type: "text" as const, text: `executed: ${command}` }],
					details: undefined,
				};
			},
			renderCall,
			renderResult,
		},
		{
			name: "nvim_lua",
			label: "nvim Lua",
			promptSnippet: "Evaluate Lua in nvim and return the result",
			description:
				"Execute Lua in nvim and return the result. Use for reading state: buffers, keymaps, LSP, plugins, window layout, etc. Example: nvim_lua({ code: 'return vim.inspect(vim.api.nvim_list_bufs())' })",
			parameters: Type.Object({
				code: Type.String({ description: "Lua code to evaluate" }),
			}),
			execute: async (_: any, { code }: { code: string }) => {
				const result = await exec(code);
				return {
					content: [{ type: "text" as const, text: result || "(no output)" }],
					details: undefined,
				};
			},
			renderCall,
			renderResult,
		},
	];
}

// ─── Tool creation ─────────────────────────────────────────────────────────

// ─── Config learning (persistent + change detection) ───────────────────────

/** List of the user's nvim config files + config dir, read via nvim. */
export interface NvimConfigFiles {
	configDir: string;
	files: string[];
}

const CONFIG_FILES_LUA = `
local configdir = vim.fn.stdpath('config')
local files = {}
local function addf(p)
  if vim.fn.filereadable(p) == 1 then table.insert(files, p) end
end
addf(configdir .. '/init.lua')
addf(configdir .. '/init.vim')
for _, pdir in ipairs({'/lua/plugins', '/lua/plugin'}) do
  local ppath = configdir .. pdir
  if vim.fn.isdirectory(ppath) == 1 then
    for _, entry in ipairs(vim.fn.readdir(ppath) or {}) do
      if entry:match('%.lua$') then addf(ppath .. '/' .. entry) end
    end
  end
end
local cdir = configdir .. '/lua/config'
if vim.fn.isdirectory(cdir) == 1 then
  for _, entry in ipairs(vim.fn.readdir(cdir) or {}) do
    if entry:match('%.lua$') then addf(cdir .. '/' .. entry) end
  end
end
return vim.fn.json_encode({ configdir = configdir, files = files })
`;

/** Query nvim for its config dir and the list of config files to fingerprint. */
export async function getNvimConfigFiles(exec: NvimExec): Promise<NvimConfigFiles> {
	try {
		const raw = await exec(CONFIG_FILES_LUA);
		const parsed = JSON.parse(raw);
		return { configDir: parsed.configdir ?? "", files: parsed.files ?? [] };
	} catch {
		return { configDir: "", files: [] };
	}
}

/**
 * Diff the user's nvim config files against the persisted manifest, record
 * the new fingerprints, and return a one-line summary of what changed (or ""
 * when nothing changed). Content-hash based, so untouched files are skipped
 * and edits that preserve mtime are still caught.
 */
export async function learnNvimConfigChanges(exec: NvimExec): Promise<string> {
	const { files } = await getNvimConfigFiles(exec);
	if (files.length === 0) return "";

	const diff = diffConfigFiles(files);
	recordSeen(files);

	const parts: string[] = [];
	if (diff.new.length > 0) parts.push(`${diff.new.length} new`);
	if (diff.changed.length > 0) parts.push(`${diff.changed.length} changed`);
	if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
	if (parts.length === 0) return "";

	const names = [...diff.new, ...diff.changed].map((p) => p.split("/").pop());
	const nameList = names.length > 0 ? ` (${names.join(", ")})` : "";
	return `nvim config ${parts.join(", ")} since last session${nameList} — ${diff.unchanged.length} unchanged.`;
}

// ─── nvim_learn tool ────────────────────────────────────────────────────────

const nvimLearnSchema = Type.Object({
	action: Type.Union([
		Type.Literal("diff"),
		Type.Literal("record"),
		Type.Literal("note_list"),
		Type.Literal("note_read"),
		Type.Literal("note_write"),
	]),
	name: Type.Optional(Type.String({ description: "Note name for note_read/note_write (e.g. 'keymaps')." })),
	content: Type.Optional(Type.String({ description: "Markdown content for note_write." })),
});

/**
 * Create the nvim_learn tool — the agent's persistent memory for the user's
 * nvim setup. `diff` reports which config files changed vs the last session
 * (content-hash); `record` marks them seen; note_* read/write learned notes
 * under .pi/nvim/notes/.
 */
export function createNvimLearnTool(root: string, exec: NvimExec): ToolDefinition<typeof nvimLearnSchema> {
	return {
		name: "nvim_learn",
		label: "nvim learn",
		promptSnippet: "Persistent nvim knowledge: diff config changes, read/write learned notes",
		description:
			"The agent's persistent memory for the user's nvim setup (stored under .pi/nvim/). " +
			"action 'diff' reports which config files changed since the last session (content-hash based); " +
			"'record' marks current config as seen; 'note_list'/'note_read'/'note_write' manage learned notes " +
			"(keymaps, plugins, LSP, options, gotchas).",
		parameters: nvimLearnSchema,
		async execute(_id, { action, name, content }, _signal) {
			setNvimLearningRoot(root);
			switch (action) {
				case "diff": {
					const { files } = await getNvimConfigFiles(exec);
					if (files.length === 0)
						return {
							content: [{ type: "text" as const, text: "No nvim config files found." }],
							details: undefined,
						};
					const diff = diffConfigFiles(files);
					const lines = [
						`new (${diff.new.length}):`,
						...diff.new.map((p) => `  ${p}`),
						`changed (${diff.changed.length}):`,
						...diff.changed.map((p) => `  ${p}`),
						`unchanged (${diff.unchanged.length})`,
						`removed (${diff.removed.length}):`,
						...diff.removed.map((p) => `  ${p}`),
					];
					return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
				}
				case "record": {
					const { files } = await getNvimConfigFiles(exec);
					recordSeen(files);
					return {
						content: [{ type: "text" as const, text: `Recorded fingerprints for ${files.length} config files.` }],
						details: undefined,
					};
				}
				case "note_list": {
					const notes = listNotes();
					return {
						content: [
							{
								type: "text" as const,
								text: notes.length > 0 ? notes.join("\n") : "(no notes yet)",
							},
						],
						details: undefined,
					};
				}
				case "note_read": {
					if (!name)
						return {
							content: [{ type: "text" as const, text: "note_read requires a note name." }],
							details: undefined,
						};
					const text = readNote(name);
					return {
						content: [{ type: "text" as const, text: text ?? `(no note named '${name}')` }],
						details: undefined,
					};
				}
				case "note_write": {
					if (!name || content === undefined)
						return {
							content: [{ type: "text" as const, text: "note_write requires a name and content." }],
							details: undefined,
						};
					writeNote(name, content);
					return {
						content: [{ type: "text" as const, text: `Saved note '${name}'.` }],
						details: undefined,
					};
				}
			}
		},
		renderCall(args, theme, _context) {
			return new Text(`${theme.fg("toolTitle", theme.bold("nvim_learn"))} ${args.action}`, 0, 0);
		},
		renderResult(result, _options, theme, _context) {
			const output = result.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

/**
 * Get nvim-backed operations for all standard tools.
 * Use these to transparently forward filesystem operations through nvim.
 */
export function nvimToolOps(getClient: () => NvimSocketClient | undefined): NvimOps {
	return createNvimOps(getClient);
}
