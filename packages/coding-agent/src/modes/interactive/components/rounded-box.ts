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

function pickGlyphs(style: BorderStyle): BorderGlyphs {
	if (process.env.NO_COLOR) return ASCII_GLYPHS;
	return GLYPHS[style];
}

/**
 * Rounded border box wrapping a child component.
 * Draws box-drawing border characters (╭─╮ / │ │ / ╰─╯ or heavy ╔═╗ / ║ ║ / ╚═╝)
 * around every line the child renders.
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

		const g = this.glyphs;
		const c = this.colorFn;
		const result: string[] = [];

		// Top border
		result.push(c(g.topLeft + g.top.repeat(innerWidth) + g.topRight));

		// Content lines with left/right borders
		for (const line of childLines) {
			const vis = visibleWidth(line);
			const pad = Math.max(0, innerWidth - vis);
			result.push(c(g.left) + line + " ".repeat(pad) + c(g.right));
		}

		// Bottom border
		result.push(c(g.bottomLeft + g.bottom.repeat(innerWidth) + g.bottomRight));

		return result;
	}
}
