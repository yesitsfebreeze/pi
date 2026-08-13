/**
 * Nvim surface tools — give the agent access to *every* nvim buffer, window,
 * and surface (not just the visible one), plus keystroke/terminal control.
 *
 * These wrap the high-level methods on {@link NvimSocketClient}, which
 * execute Lua in the connected nvim via `--server --remote-expr`. No plugin
 * required beyond `nvim --listen <socket>`.
 *
 * Two-tier state (`nvim_state` brief/full) is ported from
 * paulburgess1357/nvim-mcp; find/replace mirrors the contract of the
 * standard `edit` tool (rejects multi-match).
 */

import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { NvimSocketClient } from "./nvim-socket-client.ts";

const textOut = (result: any) =>
	result?.content
		?.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n") ?? "";

function renderText(result: any, _opts: any, theme: any) {
	return new Text(theme.fg("toolOutput", textOut(result)), 0, 0);
}

function title(theme: any, name: string, rest = "") {
	return new Text(`${theme.fg("toolTitle", theme.bold(name))}${rest ? ` ${rest}` : ""}`, 0, 0);
}

/**
 * Shared system-prompt guidelines for nvim mode. Attached to the always-active
 * nvim_state tool so they land in the built system prompt's Guidelines section
 * (the model otherwise only sees nvim tools as function schemas and defaults
 * to bash for file work).
 */
export const nvimPromptGuidelines = [
	"nvim is connected. All file operations — read, write, edit, grep, find, ls — are forwarded through nvim so you see exactly what the user sees. Prefer the nvim-native tools (nvim_state, nvim_read_buf, nvim_find_replace, nvim_search, nvim_find_files, buffers, and the LSP tools) over bash for reading, searching, and editing files.",
	"bash runs on pi's local executor (not through nvim): it behaves exactly as without nvim — POSIX shell, timeouts, abort, env all work — and it never blocks the editor. Use it freely for builds, tests, and git.",
	"Never launch nvim/vim/vi from bash to open a file — you already control the running nvim instance. Use nvim_read_buf to read a buffer and nvim_find_replace/nvim_exec/nvim_keys to edit it.",
];

// ── nvim_state ──────────────────────────────────────────────────────────────

const nvimStateSchema = Type.Object({
	level: Type.Optional(
		Type.String({
			description:
				"'brief' (default) — cheap every-turn snapshot: mode, cwd, LSP clients, listed+modified buffers, terminals, active + alternate window with context lines and diagnostics. 'full' — every window with folds, visual selection, marks, diagnostics summary, indent.",
		}),
	),
	context_lines: Type.Optional(
		Type.Number({
			description: "Lines of context around the cursor in each window (brief: 5, full: 20).",
		}),
	),
});

function formatStateBrief(s: any): string {
	const lines: string[] = [];
	lines.push(`mode: ${s.mode}  cwd: ${s.cwd}`);
	lines.push(`tab ${s.current_tab}/${s.tab_count}`);
	if (s.modified_buffers?.length) lines.push(`modified: ${s.modified_buffers.join(", ")}`);
	lines.push(`buffers (${s.buffers?.length ?? 0}): ${(s.buffers ?? []).join(", ")}`);
	if (s.lsp_clients?.length) {
		lines.push(`lsp: ${s.lsp_clients.map((c: any) => `${c.name}(${c.filetypes?.join(",") || "?"})`).join(", ")}`);
	} else {
		lines.push("lsp: none (no language server attached)");
	}
	const a = s.active;
	if (a) {
		lines.push(
			`\n[active] ${a.file}:${a.line}:${a.col} (${a.filetype || "?"}, ${a.total_lines} lines${a.modified ? ", modified" : ""}, ${a.buftype})`,
		);
		if (a.context) lines.push(a.context.join("\n"));
		const ad = a.diagnostics;
		if (ad?.length) {
			const sev = (s: number) => ({ 1: "E", 2: "W", 3: "I", 4: "H" })[s] ?? "?";
			lines.push(`diagnostics (${a.diagnostics_total ?? ad.length}):`);
			for (const d of ad) lines.push(`  ${sev(d.severity)} ${d.source}:${d.lnum + 1}:${d.col + 1}  ${d.message}`);
		}
	}
	const alt = s.alternate;
	if (alt) {
		lines.push(
			`\n[alternate] ${alt.file}:${alt.line}:${alt.col} (${alt.filetype || "?"}, ${alt.total_lines} lines${alt.modified ? ", modified" : ""})`,
		);
		if (alt.context) lines.push(alt.context.join("\n"));
		const altd = alt.diagnostics;
		if (altd?.length) {
			const sev = (s: number) => ({ 1: "E", 2: "W", 3: "I", 4: "H" })[s] ?? "?";
			lines.push(`diagnostics (${alt.diagnostics_total ?? altd.length}):`);
			for (const d of altd) lines.push(`  ${sev(d.severity)} ${d.source}:${d.lnum + 1}:${d.col + 1}  ${d.message}`);
		}
	}
	if (s.terminals?.length) {
		lines.push(
			`\nterminals: ${s.terminals.map((t: any) => `${t.buf}(${t.name}${t.visible ? ",visible" : ""})`).join(", ")}`,
		);
	}
	return lines.join("\n");
}

