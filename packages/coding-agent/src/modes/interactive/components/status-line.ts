import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "./footer.ts";

// sand from cli-spinners — braille dot animation, 35 frames at 80ms
// https://github.com/sindresorhus/cli-spinners
const SAND_FRAMES = [
	"⠁",
	"⠂",
	"⠄",
	"⡀",
	"⡈",
	"⡐",
	"⡠",
	"⣀",
	"⣁",
	"⣂",
	"⣄",
	"⣌",
	"⣔",
	"⣤",
	"⣥",
	"⣦",
	"⣮",
	"⣶",
	"⣷",
	"⣿",
	"⡿",
	"⠿",
	"⢟",
	"⠟",
	"⡛",
	"⠛",
	"⠫",
	"⢋",
	"⠋",
	"⠍",
	"⡉",
	"⠉",
	"⠑",
	"⠡",
	"⢁",
] as const;
const SPINNER_INTERVAL_MS = 80;

// Foreground palette for the spinner dot — picked randomly once per session
const DOT_PALETTE = ["\x1b[31m", "\x1b[32m", "\x1b[33m", "\x1b[34m", "\x1b[35m", "\x1b[36m"] as const;
// Static dot shown when the agent is idle (all 8 braille dots filled)
const IDLE_DOT = "⣿";

// ── Statusline — backgrounds with dynamic contrast foreground ──
// Use standard ANSI SGR so the terminal theme remaps them.
// Foreground (black 30 or white 37) is picked per segment at render time
// by WCAG contrast ratio against the ANSI reference palette RGB.
const BG = {
	version: "\x1b[45m", // magenta
	versionUpdate: "\x1b[44m", // blue  (update available = urgent call to action)
	cwd: "\x1b[43m", // yellow
	git: "\x1b[42m", // green
	ctx: "\x1b[46m", // cyan
	ctxOver: "\x1b[41m", // red
} as const;

// ANSI 16-color reference RGB values (indices 0-7)
const ANSI_REF: Record<number, [number, number, number]> = {
	0: [0, 0, 0],
	1: [205, 0, 0],
	2: [0, 205, 0],
	3: [205, 205, 0],
	4: [0, 0, 238],
	5: [205, 0, 205],
	6: [0, 205, 205],
	7: [229, 229, 229],
};
const FG_BLACK = "\x1b[30m";
const FG_WHITE = "\x1b[37m";
const RESET = "\x1b[0m";

