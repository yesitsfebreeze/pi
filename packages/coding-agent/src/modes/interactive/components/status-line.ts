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

// Spinner dot foreground — fixed terminal cyan (deterministic, ANSI-16)
const SPINNER_COLOR = "\x1b[36m";
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
	tokens: "\x1b[40m", // black — quiet counter pill
	cost: "\x1b[47m", // white — quiet cost pill
} as const;

// Extension statuses are secondary: bound each to a short pill so a verbose
// publisher can't blow out the status bar.
const EXT_STATUS_MAX = 24;

// Per-slot backgrounds for extension statuses. Only terminal-native ANSI-16
// colors are used — the same set as the core segments above — assigned by slot
// position so the mapping is deterministic and adjacent slots always differ.
// First slot black, second white, then red/blue, then the always-on core hues.
const EXT_BG = [
	"\x1b[40m", // black
	"\x1b[47m", // white
	"\x1b[41m", // red
	"\x1b[44m", // blue
	"\x1b[45m", // magenta
	"\x1b[43m", // yellow
	"\x1b[42m", // green
	"\x1b[46m", // cyan
] as const;

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
// SGR bg escape → best fg (black or white) by ANSI reference contrast.
// Memoized: the render loop runs at 12.5 Hz over a handful of compile-time
// constant backgrounds, so the contrast math should run once per distinct bg,
// not once per segment per frame.
const FG_FOR_BG = new Map<string, string>();
function bestFg(bgSgr: string): string {
	const cached = FG_FOR_BG.get(bgSgr);
	if (cached !== undefined) return cached;
	const m = bgSgr.match(/\x1b\[4(\d)m/);
	const idx = m ? +m[1] : 0;
	const [r, g, b] = ANSI_REF[idx] ?? [0, 0, 0];
	const bgL = srgbLuminance(r, g, b);
	const blackR = contrastRatio(bgL, srgbLuminance(0, 0, 0));
	const whiteR = contrastRatio(bgL, srgbLuminance(229, 229, 229));
	const fg = blackR >= whiteR ? FG_BLACK : FG_WHITE;
	FG_FOR_BG.set(bgSgr, fg);
	return fg;
}

function styled(bgAnsi: string, text: string): string {
	// The padded pill is the tight primitive with auto-picked fg + one space of padding.
	return styledTight(bgAnsi, ` ${text} `, bestFg(bgAnsi));
}

/**
 * Pick the background for the next pill. The invariant the whole layout keeps
 * is: two pills that meet — side by side on a line or across a wrap — never
 * share a background. So the next pill draws from the palette minus the
 * previous pill's color. Sections may *prefer* a semantic color (version
 * magenta, git green, overload red, …); the preference is honored unless it
 * would collide with the previous pill.
 */
function pickBg(prevIdx: number, preferred?: (typeof EXT_BG)[number]): number {
	const prefIdx = preferred ? EXT_BG.indexOf(preferred) : -1;
	if (prefIdx >= 0 && prefIdx !== prevIdx) return prefIdx;
	return (prevIdx + 1) % EXT_BG.length;
}

function formatHHMM(ms: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

function formatUptime(seconds: number): string {
	const s = Math.floor(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h${m}m`;
	if (m > 0) return `${m}m${sec}s`;
	return `${sec}s`;
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
	/** True while pi is paired with a running nvim instance (socket connected). */
	nvimConnected: boolean;
	/** Status slots published by extensions via ctx.ui.setStatus(), in registration order. */
	extensionStatuses?: readonly string[];
	now: number;
};

/**
 * Statusline rendered above the input line: a left-aligned flow of background
 * pills. All sections float left; when the next pill would overflow the line
 * it wraps to a new line, also flowing left to right. Adjacent pills always
 * have different backgrounds. Accepts a data factory to pull live state on
 * every render.
 */
export class StatusLineComponent implements Component {
	private readonly getData: () => StatusLineData;
	private spinnerFrame = 0;
	private spinnerInterval: NodeJS.Timeout | null = null;
	private readonly ui: TUI;

	constructor(getData: () => StatusLineData, ui: TUI) {
		this.getData = getData;
		this.ui = ui;
	}

	startSpinner(): void {
		this.spinnerFrame = 0;
		this.restartInterval();
	}

	stopSpinner(): void {
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
			const plain = [d.nvimConnected ? "nvim" : "", loader, d.cwd, d.gitStatus?.branch].filter(Boolean).join(" ");
			return [truncateToWidth(plain, width, "")];
		}

		// Build the pill sequence, left to right. Every pill gets a background;
		// each one differs from the pill before it (pickBg), so pills that meet
		// — on the same line or across a wrap — never share a background.
		const pills: { text: string; width: number }[] = [];
		let prevBg = -1;
		const push = (text: string, preferred?: (typeof EXT_BG)[number]) => {
			const idx = pickBg(prevBg, preferred);
			prevBg = idx;
			const s = styled(EXT_BG[idx], text);
			pills.push({ text: s, width: visibleWidth(s) });
		};

		// nvim flag — a plain "nvim" pill in front of the version while paired.
		if (d.nvimConnected) push("nvim");

		// Version segment — first item, "!" prefix when update available
		const versionLabel = d.updateAvailable ? `! pi v${d.version}` : `pi v${d.version}`;
		push(versionLabel, d.updateAvailable ? BG.versionUpdate : BG.version);

		// CWD segment
		if (d.cwd) push(d.cwd, BG.cwd);

		// Git status segment: branch + ahead/behind + changes/deletions
		if (d.gitStatus) {
			const g = d.gitStatus;
			const parts: string[] = [g.branch];
			if (g.ahead > 0) parts.push(`\u2191${g.ahead}`);
			if (g.behind > 0) parts.push(`\u2193${g.behind}`);
			if (g.added > 0) parts.push(`+${g.added}`);
			if (g.deleted > 0) parts.push(`-${g.deleted}`);
			// Clock and uptime
			parts.push(`${formatHHMM(d.now)} UP ${formatUptime(process.uptime())}`);
			push(parts.join(" "), BG.git);
		}

		// Extension statuses render as short background pills (the status bar only
		// carries brief, global state — no plain-text chatter, no long sentences).
		const extSlots = d.extensionStatuses ?? [];
		for (const text of extSlots) {
			if (text) {
				// truncateToWidth injects a reset at the ellipsis; strip it so the
				// truncated pill keeps its background through the "…".
				const truncated = truncateToWidth(text, EXT_STATUS_MAX, "…").replace(/\x1b\[0m/g, "");
				push(truncated);
			}
		}

		if (d.contextWindow > 0) {
			const pct = d.contextPercent !== null ? `${d.contextPercent.toFixed(1)}%` : "?";
			const auto = d.autoCompact ? " auto" : "";
			const overloaded = (d.contextPercent ?? 0) > 70;
			push(`${pct}${auto}`, overloaded ? BG.ctxOver : BG.ctx);
		}

		const tokParts: string[] = [];
		if (d.inputTokens > 0) tokParts.push(`\u2191${formatTokens(d.inputTokens)}`);
		if (d.outputTokens > 0) tokParts.push(`\u2193${formatTokens(d.outputTokens)}`);
		if (tokParts.length > 0) push(tokParts.join(" "), BG.tokens);

		if (d.sessionCost > 0) push(`$${d.sessionCost.toFixed(2)}`, BG.cost);

		// Greedy left-to-right flow: each line starts at column 0; when the next
		// pill would overflow, wrap to a new line. The spinner leads the first
		// line only — it is the one non-backgrounded element (activity cursor).
		const lines: string[] = [];
		const spinner = d.working
			? `${SPINNER_COLOR}${SAND_FRAMES[this.spinnerFrame]}${RESET}`
			: `${SPINNER_COLOR}${IDLE_DOT}${RESET}`;
		let line = spinner;
		let lineWidth = visibleWidth(spinner);
		for (const pill of pills) {
			if (lineWidth + pill.width > width && lineWidth > 0) {
				lines.push(line);
				line = "";
				lineWidth = 0;
			}
			line += pill.text;
			lineWidth += pill.width;
		}
		lines.push(line);

		// A single over-long pill still gets clipped to the terminal width.
		return lines.map((l) => truncateToWidth(l, width, ""));
	}
}
