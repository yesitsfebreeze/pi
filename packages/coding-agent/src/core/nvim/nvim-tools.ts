/**
 * Nvim-native tool definitions: LSP, treesitter, and search tools.
 * These tools are only available when agent is running in nvim mode.
 * They map directly to nvim's built-in LSP client, treesitter API, and
 * available fuzzy-finder plugins (telescope, fzf-lua).
 */

import { statSync } from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { createNvimConfigTool } from "./nvim-config-tool.ts";
import { luaQuote, type NvimSocketClient } from "./nvim-socket-client.ts";
import { createNvimSurfaceToolDefinitions } from "./nvim-surface.ts";
import type { NvimDiagnostic, NvimLspLocation } from "./nvim-transport-types.ts";

export { createNvimConfigTool } from "./nvim-config-tool.ts";

function resolvePath(path: string | undefined, _cwd: string, client: NvimSocketClient): Promise<string> {
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
		.map((d) => `  ${severityLabel(d.severity)} ${d.source}:${d.lnum + 1}:${d.col + 1}  ${d.message}`)
		.join("\n");
}

export function createLspDiagnosticsTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof lspDiagnosticsSchema> {
	return {
		name: "lsp_diagnostics",
		label: "lsp_diagnostics",
		promptSnippet: "LSP diagnostics for a buffer (errors, warnings, hints)",
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
			return new Text(`${theme.fg("toolTitle", theme.bold("lsp_diagnostics"))} ${args.path ?? "current"}`, 0, 0);
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

// ── lsp_references ──────────────────────────────────────────────────────────

const lspReferencesSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	line: Type.Optional(Type.Number({ description: "0-indexed line number. Defaults to cursor position." })),
	col: Type.Optional(Type.Number({ description: "0-indexed column. Defaults to cursor position." })),
});

export function createLspReferencesTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof lspReferencesSchema> {
	return {
		name: "lsp_references",
		label: "lsp_references",
		promptSnippet: "All LSP references to the symbol at cursor/position",
		description: "Find all LSP references to the symbol at the cursor (or specified position).",
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
				(r: NvimLspLocation) => `  ${r.uri}:${r.range.start.line + 1}:${r.range.start.character + 1}`,
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

// ── lsp_definition ──────────────────────────────────────────────────────────

const lspDefinitionSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	line: Type.Optional(Type.Number({ description: "0-indexed line number. Defaults to cursor position." })),
	col: Type.Optional(Type.Number({ description: "0-indexed column. Defaults to cursor position." })),
});

export function createLspDefinitionTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof lspDefinitionSchema> {
	return {
		name: "lsp_definition",
		label: "lsp_definition",
		promptSnippet: "LSP go-to-definition for the symbol at cursor/position",
		description: "Go to the definition of the symbol at the cursor (or specified position).",
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
				(d: NvimLspLocation) => `  ${d.uri}:${d.range.start.line + 1}:${d.range.start.character + 1}`,
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

// ── lsp_hover ───────────────────────────────────────────────────────────────

const lspHoverSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	line: Type.Optional(Type.Number({ description: "0-indexed line number. Defaults to cursor position." })),
	col: Type.Optional(Type.Number({ description: "0-indexed column. Defaults to cursor position." })),
});

export function createLspHoverTool(cwd: string, client: NvimSocketClient): ToolDefinition<typeof lspHoverSchema> {
	return {
		name: "lsp_hover",
		label: "lsp_hover",
		promptSnippet: "LSP hover info for the symbol at cursor/position",
		description: "Get LSP hover information for the symbol at the cursor (or specified position).",
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

// ── ts_query ────────────────────────────────────────────────────────────────

const tsQuerySchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	query: Type.String({
		description: "Treesitter query (Scheme syntax, e.g. '(function_declaration) @fn')",
	}),
});