function formatStateFull(s: any): string {
	const lines: string[] = [];
	lines.push(`mode: ${s.mode}  cwd: ${s.cwd}`);
	lines.push(`tab ${s.current_tab}/${s.tab_count}`);
	if (s.modified_buffers?.length) lines.push(`modified: ${s.modified_buffers.join(", ")}`);
	lines.push(`buffers (${s.buffers?.length ?? 0}): ${(s.buffers ?? []).join(", ")}`);
	for (const w of s.windows ?? []) {
		const role = w.role ? `[${w.role}]` : "[window]";
		const sel = w.selection
			? ` sel=${w.selection.start_line}:${w.selection.start_col}-${w.selection.end_line}:${w.selection.end_col}(${w.selection.mode})`
			: "";
		const diag = w.diagnostics_summary
			? ` diag=${w.diagnostics_summary.error}e/${w.diagnostics_summary.warning}w/${w.diagnostics_summary.info}i/${w.diagnostics_summary.hint}h`
			: "";
		const folds = w.folds?.length ? ` folds=${w.folds.length}` : "";
		const marks = w.marks?.length ? ` marks=${w.marks.map((m: any) => m.mark).join("")}` : "";
		lines.push(
			`\n${role} ${w.file}:${w.line}:${w.col} (${w.filetype || "?"}, ${w.total_lines} lines${w.modified ? ", mod" : ""}, ${w.buftype})${sel}${diag}${folds}${marks}`,
		);
		if (w.context) lines.push(w.context.join("\n"));
	}
	if (s.terminals?.length) {
		lines.push(
			`\nterminals: ${s.terminals.map((t: any) => `${t.buf}(${t.name}${t.visible ? ",visible" : ""})`).join(", ")}`,
		);
	}
	return lines.join("\n");
}

export function createNvimStateTool(client: NvimSocketClient): ToolDefinition<typeof nvimStateSchema> {
	return {
		name: "nvim_state",
		label: "nvim state",
		promptSnippet: "Snapshot the whole nvim session: mode, cwd, buffers, LSP clients, diagnostics, windows, cursor",
		promptGuidelines: nvimPromptGuidelines,
		description:
			"Snapshot the whole nvim session: mode, cwd, every open buffer, LSP clients, diagnostics, every window, cursor, folds, visual selection, marks. Use 'brief' (default) for a cheap every-turn view with LSP clients + active-buffer diagnostics; 'full' for every window with folds/marks/diagnostics summary.",
		parameters: nvimStateSchema,
		async execute(_id, args, _signal) {
			const level = args.level === "full" ? "full" : "brief";
			if (level === "full") {
				const s = await client.getStateFull(args.context_lines, args.context_lines);
				if (!s)
					return {
						content: [{ type: "text" as const, text: "No nvim state (disconnected?)" }],
						details: undefined,
					};
				return { content: [{ type: "text" as const, text: formatStateFull(s) }], details: undefined };
			}
			const s = await client.getStateBrief(args.context_lines);
			if (!s)
				return { content: [{ type: "text" as const, text: "No nvim state (disconnected?)" }], details: undefined };
			return { content: [{ type: "text" as const, text: formatStateBrief(s) }], details: undefined };
		},
		renderCall(args, theme) {
			return title(theme, "nvim_state", args.level === "full" ? "full" : "brief");
		},
		renderResult: renderText,
	};
}

