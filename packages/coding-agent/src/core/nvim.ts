/**
 * nvim integration: connect to a running nvim instance via --listen socket,
 * discover its environment, and expose tools for the agent to control it.
 *
 * When nvim is connected, standard filesystem tools (read, write, edit, grep,
 * find, ls) are transparently forwarded through nvim so all edits are visible
 * in real-time and the agent sees exactly what the user sees.
 *
 * The connection uses nvim's JSON-RPC socket API. No plugin required for basic
 * functionality; the pi nvim plugin (if installed) enables richer operations.
 */

import { execFile } from "node:child_process";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolDefinition } from "./extensions/types.js";
import { wrapToolDefinition } from "./tools/tool-definition-wrapper.js";
import type { NvimBufferEdit, NvimBufferState } from "./nvim/nvim-transport-types.js";
import { NvimSocketClient } from "./nvim/nvim-socket-client.js";
import { createNvimOps, type NvimOps } from "./nvim/nvim-ops.js";
import {
	createNvimAgentTools,
	createNvimToolDefinitions,
} from "./nvim/nvim-tools.js";

// Re-export for consumers
export { NvimSocketClient } from "./nvim/nvim-socket-client.js";
export { createNvimOps, type NvimOps } from "./nvim/nvim-ops.js";
export {
	createNvimAgentTools,
	createNvimToolDefinitions,
	createLspDiagnosticsTool,
	createLspReferencesTool,
	createLspDefinitionTool,
	createLspHoverTool,
	createTsQueryTool,
	createBuffersTool,
	createNvimConfigTool,
	createNvimSearchTool,
	createNvimFindFilesTool,
} from "./nvim/nvim-tools.js";
export type { NvimBufferState, NvimBufferEdit };

/** Escape a string for embedding inside a Vim double-quoted luaeval argument. */
function escVim(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

export type NvimExec = (lua: string) => Promise<string>;

/**
 * Create an exec function that evaluates Lua code in a remote nvim instance
 * via `nvim --server <socket> --remote-expr luaeval(...)`.
 * Used as a fallback when the socket client is not available.
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
						reject(
							new Error(
								`nvim RPC failed: ${stderr?.trim() || err.message}`,
							),
						);
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
 * Includes the socket client (for high-level operations) and the exec function
 * (for raw Lua evaluation as fallback).
 */
export interface NvimConnection {
	client: NvimSocketClient;
	exec: NvimExec;
	ops: NvimOps;
}

/**
 * Connect to nvim at the given socket path.
 * Returns the full connection object with client, exec, and operations.
 */
export async function connectNvim(
	socketPath: string,
): Promise<NvimConnection> {
	let client: NvimSocketClient;
	try {
		client = new NvimSocketClient({ socketPath });
		await client.connect();
	} catch {
		// Socket client failed — fall back to nvim --remote-expr
		throw new Error(
			`Cannot connect to nvim socket at ${socketPath}. Make sure nvim is running with --listen ${socketPath}`,
		);
	}

	const exec = createNvimExec(socketPath);
	// Verify we can reach nvim
	await exec("return 1"); // throws on failure

	const getClient = () => (client.connected ? client : undefined);
	const ops = createNvimOps(getClient);

	return { client, exec, ops };
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
const renderResult = (result: any) =>
	new Text(
		result?.content?.map((c: any) => c.text ?? "").join("\n") ?? "",
		0,
		0,
	);

function basicNvimToolDefs(exec: NvimExec): ToolDefinition[] {
	return [
		{
			name: "nvim_exec",
			label: "nvim exec",
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

/**
 * Get the basic nvim control tools (nvim_exec, nvim_lua).
 * These are always available when nvim is connected, regardless of
 * whether the pi plugin is installed.
 */
export function nvimTools(exec: NvimExec): AgentTool[] {
	return basicNvimToolDefs(exec).map((d) => wrapToolDefinition(d));
}

/**
 * Get all nvim-native tools (LSP, treesitter, config, search, find files).
 * These require the NvimSocketClient (which works with raw nvim RPC or the pi plugin).
 */
export function nvimNativeAgentTools(
	cwd: string,
	client: NvimSocketClient,
): AgentTool[] {
	return createNvimAgentTools(cwd, client);
}

/**
 * Get nvim-backed operations for all standard tools.
 * Use these to transparently forward filesystem operations through nvim.
 */
export function nvimToolOps(getClient: () => NvimSocketClient | undefined): NvimOps {
	return createNvimOps(getClient);
}
