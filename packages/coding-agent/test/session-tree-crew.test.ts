import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrewRun } from "../src/core/crew/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type LedgerEntry, loadLedger } from "../src/core/session-ledger.ts";
import { SessionTreeComponent } from "../src/modes/interactive/components/session-tree.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// The session-tree component imports `live` + `GLYPH` from crew/runner. We mock
// that module so the tree never touches real crew state, and we expose a
// setter so each test can drive the crew population. Both the mock fn and the
// GLYPH literal must be hoisted (vi.mock factories run before top-level
// declarations).
const { crewLiveMock, GLYPH } = vi.hoisted(() => {
	const crewLiveMock = vi.fn<() => CrewRun[]>(() => []);
	const GLYPH = {
		queued: "…",
		running: "▶",
		done: "✓",
		failed: "✗",
		stopped: "■",
		timeout: "⏱",
		interrupted: "↺",
	};
	return { crewLiveMock, GLYPH };
});
vi.mock("../src/core/crew/runner.ts", () => ({
	live: () => crewLiveMock(),
	GLYPH,
}));

vi.mock("../src/core/session-ledger.ts", () => ({
	loadLedger: vi.fn(() => []),
}));

function makeEntry(overrides: Partial<LedgerEntry> & { sessionId: string }): LedgerEntry {
	return {
		sessionId: overrides.sessionId,
		sessionFile: overrides.sessionFile ?? null,
		cwd: overrides.cwd ?? "/tmp/proj",
		pid: overrides.pid ?? 1,
		tty: overrides.tty ?? "pts/0",
		startedAt: overrides.startedAt ?? new Date().toISOString(),
		endedAt: overrides.endedAt ?? null,
		lastReason: overrides.lastReason ?? "startup",
	};
}

function makeRun(overrides: Partial<CrewRun> & { handle: string }): CrewRun {
	return {
		handle: overrides.handle,
		agent: overrides.agent ?? "worker",
		task: overrides.task ?? "do the thing",
		cwd: overrides.cwd ?? "/tmp/proj",
		sessionId: overrides.sessionId ?? `crew-${overrides.handle}-abc`,
		state: overrides.state ?? "running",
		resumes: 0,
		started: overrides.started ?? Date.now(),
		tools: 0,
		turns: 0,
		text: overrides.text ?? "",
		stderr: "",
		dir: "/tmp/crew",
		depth: 1,
		parentSessionId: overrides.parentSessionId,
	};
}

