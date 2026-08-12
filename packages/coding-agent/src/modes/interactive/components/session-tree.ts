import {
	type Component,
	type Focusable,
	TreeList,
	type TreeListTheme,
	type TreeNode,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type LedgerEntry, loadLedger } from "../../../core/session-ledger.ts";
import {
	type CrewRun,
	GLYPH,
	live as crewLive,
} from "../../../core/crew/runner.ts";
import { theme as appTheme } from "../theme/theme.ts";

/** Extra data attached to tree nodes for rendering and navigation */
interface SessionTreeNode extends TreeNode {
	sessionId?: string;
	cwd?: string;
	crewHandle?: string;
	status?: string;
	task?: string;
}

/**
 * Live session network tree.
 *
 * Renders a tree of all active pi sessions and their dispatched crew
 * sub-agents. Each node shows status glyphs (▶ running, … queued,
 * ✓ done, ✗ failed, etc.) and the task at hand.
 *
 * Polls the ledger and crew runner every 2s.
 */
export class SessionTreeComponent implements Component, Focusable {
	focused: boolean = false;
	private tree: TreeList;
	private lastRoots: TreeNode[] = [];
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private requestRender: () => void;

	onSelectSession?: (sessionId: string, cwd: string) => void;
	onFocusLeave?: () => void;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
		const treeTheme: Partial<TreeListTheme> = {
			selectedText: (t) => appTheme.bg("selectedBg", t),
			normalText: (t) => t,
			mutedText: (t) => appTheme.fg("muted", t),
		};
		this.tree = new TreeList({ theme: treeTheme });
		this.tree.onRequestRender = this.requestRender;
		this.tree.onSelect = (node) => {
			const sn = node as SessionTreeNode;
			if (sn.sessionId && sn.cwd && this.onSelectSession) {
				this.onSelectSession(sn.sessionId, sn.cwd);
			}
		};
		this.tree.onFocusLeave = () => {
			if (this.onFocusLeave) this.onFocusLeave();
		};
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

	handleInput(data: string): void {
		this.tree.handleInput(data);
	}

	invalidate(): void {
		this.tree.invalidate();
	}

	render(width: number): string[] {
		const treeLines = this.tree.render(width);

		// Header line
		const headerLeft = appTheme.bold(appTheme.fg("accent", " Sessions"));
		const nav = appTheme.fg("muted", "↑↓/jk  ↵switch  ");
		const focusHint = appTheme.fg("dim", "Ctrl+S focus");
		const headerRight = `${nav}${focusHint}`;
		const pad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight));
		const headerLine = `${headerLeft}${" ".repeat(pad)}${headerRight}`;

		return [headerLine, ...treeLines];
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
		const collapsedState = this.captureCollapsed();
		const liveCrew = crewLive();

		// Build a mapping of sessionId → crew runs dispatched by that session
		// Crew runs carry their own sessionId, which differs from the parent's
		// sessionId.  We use a heuristic: a crew run belongs to a parent session
		// if the parent dispatched it (we detect this by checking if the run
		// was started by a live session entry).
		const sessionToCrew = new Map<string, CrewRun[]>();
		const assignedCrew = new Set<string>();

		// Try to match crew runs to parent sessions by checking if any
		// live session's sessionId or crew handle matches.
		for (const session of liveSessions) {
			for (const run of liveCrew) {
				if (assignedCrew.has(run.handle)) continue;
				// A crew run's dir might contain clues, but simplest:
				// match by cwd proximity - a crew run in the same cwd
				// was likely dispatched by a session in that cwd.
				if (run.cwd === session.cwd) {
					if (!sessionToCrew.has(session.sessionId)) {
						sessionToCrew.set(session.sessionId, []);
					}
					sessionToCrew.get(session.sessionId)!.push(run);
					assignedCrew.add(run.handle);
				}
			}
		}

		// Remaining (orphaned) crew runs get shown as top-level nodes
		const orphanCrew = liveCrew.filter((r) => !assignedCrew.has(r.handle));

		const roots: SessionTreeNode[] = [];

		for (const session of liveSessions) {
			const children: SessionTreeNode[] = [];
			const crew = sessionToCrew.get(session.sessionId) || [];

			for (const run of crew) {
				children.push(this.crewNode(run));
			}

			const cwdBase = session.cwd ? session.cwd.split("/").pop() || session.cwd : "?";
			const label = `${cwdBase}`;

			roots.push({
				id: `s-${session.sessionId}`,
				label,
				sessionId: session.sessionId,
				cwd: session.cwd,
				children: children.length > 0 ? children : undefined,
				collapsed: false,
			});
		}

		// Orphaned crew runs as roots
		for (const run of orphanCrew) {
			roots.push(this.crewNode(run));
		}

		this.tree.setRoots(roots, collapsedState);
		this.lastRoots = roots;
		this.tree.invalidate();
	}

	// ── helpers ───────────────────────────────────────────────────

	private crewNode(run: CrewRun): SessionTreeNode {
		const glyph = GLYPH[run.state] || "?";
		const taskLine = run.task ? run.task.split("\n")[0].slice(0, 72) : "";
		const taskSuffix = run.task && run.task.length > 72 ? "…" : "";
		const age = this.fmtAge(run.started);
		const label = `${glyph} ${run.handle}  ${taskLine}${taskSuffix}  ${age}`;
		return {
			id: `crew-${run.handle}`,
			label,
			sessionId: run.sessionId,
			cwd: run.cwd,
			crewHandle: run.handle,
			status: run.state,
			task: taskLine,
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

	private captureCollapsed(): Map<string, boolean> {
		const map = new Map<string, boolean>();
		const walk = (nodes: TreeNode[]) => {
			for (const n of nodes) {
				if (n.children && n.children.length > 0) {
					map.set(n.id, !!n.collapsed);
					walk(n.children);
				}
			}
		};
		walk(this.lastRoots);
		return map;
	}
}
