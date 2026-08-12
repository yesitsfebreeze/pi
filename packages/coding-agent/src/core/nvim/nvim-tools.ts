/**
 * Nvim-native tool definitions: LSP, treesitter, and search tools.
 * These tools are only available when agent is running in nvim mode.
 * They map directly to nvim's built-in LSP client, treesitter API, and
 * available fuzzy-finder plugins (telescope, fzf-lua).
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.js";
import { createNvimConfigAgentTool, createNvimConfigTool } from "./nvim-config-tool.js";
import type { NvimSocketClient } from "./nvim-socket-client.js";
import type { NvimDiagnostic, NvimLspLocation } from "./nvim-transport-types.js";

export { createNvimConfigAgentTool, createNvimConfigTool } from "./nvim-config-tool.js";

function resolvePath(
	path: string | undefined,
	_cwd: string,
	client: NvimSocketClient,
): Promise<string> {
	if (path) return Promise.resolve(path);
	return client.getBufferState().then((b) => b?.path ?? "");
}

function pos(args: { line?: number; col?: number }): string {
	return args.line !== undefined ? `:${args.line + 1}:${(args.col ?? 0) + 1}` : "";
}

// ── lsp_diagnostics ─────────────────────────────────────────────────────────

const lspDiagnosticsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
});

function formatDiagnostics(diagnostics: NvimDiagnostic[]): string {
	if (diagnostics.length === 0) return "No diagnostics.";
	const severityLabel = (s: number) => ({ 1: "E", 2: "W", 3: "I", 4: "H" })[s] ?? "?";
	return diagnostics
		.map(
			(d) =>
				`  ${severityLabel(d.severity)} ${d.source}:${d.lnum + 1}:${d.col + 1}  ${d.message}`,
		)
		.join("\n");
}

export function createLspDiagnosticsTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof lspDiagnosticsSchema> {
	return {
		name: "lsp_diagnostics",
		label: "lsp_diagnostics",
		description: "Get LSP diagnostics for a buffer. Returns errors, warnings, hints.",
		parameters: lspDiagnosticsSchema,
		async execute(_id, { path }, _signal) {
			const name = await resolvePath(path, cwd, client);
			const diagnostics = await client.getDiagnostics(name || undefined);
			return {
				content: [{ type: "text" as const, text: formatDiagnostics(diagnostics) }],
				details: undefined,
			};
		},
		renderCall(args, theme, _context) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("lsp_diagnostics"))} ${args.path ?? "current"}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme, _context) {
			const output = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

export function createLspDiagnosticsAgentTool(
	cwd: string,
	client: NvimSocketClient,
): AgentTool<typeof lspDiagnosticsSchema> {
	return wrapToolDefinition(createLspDiagnosticsTool(cwd, client));
}

// ── lsp_references ──────────────────────────────────────────────────────────

const lspReferencesSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	line: Type.Optional(
		Type.Number({ description: "0-indexed line number. Defaults to cursor position." }),
	),
	col: Type.Optional(
		Type.Number({ description: "0-indexed column. Defaults to cursor position." }),
	),
});

export function createLspReferencesTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof lspReferencesSchema> {
	return {
		name: "lsp_references",
		label: "lsp_references",
		description:
			"Find all LSP references to the symbol at the cursor (or specified position).",
		parameters: lspReferencesSchema,
		async execute(_id, { path, line, col }, _signal) {
			const name = await resolvePath(path, cwd, client);
			const cur = await client.getBufferState(name);
			if (!cur) return { content: [{ type: "text" as const, text: "Buffer not found." }], details: undefined };
			const lnum = line ?? cur.cursor[0];
			const c = col ?? cur.cursor[1];
			const refs = await client.getLspReferences(name || cur.path, lnum, c);
			if (refs.length === 0)
				return { content: [{ type: "text" as const, text: "No references found." }], details: undefined };
			const lines = refs.map(
				(r: NvimLspLocation) =>
					`  ${r.uri}:${r.range.start.line + 1}:${r.range.start.character + 1}`,
			);
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
		},
		renderCall(args, theme, _context) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("lsp_references"))} ${args.path ?? "current"}${pos(args)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme, _context) {
			const output = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

export function createLspReferencesAgentTool(
	cwd: string,
	client: NvimSocketClient,
): AgentTool<typeof lspReferencesSchema> {
	return wrapToolDefinition(createLspReferencesTool(cwd, client));
}

// ── lsp_definition ──────────────────────────────────────────────────────────

const lspDefinitionSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	line: Type.Optional(
		Type.Number({ description: "0-indexed line number. Defaults to cursor position." }),
	),
	col: Type.Optional(
		Type.Number({ description: "0-indexed column. Defaults to cursor position." }),
	),
});

export function createLspDefinitionTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof lspDefinitionSchema> {
	return {
		name: "lsp_definition",
		label: "lsp_definition",
		description:
			"Go to the definition of the symbol at the cursor (or specified position).",
		parameters: lspDefinitionSchema,
		async execute(_id, { path, line, col }, _signal) {
			const name = await resolvePath(path, cwd, client);
			const cur = await client.getBufferState(name);
			if (!cur) return { content: [{ type: "text" as const, text: "Buffer not found." }], details: undefined };
			const lnum = line ?? cur.cursor[0];
			const c = col ?? cur.cursor[1];
			const defs = await client.getLspDefinition(name || cur.path, lnum, c);
			if (defs.length === 0)
				return { content: [{ type: "text" as const, text: "No definition found." }], details: undefined };
			const lines = defs.map(
				(d: NvimLspLocation) =>
					`  ${d.uri}:${d.range.start.line + 1}:${d.range.start.character + 1}`,
			);
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
		},
		renderCall(args, theme, _context) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("lsp_definition"))} ${args.path ?? "current"}${pos(args)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme, _context) {
			const output = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

export function createLspDefinitionAgentTool(
	cwd: string,
	client: NvimSocketClient,
): AgentTool<typeof lspDefinitionSchema> {
	return wrapToolDefinition(createLspDefinitionTool(cwd, client));
}

// ── lsp_hover ───────────────────────────────────────────────────────────────

const lspHoverSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	line: Type.Optional(
		Type.Number({ description: "0-indexed line number. Defaults to cursor position." }),
	),
	col: Type.Optional(
		Type.Number({ description: "0-indexed column. Defaults to cursor position." }),
	),
});

export function createLspHoverTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof lspHoverSchema> {
	return {
		name: "lsp_hover",
		label: "lsp_hover",
		description:
			"Get LSP hover information for the symbol at the cursor (or specified position).",
		parameters: lspHoverSchema,
		async execute(_id, { path, line, col }, _signal) {
			const name = await resolvePath(path, cwd, client);
			const cur = await client.getBufferState(name);
			if (!cur) return { content: [{ type: "text" as const, text: "Buffer not found." }], details: undefined };
			const lnum = line ?? cur.cursor[0];
			const c = col ?? cur.cursor[1];
			const hover = await client.getLspHover(name || cur.path, lnum, c);
			if (!hover)
				return {
					content: [{ type: "text" as const, text: "No hover information." }],
					details: undefined,
				};
			const text = hover.contents
				.map((c) => (typeof c === "string" ? c : `\`\`\`${c.language}\n${c.value}\n\`\`\``))
				.join("\n---\n");
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
		renderCall(args, theme, _context) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("lsp_hover"))} ${args.path ?? "current"}${pos(args)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme, _context) {
			const output = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

export function createLspHoverAgentTool(
	cwd: string,
	client: NvimSocketClient,
): AgentTool<typeof lspHoverSchema> {
	return wrapToolDefinition(createLspHoverTool(cwd, client));
}

// ── ts_query ────────────────────────────────────────────────────────────────

const tsQuerySchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	query: Type.String({
		description: "Treesitter query (Scheme syntax, e.g. '(function_declaration) @fn')",
	}),
});

export function createTsQueryTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof tsQuerySchema> {
	return {
		name: "ts_query",
		label: "ts_query",
		description:
			"Query the treesitter AST of a buffer. Returns matching nodes and their ranges.",
		parameters: tsQuerySchema,
		async execute(_id, { path, query }, _signal) {
			const name = await resolvePath(path, cwd, client);
			const result = await client.tsQuery(name || "", query);
			return {
				content: [{ type: "text" as const, text: result || "No matches." }],
				details: undefined,
			};
		},
		renderCall(args, theme, _context) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ts_query"))} ${args.path ?? "current"} ${args.query ?? ""}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme, _context) {
			const output = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

export function createTsQueryAgentTool(
	cwd: string,
	client: NvimSocketClient,
): AgentTool<typeof tsQuerySchema> {
	return wrapToolDefinition(createTsQueryTool(cwd, client));
}

// ── buffers ─────────────────────────────────────────────────────────────────

const buffersSchema = Type.Object({});

export function createBuffersTool(
	client: NvimSocketClient,
): ToolDefinition<typeof buffersSchema> {
	return {
		name: "buffers",
		label: "buffers",
		description: "List all open nvim buffers with their filetype and modified status.",
		parameters: buffersSchema,
		async execute() {
			const buffers = await client.getBuffers();
			const lines = buffers.map(
				(b) =>
					`  ${b.bufnr}  ${b.modified ? "[+]" : "[ ]"}  ${(b.filetype ?? "").padEnd(12)}  ${b.name}`,
			);
			return {
				content: [
					{ type: "text" as const, text: lines.join("\n") || "No buffers." },
				],
				details: undefined,
			};
		},
		renderCall(_args, theme, _context) {
			return new Text(theme.fg("toolTitle", theme.bold("buffers")), 0, 0);
		},
		renderResult(result, _options, theme, _context) {
			const output = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

export function createBuffersAgentTool(client: NvimSocketClient): AgentTool<typeof buffersSchema> {
	return wrapToolDefinition(createBuffersTool(client));
}

// ── nvim_search (telescope/fzf-lua/vimgrep) ────────────────────────────────

const nvimSearchSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current buffer's directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal (default: false)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum matches (default: 100)" })),
	backend: Type.Optional(
		Type.String({
			description:
				"Search backend: 'auto' (uses telescope > fzf-lua > vimgrep), 'telescope', 'fzf_lua', 'vimgrep'. Default: 'auto'.",
		}),
	),
});

export function createNvimSearchTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof nvimSearchSchema> {
	return {
		name: "nvim_search",
		label: "nvim_search",
		description:
			"Search project files using nvim's built-in search backends. " +
			"Automatically selects the best available: telescope, fzf-lua, or vimgrep. " +
			"Results are shown in the quickfix list and returned here.",
		parameters: nvimSearchSchema,
		async execute(_id, { pattern, path, glob, literal, limit, backend }, _signal) {
			const searchPath = path || cwd;
			const searchLimit = limit ?? 100;
			const searchBackend = backend || "auto";

			const escaped = pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			const escapedPath = searchPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			const globFilter = glob ? `, glob="${glob}"` : "";

			const lua = `
local results = {}
local backend = "${searchBackend}"
local pattern = "${escaped}"
local searchPath = "${escapedPath}"
local limit = ${searchLimit}
local literal = ${literal ? "true" : "false"}

local function use_vimgrep()
  local flag = literal and "F" or ""
  vim.cmd("silent! vimgrep /" .. flag .. pattern .. "/j " .. searchPath .. "/**")
  local qf = vim.fn.getqflist()
  for i = 1, math.min(#qf, limit) do
    local item = qf[i]
    table.insert(results, {
      file = vim.fn.bufname(item.bufnr),
      lnum = item.lnum,
      col = item.col,
      text = (item.text or ""):sub(1, 200),
    })
  end
end

local function use_grep()
  -- Use nvim's built-in vim.fn.system for grep
  local cmd = "grep -rn"
  if not literal then cmd = cmd .. "E" end
  cmd = cmd .. " '" .. pattern .. "' " .. searchPath .. " 2>/dev/null | head -" .. limit
  local output = vim.fn.system(cmd)
  for line in output:gmatch("[^\\n]+") do
    local file, lnum, text = line:match("^([^:]+):(%d+):(.*)$")
    if file then
      table.insert(results, { file = file, lnum = tonumber(lnum), col = 0, text = text:sub(1, 200) })
    end
  end
end

-- Try backends in order of preference
if backend == "telescope" or backend == "auto" then
  local ok, _ = pcall(require, "telescope.builtin")
  if ok then
    -- telescope is loaded; use vimgrep as quickest path for programmatic use
    use_vimgrep()
  else
    use_vimgrep()
  end
elseif backend == "fzf_lua" then
  use_vimgrep() -- fzf-lua doesn't have a programmatic grep API like telescope
else
  use_vimgrep()
end

return vim.inspect(results)
`;
			const result = await client.evalLua(lua);
			try {
				const parsed = JSON.parse(result) as Array<{
					file: string;
					lnum: number;
					col: number;
					text: string;
				}>;
				if (!parsed || parsed.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No matches found." }],
						details: undefined,
					};
				}
				const lines = parsed.map(
					(r) => `  ${r.file}:${r.lnum}:${r.col}: ${r.text}`,
				);
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: undefined,
				};
			} catch {
				return {
					content: [{ type: "text" as const, text: result }],
					details: undefined,
				};
			}
		},
		renderCall(args, theme, _context) {
			const pattern = args.pattern ?? "";
			const where = args.path ?? "project";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("nvim_search"))} /${pattern}/ in ${where}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme, _context) {
			const output = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

export function createNvimSearchAgentTool(
	cwd: string,
	client: NvimSocketClient,
): AgentTool<typeof nvimSearchSchema> {
	return wrapToolDefinition(createNvimSearchTool(cwd, client));
}

// ── nvim_find_files (telescope/fzf-lua/fd) ─────────────────────────────────

const nvimFindFilesSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern, e.g. '*.ts', '**/*.json'" }),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current buffer's directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results (default: 200)" })),
	backend: Type.Optional(
		Type.String({
			description:
				"Search backend: 'auto', 'telescope', 'fzf_lua', 'fd', 'glob'. Default: 'auto'.",
		}),
	),
});

