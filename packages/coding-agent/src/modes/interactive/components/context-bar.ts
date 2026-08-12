import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme as appTheme } from "../theme/theme.ts";

/**
 * Thin horizontal rule that separates the editor input from the list pane
 * below it. Renders exactly one line of box-drawing characters across the
 * full width using the theme's `border` color.
 */
export class Separator implements Component {
	private readonly requestRender?: () => void;
	constructor(requestRender?: () => void) {
		this.requestRender = requestRender;
	}

	invalidate(): void {
		this.requestRender?.();
	}

	render(width: number): string[] {
		const w = Math.max(0, width);
		const line = appTheme.fg("border", "─".repeat(w));
		return [line];
	}
}

/**
 * Sticky title line rendered at the top of the bottom list pane. Shows the
 * current view's name (e.g. "Sessions", a menu name, a plugin name) so the
 * user always knows what the pane below the input contains.
 */
export class ViewHeader implements Component {
	private readonly requestRender?: () => void;
	private title = "Sessions";
	constructor(requestRender?: () => void) {
		this.requestRender = requestRender;
	}

	setTitle(title: string): void {
		if (this.title === title) return;
		this.title = title;
		this.requestRender?.();
	}

	invalidate(): void {
		this.requestRender?.();
	}

	render(width: number): string[] {
		const left = appTheme.bold(appTheme.fg("accent", ` ${this.title}`));
		const pad = Math.max(0, width - visibleWidth(left));
		return [left + " ".repeat(pad)];
	}
}

/**
 * Context bar pinned to the very last terminal line. Shows the current view
 * name plus its shortcut hints — a single context line that changes with
 * whatever is displayed in the list pane above it.
 */
export class ContextBar implements Component {
	private readonly requestRender?: () => void;
	private title = "Sessions";
	private shortcuts = "";
	constructor(requestRender?: () => void) {
		this.requestRender = requestRender;
	}

	/** Update the view. `shortcuts` is a pre-rendered (already-styled) string. */
	setView(title: string, shortcuts: string): void {
		let changed = false;
		if (this.title !== title) {
			this.title = title;
			changed = true;
		}
		if (this.shortcuts !== shortcuts) {
			this.shortcuts = shortcuts;
			changed = true;
		}
		if (changed) this.requestRender?.();
	}

	invalidate(): void {
		this.requestRender?.();
	}

	render(width: number): string[] {
		const titlePart = appTheme.fg("accent", this.title);
		const sep = this.shortcuts ? appTheme.fg("muted", "  ") : "";
		const content = titlePart + sep + this.shortcuts;
		const vis = visibleWidth(content);
		const pad = Math.max(0, width - vis);
		return [content + " ".repeat(pad)];
	}
}