export function createTsQueryTool(cwd: string, client: NvimSocketClient): ToolDefinition<typeof tsQuerySchema> {
	return {
		name: "ts_query",
		label: "ts_query",
		promptSnippet: "Query the treesitter AST of a buffer",
		description: "Query the treesitter AST of a buffer. Returns matching nodes and their ranges.",
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

// ── buffers ─────────────────────────────────────────────────────────────────

const buffersSchema = Type.Object({});

export function createBuffersTool(client: NvimSocketClient): ToolDefinition<typeof buffersSchema> {
	return {
		name: "buffers",
		label: "buffers",
		promptSnippet: "List open nvim buffers with filetype and modified status",
		description: "List all open nvim buffers with their filetype and modified status.",
		parameters: buffersSchema,
		rare: false,
		async execute() {
			const buffers = await client.getBuffers();
			const lines = buffers.map(
				(b) => `  ${b.bufnr}  ${b.modified ? "[+]" : "[ ]"}  ${(b.filetype ?? "").padEnd(12)}  ${b.name}`,
			);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") || "No buffers." }],
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

// ── nvim_search (telescope/fzf-lua/vimgrep) ────────────────────────────────

const nvimSearchSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal)" }),
	path: Type.Optional(
		Type.String({ description: "Directory or file to search (default: current buffer's directory)" }),
	),
	glob: Type.Optional(
		Type.String({
			description: "Filter matches by glob, e.g. '*.ts' (basename) or 'src/**/*.ts' (path).",
		}),
	),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal (default: false)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum matches (default: 100)" })),
});

/** True when the path names an existing file (vimgrep target differs for files). */
function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

export function createNvimSearchTool(cwd: string, client: NvimSocketClient): ToolDefinition<typeof nvimSearchSchema> {
	return {
		name: "nvim_search",
		label: "nvim_search",
		promptSnippet: "Search project files via nvim (vimgrep), optionally filtered by glob",
		description:
			"Search project files using nvim's vimgrep. Optionally filter matches by glob. " +
			"Results are placed in the quickfix list and returned here.",
		parameters: nvimSearchSchema,
		rare: false,
		async execute(_id, { pattern, path, glob, literal, limit }, _signal) {
			const searchPath = path || cwd;
			const searchLimit = limit ?? 100;

			// vimgrep's file args are globs natively, so the glob filter and the
			// single-file case are resolved here instead of grepping everything
			// and filtering in Lua: a *file* path must not get "/**" appended
			// (that matches nothing), and a glob folds into the target so
			// vimgrep skips non-matching files (and binaries) itself.
			let target: string;
			if (glob) {
				target = glob.includes("/") ? `${searchPath}/${glob}` : `${searchPath}/**/${glob}`;
			} else if (isFile(searchPath)) {
				target = searchPath;
			} else {
				target = `${searchPath}/**`;
			}

			const escaped = luaQuote(pattern);
			const escapedTarget = luaQuote(target);

			const lua = `
local results = {}
local pattern = "${escaped}"
local target = "${escapedTarget}"
local limit = ${searchLimit}
local literal = ${literal ? "true" : "false"}

-- vimgrep is the only programmatic backend here: telescope and fzf-lua are
-- interactive pickers with no headless grep API, so every "backend" branch
-- this tool used to advertise ended up calling vimgrep anyway.
--
-- literal mode must NOT inline a flag into the pattern (the old F flag
-- landed inside the pattern, so vimgrep searched for "F <pattern>"). Use
-- very-nomagic (\\V) instead so regex metachars are inert. The delimiter is
-- picked at runtime to be absent from the pattern, so a '/' in the pattern
-- cannot split the vimgrep command.
local magic = literal and "\\\\V" or ""
local d = "/"
if pattern:find("/", 1, true) then
  for _, c in ipairs({"#", "|", "@", "!", "%", "^", "&", "*", "+", "~", "="}) do
    if not pattern:find(c, 1, true) then d = c break end
  end
end
vim.cmd("silent! vimgrep " .. d .. magic .. pattern .. d .. "j " .. target)
local qf = vim.fn.getqflist()
for i = 1, #qf do
  if #results >= limit then break end
  local item = qf[i]
  table.insert(results, {
    file = vim.fn.bufname(item.bufnr),
    lnum = item.lnum,
    col = item.col,
    text = (item.text or ""):sub(1, 200),
  })
end

return vim.fn.json_encode(results)
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
				const lines = parsed.map((r) => `  ${r.file}:${r.lnum}:${r.col}: ${r.text}`);
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
			return new Text(`${theme.fg("toolTitle", theme.bold("nvim_search"))} /${pattern}/ in ${where}`, 0, 0);
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

// ── nvim_find_files (telescope/fzf-lua/fd) ─────────────────────────────────

const nvimFindFilesSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern, e.g. '*.ts', '**/*.json'" }),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current buffer's directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results (default: 200)" })),
});

export function createNvimFindFilesTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof nvimFindFilesSchema> {
	return {
		name: "nvim_find_files",
		label: "nvim_find_files",
		promptSnippet: "Find files by glob via nvim globpath",
		description:
			"Find files by glob pattern using nvim's globpath, which respects the user's 'wildignore'. " +
			"Always available — needs no fuzzy-finder plugin.",
		parameters: nvimFindFilesSchema,
		rare: false,
		async execute(_id, { pattern, path, limit }, _signal) {
			const searchPath = path || cwd;
			const searchLimit = limit ?? 200;

			const escaped = luaQuote(pattern);
			const escapedPath = luaQuote(searchPath);

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

return vim.fn.json_encode(results)
`;
			const result = await client.evalLua(lua);
			try {
				const parsed = JSON.parse(result) as string[];
				if (!parsed || parsed.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No files found matching pattern." }],
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

// ── nvim_find_replace_all (multi-file replace via quickfix) ─────────────────

const nvimFindReplaceAllSchema = Type.Object({
	pattern: Type.String({
		description:
			"Search pattern. Vim regex by default (groups use \\(...\\) and are referenced in the replacement as \\1, \\2…). Set literal=true for plain text.",
	}),
	replacement: Type.String({
		description: "Replacement text (vim syntax: \\1 = first group, & = whole match, \\r = newline).",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current nvim cwd)." })),
	glob: Type.Optional(
		Type.String({
			description: "Only match/edit files matching this glob, e.g. '*.ts' (basename) or 'src/**/*.ts' (path).",
		}),
	),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text (default: false)." })),
	apply: Type.Optional(
		Type.Boolean({
			description:
				"false (default): dry run — search, populate the quickfix list, report matches, change nothing. true: apply the replacement to every matched line (via :cdo) and save the touched buffers.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum matches in the report (default: 100)." })),
});

export function createNvimFindReplaceAllTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof nvimFindReplaceAllSchema> {
	return {
		name: "nvim_find_replace_all",
		label: "nvim find replace all",
		promptSnippet: "Multi-file find-and-replace via nvim quickfix (dry-run or apply), results visible in nvim",
		description:
			"Find and replace across many files in one call, using nvim's own quickfix pipeline: vimgrep -> quickfix -> :cdo substitute. " +
			"Every match lands in the user's quickfix list (open with :copen), so the change is visible and navigable in nvim. " +
			"apply=false (default) is a dry run that reports matches without touching anything; apply=true performs the replacement and saves. " +
			"For a single unique string in one buffer, prefer nvim_find_replace.",
		parameters: nvimFindReplaceAllSchema,
		rare: false,
		async execute(_id, { pattern, replacement, path, glob, literal, apply, limit }, _signal) {
			const searchPath = path || cwd;
			const searchLimit = limit ?? 100;

			// Same target resolution as nvim_search: a *file* path must not get
			// "/**" appended (matches nothing), and a glob folds into the target
			// so vimgrep (and therefore the quickfix list) only ever contains the
			// files the caller asked for — no in-Lua post-filter needed.
			let target: string;
			if (glob) {
				target = glob.includes("/") ? `${searchPath}/${glob}` : `${searchPath}/**/${glob}`;
			} else if (isFile(searchPath)) {
				target = searchPath;
			} else {
				target = `${searchPath}/**`;
			}

			const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			const escaped = esc(pattern);
			const escapedRepl = esc(replacement);
			const escapedTarget = esc(target);

			const lua = `
local results = {}
local pattern = "${escaped}"
local replacement = "${escapedRepl}"
local target = "${escapedTarget}"
local limit = ${searchLimit}
local literal = ${literal ? "true" : "false"}
local apply = ${apply ? "true" : "false"}

-- Very-nomagic for literal searches so regex metachars are inert.
local magic = literal and "\\\\V" or ""

-- vimgrep/substitute delimiter: one absent from both pattern and replacement.
local function pick_delim(s1, s2)
  for _, d in ipairs({"/", "#", "|", "@", "!", "%", "^", "&", "*", "+", "~", "="}) do
    if not s1:find(d, 1, true) and not s2:find(d, 1, true) then return d end
  end
  return "/"
end
local d = pick_delim(pattern, replacement)

-- Populate the quickfix list: every match is visible in nvim (:copen) and,
-- because the glob was folded into the vimgrep target, the list already
-- contains exactly the files the caller asked for.
vim.cmd("silent! vimgrep " .. d .. magic .. pattern .. d .. "j " .. target)
local qf = vim.fn.getqflist()

local function count_by_file(items)
  local counts = {}
  for _, item in ipairs(items) do
    local file = vim.fn.bufname(item.bufnr)
    counts[file] = (counts[file] or 0) + 1
  end
  return counts
end

local before = count_by_file(vim.fn.getqflist())

if apply then
  -- Replace on every quickfix line (g = all occurrences per line), then write
  -- the touched buffers so the edit-tool contract (change visible on disk) holds.
  vim.cmd("silent! cdo s" .. d .. magic .. pattern .. d .. replacement .. d .. "g")
  vim.cmd("silent! cdo update")
end

-- Report: re-check the LIVE buffer line (qf entry text is a snapshot from
-- vimgrep time and stays stale after :cdo) so "remaining" is honest — a
-- replacement that re-introduces the pattern is reported, not hidden.
local qf2 = vim.fn.getqflist()
local after = count_by_file(qf2)
local function line_matches(bufnr, lnum, fallback)
  local ok, line = pcall(vim.api.nvim_buf_get_lines, bufnr, lnum - 1, lnum, false)
  local text = (ok and line and line[1]) or (fallback or "")
  return vim.fn.match(text, magic .. pattern) >= 0
end
local remaining_by_file = {}
local changed_total = 0
for _, item in ipairs(qf2) do
  if line_matches(item.bufnr, item.lnum, item.text) then
    local file = vim.fn.bufname(item.bufnr)
    remaining_by_file[file] = (remaining_by_file[file] or 0) + 1
  else
    changed_total = changed_total + 1
  end
end

local files = {}
for file, n in pairs(before) do
  table.insert(files, {
    file = file,
    matched = n,
    remaining = remaining_by_file[file] or 0,
  })
end
table.sort(files, function(a, b) return a.file < b.file end)

for i = 1, math.min(#qf2, limit) do
  local item = qf2[i]
  table.insert(results, {
    file = vim.fn.bufname(item.bufnr),
    lnum = item.lnum,
    col = item.col,
    text = (item.text or ""):sub(1, 200),
  })
end

return vim.fn.json_encode({
  applied = apply,
  total_matches = #qf2,
  changed = changed_total,
  files = files,
  matches = results,
})
`;
			const result = await client.evalLua(lua);
			try {
				const parsed = JSON.parse(result) as {
					applied: boolean;
					total_matches: number;
					changed: number;
					files: Array<{ file: string; matched: number; remaining: number }>;
					matches: Array<{ file: string; lnum: number; col: number; text: string }>;
				};
				const lines: string[] = [];
				if (parsed.total_matches === 0) {
					lines.push("No matches found.");
				} else {
					lines.push(
						`${parsed.applied ? "REPLACED" : "DRY RUN (apply=false — nothing changed, quickfix populated)"}: ` +
							`${parsed.total_matches} matches${parsed.applied ? `, ${parsed.changed} lines changed` : ""} across ${parsed.files.length} file(s)`,
					);
					for (const f of parsed.files) {
						lines.push(
							`  ${f.file}: ${f.matched} match(es)${parsed.applied ? `, ${f.remaining} still match` : ""}`,
						);
					}
					if (parsed.applied)
						lines.push("Quickfix list updated; open with :copen or nvim_exec { command: 'copen' }.");
					lines.push("");
					for (const r of parsed.matches) lines.push(`  ${r.file}:${r.lnum}:${r.col}: ${r.text}`);
				}
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
			} catch {
				return { content: [{ type: "text" as const, text: result }], details: undefined };
			}
		},
		renderCall(args, theme, _context) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("nvim_find_replace_all"))} ${args.pattern ?? ""} in ${args.path ?? "project"}${args.apply ? " (apply)" : " (dry-run)"}`,
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

// ── lsp_rename ──────────────────────────────────────────────────────────────

const lspRenameSchema = Type.Object({
	newName: Type.String({ description: "The new name for the symbol." }),
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	line: Type.Optional(Type.Number({ description: "0-indexed line number. Defaults to cursor position." })),
	col: Type.Optional(Type.Number({ description: "0-indexed column. Defaults to cursor position." })),
	write: Type.Optional(Type.Boolean({ description: "Write affected buffers after renaming (default: true)." })),
});

export function createLspRenameTool(cwd: string, client: NvimSocketClient): ToolDefinition<typeof lspRenameSchema> {
	return {
		name: "lsp_rename",
		label: "lsp_rename",
		promptSnippet: "Rename a symbol across the project via LSP",
		description:
			"Rename the symbol at the cursor (or given position) across every file via the LSP textDocument/rename handler. " +
			"Applies edits to the live buffers and writes them (unless write=false), so the rename lands on disk like an edit-tool change.",
		parameters: lspRenameSchema,
		async execute(_id, { newName, path, line, col, write }, _signal) {
			const name = await resolvePath(path, cwd, client);
			const result = await client.renameSymbol(name || undefined, line, col, newName, write ?? true);
			if (result.error) {
				return { content: [{ type: "text" as const, text: result.error }], details: undefined };
			}
			const lines = result.files?.length
				? [
						`Renamed to "${newName}" (${result.edits} edit(s) across ${result.files.length} file(s)):`,
						...result.files.map((f) => `  ${f}`),
					]
				: [`Renamed to "${newName}" — no edits applied.`];
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
		},
		renderCall(args, theme, _context) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("lsp_rename"))} ${args.newName ?? ""} @ ${args.path ?? "current"}${pos(args)}`,
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

// ── lsp_code_action ─────────────────────────────────────────────────────────

const lspCodeActionSchema = Type.Object({
	action: Type.Optional(
		Type.Union([
			Type.Number({ description: "1-based index of the action to apply (from the listing)." }),
			Type.String({ description: "Exact title of the action to apply." }),
		]),
	),
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	line: Type.Optional(Type.Number({ description: "0-indexed line number. Defaults to cursor position." })),
	col: Type.Optional(Type.Number({ description: "0-indexed column. Defaults to cursor position." })),
});

export function createLspCodeActionTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof lspCodeActionSchema> {
	return {
		name: "lsp_code_action",
		label: "lsp_code_action",
		promptSnippet: "List or apply LSP code actions (quickfixes, refactors) at the cursor",
		description:
			"List LSP code actions available at the cursor (or given position): quickfixes for diagnostics, refactors, organize-imports, etc. " +
			"Omit `action` to get the numbered list; pass an index or an exact title to apply it (workspace edit + command, touched buffers written).",
		parameters: lspCodeActionSchema,
		async execute(_id, { action, path, line, col }, _signal) {
			const name = await resolvePath(path, cwd, client);
			const result = await client.codeActions(name || undefined, line, col, action);
			if (result.error) {
				return { content: [{ type: "text" as const, text: result.error }], details: undefined };
			}
			if (result.applied) {
				const parts = [`Applied code action: ${result.applied}`];
				if (result.edit) parts.push("(edit)");
				if (result.command) parts.push("(command)");
				if (result.wrote) parts.push(`(${result.wrote} buffer(s) written)`);
				return { content: [{ type: "text" as const, text: parts.join(" ") }], details: undefined };
			}
			const lines = [`Code actions (${result.count}):`];
			for (const [i, a] of (result.actions ?? []).entries()) {
				lines.push(`  ${i + 1}. ${a.title}${a.is_preferred ? " (preferred)" : ""}${a.kind ? ` [${a.kind}]` : ""}`);
			}
			lines.push("", "Pass action=<index or title> to apply one.");
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
		},
		renderCall(args, theme, _context) {
			const act = args.action !== undefined ? ` → ${String(args.action)}` : " (list)";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("lsp_code_action"))} ${args.path ?? "current"}${pos(args)}${act}`,
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

// ── nvim_format (conform.nvim) ──────────────────────────────────────────────

const nvimFormatSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	formatter: Type.Optional(
		Type.String({
			description:
				"Force a specific conform formatter name (e.g. 'prettier', 'black'). Default: conform's formatters_by_ft resolution, falling back to LSP formatting.",
		}),
	),
});

export function createNvimFormatTool(cwd: string, client: NvimSocketClient): ToolDefinition<typeof nvimFormatSchema> {
	return {
		name: "nvim_format",
		label: "nvim_format",
		promptSnippet: "Format a buffer via conform.nvim (or LSP fallback)",
		description:
			"Format a buffer using the user's installed formatter runner (conform.nvim: resolves formatters_by_ft, e.g. black for python, prettier for markdown, and falls back to LSP formatting). " +
			"Without conform, falls back to plain vim.lsp.buf.format. The live buffer is formatted in place; the change is visible in nvim immediately.",
		parameters: nvimFormatSchema,
		async execute(_id, { path, formatter }, _signal) {
			const name = await resolvePath(path, cwd, client);
			const result = await client.formatBuffer(name || undefined, formatter);
			if (result.error) {
				return { content: [{ type: "text" as const, text: result.error }], details: undefined };
			}
			const used = result.formatters?.length ? result.formatters.join(", ") : "lsp fallback";
			const text = `Formatted via ${result.backend === "lsp" ? "LSP" : `conform [${used}]`}${result.changed ? "" : " — no changes needed"}`;
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
		renderCall(args, theme, _context) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("nvim_format"))} ${args.path ?? "current"}${args.formatter ? ` (${args.formatter})` : ""}`,
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

// ── nvim_table_realign (vim-table-mode) ─────────────────────────────────────

const nvimTableRealignSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer name. Defaults to current buffer." })),
	line: Type.Optional(
		Type.Number({
			description: "1-based line inside the table to realign at. Defaults to the cursor line (or line 1).",
		}),
	),
});

export function createNvimTableRealignTool(
	cwd: string,
	client: NvimSocketClient,
): ToolDefinition<typeof nvimTableRealignSchema> {
	return {
		name: "nvim_table_realign",
		label: "nvim_table_realign",
		promptSnippet: "Realign a markdown table via vim-table-mode",
		description:
			"Realign the markdown table under the given line using vim-table-mode's TableModeRealign. " +
			"Fixes pipe alignment that drifts when rows are added or edited. No-op when the line is not inside a table.",
		parameters: nvimTableRealignSchema,
		async execute(_id, { path, line }, _signal) {
			const name = await resolvePath(path, cwd, client);
			const result = await client.realignTable(name || undefined, line);
			if (result.error) {
				return { content: [{ type: "text" as const, text: result.error }], details: undefined };
			}
			const text = `Table realigned at line ${result.line}${result.realigned ? "" : " (already aligned, or no table there)"}`;
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
		renderCall(args, theme, _context) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("nvim_table_realign"))} ${args.path ?? "current"}${args.line ? `:${args.line}` : ""}`,
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

// ── all nvim tools ──────────────────────────────────────────────────────────

export function createNvimToolDefinitions(cwd: string, client: NvimSocketClient): ToolDefinition[] {
	return [
		...createNvimSurfaceToolDefinitions(client),
		createLspDiagnosticsTool(cwd, client),
		createLspReferencesTool(cwd, client),
		createLspDefinitionTool(cwd, client),
		createLspHoverTool(cwd, client),
		createTsQueryTool(cwd, client),
		createBuffersTool(client),
		createNvimConfigTool(client),
		createNvimSearchTool(cwd, client),
		createNvimFindFilesTool(cwd, client),
		createNvimFindReplaceAllTool(cwd, client),
		createLspRenameTool(cwd, client),
		createLspCodeActionTool(cwd, client),
		createNvimFormatTool(cwd, client),
		createNvimTableRealignTool(cwd, client),
	];
}