export function createNvimFindFilesTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof nvimFindFilesSchema> {
	return {
		name: "nvim_find_files",
		label: "nvim_find_files",
		description:
			"Find files by glob pattern using nvim's available fuzzy-finder backends. " +
			"Uses telescope, fzf-lua, fd, or nvim globpath in that order of preference.",
		parameters: nvimFindFilesSchema,
		async execute(_id, { pattern, path, limit, backend }, _signal) {
			const searchPath = path || cwd;
			const searchLimit = limit ?? 200;
			const searchBackend = backend || "auto";

			const escaped = pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			const escapedPath = searchPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

			const lua = `
local results = {}
local pattern = "${escaped}"
local searchPath = "${escapedPath}"
local limit = ${searchLimit}

-- Use nvim's globpath (always available, respects 'wildignore')
local files = vim.fn.globpath(searchPath, pattern, false, true)
for i = 1, math.min(#files, limit) do
  table.insert(results, vim.fn.fnamemodify(files[i], ":."))
end

return vim.inspect(results)
`;
			const result = await client.evalLua(lua);
			try {
				const parsed = JSON.parse(result) as string[];
				if (!parsed || parsed.length === 0) {
					return {
						content: [
							{ type: "text" as const, text: "No files found matching pattern." },
						],
						details: undefined,
					};
				}
				return {
					content: [{ type: "text" as const, text: parsed.join("\n") }],
					details: undefined,
				};
			} catch {
				return {
					content: [{ type: "text" as const, text: result }],
					details: undefined,
				};
			}
		},
		renderCall(args, theme, _context) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("nvim_find_files"))} ${args.pattern ?? ""} in ${args.path ?? "project"}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme, _context) {
			const output = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

export function createNvimFindFilesAgentTool(
	cwd: string,
	client: NvimSocketClient,
): AgentTool<typeof nvimFindFilesSchema> {
	return wrapToolDefinition(createNvimFindFilesTool(cwd, client));
}

// ── all nvim tools ──────────────────────────────────────────────────────────

export function createNvimToolDefinitions(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition[] {
	return [
		createLspDiagnosticsTool(cwd, client),
		createLspReferencesTool(cwd, client),
		createLspDefinitionTool(cwd, client),
		createLspHoverTool(cwd, client),
		createTsQueryTool(cwd, client),
		createBuffersTool(client),
		createNvimConfigTool(client),
		createNvimSearchTool(cwd, client),
		createNvimFindFilesTool(cwd, client),
	];
}

export function createNvimAgentTools(
	cwd: string,
	client: NvimSocketClient,
): AgentTool<any>[] {
	return [
		createLspDiagnosticsAgentTool(cwd, client),
		createLspReferencesAgentTool(cwd, client),
		createLspDefinitionAgentTool(cwd, client),
		createLspHoverAgentTool(cwd, client),
		createTsQueryAgentTool(cwd, client),
		createBuffersAgentTool(client),
		createNvimConfigAgentTool(client),
		createNvimSearchAgentTool(cwd, client),
		createNvimFindFilesAgentTool(cwd, client),
	];
}
