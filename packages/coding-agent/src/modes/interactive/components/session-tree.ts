import { type Component, type Focusable, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { live as crewLive, GLYPH } from "../../../core/crew/runner.ts";
import type { CrewRun } from "../../../core/crew/types.ts";
import { type LedgerEntry, loadLedger } from "../../../core/session-ledger.ts";
import { theme as appTheme } from "../theme/theme.ts";

/** A flattened, visible row in the session tree. */
interface FlatNode {
	id: string;
	/** Display label (already styled). */
	label: string;
	/** Plain-text label for width math. */
	rawLabel: string;
	depth: number;
	hasChildren: boolean;
	collapsed: boolean;
	/** Is this a session (navigable) node vs. a crew (leaf) node? */
	isSession: boolean;
	/** Session to switch to when this node is activated. */
	sessionId?: string;
	cwd?: string;
}

const EXPANDED_MARKER = "▾ ";
const COLLAPSED_MARKER = "▸ ";
const LEAF_MARKER = "  ";

/**
 * Session-tree menu rendered inside the bottom scroll pane.
 *
 * Renders every live pi session (root) and its dispatched crew sub-agents
 * (children) as a flat list of rows plus a header line. The surrounding
 * ScrollView windows the full content and scrolls it with the mouse wheel;
 * this component always renders its entire content and lets the view handle
 * windowing. Keyboard navigation (↑↓/jk) moves the selection and asks the
 * host ScrollView to keep it visible via {@link SessionTreeComponent.onEnsureVisible}.
 *
 * Polls the session ledger and crew runner every 2s.
 *
 * Navigation: ↑↓/jk move, ↵ switch session, ←/→ collapse/expand,
 * Ctrl+S or Escape returns focus to the editor.
 */
export class SessionTreeComponent implements Component, Focusable {
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		if (this._focused === value) return;
		this._focused = value;
		this.requestRender();
		this.onContextUpdate?.();
	}

	/** Notifies the host that the context-bar (shortcuts/title) should refresh. */
	onContextUpdate?: () => void;
	/** View title shown in the sticky header and context bar. */
	readonly viewTitle = "Sessions";
	/** Focus-aware, already-styled shortcut hints for the context bar. */
	shortcutsText(): string {
		return this.focused
			? appTheme.fg("muted", "↑↓/jk navigate  ←/→ fold  ↵ switch  Ctrl+S close")
			: appTheme.fg("muted", "Ctrl+S focus");
	}

	private flatNodes: FlatNode[] = [];
	private selectedIndex = 0;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private requestRender: () => void;
	/** Collapsed state preserved across refreshes: nodeId → collapsed. */
	private collapsed = new Map<string, boolean>();

	onSelectSession?: (sessionId: string, cwd: string) => void;
	onFocusLeave?: () => void;
	/** Called with the selected line index (0-based, incl. header offset) so the host ScrollView can keep it visible. */
	onEnsureVisible?: (line: number) => void;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	start(): void {
		this.refresh();
		this.pollTimer = setInterval(() => this.refresh(), 2000);
	}

	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	invalidate(): void {
		this.requestRender();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (!kb) return;
		const len = this.flatNodes.length;

		// Ctrl+S or Escape returns focus to the editor.
		if (kb.matches(data, "app.session.focusTree") || kb.matches(data, "tui.select.cancel")) {
			if (this.onFocusLeave) this.onFocusLeave();
			return;
		}
		if (len === 0) return;

		if (kb.matches(data, "tui.select.up") || data === "j" || data === "k") {
			// j = down, k = up (vim-style); arrows handled by keybinding.
			if (data === "k") this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			else if (data === "j") this.selectedIndex = Math.min(len - 1, this.selectedIndex + 1);
			else this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			this.ensureVisible();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(len - 1, this.selectedIndex + 1);
			this.requestRender();
			this.ensureVisible();
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 10);
			this.requestRender();
			this.ensureVisible();
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(len - 1, this.selectedIndex + 10);
			this.requestRender();
			this.ensureVisible();
			return;
		}
		// ← collapses, → expands (toggle either way).
		if (kb.matches(data, "tui.select.collapse") || kb.matches(data, "tui.select.expand")) {
			const fn = this.flatNodes[this.selectedIndex];
			if (fn?.hasChildren) {
				const cur = this.collapsed.get(fn.id) ?? false;
				this.collapsed.set(fn.id, !cur);
				this.refresh();
			}
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const fn = this.flatNodes[this.selectedIndex];
			if (fn && fn.sessionId && fn.cwd && this.onSelectSession) {
				this.onSelectSession(fn.sessionId, fn.cwd);
			}
			return;
		}
	}

	render(width: number): string[] {
		// Header is rendered as a sticky line above the ScrollView by the host,
		// so this component renders the tree body only.
		return this.renderTreeBody(width);
	}

	// ── rendering helpers ─────────────────────────────────────────

	/** Line index of the selected row (0-based; header is no longer in-body). */
	private selectedLine(): number {
		return this.selectedIndex;
	}

	private ensureVisible(): void {
		if (this.onEnsureVisible) this.onEnsureVisible(this.selectedLine());
	}

	private renderTreeBody(width: number): string[] {
		if (this.flatNodes.length === 0) {
			return [appTheme.fg("muted", "  No live sessions")];
		}

		const out: string[] = [];
		for (let i = 0; i < this.flatNodes.length; i++) {
			const fn = this.flatNodes[i];
			const indent = "  ".repeat(fn.depth);
			const marker = fn.hasChildren ? (fn.collapsed ? COLLAPSED_MARKER : EXPANDED_MARKER) : LEAF_MARKER;
			const raw = `${indent}${marker}${fn.rawLabel}`;
			const isSelected = i === this.selectedIndex;
			const styled = isSelected && this.focused ? appTheme.bg("selectedBg", appTheme.bold(raw)) : fn.label;
			const vis = visibleWidth(styled);
			const pad = Math.max(0, width - vis);
			out.push(styled + " ".repeat(pad));
		}
		return out;
	}

	// ── data ──────────────────────────────────────────────────────

	private refresh(): void {
		let entries: LedgerEntry[];
		try {
			entries = loadLedger();
		} catch {
			return;
		}
		const liveSessions = entries.filter((e: LedgerEntry) => !e.endedAt);
		const liveCrew = crewLive();

		// Match crew runs to parent sessions by cwd proximity.
		const sessionToCrew = new Map<string, CrewRun[]>();
		const assignedCrew = new Set<string>();
		for (const session of liveSessions) {
			for (const run of liveCrew) {
				if (assignedCrew.has(run.handle)) continue;
				if (run.cwd === session.cwd) {
					if (!sessionToCrew.has(session.sessionId)) sessionToCrew.set(session.sessionId, []);
					sessionToCrew.get(session.sessionId)!.push(run);
					assignedCrew.add(run.handle);
				}
			}
		}
		const orphanCrew = liveCrew.filter((r) => !assignedCrew.has(r.handle));

		const roots: FlatNode[] = [];
		const prevSelectedId = this.flatNodes[this.selectedIndex]?.id;

		for (const session of liveSessions) {
			const crew = sessionToCrew.get(session.sessionId) || [];
			const cwdBase = session.cwd ? session.cwd.split("/").pop() || session.cwd : "?";
			const meta = this.sessionMeta(session, crew.length);
			const rawLabel = meta ? `${cwdBase}  ${meta}` : cwdBase;
			const id = `s-${session.sessionId}`;
			const hasChildren = crew.length > 0;
			const collapsed = hasChildren ? (this.collapsed.get(id) ?? false) : false;
			roots.push({
				id,
				label: this.styleSession(cwdBase, meta),
				rawLabel,
				depth: 0,
				hasChildren,
				collapsed,
				isSession: true,
				sessionId: session.sessionId,
				cwd: session.cwd,
			});
			if (hasChildren && !collapsed) {
				for (const run of crew) {
					roots.push(this.crewNode(run, 1));
				}
			}
		}

		for (const run of orphanCrew) {
			roots.push(this.crewNode(run, 0));
		}

		this.flatNodes = roots;

		// Preserve selection on the same node if it still exists.
		if (prevSelectedId) {
			const idx = this.flatNodes.findIndex((n) => n.id === prevSelectedId);
			if (idx >= 0) this.selectedIndex = idx;
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.flatNodes.length - 1));
		this.requestRender();
	}

	/** Plain-text meta suffix for width math (mirrors {@link styleSession}). */
	private sessionMeta(session: LedgerEntry, crewCount: number): string {
		const parts: string[] = [];
		const short = this.shortPath(session.cwd);
		if (short) parts.push(short);
		if (session.tty && session.tty !== "?") parts.push(session.tty);
		if (session.startedAt) {
			const age = this.fmtIsoAge(session.startedAt);
			if (age) parts.push(age);
		}
		if (crewCount > 0) parts.push(`${crewCount} crew`);
		return parts.join(" · ");
	}

	private styleSession(label: string, meta: string): string {
		const name = appTheme.fg("accent", label);
		return meta ? `${name}  ${appTheme.fg("dim", meta)}` : name;
	}

	/** Shorten a path for inline display: ~/dev/pi, ~ if home. */
	private shortPath(p: string | undefined): string {
		if (!p) return "";
		const home = process.env.HOME || process.env.USERPROFILE || "";
		if (home && p === home) return "~";
		if (home && p.startsWith(home + "/")) return "~" + p.slice(home.length);
		return p;
	}

	/** Age since an ISO timestamp string. */
	private fmtIsoAge(iso: string): string {
		const t = Date.parse(iso);
		if (Number.isNaN(t)) return "";
		return this.fmtAge(t);
	}

	private crewNode(run: CrewRun, depth: number): FlatNode {
		const glyph = GLYPH[run.state] || "?";
		const taskLine = run.task ? run.task.split("\n")[0].slice(0, 72) : "";
		const taskSuffix = run.task && run.task.length > 72 ? "…" : "";
		const age = this.fmtAge(run.started);
		const rawLabel = `${glyph} ${run.handle}  ${taskLine}${taskSuffix}  ${age}`;
		const isRunning = run.state === "running";
		const styled = isRunning
			? appTheme.fg("success", `${glyph} `) +
				run.handle +
				appTheme.fg("dim", `  ${taskLine}${taskSuffix}`) +
				appTheme.fg("muted", `  ${age}`)
			: appTheme.fg("muted", `${glyph} ${run.handle}  ${taskLine}${taskSuffix}  ${age}`);
		return {
			id: `crew-${run.handle}`,
			label: styled,
			rawLabel,
			depth,
			hasChildren: false,
			collapsed: false,
			isSession: false,
			sessionId: run.sessionId,
			cwd: run.cwd,
		};
	}

	private fmtAge(startedMs: number): string {
		const diffMs = Date.now() - startedMs;
		const s = Math.floor(diffMs / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m`;
		const h = Math.floor(m / 60);
		return `${h}h${m % 60}m`;
	}
}
