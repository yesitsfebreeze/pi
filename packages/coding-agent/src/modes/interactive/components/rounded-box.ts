import { type Component, visibleWidth } from "@earendil-works/pi-tui";

export type BorderStyle = "light" | "heavy";

interface BorderGlyphs {
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
	const { lines, width, colorFn = (s) => s, leftPad = 0, rightPad = 0, sizeToContent = true } = opts;
	if (lines.length === 0 || width < 3) return [];

	const g = opts.glyphs ?? pickGlyphs("light");
	const avail = width - 2; // space between the two side borders

	// Children (e.g. Text) right-pad their lines to the render width. Strip that
	// padding so the box sizes to the actual content, then re-pad to the box.
	const stripped = lines.map((l) => l.replace(/[ \t]+$/, ""));

	let maxVis = 0;
	for (const line of stripped) maxVis = Math.max(maxVis, visibleWidth(line));

	// inner width (between borders) — sized to content, capped to available.
	const innerWidth = Math.max(1, Math.min(avail, sizeToContent ? maxVis + leftPad + rightPad : avail));
	const padStr = " ".repeat(leftPad);
	const rightPadStr = " ".repeat(rightPad);

	const result: string[] = [];
	result.push(colorFn(g.topLeft + g.top.repeat(innerWidth) + g.topRight));
	for (const line of stripped) {
		const vis = visibleWidth(line);
		const fill = Math.max(0, innerWidth - leftPad - rightPad - vis);
		result.push(colorFn(g.left) + padStr + line + " ".repeat(fill) + rightPadStr + colorFn(g.right));
	}
	result.push(colorFn(g.bottomLeft + g.bottom.repeat(innerWidth) + g.bottomRight));
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
	private glyphs: BorderGlyphs;

	constructor(borderStyle: BorderStyle = "light", colorFn: (text: string) => string = (s) => s) {
		this.colorFn = colorFn;
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
			sizeToContent: true,
		});
	}
}
