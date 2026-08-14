/**
 * RecapComponent — pinned three-line status overlay shown at the very top of
 * the TUI (above the scrolling transcript), summarizing what the agent is
 * doing at a glance:
 *
 *   MISSION: the user's overall goal for the session (the big picture)
 *   TASK:    the specific thing the agent is working on right now
 *   NEXT:    the immediate next step the agent plans
 *
 * The agent emits `<recap>…</recap>` blocks (see the system-prompt instruction
 * in system-prompt.ts); InteractiveMode parses them and calls setRecap().
 *
 * Lines longer than the viewport scroll left-to-right as a marquee, repeating
 * the content with a `  ─────  ` separator so the whole line stays readable
 * without wrapping. Lines that fit are shown as-is. The marquee only ticks
 * while at least one line overflows, so short recaps cost nothing.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "./theme/theme.ts";

/** Parsed recap. */
export interface Recap {
	mission: string;
	task: string;
	next: string;
}

const SCROLL_SEP = "  ─────  ";
const SCROLL_TICK_MS = 280;
const SCROLL_STEP = 1;

const LABELS: ReadonlyArray<{ key: keyof Recap; color: ThemeColor }> = [
	{ key: "mission", color: "accent" },
	{ key: "task", color: "text" },
	{ key: "next", color: "muted" },
];

/** Strip ANSI escape codes — used for scroll width math on plain content. */
function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Build the visible window for one marquee line.
 * `content` is plain (unstyled) text. Returns a plain substring of width <= maxWidth.
 * If the line fits, returns it unchanged.
 */
function marqueeWindow(content: string, maxWidth: number, offset: number): string {
	const len = visibleWidth(content);
	if (len <= maxWidth) return content;

	const period = content + SCROLL_SEP;
	const periodLen = period.length;
	const safeOffset = ((offset % periodLen) + periodLen) % periodLen;
	// Repeat the period enough to cover the window from any offset.
	const repeats = Math.ceil((maxWidth + periodLen) / periodLen) + 1;
	const buffer = period.repeat(repeats);
	const window = buffer.slice(safeOffset, safeOffset + maxWidth);
	// Pad to maxWidth in case slicing underflowed (e.g. surrogate boundaries).
	if (window.length < maxWidth) return window + " ".repeat(maxWidth - window.length);
	return window;
}

/**
 * Parse a `<recap>…</recap>` block out of assistant text.
 * Returns null if absent or any of MISSION/TASK/NEXT is missing.
 */
const FIELD_RE = /^(MISSION|TASK|NEXT):\s*(.*)$/;
export function parseRecap(text: string): Recap | null {
	const parsed = parseRecapPartial(text);
	if (!parsed) return null;
	if (parsed.mission === undefined || parsed.task === undefined || parsed.next === undefined) return null;
	return { mission: parsed.mission, task: parsed.task, next: parsed.next };
}

/**
 * Parse a `<recap>…</recap>` block and return whichever of MISSION/TASK/NEXT
 * are present (undefined for the rest). Returns null only when no block exists.
 * Used to merge a partial update into the last known recap so a block that only
 * refreshes TASK/NEXT still advances the display instead of being discarded.
 */
export function parseRecapPartial(text: string): Partial<Recap> | null {
	const match = text.match(/<recap>\s*([\s\S]*?)<\/recap>/);
	if (!match) return null;
	const body = match[1];
	const fields: Partial<Recap> = {};
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		const fm = trimmed.match(FIELD_RE);
		if (!fm) continue;
		const key = fm[1].toLowerCase() as keyof Recap;
		fields[key] = fm[2].trim();
	}
	// No fields parsed at all → treat as absent.
	if (fields.mission === undefined && fields.task === undefined && fields.next === undefined) return null;
	return fields;
}

const OPEN_TAG = "<recap>";
const CLOSE_TAG = "</recap>";

/**
 * Strip a trailing partial `<recap>` opening tag (token-split streaming).
 * The recap is always the last thing in the message, so a trailing fragment of
 * its opening tag ("<rec", "<recap", …) cannot be legitimate visible content.
 * Only fragments of length >= 2 are stripped — a bare "<" at end of stream is
 * far more likely to be ordinary mid-sentence content and is left alone.
 */
function stripTrailingPartialOpenTag(markdown: string): string {
	for (let len = OPEN_TAG.length - 1; len >= 2; len--) {
		if (markdown.endsWith(OPEN_TAG.slice(0, len))) {
			return markdown.slice(0, -len);
		}
	}
	return markdown;
}

