import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
	type Component,
	type Focusable,
	flattenWithCollapse,
	getKeybindings,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { live as crewLive, GLYPH } from "../../../core/crew/runner.ts";
import type { CrewRun } from "../../../core/crew/types.ts";
import { type LedgerEntry, loadLedger } from "../../../core/session-ledger.ts";
import { parseSessionEntryLine } from "../../../core/session-manager.ts";
import { theme as appTheme } from "../theme/theme.ts";

/** A flattened, visible row in the session tree. */
interface FlatNode {
	id: string;
	/** Display label (already styled). */
	label: string;
	depth: number;
	hasChildren: boolean;
	collapsed: boolean;
	/** Is this a session (navigable) node vs. a crew (leaf) node? */
	isSession: boolean;
	/** Is this the synthetic "+New session" action row? */
	isNew?: boolean;
	/** Sub-rows (crew runs) — flattened by the shared tree walk. */
	children?: FlatNode[];
	/** Is this the session the host is currently running? Rendered with a marker. */
	isCurrent?: boolean;
	/** Session to switch to when this node is activated. */
	sessionId?: string;
	cwd?: string;
	/** Path to the session file (rename + preview). */
	sessionFile?: string | null;
	// Column data (session nodes only).
	/** Display name: session name > first user message > cwd leaf. */
	colName?: string;
	colAge?: string;
	colCrew?: number;
	/** Last assistant response snippet, for the live preview. */
	lastResponse?: string;
}

const EXPANDED_MARKER = "▾ ";
const COLLAPSED_MARKER = "▸ ";

