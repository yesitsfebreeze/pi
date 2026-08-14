/**
 * Embedded terminal — hosts the external editor (nvim/vim/nano/…) in a fixed
 * region of the pi TUI instead of taking over the whole screen.
 *
 * This wires two existing libraries together rather than reimplementing a
 * terminal: `@lydell/node-pty` allocates a real PTY (so the editor believes it
 * owns a terminal, loads the user's full config, and gets raw input), and
 * `@xterm/headless` parses the editor's escape output into a cell buffer that
 * we paint line-by-line into the TUI region.
 *
 * Lifecycle: constructor writes the message content to a temp file, spawns the
 * editor in the PTY, and streams output through the xterm buffer. When the
 * editor exits, the file is read back and `onExit` reports the result.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, CURSOR_MARKER } from "@earendil-works/pi-tui";
import type { IPty } from "@lydell/node-pty";
import type { IBuffer, IBufferCell, Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";

const XtermTerminal = xterm.Terminal;

type NodePtySpawn = (file: string, args: string[] | string, options: Record<string, unknown>) => IPty;

/**
 * Load node-pty lazily so a missing native addon (e.g. in a standalone binary
 * build) degrades to the fullscreen editor fallback instead of crashing module
 * load. Throws if the package cannot be loaded.
 */
function loadNodePtySpawn(): NodePtySpawn {
	const require = createRequire(import.meta.url);
	const nodePty = require("@lydell/node-pty") as { spawn: NodePtySpawn };
	return nodePty.spawn;
}

/** xterm.js Attributes color-mode bits (see Attributes.CM_*). */
const CM_P16 = 0x01000000;
const CM_P256 = 0x02000000;
const CM_RGB = 0x03000000;

export type EmbeddedEditorResult = { status: "complete"; content: string } | { status: "failed" };

export interface EmbeddedTerminalOptions {
	/** Editor command line, e.g. "nvim", "vim", "nano", "nvim -u NONE". */
	command: string;
	/** Initial message content written to the scratch file. */
	content: string;
	/** Working directory for the editor process. */
	cwd: string;
	requestRender: () => void;
	/** Called once, after the editor exits, with the edited content. */
	onExit: (result: EmbeddedEditorResult) => void;
	/** Hex color used for cells with the terminal-default foreground (e.g. "#d8d8e0"). */
	defaultFg?: string;
	/** Hex color used for cells with the terminal-default background (e.g. "#18181e"). */
	defaultBg?: string;
}

interface Rgb {
	r: number;
	g: number;
	b: number;
}

function parseHex(hex: string | undefined): Rgb | undefined {
	if (!hex) return undefined;
	const cleaned = hex.replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return undefined;
	return {
		r: parseInt(cleaned.slice(0, 2), 16),
		g: parseInt(cleaned.slice(2, 4), 16),
		b: parseInt(cleaned.slice(4, 6), 16),
	};
}

function rgbColor(color: number, base: 38 | 48): string {
	return `${base};2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}`;
}

/** OSC 11 (background color) report, so nvim/vim's `&background` detection matches pi. */
function osc11Report(rgb: Rgb): string {
	const hex = (v: number) => (v * 257).toString(16).padStart(4, "0");
	return `\x1b]11;rgb:${hex(rgb.r)}/${hex(rgb.g)}/${hex(rgb.b)}\x07`;
}

/** Editors that run inside a terminal and can therefore be embedded. */
const TERMINAL_EDITORS = new Set([
	"nvim",
	"vim",
	"vi",
	"nano",
	"pico",
	"emacs",
	"hx",
	"helix",
	"micro",
	"kak",
	"kakoune",
	"ne",
	"mg",
	"joe",
]);

/**
 * True if the editor command runs in a terminal (so it can be embedded in the
 * lower half). GUI editors (code, notepad, …) are handled by the fullscreen
 * external-editor path instead.
 */
export function isTerminalEditorCommand(command: string): boolean {
	const first = command.trim().split(/\s+/)[0] ?? "";
	const base = first.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	return TERMINAL_EDITORS.has(base);
}

export class EmbeddedTerminal implements Component {
	focused = false;
	/** The editor owns all keystrokes, including viewport scroll keys. */
	capturesAllInput = true;

	private readonly term: XtermTerminalType;
	private readonly pty: IPty;
	private readonly tempDir: string;
	private readonly filePath: string;
	private readonly defaultFgRgb: Rgb | undefined;
	private readonly defaultBgRgb: Rgb | undefined;
	private readonly options: EmbeddedTerminalOptions;
	private cols: number;
	private rows: number;
	private exited = false;

	constructor(options: EmbeddedTerminalOptions) {
		this.options = options;
		this.cols = 80;
		this.rows = 24;
		this.defaultFgRgb = parseHex(options.defaultFg);
		this.defaultBgRgb = parseHex(options.defaultBg);

		this.tempDir = mkdtempSync(join(tmpdir(), "pi-editor-"));
		this.filePath = join(this.tempDir, "prompt.md");
		writeFileSync(this.filePath, options.content, "utf8");

		this.term = new XtermTerminal({ cols: this.cols, rows: this.rows, allowProposedApi: true, scrollback: 0 });

		const [program, ...args] = options.command.trim().split(/\s+/);
		const spawn = loadNodePtySpawn();
		this.pty = spawn(program ?? "", [...args, this.filePath], {
			name: "xterm-256color",
			cols: this.cols,
			rows: this.rows,
			cwd: options.cwd,
			// COLORTERM=truecolor makes nvim/vim enable termguicolors without a
			// full terminal capability handshake (we have no real tty to answer
			// the DA1/OSC11 queries the editor sends).
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
		});

		this.pty.onData((data) => this.onPtyData(data));
		this.pty.onExit(() => this.handleExit());
	}