/**
 * Strip `<recap>…</recap>` blocks from text (used as a markdown transformer).
 *
 * Handles the streaming case: while the model is still emitting a recap block
 * (opening `<recap>` present but no closing `</recap>` yet), truncate everything
 * from `<recap>` onward. The recap is always the LAST thing in the message, so
 * nothing after the opening tag is user-visible content. Without this, the
 * partial `<recap>` tag and its half-written fields would flash through to the
 * user on every render until the closing tag arrives.
 */
export function stripRecapBlock(markdown: string): string {
	// Strip a trailing partial opening tag first, so a split stream token can't
	// flash a fragment of the tag itself (e.g. "<rec") before the rest lands.
	markdown = stripTrailingPartialOpenTag(markdown);

	const openIdx = markdown.indexOf(OPEN_TAG);
	if (openIdx === -1) return markdown.trim();

	const closeIdx = markdown.indexOf(CLOSE_TAG, openIdx);
	if (closeIdx === -1) {
		// Streaming: block not yet closed — drop everything from <recap> on.
		return markdown.substring(0, openIdx).trim();
	}

	// Closed block(s) present — strip them all, preserving text in between.
	return markdown.replace(/<recap>[\s\S]*?<\/recap>\s*/g, "").trim();
}

export interface RecapComponentOptions {
	/** Called whenever the marquee ticks, to trigger a TUI re-render. */
	requestRender: () => void;
	theme: Theme;
}

export class RecapComponent {
	private theme: Theme;
	private requestRender: () => void;
	private recap: Partial<Recap> | null = null;
	private offset = 0;
	private longLine = false;
	private interval: ReturnType<typeof setInterval> | null = null;

	constructor(options: RecapComponentOptions) {
		this.theme = options.theme;
		this.requestRender = options.requestRender;
		this.interval = setInterval(() => {
			if (!this.longLine) return;
			this.offset += SCROLL_STEP;
			this.requestRender();
		}, SCROLL_TICK_MS);
	}

	setRecap(recap: Recap | null): void {
		this.recap = recap;
		this.offset = 0;
		this.requestRender();
	}

	/**
	 * Merge a (possibly partial) recap parsed from assistant text into the
	 * last known recap. Fields present in `partial` overwrite the current
	 * value; fields absent are kept from the existing recap. When nothing is
	 * known yet and `partial` is incomplete, the missing fields stay as the
	 * ellipsis fallback (undefined). No-op when `partial` is null.
	 */
	mergeRecap(partial: Partial<Recap> | null): void {
		if (!partial) return;
		const cur = this.recap;
		this.recap = {
			mission: partial.mission ?? cur?.mission,
			task: partial.task ?? cur?.task,
			next: partial.next ?? cur?.next,
		};
		this.offset = 0;
		this.requestRender();
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
		this.requestRender();
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	render(width: number): string[] {
		// Nothing known yet → render nothing, not even the separator line.
		const recap = this.recap;
		if (!recap || (!recap.mission && !recap.task && !recap.next)) return [];
		// Reserve 1 cell of left indent for readability.
		const inner = Math.max(1, width - 1);
		this.longLine = false;
		const out: string[] = [];
		for (const { key, color } of LABELS) {
			const value = recap[key];
			const display = value ? `${key.toUpperCase()}: ${value}` : `${key.toUpperCase()}: …`;
			const plain = stripAnsi(display);
			if (visibleWidth(plain) > inner) {
				this.longLine = true;
				const window = marqueeWindow(plain, inner, this.offset);
				out.push(` ${this.theme.fg(color, window)}`);
			} else {
				out.push(` ${this.theme.fg(color, plain)}`);
			}
		}
		// Separator below the MISSION/TASK/NEXT lines, mirroring the input
		// separator at the bottom of the TUI. Rendered here (instead of as a
		// sibling component) so it disappears with the recap lines when there
		// is no recap yet.
		out.push(this.theme.fg("border", "─".repeat(Math.max(0, width))));
		// Reset the marquee when nothing needs to scroll, so a newly-long
		// line starts from the beginning rather than mid-scroll.
		if (!this.longLine) this.offset = 0;
		return out;
	}

	invalidate(): void {
		// No cached render state — render is computed fresh each frame.
	}
}
