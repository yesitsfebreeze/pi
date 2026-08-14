import { type Component, visibleWidth } from "@earendil-works/pi-tui";

export type BorderStyle = "light" | "heavy";

export interface BorderGlyphs {
	topLeft: string;
	top: string;
	topRight: string;
	left: string;
	right: string;
	bottomLeft: string;
	bottom: string;
	bottomRight: string;
}

const GLYPHS: Record<BorderStyle, BorderGlyphs> = {
	light: {
		topLeft: "╭",
		top: "─",
		topRight: "╮",
		left: "│",
		right: "│",
		bottomLeft: "╰",
		bottom: "─",
		bottomRight: "╯",
	},
	heavy: {
		topLeft: "┏",
		top: "━",
		topRight: "┓",
		left: "┃",
		right: "┃",
		bottomLeft: "┗",
		bottom: "━",
		bottomRight: "┛",
	},
};

/** ASCII fallback when NO_COLOR is set. */
const ASCII_GLYPHS: BorderGlyphs = {
	topLeft: "+",
	top: "-",
	topRight: "+",
	left: "|",
	right: "|",
	bottomLeft: "+",
	bottom: "-",
	bottomRight: "+",
};

export function pickGlyphs(style: BorderStyle): BorderGlyphs {
	if (process.env.NO_COLOR) return ASCII_GLYPHS;
	return GLYPHS[style];
}

export interface RenderRoundedBoxOptions {
	/** Already-rendered content lines (no borders). */
	lines: string[];
	/** Available width from the parent. */
	width: number;
	glyphs?: BorderGlyphs;
	/** Applied to border glyphs only; content lines keep their own styling. */
	colorFn?: (text: string) => string;
	/**
	 * Applied to every box row (border + interior), filling the whole
	 * rectangle behind the box. Use to give a box a background. The bg is
	 * opened at the start of each row and reset at the end, so every emitted
	 * line ends with the bg reset sequence. Default: no background.
	 */
	bgFn?: (text: string) => string;
	/** Inner left padding in cells (default 0). */
	leftPad?: number;
	/** Inner right padding in cells (default 0). */
	rightPad?: number;
	/**
	 * Size the box to the widest content line instead of always stretching to
	 * the full available width. The box never exceeds `width`. Default: true.
	 */
	sizeToContent?: boolean;
}

/**
 * Shared rounded-border renderer — the single authoritative way to draw a
 * bordered box around pre-rendered content lines.
 *
 * The box inner width is `max(contentWidth + leftPad)`, capped at `width - 2`,
 * so short content yields a narrow box and long/wrapped content still fills
 * the available width.
 */
export function renderRoundedBox(opts: RenderRoundedBoxOptions): string[] {
	const { lines, width, colorFn = (s) => s, bgFn, leftPad = 0, rightPad = 0, sizeToContent = true } = opts;
	if (lines.length === 0 || width < 3) return [];

	const g = opts.glyphs ?? pickGlyphs("light");
	const avail = width - 2; // space between the two side borders

	// Strip all leading/trailing whitespace so the box owns padding uniformly.
	const stripped = lines.map((l) => l.trim());

	let maxVis = 0;
	for (const line of stripped) maxVis = Math.max(maxVis, visibleWidth(line));

	// inner width (between borders) — sized to content, capped to available.
	const innerWidth = Math.max(1, Math.min(avail, sizeToContent ? maxVis + leftPad + rightPad : avail));
	const padStr = " ".repeat(leftPad);
	const rightPadStr = " ".repeat(rightPad);

	// Wrap a fully-colored row in the background fill, if any. The bg wraps the
	// entire row (border + interior) so the whole rectangle is filled and every
	// emitted line ends with the bg reset.
	const fill = bgFn ? (s: string) => bgFn(s) : (s: string) => s;

	const result: string[] = [];
	result.push(fill(colorFn(g.topLeft + g.top.repeat(innerWidth) + g.topRight)));
	for (const line of stripped) {
		const vis = visibleWidth(line);
		const blank = Math.max(0, innerWidth - leftPad - rightPad - vis);
		result.push(fill(colorFn(g.left) + padStr + line + " ".repeat(blank) + rightPadStr + colorFn(g.right)));
	}
	result.push(fill(colorFn(g.bottomLeft + g.bottom.repeat(innerWidth) + g.bottomRight)));
	return result;
}

/**
 * Rounded border box wrapping child components.
 * Draws box-drawing border characters (╭─╮ / │ │ / ╰─╯ or heavy ┏━┓ / ┃ ┃ / ┗━┛)
 * around every line the children render, sized to the widest content line.
 */
export class RoundedBox implements Component {
	children: Component[] = [];
	private colorFn: (text: string) => string;
	private bgFn: ((text: string) => string) | undefined;
	private glyphs: BorderGlyphs;
	/** Inner gutter (cells) between the side borders and content. */
	protected leftPad = 0;
	protected rightPad = 0;

	constructor(
		borderStyle: BorderStyle = "light",
		colorFn: (text: string) => string = (s) => s,
		bgFn?: (text: string) => string,
	) {
		this.colorFn = colorFn;
		this.bgFn = bgFn;
		this.glyphs = pickGlyphs(borderStyle);
	}

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const idx = this.children.indexOf(component);
		if (idx !== -1) this.children.splice(idx, 1);
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate?.();
	}

	render(width: number): string[] {
		if (this.children.length === 0) return [];

		const innerWidth = Math.max(1, width - 2);
		const childLines: string[] = [];
		for (const child of this.children) {
			childLines.push(...child.render(innerWidth));
		}
		if (childLines.length === 0) return [];

		return renderRoundedBox({
			lines: childLines,
			width,
			glyphs: this.glyphs,
			colorFn: this.colorFn,
			bgFn: this.bgFn,
			leftPad: this.leftPad,
			rightPad: this.rightPad,
			sizeToContent: true,
		});
	}
}
