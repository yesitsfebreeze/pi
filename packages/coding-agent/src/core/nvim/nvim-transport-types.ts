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

/** Options dictionary. */
export type NvimOptions = Record<string, unknown>;

/** Section of nvim config. */
export type NvimConfigSection = "keymaps" | "options" | "lsp" | "plugins";
