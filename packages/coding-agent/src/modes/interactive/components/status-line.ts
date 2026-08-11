import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "./footer.ts";

// ── NuShell-style segment colours ─────────────────────────────────────────
const BG_CWD = "\x1b[48;5;33m"; // blue
const BG_GIT = "\x1b[48;5;63m"; // purple
const BG_MODEL = "\x1b[48;5;35m"; // green
const BG_CONTEXT = "\x1b[48;5;240m"; // dark grey
const BG_TOKENS = "\x1b[48;5;240m"; // dark grey
const BG_COST = "\x1b[48;5;36m"; // teal
const FG_LIGHT = "\x1b[37m"; // bright white
const RESET = "\x1b[0m";

export type StatusLineData = {
	cwd: string;
	gitBranch?: string;
	modelName: string;
	contextPercent: number | null;
	contextWindow: number;
	inputTokens: number;
	outputTokens: number;
	sessionCost: number;
	autoCompact: boolean;
};

/**
 * NuShell-style statusline rendered above the input line.
 * Accepts a data factory to pull live state on every render.
 */
export class StatusLineComponent implements Component {
	private readonly getData: () => StatusLineData;

	constructor(getData: () => StatusLineData) {
		this.getData = getData;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const d = this.getData();
		const segments: string[] = [];

		// CWD segment
		if (d.cwd) {
			segments.push(`${BG_CWD}${FG_LIGHT} ${d.cwd} ${RESET}`);
		}

		// Git branch segment
		if (d.gitBranch) {
			const chev = segments.length > 0 ? `${BG_CWD}${BG_GIT}\ue0b2${RESET}` : "";
			segments.push(`${chev}${BG_GIT}${FG_LIGHT} ${d.gitBranch} ${RESET}`);
		}

		// Model segment
		if (d.modelName) {
			const prevBg = segments.length > 0 ? (d.gitBranch ? BG_GIT : BG_CWD) : "";
			const chev = prevBg ? `${prevBg}${BG_MODEL}\ue0b2${RESET}` : "";
			segments.push(`${chev}${BG_MODEL}${FG_LIGHT} ${d.modelName} ${RESET}`);
		}

		// Right-side segments: context, tokens, cost
		const rightSegments: string[] = [];

		if (d.contextWindow > 0) {
			const pct = d.contextPercent !== null ? `${d.contextPercent.toFixed(1)}%` : "?";
			const auto = d.autoCompact ? " auto" : "";
			const contextBg =
				(d.contextPercent ?? 0) > 90
					? "\x1b[48;5;196m"
					: (d.contextPercent ?? 0) > 70
						? "\x1b[48;5;220m"
						: BG_CONTEXT;
			rightSegments.push(`${contextBg}${FG_LIGHT} ${pct}${auto} ${RESET}`);
		}

		const tokParts: string[] = [];
		if (d.inputTokens > 0) tokParts.push(`↑${formatTokens(d.inputTokens)}`);
		if (d.outputTokens > 0) tokParts.push(`↓${formatTokens(d.outputTokens)}`);
		if (tokParts.length > 0) {
			rightSegments.push(`${BG_TOKENS}${FG_LIGHT} ${tokParts.join(" ")} ${RESET}`);
		}

		if (d.sessionCost > 0) {
			rightSegments.push(`${BG_COST}${FG_LIGHT} $${d.sessionCost.toFixed(2)} ${RESET}`);
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