	private onPtyData(data: string): void {
		if (this.exited) return;
		// Answer the background-color query so the editor's dark/light detection
		// agrees with pi's terminal instead of guessing.
		if (this.defaultBgRgb && data.includes("\x1b]11;?")) {
			try {
				this.pty.write(osc11Report(this.defaultBgRgb));
			} catch {
				// Best effort — the editor proceeds without the answer.
			}
		}
		this.term.write(data);
		this.options.requestRender();
	}

	private handleExit(): void {
		if (this.exited) return;
		this.exited = true;
		let result: EmbeddedEditorResult;
		try {
			result = { status: "complete", content: readFileSync(this.filePath, "utf8").replace(/\n$/, "") };
		} catch {
			result = { status: "failed" };
		}
		this.cleanup();
		this.options.onExit(result);
	}

	private cleanup(): void {
		try {
			rmSync(this.tempDir, { recursive: true, force: true });
		} catch {
			// Best effort.
		}
		try {
			this.term.dispose();
		} catch {
			// Best effort.
		}
	}

	renderSized(width: number, height: number): string[] {
		if (width !== this.cols || height !== this.rows) {
			this.cols = width;
			this.rows = height;
			try {
				this.term.resize(width, height);
				this.pty.resize(width, height);
			} catch {
				// Resize races with shutdown; ignore.
			}
		}
		return this.renderBuffer(width, height);
	}

	render(width: number): string[] {
		return this.renderBuffer(width, this.rows);
	}

	handleInput(data: string): void {
		if (this.exited) return;
		try {
			this.pty.write(data);
		} catch {
			// PTY closed; the exit handler will fire shortly.
		}
	}

	invalidate(): void {}

	/** Kill the editor without reading back content (used when pi is shutting down). */
	dispose(): void {
		if (this.exited) return;
		this.exited = true;
		try {
			this.pty.kill();
		} catch {
			// Best effort.
		}
		this.cleanup();
	}

	private renderBuffer(width: number, height: number): string[] {
		const buffer = this.term.buffer.active;
		const baseY = buffer.viewportY;
		const lines: string[] = [];
		for (let y = 0; y < height; y++) {
			lines.push(this.renderLine(buffer, baseY + y, y, width));
		}
		return lines;
	}

	private renderLine(buffer: IBuffer, lineIndex: number, viewRow: number, width: number): string {
		const line = buffer.getLine(lineIndex);
		if (!line) return "";

		const cursorRow = buffer.cursorY - buffer.viewportY;
		const isCursorLine = this.focused && cursorRow === viewRow;
		const cursorCol = buffer.cursorX;

		let out = "";
		let currentSgr = "";
		for (let x = 0; x < width; x++) {
			const cell = line.getCell(x);
			// Skip continuation cells of wide chars (width 0); paint everything else
			// (a space when empty) so the cell's background fills the row.
			if (!cell || cell.getWidth() === 0) continue;
			const text = cell.getChars() || " ";
			const sgr = this.cellSgr(cell);
			if (isCursorLine && x === cursorCol) {
				out += `${sgr}${CURSOR_MARKER}\x1b[7m${text}\x1b[27m`;
				currentSgr = sgr;
			} else {
				if (sgr !== currentSgr) {
					out += sgr;
					currentSgr = sgr;
				}
				out += text;
			}
		}
		return out;
	}

	private cellSgr(cell: IBufferCell): string {
		const parts: string[] = [];

		const fgMode = cell.getFgColorMode();
		const fg = cell.getFgColor();
		if (fgMode === CM_RGB) parts.push(rgbColor(fg, 38));
		else if (fgMode === CM_P256 || fgMode === CM_P16) parts.push(`38;5;${fg}`);
		else if (this.defaultFgRgb)
			parts.push(`38;2;${this.defaultFgRgb.r};${this.defaultFgRgb.g};${this.defaultFgRgb.b}`);

		const bgMode = cell.getBgColorMode();
		const bg = cell.getBgColor();
		if (bgMode === CM_RGB) parts.push(rgbColor(bg, 48));
		else if (bgMode === CM_P256 || bgMode === CM_P16) parts.push(`48;5;${bg}`);
		else if (this.defaultBgRgb)
			parts.push(`48;2;${this.defaultBgRgb.r};${this.defaultBgRgb.g};${this.defaultBgRgb.b}`);

		if (cell.isBold()) parts.push("1");
		if (cell.isItalic()) parts.push("3");
		if (cell.isUnderline()) parts.push("4");
		if (cell.isStrikethrough()) parts.push("9");
		if (cell.isInverse()) parts.push("7");

		return parts.length > 0 ? `\x1b[${parts.join(";")}m` : "";
	}
}
