// Transport-level types shared across the nvim integration.
// These represent the shape of data flowing over the JSON-RPC socket.

/** A raw nvim buffer descriptor from the plugin. */
export interface NvimBuffer {
	bufnr: number;
	name: string;
	loaded: boolean;
	modified: boolean;
	filetype: string;
}

/** Full buffer state including content. */
export interface NvimBufferState {
	path: string;
	content: string;
	cursor: [number, number]; // 0-indexed [line, col]
	selection?: {
		start: [number, number];
		end: [number, number];
	};
	modified: boolean;
	filetype: string;
}

/** LSP diagnostic entry. */
export interface NvimDiagnostic {
	bufnr: number;
	lnum: number; // 0-indexed
	col: number; // 0-indexed
	end_lnum?: number;
	end_col?: number;
	severity: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
	message: string;
	source: string;
}

/** LSP location (used for references and definitions). */
export interface NvimLspLocation {
	uri: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

/** Buffer edit operation. */
export interface NvimBufferEdit {
	startLine: number; // 0-indexed, inclusive
	endLine: number; // 0-indexed, exclusive
	newLines: string[];
}

/** Keymap descriptor. */
export interface NvimKeymap {
	lhs: string;
	rhs: string;
	mode: string;
	desc?: string;
}

/** LSP server descriptor. */
export interface NvimLspServer {
	name: string;
	root_dir: string;
	capabilities: string[];
}

/** One attached LSP client (brief form). */
export interface NvimLspClient {
	name: string;
	root_dir: string;
	filetypes: string[];
}

/** One LSP diagnostic entry (brief form). */
export interface NvimBriefDiagnostic {
	lnum: number; // 0-indexed
	col: number; // 0-indexed
	severity: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
	source: string;
	message: string;
}

/** Options dictionary. */
export type NvimOptions = Record<string, unknown>;

/** Section of nvim config. */
export type NvimConfigSection = "keymaps" | "options" | "lsp" | "plugins";

// ── Surface snapshot (whole-session state) ─────────────────────────────────

/** One window in a full surface snapshot. */
export interface NvimWindowInfo {
	file: string;
	filetype: string;
	total_lines: number;
	modified: boolean;
	buftype: string;
	role?: "active" | "alternate";
	line: number;
	col: number;
	context?: string[];
	selection?: {
		start_line: number;
		start_col: number;
		end_line: number;
		end_col: number;
		mode: string;
	};
	folds?: Array<[number, number]>;
	diagnostics_summary?: { error: number; warning: number; info: number; hint: number };
	marks?: Array<{ mark: string; line: number; col: number }>;
	indent?: { expandtab: boolean; shiftwidth: number; tabstop: number };
}

/** Lightweight snapshot: cheap enough to pull every turn. */
export interface NvimStateBrief {
	mode: string;
	cwd: string;
	modified_buffers: string[];
	buffers: string[];
	current_tab: number;
	tab_count: number;
	active: {
		file: string;
		filetype: string;
		total_lines: number;
		modified: boolean;
		buftype: string;
		line: number;
		col: number;
		context?: string[];
		diagnostics?: NvimBriefDiagnostic[];
		diagnostics_total?: number;
	};
	alternate: Omit<NvimStateBrief["active"], never> | null;
	lsp_clients?: NvimLspClient[];
	terminals?: Array<{ buf: number; name: string; visible: boolean }>;
}

/** Full snapshot: every window with folds, selection, marks, diagnostics. */
export interface NvimStateFull extends Omit<NvimStateBrief, "active" | "alternate"> {
	windows: NvimWindowInfo[];
}

/** Result of reading a buffer (whole or range). */
export interface NvimBufferRead {
	lines: string[];
	total_lines: number;
	error?: string;
}

/** Result of a find-and-replace in a buffer. */
export interface NvimFindReplaceResult {
	start_line: number;
	lines_removed: number;
	lines_added: number;
	total_lines: number;
	error?: string;
}