describe("SessionTreeComponent — crew nesting & current-session marker", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		crewLiveMock.mockReturnValue([]);
	});

	afterEach(() => {
		vi.mocked(loadLedger).mockReset();
		crewLiveMock.mockReset();
	});

	it("marks exactly the host's current session row with the ● marker", () => {
		// "host" has the newest startedAt so it sorts to the top (index 1) and is
		// the default selection; "other" is older and lands below it.
		const newer = new Date().toISOString();
		const older = new Date(Date.now() - 60_000).toISOString();
		vi.mocked(loadLedger).mockReturnValue([
			makeEntry({ sessionId: "host", cwd: "/tmp/host", startedAt: newer }),
			makeEntry({ sessionId: "other", cwd: "/tmp/other", startedAt: older }),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.setCurrentSessionId("host");
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		// +New at line 0; "host" (hottest) at line 1; "other" at line 2.
		const marker = "\u25cf"; // ●
		const marked = lines.filter((l) => l.includes(marker));
		expect(marked).toHaveLength(1);
		expect(lines[1]).toContain(marker);
		expect(lines[2]).not.toContain(marker);

		// getSelectedNode reports isCurrent for the host row (default selection).
		const node = tree.getSelectedNode();
		expect(node?.isCurrent).toBe(true);
		expect(node?.sessionId).toBe("host");
	});

	it("clearing the current session id removes the ● marker from all rows", () => {
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "host", cwd: "/tmp/host" })]);
		const tree = new SessionTreeComponent(() => {});
		tree.setCurrentSessionId("host");
		tree.start();
		tree.stop();
		expect(tree.render(120)[1]).toContain("\u25cf");

		tree.setCurrentSessionId(null);
		expect(tree.render(120)[1]).not.toContain("\u25cf");
		expect(tree.getSelectedNode()?.isCurrent).toBe(false);
	});

	it("nests a crew sub-agent under its parent session by parentSessionId", () => {
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "parent", cwd: "/tmp/proj" })]);
		crewLiveMock.mockReturnValue([
			makeRun({ handle: "worker-1", parentSessionId: "parent", sessionId: "crew-worker-1-aaa" }),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		// Layout: line 0 = +New, line 1 = parent session, line 2 = nested crew.
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("proj");
		expect(lines[2]).toContain("worker-1");
		// The crew row is not at top level (no leading fold marker / it's a leaf
		// child) — it must come *after* its parent, never instead of it.
		const crewLine = lines[2];
		expect(crewLine).toContain("worker-1");
	});

	it("hides a crew sub-agent from the top-level session list", () => {
		// The crew run is itself a real session with a ledger entry; it must not
		// appear as a standalone top-level row — only nested under its parent.
		vi.mocked(loadLedger).mockReturnValue([
			makeEntry({ sessionId: "parent", cwd: "/tmp/proj" }),
			makeEntry({ sessionId: "crew-worker-2-bbb", cwd: "/tmp/proj" }),
		]);
		crewLiveMock.mockReturnValue([
			makeRun({ handle: "worker-2", parentSessionId: "parent", sessionId: "crew-worker-2-bbb" }),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		// +New, parent, nested crew = 3 rows. The crew session id must NOT get
		// its own top-level session row.
		expect(lines).toHaveLength(3);
		const topRows = lines.slice(1); // skip +New
		// Only one top-level session row (the parent); the crew appears once,
		// nested, not twice.
		const crewAppearances = topRows.filter((l) => l.includes("worker-2"));
		expect(crewAppearances).toHaveLength(1);
	});

	it("falls back to matching by cwd when a crew run has no parentSessionId", () => {
		// Old meta without parentSessionId should still nest under a session
		// sharing its cwd, preserving the previous behaviour.
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "parent", cwd: "/tmp/proj" })]);
		crewLiveMock.mockReturnValue([
			makeRun({ handle: "worker-3", parentSessionId: undefined, sessionId: "crew-worker-3-ccc" }),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		expect(lines).toHaveLength(3); // +New, parent, nested crew
		expect(lines[2]).toContain("worker-3");
	});

	it("orphan crew (no matching parent session) render at top level, not hidden", () => {
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "unrelated", cwd: "/tmp/elsewhere" })]);
		crewLiveMock.mockReturnValue([
			makeRun({ handle: "worker-4", parentSessionId: "ghost", sessionId: "crew-worker-4-ddd", cwd: "/tmp/proj" }),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		// +New, unrelated session, orphan crew = 3 rows.
		expect(lines).toHaveLength(3);
		expect(lines[2]).toContain("worker-4");
	});

	it("collapsing a parent session hides its nested crew rows", () => {
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "parent", cwd: "/tmp/proj" })]);
		crewLiveMock.mockReturnValue([
			makeRun({ handle: "worker-5", parentSessionId: "parent", sessionId: "crew-worker-5-eee" }),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();
		// Initially expanded: 3 rows (+New, parent, nested crew).
		expect(tree.render(120)).toHaveLength(3);

		// After start, the default selection is index 1 = the parent session
		// (it has children → hasChildren=true). Toggle collapse with → (right).
		expect(tree.getSelectedNode()?.sessionId).toBe("parent");
		tree.handleInput("\u001b[C"); // right = tui.select.expand (toggles collapse)

		const collapsed = tree.render(120);
		// Collapsed: +New + parent only; crew row hidden.
		expect(collapsed).toHaveLength(2);
		expect(collapsed[1]).toContain("proj");
		expect(collapsed.find((l) => l.includes("worker-5"))).toBeUndefined();

		// Re-expand with → again.
		tree.handleInput("\u001b[C");
		expect(tree.render(120)).toHaveLength(3);
	});

	it("crew sub-agent nodes are switchable: carry sessionId and cwd so Enter can switch", () => {
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "parent", cwd: "/tmp/proj" })]);
		crewLiveMock.mockReturnValue([
			makeRun({
				handle: "worker-6",
				parentSessionId: "parent",
				sessionId: "crew-worker-6-fff",
				cwd: "/tmp/proj",
				task: "investigate the regression",
			}),
		]);
		const tree = new SessionTreeComponent(() => {});
		const onSelectSession = vi.fn();
		tree.onSelectSession = onSelectSession;
		tree.start();
		tree.stop();

		// After start, selection is on the parent (index 1). One ↓ moves to the
		// nested crew child (index 2).
		tree.handleInput("j"); // → 2 (crew child)
		expect(tree.getSelectedNode()?.sessionId).toBe("crew-worker-6-fff");
		expect(tree.getSelectedNode()?.cwd).toBe("/tmp/proj");
		expect(tree.getSelectedNode()?.isSession).toBe(false);

		// Confirm (Enter) on the crew row fires onSelectSession with the crew's
		// sessionId + cwd, so the host can switch to the sub-agent's session.
		tree.handleInput("\r");
		expect(onSelectSession).toHaveBeenCalledTimes(1);
		expect(onSelectSession.mock.calls[0][0]).toBe("crew-worker-6-fff");
		expect(onSelectSession.mock.calls[0][1]).toBe("/tmp/proj");
	});

	it("crew sub-agent nodes are previewable: carry lastResponse from run.text", () => {
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "parent", cwd: "/tmp/proj" })]);
		crewLiveMock.mockReturnValue([
			makeRun({
				handle: "worker-7",
				parentSessionId: "parent",
				sessionId: "crew-worker-7-ggg",
				text: "the sub-agent's latest output line",
			}),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		// Select the crew child: selection starts on the parent (index 1); one ↓
		// moves to the nested crew child (index 2).
		tree.handleInput("j"); // parent → crew child
		const node = tree.getSelectedNode();
		expect(node?.lastResponse).toContain("the sub-agent's latest output line");
	});

	it("a session with multiple crew children shows a crew-count column", () => {
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "parent", cwd: "/tmp/proj" })]);
		crewLiveMock.mockReturnValue([
			makeRun({ handle: "worker-a", parentSessionId: "parent", sessionId: "crew-a" }),
			makeRun({ handle: "worker-b", parentSessionId: "parent", sessionId: "crew-b" }),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		expect(lines[1]).toContain("2 crew");
		// Both children render nested under the parent.
		expect(lines[2]).toContain("worker-a");
		expect(lines[3]).toContain("worker-b");
	});

	it("renders nested crew rows padded to the full width", () => {
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "parent", cwd: "/tmp/proj" })]);
		crewLiveMock.mockReturnValue([
			makeRun({ handle: "worker-pad", parentSessionId: "parent", sessionId: "crew-pad" }),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(120);
		}
	});
});
