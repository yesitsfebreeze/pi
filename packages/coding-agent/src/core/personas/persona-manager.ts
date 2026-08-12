/**
 * PersonaManager — manages the active persona for a session.
 *
 * Handles persona loading, switching, system prompt injection, status bar,
 * and the /persona command (including the TUI picker).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.ts";
import type { Persona } from "./persona-loader.ts";
import { loadPersonas, sortPersonas } from "./persona-loader.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_ID = "substrate";
const OVERRIDE_FILE = ".pi/persona.md";
const STATUS_KEY = "persona";

// ---------------------------------------------------------------------------
// PersonaManager
// ---------------------------------------------------------------------------
export class PersonaManager {
	private _selectedId: string = DEFAULT_ID;
	private _cwd: string;
	private _searchDirs: string[];
	private _personas: Persona[] = [];

	constructor(cwd: string, extraDirs: string[] = []) {
		this._cwd = cwd;
		this._searchDirs = [builtinPersonasDir(), ...extraDirs];
		this._reload();
	}

	/** Reload personas from all search directories. */
	private _reload(): void {
		this._personas = sortPersonas(loadPersonas(this._searchDirs));
	}

	/** The currently selected persona id. */
	get selectedId(): string {
		return this._selectedId;
	}

	/** All available personas, sorted. */
	get personas(): Persona[] {
		return this._personas;
	}

	/** Get a persona by id. */
	getPersona(id: string): Persona | undefined {
		return this._personas.find((p) => p.id === id);
	}

	/** The active persona object (or undefined if none loaded). */
	get active(): Persona | undefined {
		return this.getPersona(this._selectedId);
	}

	/**
	 * The full injected persona text: active persona body plus any repo
	 * override (.pi/persona.md), separated by ---.
	 */
	getInjectText(): string {
		const base = this.active?.body;
		if (!base) return "";
		const bodyOnly = base.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
		const override = this._repoOverride();
		if (override) {
			return `${bodyOnly}\n\n---\n\n${override}`;
		}
		return bodyOnly;
	}

	/** Read repo-level persona override from .pi/persona.md. */
	private _repoOverride(): string | null {
		try {
			const text = readFileSync(join(this._cwd, OVERRIDE_FILE), "utf8").trim();
			return text || null;
		} catch {
			return null;
		}
	}

	/** Build the auto-injected context block for the system prompt. */
	buildInjectedBlock(): string {
		const text = this.getInjectText();
		if (!text) return "";
		return [
			"<auto-injected-context>",
			"# Active persona — internalize this; do not narrate it",
			"",
			text,
			"# End persona",
			"</auto-injected-context>",
		].join("\n");
	}

	/** Status bar text. */
	statusText(): string {
		const p = this.active;
		if (!p) return "";
		const parts = [p.name, p.profession].filter(Boolean);
		const label = parts.join(" · ");
		const tail = this._selectedId !== DEFAULT_ID ? ` · ${this._selectedId}` : "";
		return `persona: ${label}${tail}`;
	}

	/** Switch to a persona by id. Returns false if not found. */
	switchTo(id: string): boolean {
		if (!this.getPersona(id)) return false;
		this._selectedId = id;
		return true;
	}

	/** Reset to default (substrate). */
	reset(): void {
		this._selectedId = DEFAULT_ID;
	}

	/**
	 * Register the /persona slash command and TUI picker.
	 */
	register(pi: ExtensionAPI): void {
		const self = this;
		pi.registerCommand("persona", {
			description: "Select a persona (dropdown), or switch directly: /persona [status|<id>]",
			async handler(args, ctx) {
				const action = args.trim();
				if (!action) {
					await self._pickPersona(ctx);
					return;
				}
				if (action === "status") {
					const p = self.active;
					if (p) {
						ctx.ui.notify(`persona: ${p.name} · ${p.profession} · ${self._selectedId}`, "info");
					} else {
						ctx.ui.notify("no persona active", "warning");
					}
					return;
				}
				// /persona <id> — switch directly
				if (self.switchTo(action)) {
					const p = self.active!;
					ctx.ui.notify(`persona: ${p.name} · ${p.profession}`, "info");
					self._updateStatusBar(ctx);
				} else {
					const ids = self._personas.map((p) => p.id).join(", ");
					ctx.ui.notify(`unknown persona "${action}". Available: ${ids}`, "warning");
				}
			},
		});
	}

	/** Update the status bar with current persona. */
	private _updateStatusBar(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, this.statusText());
	}

	/** Set the status bar at session start. */
	setStatusBar(ctx: ExtensionContext): void {
		this._updateStatusBar(ctx);
	}

	/** Clear status bar. */
	clearStatusBar(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	// ------------------------------------------------------------------
	// TUI picker
	// ------------------------------------------------------------------
	private async _pickPersona(ctx: ExtensionContext): Promise<void> {
		const personas = this._personas;
		if (personas.length === 0) {
			ctx.ui.notify("no personas found", "warning");
			return;
		}
		if (ctx.mode !== "tui") {
			const ids = personas.map((p) => p.id).join(", ");
			ctx.ui.notify(`/persona <id> — available: ${ids}`, "info");
			return;
		}

		const startIdx = Math.max(
			0,
			personas.findIndex((p) => p.id === this._selectedId),
		);
		let sel = startIdx;
		let cache: string[] | undefined;

		const chosen = await ctx.ui.custom<Persona | null>((tui, theme, keybindings, done) => {
			const render = (width: number): string[] => {
				if (cache) return cache;
				const cols = process.stdout?.columns ?? 80;
				const w = Math.max(30, Math.min(width, cols));
				const out: string[] = [];
				const put = (prefix: string, text: string) => {
					const vw = (s: string) => [...s].length;
					const pw = vw(prefix);
					let line = prefix;
					for (const ch of [...text]) {
						if (vw(line + ch) > w - 1) {
							out.push(line);
							line = " ".repeat(pw);
						}
						line += ch;
					}
					if (line.trim()) out.push(line);
				};
				out.push(theme.fg("dim", "─".repeat(w)));
				put(" ", theme.bold(theme.fg("accent", "select a persona")));
				out.push("");
				for (let i = 0; i < personas.length; i++) {
					const p = personas[i];
					const on = i === sel;
					const mark = p.id === this._selectedId ? theme.fg("success", "●") : theme.fg("dim", "○");
					const title = `${mark} ${theme.fg(on ? "accent" : "text", p.name)}`;
					put(on ? theme.fg("accent", "> ") : "  ", title);
					if (p.profession) {
						put("      ", theme.fg("muted", p.profession));
					}
					if (on && p.description) {
						put("      ", theme.fg("dim", p.description));
					}
				}
				out.push("");
				put(" ", theme.fg("dim", "↑↓ move · enter select · esc cancel"));
				out.push(theme.fg("dim", "─".repeat(w)));
				cache = out;
				return out;
			};

			const handleInput = (data: string) => {
				if (matchesKey(data, Key.up)) {
					sel = Math.max(0, sel - 1);
					cache = undefined;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					sel = Math.min(personas.length - 1, sel + 1);
					cache = undefined;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					done(personas[sel]);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(null);
				}
			};

			return {
				render,
				invalidate: () => {
					cache = undefined;
				},
				handleInput,
			};
		});

		if (!chosen || chosen.id === this._selectedId) return;
		this._selectedId = chosen.id;
		this._updateStatusBar(ctx);
		ctx.ui.notify(`persona: ${chosen.name} · ${chosen.profession}`, "info");
	}
}

// ---------------------------------------------------------------------------
// Built-in persona directory (shipped with the package)
// ---------------------------------------------------------------------------
function builtinPersonasDir(): string {
	return join(import.meta.dirname, "personas");
}
