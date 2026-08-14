import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type LedgerEntry, loadLedger } from "../src/core/session-ledger.ts";
import { SessionTreeComponent } from "../src/modes/interactive/components/session-tree.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

vi.mock("../src/core/crew/runner.ts", () => ({
	live: () => [],
	GLYPH: {},
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

describe("SessionTreeComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		vi.mocked(loadLedger).mockReset();
	});

	it("renders a +New row as the first entry", () => {
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "s1" })]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		expect(lines[0]).toContain("+New");
		expect(lines[0]).toContain("start a new session");
		expect(lines[1]).toContain("proj");
	});

	it("sorts sessions hottest first (most recently started at the top)", () => {
		const older = new Date(Date.now() - 60_000).toISOString();
		const newer = new Date().toISOString();
		vi.mocked(loadLedger).mockReturnValue([
			makeEntry({ sessionId: "old", startedAt: older, cwd: "/tmp/alpha" }),
			makeEntry({ sessionId: "new", startedAt: newer, cwd: "/tmp/bravo" }),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		// +New is line 0; the freshly started session must be line 1, not the last.
		expect(lines[1]).toContain("bravo");
		expect(lines[2]).toContain("alpha");
	});

	it("renders only the +New row when there are no live sessions", () => {
		vi.mocked(loadLedger).mockReturnValue([]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("+New");
	});

	it("invokes onNewSessionFocus when the +New row is confirmed", () => {
		vi.mocked(loadLedger).mockReturnValue([]);
		const tree = new SessionTreeComponent(() => {});
		const onNewSessionFocus = vi.fn();
		tree.onNewSessionFocus = onNewSessionFocus;
		tree.start();
		tree.stop();

		tree.handleInput("\r");
		expect(onNewSessionFocus).toHaveBeenCalledTimes(1);
	});

	it("marks exactly one row as selected with the → arrow", () => {
		vi.mocked(loadLedger).mockReturnValue([
			makeEntry({ sessionId: "a", cwd: "/tmp/alpha" }),
			makeEntry({ sessionId: "b", cwd: "/tmp/bravo" }),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		// +New is line 0 (unselected); the first session (line 1) is selected by default.
		const arrowCount = lines.filter((l) => l.includes("→")).length;
		expect(arrowCount).toBe(1);
		expect(lines[1]).toContain("→");
		expect(lines[0]).not.toContain("→");
	});

	it("presses r to rename the selected session", () => {
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "s1", sessionFile: "/tmp/s.json" })]);
		const tree = new SessionTreeComponent(() => {});
		const onRename = vi.fn();
		tree.onRename = onRename;
		tree.start();
		tree.stop();

		tree.handleInput("r");
		expect(onRename).toHaveBeenCalledTimes(1);
		expect(onRename.mock.calls[0][0].sessionFile).toBe("/tmp/s.json");
		expect(onRename.mock.calls[0][0].isSession).toBe(true);
	});

	it("gutter is exactly one cell: every row pads to the full width", () => {
		vi.mocked(loadLedger).mockReturnValue([
			makeEntry({ sessionId: "a", cwd: "/tmp/alpha" }),
			makeEntry({ sessionId: "b", cwd: "/tmp/bravo" }),
		]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const lines = tree.render(120);
		expect(lines).toHaveLength(3); // +New, a, b
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(120);
		}
	});

	it("rename tail-scan: latest session_info beyond the 8KB head buffer wins the display name", () => {
		const dir = mkdtempSync(join(tmpdir(), "stree-"));
		const file = join(dir, "s.jsonl");
		const header = JSON.stringify({
			type: "session",
			id: "s1",
			timestamp: new Date().toISOString(),
			cwd: "/tmp/proj",
			provider: "x",
			modelId: "y",
			thinkingLevel: "off",
		});
		const userMsg = JSON.stringify({
			type: "message",
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: "first user question" }] },
		});
		const firstName = JSON.stringify({
			type: "session_info",
			id: "i1",
			parentId: "root",
			timestamp: new Date().toISOString(),
			name: "first-name",
		});
		// Valid filler entries so the rename lands beyond the 8KB head buffer and
		// beyond the 32KB tail offset, exercising the tail-only read path.
		const pad = JSON.stringify({
			type: "custom",
			id: "p",
			parentId: "root",
			timestamp: new Date().toISOString(),
			customType: "pad",
			data: "x".repeat(4096),
		});
		const lines = [header, userMsg, firstName];
		while (Buffer.byteLength(lines.join("\n")) < 40 * 1024) {
			lines.push(pad);
		}
		const renamed = JSON.stringify({
			type: "session_info",
			id: "i2",
			parentId: "root",
			timestamp: new Date().toISOString(),
			name: "renamed-later",
		});
		const finalAnswer = JSON.stringify({
			type: "message",
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "the final answer" }] },
		});
		lines.push(renamed, finalAnswer);
		writeFileSync(file, `${lines.join("\n")}\n`);

		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "s1", sessionFile: file, cwd: "/tmp/proj" })]);
		const tree = new SessionTreeComponent(() => {});
		tree.start();
		tree.stop();

		const rendered = tree.render(120);
		expect(rendered[1]).toContain("renamed-later");
		expect(rendered[1]).not.toContain("first-name");
		const node = tree.getSelectedNode();
		expect(node?.lastResponse).toContain("the final answer");
	});

	it("notifies selection change after refresh", () => {
		vi.mocked(loadLedger).mockReturnValue([makeEntry({ sessionId: "s1" })]);
		const tree = new SessionTreeComponent(() => {});
		const onSelectionChange = vi.fn();
		tree.onSelectionChange = onSelectionChange;
		tree.start();
		tree.stop();

		expect(onSelectionChange).toHaveBeenCalled();
		expect(onSelectionChange.mock.calls[0][0].isSession).toBe(true);
		expect(onSelectionChange.mock.calls[0][0].sessionId).toBe("s1");
	});
});