// ── nvim_read_buf ────────────────────────────────────────────────────────────

const nvimReadBufSchema = Type.Object({
	path: Type.String({ description: "Buffer name or path (relative to cwd works)." }),
	start_line: Type.Optional(Type.Number({ description: "1-indexed inclusive start line. Defaults to 1." })),
	end_line: Type.Optional(Type.Number({ description: "1-indexed inclusive end line. Defaults to last line." })),
});

export function createNvimReadBufTool(client: NvimSocketClient): ToolDefinition<typeof nvimReadBufSchema> {
	return {
		name: "nvim_read_buf",
		label: "nvim read buf",
		promptSnippet: "Read any nvim buffer (whole or line range) with line numbers",
		description: "Read any nvim buffer (not just the current one), whole or by line range, with line numbers.",
		parameters: nvimReadBufSchema,
		async execute(_id, { path, start_line, end_line }, _signal) {
			const r = await client.readBuffer(path, start_line, end_line);
			if (!r) return { content: [{ type: "text" as const, text: "Buffer read failed." }], details: undefined };
			if (r.error) return { content: [{ type: "text" as const, text: r.error }], details: undefined };
			return {
				content: [{ type: "text" as const, text: `${(r.lines ?? []).join("\n")}\n(${r.total_lines} lines total)` }],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			const range = args.start_line || args.end_line ? `:${args.start_line ?? ""}-${args.end_line ?? ""}` : "";
			return title(theme, "nvim_read_buf", `${args.path ?? ""}${range}`);
		},
		renderResult: renderText,
	};
}

// ── nvim_find_replace ───────────────────────────────────────────────────────

const nvimFindReplaceSchema = Type.Object({
	path: Type.String({ description: "Buffer name or path." }),
	old_string: Type.String({ description: "Exact text to find. Must be unique in the buffer." }),
	new_string: Type.String({ description: "Replacement text." }),
});

export function createNvimFindReplaceTool(client: NvimSocketClient): ToolDefinition<typeof nvimFindReplaceSchema> {
	return {
		name: "nvim_find_replace",
		label: "nvim find replace",
		promptSnippet: "Find-and-replace a unique string in any live nvim buffer",
		description:
			"Find-and-replace an exact, unique string in any nvim buffer (edits the live buffer, not disk). Rejects multi-match — add surrounding context to make old_string unique. Full undo support.",
		parameters: nvimFindReplaceSchema,
		async execute(_id, { path, old_string, new_string }, _signal) {
			const r = await client.findReplaceInBuffer(path, old_string, new_string);
			if (!r) return { content: [{ type: "text" as const, text: "Replace failed." }], details: undefined };
			if (r.error) return { content: [{ type: "text" as const, text: r.error }], details: undefined };
			return {
				content: [
					{
						type: "text" as const,
						text: `Replaced at line ${r.start_line}: removed ${r.lines_removed}, added ${r.lines_added}. Buffer now ${r.total_lines} lines.`,
					},
				],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			return title(theme, "nvim_find_replace", args.path ?? "");
		},
		renderResult: renderText,
	};
}

// ── nvim_keys ──────────────────────────────────────────────────────────────

const nvimKeysSchema = Type.Object({
	keys: Type.String({
		description:
			"Keystrokes to send to nvim. Special keys use <...> notation: <CR>, <Tab>, <Esc>, <C-w>, <M-x>, <Up>, etc. Mappings are triggered. <Esc> is auto-prepended so you never strand in insert mode.",
	}),
});

export function createNvimKeysTool(client: NvimSocketClient): ToolDefinition<typeof nvimKeysSchema> {
	return {
		name: "nvim_keys",
		label: "nvim keys",
		promptSnippet: "Send keystrokes to nvim (cursor, insert mode, mappings)",
		description:
			"Send raw keystrokes to nvim to drive the cursor, enter insert mode, trigger mappings, etc. Escape is auto-prepended. Use for interactive editing; use nvim_find_replace/nvim_exec for precise edits.",
		parameters: nvimKeysSchema,
		async execute(_id, { keys }, _signal) {
			const r = await client.sendKeys(keys);
			return { content: [{ type: "text" as const, text: `sent: ${r.sent}` }], details: undefined };
		},
		renderCall(args, theme) {
			return title(theme, "nvim_keys", args.keys ?? "");
		},
		renderResult: renderText,
	};
}

// ── nvim_terminal_send ──────────────────────────────────────────────────────

const nvimTerminalSendSchema = Type.Object({
	terminal: Type.Optional(
		Type.String({
			description: "Terminal buffer number or name. Omit to auto-select when exactly one terminal exists.",
		}),
	),
	text: Type.String({ description: "Text to send to the terminal's running program (via its job channel)." }),
	submit: Type.Optional(
		Type.Boolean({
			description:
				"If true, append a CR so the program executes the text. If false (default), text sits at the prompt unexecuted.",
		}),
	),
});

export function createNvimTerminalSendTool(client: NvimSocketClient): ToolDefinition<typeof nvimTerminalSendSchema> {
	return {
		name: "nvim_terminal_send",
		label: "nvim terminal send",
		promptSnippet: "Type text into a nvim terminal buffer's running program",
		description:
			"Type text into an existing nvim terminal buffer's running program via its job channel (no focus/mode change). Lets you drive a shell or a sibling agent living in a nvim terminal. submit=true runs it.",
		parameters: nvimTerminalSendSchema,
		async execute(_id, { terminal, text, submit }, _signal) {
			const term = terminal === undefined ? undefined : /^\d+$/.test(terminal) ? Number(terminal) : terminal;
			const r: any = await client.sendToTerminal(term, text, submit ?? false);
			if (r.error) {
				const tail = r.terminals ? `\nTerminals: ${JSON.stringify(r.terminals)}` : "";
				return { content: [{ type: "text" as const, text: r.error + tail }], details: undefined };
			}
			return { content: [{ type: "text" as const, text: `sent: ${r.sent ?? text}` }], details: undefined };
		},
		renderCall(args, theme) {
			return title(theme, "nvim_terminal_send", `${args.terminal ?? "auto"}${args.submit ? " +CR" : ""}`);
		},
		renderResult: renderText,
	};
}

// ── nvim_highlight ──────────────────────────────────────────────────────────

const nvimHighlightSchema = Type.Object({
	path: Type.String({ description: "Buffer name or path." }),
	start_line: Type.Number({ description: "1-indexed inclusive start line." }),
	end_line: Type.Number({ description: "1-indexed inclusive end line." }),
	color: Type.String({ description: "Hex color e.g. '#ff0000', or an existing highlight group name." }),
});

export function createNvimHighlightTool(client: NvimSocketClient): ToolDefinition<typeof nvimHighlightSchema> {
	return {
		name: "nvim_highlight",
		label: "nvim highlight",
		promptSnippet: "Highlight a line range in a buffer (non-destructive extmarks)",
		description:
			"Highlight a line range in a buffer with a color. Uses extmarks under the 'pi_highlight' namespace — never touches real buffer content or disk. Clear with nvim_highlight_clear.",
		parameters: nvimHighlightSchema,
		async execute(_id, { path, start_line, end_line, color }, _signal) {
			await client.highlightRange(path, start_line, end_line, color);
			return {
				content: [{ type: "text" as const, text: `highlighted ${path}:${start_line}-${end_line} (${color})` }],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			return title(theme, "nvim_highlight", `${args.path}:${args.start_line}-${args.end_line} ${args.color ?? ""}`);
		},
		renderResult: renderText,
	};
}

// ── nvim_highlight_clear ────────────────────────────────────────────────────

const nvimHighlightClearSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer to clear. Omit/empty to clear all buffers." })),
});

export function createNvimHighlightClearTool(
	client: NvimSocketClient,
): ToolDefinition<typeof nvimHighlightClearSchema> {
	return {
		name: "nvim_highlight_clear",
		label: "nvim highlight clear",
		promptSnippet: "Clear pi highlights from a buffer (or all buffers)",
		description: "Clear pi highlights from a buffer (or all buffers if path is omitted).",
		parameters: nvimHighlightClearSchema,
		async execute(_id, { path }, _signal) {
			await client.clearHighlights(path ?? "");
			return {
				content: [{ type: "text" as const, text: `cleared highlights${path ? ` in ${path}` : " (all buffers)"}` }],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			return title(theme, "nvim_highlight_clear", args.path ?? "all");
		},
		renderResult: renderText,
	};
}

// ── nvim_virtual_text ───────────────────────────────────────────────────────

const nvimVirtualTextSchema = Type.Object({
	path: Type.String({ description: "Buffer name or path." }),
	line: Type.Number({ description: "1-indexed line to annotate." }),
	text: Type.String({ description: "Annotation text." }),
	position: Type.Optional(Type.String({ description: "'eol' (default), 'above', or 'below'." })),
	color: Type.Optional(Type.String({ description: "Hex color or hl group for the text." })),
});

export function createNvimVirtualTextTool(client: NvimSocketClient): ToolDefinition<typeof nvimVirtualTextSchema> {
	return {
		name: "nvim_virtual_text",
		label: "nvim virtual text",
		promptSnippet: "Attach virtual-text annotations to a buffer line",
		description:
			"Attach a virtual-text annotation to a buffer line (eol/above/below). Visual only — never touches real content or disk. Clear with nvim_virtual_text_clear.",
		parameters: nvimVirtualTextSchema,
		async execute(_id, { path, line, text, position, color }, _signal) {
			await client.addVirtualText(path, line, text, (position as any) ?? "eol", color);
			return {
				content: [{ type: "text" as const, text: `annotated ${path}:${line} (${position ?? "eol"})` }],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			return title(theme, "nvim_virtual_text", `${args.path}:${args.line}`);
		},
		renderResult: renderText,
	};
}

// ── nvim_virtual_text_clear ────────────────────────────────────────────────

const nvimVirtualTextClearSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Buffer to clear. Omit/empty to clear all buffers." })),
});

export function createNvimVirtualTextClearTool(
	client: NvimSocketClient,
): ToolDefinition<typeof nvimVirtualTextClearSchema> {
	return {
		name: "nvim_virtual_text_clear",
		label: "nvim virtual text clear",
		promptSnippet: "Clear pi virtual text from a buffer (or all buffers)",
		description: "Clear pi virtual text from a buffer (or all buffers if path is omitted).",
		parameters: nvimVirtualTextClearSchema,
		async execute(_id, { path }, _signal) {
			await client.clearVirtualText(path ?? "");
			return {
				content: [
					{ type: "text" as const, text: `cleared virtual text${path ? ` in ${path}` : " (all buffers)"}` },
				],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			return title(theme, "nvim_virtual_text_clear", args.path ?? "all");
		},
		renderResult: renderText,
	};
}

// ── aggregate ──────────────────────────────────────────────────────────────

export function createNvimSurfaceToolDefinitions(client: NvimSocketClient): ToolDefinition[] {
	return [
		createNvimStateTool(client),
		createNvimReadBufTool(client),
		createNvimFindReplaceTool(client),
		createNvimKeysTool(client),
		createNvimTerminalSendTool(client),
		createNvimHighlightTool(client),
		createNvimHighlightClearTool(client),
		createNvimVirtualTextTool(client),
		createNvimVirtualTextClearTool(client),
	];
}
