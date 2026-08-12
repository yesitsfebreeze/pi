import { type Component, type Focusable, matchesKey } from "@earendil-works/pi-tui";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { theme } from "../theme/theme.ts";

/**
 * nvim pairing panel rendered in place of the session tree (below the input
 * line) while `/nvim` waits for the nvim server socket to appear.
 *
 * The socket path is derived from the current pi session id, so it is stable
 * for the life of the session: run `/nvim` once to print the command, start
 * the server in nvim, and every later `/nvim` reconnects to the same socket.
 *
 * Keys: `C` copies the Ex command without the leading `:` so it can be pasted
 * into nvim's command line; `Esc` cancels and restores the session tree.
 */
export class NvimPairPanel implements Component, Focusable {
	private _focused = false;
	private socketPath: string;
	/** Ex command with leading `:` (for display). */
	private displayCommand: string;
	/** Ex command without leading `:` (for clipboard). */
	private copyCommand: string;
	private requestRender: () => void;
	private onDone: () => void;
	private copied = false;
	private copiedTimer: ReturnType<typeof setTimeout> | null = null;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		if (this._focused === value) return;
		this._focused = value;
		this.requestRender();
	}

	constructor(opts: {
		socketPath: string;
		requestRender: () => void;
		onDone: () => void;
	}) {
		this.socketPath = opts.socketPath;
		this.requestRender = opts.requestRender;
		this.onDone = opts.onDone;
		this.copyCommand = `lua vim.fn.serverstart('${this.socketPath}')`;
		this.displayCommand = `:${this.copyCommand}`;
	}

	dispose(): void {
		if (this.copiedTimer) {
			clearTimeout(this.copiedTimer);
			this.copiedTimer = null;
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onDone();
			return;
		}
		if (data === "c" || data === "C") {
			this.copied = true;
			this.requestRender();
			copyToClipboard(this.copyCommand).catch(() => {});
			if (this.copiedTimer) clearTimeout(this.copiedTimer);
			this.copiedTimer = setTimeout(() => {
				this.copied = false;
				this.requestRender();
			}, 2000);
			return;
		}
	}

	render(_width: number): string[] {
		const indent = "  ";
		const lines: string[] = [];

		lines.push(theme.bold(theme.fg("accent", "Pair with nvim")));
		lines.push("");
		lines.push(theme.fg("muted", `Socket: ${this.socketPath}`));
		lines.push("");
		lines.push("Run this Ex command in nvim:");
		lines.push(theme.fg("accent", `${indent}${this.displayCommand}`));
		lines.push("");
		const hint = this.copied
			? theme.fg("accent", 'Copied! In nvim: type : then paste (Cmd-V / "+p)')
			: theme.fg("muted", "Press C to copy command (without :) · Esc to cancel");
		lines.push(hint);
		lines.push("");
		lines.push(theme.fg("dim", "Waiting for connection..."));

		return lines;
	}

	invalidate(): void {
		/* stateless render */
	}
}