/** Public snapshot of the currently selected row, for preview/rename wiring. */
export interface SessionTreeNodeInfo {
	id: string;
	isSession: boolean;
	isNew: boolean;
	isCurrent?: boolean;
	sessionId?: string;
	cwd?: string;
	sessionFile?: string | null;
	displayName?: string;
	lastResponse?: string;
}

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
		this.onFocusChange?.(value);
	}

	/** Notifies the host that the context-bar (shortcuts/title) should refresh. */
	onContextUpdate?: () => void;
	/** Notifies the host when the tree gains/loses keyboard focus. */
	onFocusChange?: (focused: boolean) => void;
	/** View title shown in the sticky header and context bar. */
	readonly viewTitle = "Sessions";
	/** Focus-aware, already-styled shortcut hints for the context bar. */
	shortcutsText(): string {
		return this.focused
			? appTheme.fg("muted", "↑↓/jk navigate  r rename  ←/→ fold  ↵ switch  Ctrl+S close")
			: appTheme.fg("muted", "Ctrl+S focus");
	}

	private flatNodes: FlatNode[] = [];
	private selectedIndex = 0;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private requestRender: () => void;
	/** Collapsed state preserved across refreshes: nodeId → collapsed. */
	private collapsed = new Map<string, boolean>();
	/** Session id of the host's currently running session; its row is marked. */
	private currentSessionId: string | null = null;

	/** Set the host's current session id so its row can be marked. */
	setCurrentSessionId(id: string | null): void {
		if (this.currentSessionId === id) return;
		this.currentSessionId = id;
		this.refresh();
	}

	onSelectSession?: (sessionId: string, cwd: string) => void;
	/** Called when the user activates the "+New session" row (Enter or auto-focus). */
	onNewSessionFocus?: () => void;
	onFocusLeave?: () => void;
	/** Called whenever the selected row changes (keyboard nav + refresh). */
	onSelectionChange?: (node: SessionTreeNodeInfo | null) => void;
	/** Called when the user presses the rename key on a selected session. */
	onRename?: (node: SessionTreeNodeInfo) => void;
	/** Called with the selected line index (0-based, incl. header offset) so the host ScrollView can keep it visible. */
	onEnsureVisible?: (line: number) => void;

	/** Cache for brief session info (name, firstMessage), keyed by sessionFile. */
	private briefCache = new Map<
		string,
		{ name?: string; firstMessage?: string; lastResponse?: string; mtimeMs: number }
	>();

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
			this.notifySelectionChange();
			this.maybeAutoFocusNew();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(len - 1, this.selectedIndex + 1);
			this.requestRender();
			this.ensureVisible();
			this.notifySelectionChange();
			this.maybeAutoFocusNew();
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 10);
			this.requestRender();
			this.ensureVisible();
			this.notifySelectionChange();
			this.maybeAutoFocusNew();
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(len - 1, this.selectedIndex + 10);
			this.requestRender();
			this.ensureVisible();
			this.notifySelectionChange();
			this.maybeAutoFocusNew();
			return;
		}
		// r renames the selected session (same as the app.session.rename binding).
		if (data === "r" || data === "R" || kb.matches(data, "app.session.rename")) {
			const fn = this.flatNodes[this.selectedIndex];
			if (fn?.isSession && this.onRename) {
				this.onRename(this.toNodeInfo(fn));
			}
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
			if (fn?.isNew) {
				if (this.onNewSessionFocus) this.onNewSessionFocus();
			} else if (fn?.sessionId && fn.cwd && this.onSelectSession) {
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

	/** Current selected row as a public snapshot (null if nothing selected). */
	getSelectedNode(): SessionTreeNodeInfo | null {
		const fn = this.flatNodes[this.selectedIndex];
		return fn ? this.toNodeInfo(fn) : null;
	}

	private toNodeInfo(fn: FlatNode): SessionTreeNodeInfo {
		return {
			id: fn.id,
			isSession: fn.isSession,
			isNew: !!fn.isNew,
			isCurrent: !!fn.isCurrent,
			sessionId: fn.sessionId,
			cwd: fn.cwd,
			sessionFile: fn.sessionFile,
			displayName: fn.colName,
			lastResponse: fn.lastResponse,
		};
	}

	private notifySelectionChange(): void {
		if (this.onSelectionChange) this.onSelectionChange(this.getSelectedNode());
	}

	private renderTreeBody(width: number): string[] {
		if (this.flatNodes.length === 0) {
			return [this.renderRow(this.newSessionNode(), true, width)];
		}

		const out: string[] = [];
		for (let i = 0; i < this.flatNodes.length; i++) {
			out.push(this.renderRow(this.flatNodes[i], i === this.selectedIndex, width));
		}
		return out;
	}

	/** Render a single row with the shared selection gutter + fold marker + label. */
	private renderRow(fn: FlatNode, isSelected: boolean, width: number): string {
		// Single-cell gutter: the arrow (→) or a blank space is the only base left
		// margin — one cell, exactly the space the arrow needs.
		const gutter = isSelected ? appTheme.fg("accent", "→") : " ";
		// Tree structure: a fold marker for parents with children, indentation for
		// nested crew rows. Leaf rows get no extra padding.
		const treePrefix = fn.hasChildren ? (fn.collapsed ? COLLAPSED_MARKER : EXPANDED_MARKER) : "  ".repeat(fn.depth);
		const body = isSelected ? appTheme.bold(fn.label) : fn.label;
		const line = `${gutter}${treePrefix}${body}`;
		const pad = Math.max(0, width - visibleWidth(line));
		return line + " ".repeat(pad);
	}

	/** The synthetic first row: start a brand-new session from a prompt. */
	private newSessionNode(): FlatNode {
		return {
			id: "new-session",
			label: appTheme.fg("accent", "+New") + appTheme.fg("dim", "  just type to start a new session"),
			depth: 0,
			hasChildren: false,
			collapsed: false,
			isSession: false,
			isNew: true,
		};
	}

	// ── data ──────────────────────────────────────────────────────

	/** Re-read the ledger and rebuild the tree. Public so the host can trigger it
	 *  when the status bar updates, so a newly created session appears without
	 *  waiting for the poll. */
	refresh(): void {
		let entries: LedgerEntry[];
		try {
			entries = loadLedger();
		} catch {
			return;
		}
		const liveSessions = entries.filter((e: LedgerEntry) => !e.endedAt);
		// Hottest first: most recently started at the top, so a freshly created
		// session lands in the first slot instead of the bottom of the list.
		liveSessions.sort((a, b) => {
			const at = Date.parse(a.startedAt);
			const bt = Date.parse(b.startedAt);
			return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
		});
		const liveCrew = crewLive();

		// A crew sub-agent is itself a real pi session, so it also has a ledger
		// entry. Keep it out of the top-level overview and nest it under its
		// parent instead.
		const crewSessionIds = new Set(liveCrew.map((r) => r.sessionId));
		const mainSessions = liveSessions.filter((e) => !crewSessionIds.has(e.sessionId));

		// Nest each crew run under its exact parent session (by parentSessionId).
		// Runs without a recorded parent (e.g. loaded from old meta) fall back to
		// matching by cwd, the previous behaviour.
		const sessionById = new Map(liveSessions.map((e) => [e.sessionId, e] as const));
		const sessionToCrew = new Map<string, CrewRun[]>();
		const assignedCrew = new Set<string>();
		for (const run of liveCrew) {
			let parent = run.parentSessionId ? sessionById.get(run.parentSessionId) : undefined;
			if (!parent) {
				parent = liveSessions.find((e) => e.cwd === run.cwd);
			}
			if (!parent) continue;
			if (!sessionToCrew.has(parent.sessionId)) sessionToCrew.set(parent.sessionId, []);
			sessionToCrew.get(parent.sessionId)!.push(run);
			assignedCrew.add(run.handle);
		}
		const orphanCrew = liveCrew.filter((r) => !assignedCrew.has(r.handle));

		const roots: FlatNode[] = [];
		const prevSelectedId = this.flatNodes[this.selectedIndex]?.id;

		for (const session of mainSessions) {
			const crew = sessionToCrew.get(session.sessionId) || [];
			const cwdBase = session.cwd ? session.cwd.split("/").pop() || session.cwd : "?";
			const brief = this.getSessionBrief(session.sessionFile);
			const displayName = (brief?.name || brief?.firstMessage || cwdBase).trim();
			const age = session.startedAt ? this.fmtAge(Date.parse(session.startedAt)) || "" : "";
			const id = `s-${session.sessionId}`;
			const hasChildren = crew.length > 0;
			const collapsed = hasChildren ? (this.collapsed.get(id) ?? false) : false;
			const isCurrent = this.currentSessionId === session.sessionId;
			roots.push({
				id,
				label: "",
				depth: 0,
				hasChildren,
				collapsed,
				isSession: true,
				isCurrent,
				sessionId: session.sessionId,
				cwd: session.cwd,
				sessionFile: session.sessionFile,
				colName: displayName,
				colAge: age,
				colCrew: crew.length,
				lastResponse: brief?.lastResponse,
				children: crew.map((run) => this.crewNode(run, 1)),
			});
		}

		for (const run of orphanCrew) {
			roots.push(this.crewNode(run, 0));
		}

		this.applyColumnLayout(roots);
		// Shared tree walk (tui TreeList flattenWithCollapse): depth-first, skipping
		// collapsed subtrees — the same mechanics TreeList renders with. Collapse
		// state stays in our own map; the walk's isCollapsed predicate reads it.
		this.flatNodes = [
			this.newSessionNode(),
			...flattenWithCollapse(roots, (id) => this.collapsed.get(id) ?? false).map((f) => f.node),
		];

		// Default selection: the first real session (index 1), or +New if it's the only entry.
		// Preserve previous selection if the same id still exists.
		if (prevSelectedId) {
			const idx = this.flatNodes.findIndex((n) => n.id === prevSelectedId);
			if (idx >= 0) this.selectedIndex = idx;
			else this.selectedIndex = Math.min(1, Math.max(0, this.flatNodes.length - 1));
		} else {
			this.selectedIndex = Math.min(1, Math.max(0, this.flatNodes.length - 1));
		}
		this.notifySelectionChange();
		this.requestRender();
	}

	/** Build column-aligned labels for session nodes after all data is collected. */
	private applyColumnLayout(nodes: FlatNode[]): void {
		let wName = 0;
		let wAge = 0;
		let wCrew = 0;
		for (const fn of nodes) {
			if (!fn.isSession || !fn.colName) continue;
			wName = Math.max(wName, visibleWidth(fn.colName));
			const age = fn.colAge ?? "";
			if (age) wAge = Math.max(wAge, visibleWidth(age));
			if (fn.colCrew && fn.colCrew > 0) {
				wCrew = Math.max(wCrew, visibleWidth(`${fn.colCrew} crew`));
			}
		}

		for (const fn of nodes) {
			if (!fn.isSession || !fn.colName) continue;
			const name = fn.colName.padEnd(wName);
			const age = wAge > 0 ? (fn.colAge ?? "").padEnd(wAge) : "";
			const crew = fn.colCrew && fn.colCrew > 0 && wCrew > 0 ? `${fn.colCrew} crew`.padEnd(wCrew) : "";

			const styled = [appTheme.fg("accent", name), appTheme.fg("dim", age), crew ? appTheme.fg("dim", crew) : ""]
				.filter((c) => c.trim())
				.join("  ");
			// Mark the host's current session with a leading ●; reserve the slot
			// on every row so the name column stays aligned.
			const marker = fn.isCurrent ? appTheme.fg("warning", "●") : " ";
			fn.label = `${marker} ${styled}`;
		}
	}

	/** Read brief display info (name, first message, last response) from a session file with caching. */
	private getSessionBrief(
		sessionFile: string | null,
	): { name?: string; firstMessage?: string; lastResponse?: string } | null {
		if (!sessionFile) return null;
		let s: { mtimeMs: number; size: number };
		try {
			const st = statSync(sessionFile);
			s = { mtimeMs: st.mtimeMs, size: st.size };
		} catch {
			this.briefCache.delete(sessionFile);
			return null;
		}
		const cached = this.briefCache.get(sessionFile);
		if (cached && cached.mtimeMs === s.mtimeMs) {
			return cached;
		}
		// Read the head for the name/first message, and the tail for the last
		// assistant response (for the hover/selection preview) without loading
		// the whole file.
		try {
			const HEAD_BUF = 8 * 1024;
			const TAIL_BUF = 32 * 1024;
			const head = this.readFileChunk(sessionFile, 0, HEAD_BUF);
			const tail = this.readFileChunk(sessionFile, Math.max(0, s.size - TAIL_BUF), TAIL_BUF);
			const info = this.parseSessionBrief(head, tail, s.mtimeMs);
			if (info) this.briefCache.set(sessionFile, info);
			return info;
		} catch {
			this.briefCache.delete(sessionFile);
			return null;
		}
	}

	/** Read up to `length` bytes starting at `offset` from a file. */
	private readFileChunk(path: string, offset: number, length: number): string {
		const fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(length);
		let bytesRead: number;
		try {
			bytesRead = readSync(fd, buffer, 0, length, offset);
		} finally {
			closeSync(fd);
		}
		return buffer.toString("utf8", 0, bytesRead);
	}

	/** Parse name/firstMessage from the head and last assistant response from the tail. */
	private parseSessionBrief(
		head: string,
		tail: string,
		mtimeMs: number,
	): { name?: string; firstMessage?: string; lastResponse?: string; mtimeMs: number } | null {
		let headerSeen = false;
		let name: string | undefined;
		let firstMessage: string | undefined;
		for (const line of head.split("\n")) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;
			if (!headerSeen) {
				if (entry.type !== "session") continue;
				headerSeen = true;
				continue;
			}
			if (entry.type === "session_info" && name === undefined) {
				name = (entry.name as string)?.trim() || undefined;
			}
			if (entry.type === "message" && firstMessage === undefined) {
				const msg = (entry as any).message;
				if (msg?.role === "user") {
					firstMessage = this.extractMessageText(msg.content)?.trim();
				}
			}
			if (name !== undefined && firstMessage !== undefined) break;
		}

		// Tail scan: the most recent session_info name wins (renames append at the
		// end of the file, so the head buffer may not contain the latest name).
		let tailName: string | undefined;
		let lastResponse: string | undefined;
		for (const line of tail.split("\n")) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;
			if (entry.type === "session_info") {
				const n = (entry.name as string)?.trim();
				if (n) tailName = n;
			} else if (entry.type === "message") {
				const msg = (entry as any).message;
				if (msg?.role === "assistant") {
					const text = this.extractMessageText(msg.content)?.trim();
					if (text) lastResponse = text;
				}
			}
		}
		if (tailName !== undefined) name = tailName;

		if (!headerSeen) return null;
		return { name, firstMessage, lastResponse, mtimeMs };
	}

	/** Pull the first text block out of a message content payload. */
	private extractMessageText(content: unknown): string | undefined {
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === "object" && (block as any).type === "text") {
					const text = (block as any).text;
					if (typeof text === "string") return text;
				}
			}
			return undefined;
		}
		return typeof content === "string" ? content : undefined;
	}

	/** If the selected row is the +New entry, auto-focus the editor for typing. */
	private maybeAutoFocusNew(): void {
		const fn = this.flatNodes[this.selectedIndex];
		if (fn?.isNew && this.onNewSessionFocus) {
			this.onNewSessionFocus();
		}
	}

	private crewNode(run: CrewRun, depth: number): FlatNode {
		const glyph = GLYPH[run.state] || "?";
		const taskLine = run.task ? run.task.split("\n")[0].slice(0, 72) : "";
		const taskSuffix = run.task && run.task.length > 72 ? "…" : "";
		const age = this.fmtAge(run.started);
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
			depth,
			hasChildren: false,
			collapsed: false,
			isSession: false,
			sessionId: run.sessionId,
			cwd: run.cwd,
			colName: run.handle,
			lastResponse: run.text || undefined,
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