function srgbLuminance(r: number, g: number, b: number): number {
	const c = [r, g, b].map((v) => {
		v /= 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrastRatio(L1: number, L2: number): number {
	return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}
// SGR bg escape → best fg (black or white) by ANSI reference contrast
function bestFg(bgSgr: string): string {
	const m = bgSgr.match(/\x1b\[4(\d)m/);
	const idx = m ? +m[1] : 0;
	const [r, g, b] = ANSI_REF[idx] ?? [0, 0, 0];
	const bgL = srgbLuminance(r, g, b);
	const blackR = contrastRatio(bgL, srgbLuminance(0, 0, 0));
	const whiteR = contrastRatio(bgL, srgbLuminance(229, 229, 229));
	return blackR >= whiteR ? FG_BLACK : FG_WHITE;
}

function styled(bgAnsi: string, text: string, forceFg?: string): string {
	return `${bgAnsi}${forceFg ?? bestFg(bgAnsi)} ${text} ${RESET}`;
}
function styledTight(bgAnsi: string, text: string, fg: string): string {
	return `${bgAnsi}${fg}${text}${RESET}`;
}

export type GitStatus = {
	branch: string;
	ahead: number;
	behind: number;
	added: number;
	deleted: number;
};

export type StatusLineData = {
	version: string;
	updateAvailable: boolean;
	cwd: string;
	gitStatus?: GitStatus;
	contextPercent: number | null;
	contextWindow: number;
	inputTokens: number;
	outputTokens: number;
	sessionCost: number;
	autoCompact: boolean;
	working: boolean;
};

/**
 * NuShell-style statusline rendered above the input line.
 * Accepts a data factory to pull live state on every render.
 */
export class StatusLineComponent implements Component {
	private readonly getData: () => StatusLineData;
	private spinnerFrame = 0;
	private spinning = false;
	private spinnerInterval: NodeJS.Timeout | null = null;
	private readonly spinnerColor: string;
	private readonly ui: TUI;

	constructor(getData: () => StatusLineData, ui: TUI) {
		this.getData = getData;
		this.ui = ui;
		this.spinnerColor = DOT_PALETTE[Math.floor(Math.random() * DOT_PALETTE.length)];
	}

	startSpinner(): void {
		this.spinning = true;
		this.spinnerFrame = 0;
		this.restartInterval();
	}

	stopSpinner(): void {
		this.spinning = false;
		this.spinnerFrame = 0;
		if (this.spinnerInterval) {
			clearInterval(this.spinnerInterval);
			this.spinnerInterval = null;
		}
	}

	dispose(): void {
		this.stopSpinner();
	}

	private restartInterval(): void {
		if (this.spinnerInterval) {
			clearInterval(this.spinnerInterval);
		}
		this.spinnerInterval = setInterval(() => {
			this.spinnerFrame = (this.spinnerFrame + 1) % SAND_FRAMES.length;
			this.ui.requestRender();
		}, SPINNER_INTERVAL_MS);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const d = this.getData();
		if (process.env.NO_COLOR) {
			const loader = d.working ? "..." : "";
			const plain = [loader, d.cwd, d.gitStatus?.branch].filter(Boolean).join(" ");
			return [truncateToWidth(plain, width, "")];
		}
		const segments: string[] = [];

		// Spinner dot — no background, coloured randomly once per session
		if (d.working) {
			segments.push(`${this.spinnerColor}${SAND_FRAMES[this.spinnerFrame]}${RESET}`);
		} else {
			segments.push(`${this.spinnerColor}${IDLE_DOT}${RESET}`);
		}

		// Version segment — first item, "!" prefix when update available
		const versionLabel = d.updateAvailable ? `! pi v${d.version}` : `pi v${d.version}`;
		segments.push(styled(d.updateAvailable ? BG.versionUpdate : BG.version, versionLabel));

		// CWD segment
		if (d.cwd) {
			segments.push(styled(BG.cwd, d.cwd));
		}

		// Git status segment: branch + ahead/behind + changes/deletions
		if (d.gitStatus) {
			const g = d.gitStatus;
			const parts: string[] = [g.branch];
			if (g.ahead > 0) parts.push(`\u2191${g.ahead}`);
			if (g.behind > 0) parts.push(`\u2193${g.behind}`);
			if (g.added > 0) parts.push(`+${g.added}`);
			if (g.deleted > 0) parts.push(`-${g.deleted}`);
			segments.push(styled(BG.git, parts.join(" ")));
		}

		// Right-side segments: context, tokens, cost
		const rightSegments: string[] = [];

		if (d.contextWindow > 0) {
			const pct = d.contextPercent !== null ? `${d.contextPercent.toFixed(1)}%` : "?";
			const auto = d.autoCompact ? " auto" : "";
			const overloaded = (d.contextPercent ?? 0) > 70;
			const bg = overloaded ? BG.ctxOver : BG.ctx;
			rightSegments.push(styled(bg, `${pct}${auto}`));
		}

		const tokParts: string[] = [];
		if (d.inputTokens > 0) tokParts.push(`\u2191${formatTokens(d.inputTokens)}`);
		if (d.outputTokens > 0) tokParts.push(`\u2193${formatTokens(d.outputTokens)}`);
		if (tokParts.length > 0) {
			rightSegments.push(` ${tokParts.join(" ")} `);
		}

		if (d.sessionCost > 0) {
			rightSegments.push(` $${d.sessionCost.toFixed(2)} `);
		}

		let line = segments.join("");
		const leftWidth = visibleWidth(line);

		if (rightSegments.length > 0) {
			const rightStr = rightSegments.join("");
			const rightWidth = visibleWidth(rightStr);
			if (leftWidth + rightWidth <= width) {
				const pad = width - leftWidth - rightWidth;
				line += " ".repeat(pad) + rightStr;
			} else if (leftWidth < width) {
				const available = width - leftWidth;
				const truncated = truncateToWidth(rightStr, available, "");
				line += " ".repeat(Math.max(0, available - visibleWidth(truncated))) + truncated;
			}
		}

		return [truncateToWidth(line, width, "")];
	}
}
