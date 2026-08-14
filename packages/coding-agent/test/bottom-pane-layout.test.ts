import { type Component, Container, ScrollView, VStack } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ContextBar, Separator, ViewHeader } from "../src/modes/interactive/components/context-bar.ts";
import { NvimPairPanel } from "../src/modes/interactive/components/nvim-pair-panel.ts";
import { createInteractiveTui } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("terminal");

/**
 * Regression: the bottom list pane is a layout-bearing VStack host whose
 * single entry fills the pane. A plain Container host would flatten its
 * layout-bearing child via .render(), and VStack.render (standalone) sizes a
 * basis:0 grow entry to its basis (clamped to minSize 1) — truncating the
 * scroll content to a single line. This mirrors the InteractiveMode bottom
 * band and asserts the nvim pair panel's full content is windowed, not
 * truncated to its first line.
 */
class MockEditor implements Component {
	render(): string[] {
		return [""];
	}
	invalidate(): void {}
}
class MockStatusLine implements Component {
	render(width: number): string[] {
		return ["─".repeat(Math.max(0, width))];
	}
	invalidate(): void {}
}

function buildBottomBand(panel: Component): { root: Component; scroll: ScrollView } {
	const sessionTreeContainer = new Container();
	sessionTreeContainer.addChild(panel);
	const sessionTreeScrollView = new ScrollView(sessionTreeContainer, { follow: "none", overscroll: "chain" });
	const viewHeader = new ViewHeader(() => {});
	const contextBar = new ContextBar(() => {});
	const inputSeparator = new Separator(() => {});
	const bottomListHost = new VStack([
		{ component: viewHeader, basis: "auto", shrink: 1, minSize: 0 },
		{ component: sessionTreeScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
	// Pane host MUST be a layout-bearing VStack so the engine recurses.
	const bottomPaneContainer = new VStack([]);
	bottomPaneContainer.addChild(bottomListHost, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
	const editorContainer = new Container();
	editorContainer.addChild(new MockEditor());
	const editorDock = new VStack([{ component: editorContainer, shrink: 1, minSize: 1 }]);
	const statusLineContainer = new Container();
	statusLineContainer.addChild(new MockStatusLine());
	const bottomBand = new VStack([
		{ component: statusLineContainer, basis: "auto", shrink: 1, minSize: 0 },
		{ component: editorDock, basis: "auto", shrink: 1, minSize: 1 },
		{ component: inputSeparator, basis: "auto", shrink: 1, minSize: 0 },
		{ component: bottomPaneContainer, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: contextBar, basis: "auto", shrink: 1, minSize: 0 },
	]);
	const transcriptContainer = new Container();
	const transcriptScrollView = new ScrollView(transcriptContainer, {
		follow: "end",
		primary: true,
		overscroll: "chain",
	});
	const root = new VStack([
		{ component: transcriptScrollView, basis: 0, grow: 6, shrink: 1, minSize: 1 },
		{ component: bottomBand, basis: 0, grow: 4, shrink: 1, minSize: 1 },
	]);
	return { root, scroll: sessionTreeScrollView };
}

describe("nvim pair panel bottom-pane rendering", () => {
	it("windows the full panel content (does not truncate to the first line)", async () => {
		const terminal = new VirtualTerminal(80, 40);
		const tui = createInteractiveTui({ showHardwareCursor: false, logDirectory: "/tmp", terminal });
		const panel = new NvimPairPanel({
			socketPath: "/tmp/nvim-318-673.sock",
			requestRender: () => tui.requestRender(),
			onDone: () => {},
		});
		const { root, scroll } = buildBottomBand(panel);
		tui.setLayoutRoot(root);
		tui.start();
		try {
			await terminal.waitForRender();
			const viewport = terminal.getViewport().join("\n");
			// The command line and the copy hint must be present in the pane.
			expect(viewport).toContain("lua vim.fn.serverstart('/tmp/nvim-318-673.sock')");
			expect(viewport).toContain("Press C to copy command");
			expect(viewport).toContain("Waiting for connection...");
			// The scroll viewport must know about the full 10-line content.
			expect(scroll.viewportHeight).toBeGreaterThan(0);
		} finally {
			tui.stop();
		}
	});

	it("regression: a plain Container host truncates the panel (demonstrates the bug)", async () => {
		const terminal = new VirtualTerminal(80, 40);
		const tui = createInteractiveTui({ showHardwareCursor: false, logDirectory: "/tmp", terminal });
		const panel = new NvimPairPanel({
			socketPath: "/tmp/nvim-318-673.sock",
			requestRender: () => tui.requestRender(),
			onDone: () => {},
		});
		// Same as buildBottomBand but the pane host is a plain Container.
		const sessionTreeContainer = new Container();
		sessionTreeContainer.addChild(panel);
		const sessionTreeScrollView = new ScrollView(sessionTreeContainer, { follow: "none", overscroll: "chain" });
		const bottomListHost = new VStack([
			{ component: new ViewHeader(() => {}), basis: "auto", shrink: 1, minSize: 0 },
			{ component: sessionTreeScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		]);
		const bottomPaneContainer = new Container();
		bottomPaneContainer.addChild(bottomListHost);
		const editorContainer = new Container();
		editorContainer.addChild(new MockEditor());
		const editorDock = new VStack([{ component: editorContainer, shrink: 1, minSize: 1 }]);
		const statusLineContainer = new Container();
		statusLineContainer.addChild(new MockStatusLine());
		const bottomBand = new VStack([
			{ component: statusLineContainer, basis: "auto", shrink: 1, minSize: 0 },
			{ component: editorDock, basis: "auto", shrink: 1, minSize: 1 },
			{ component: new Separator(() => {}), basis: "auto", shrink: 1, minSize: 0 },
			{ component: bottomPaneContainer, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: new ContextBar(() => {}), basis: "auto", shrink: 1, minSize: 0 },
		]);
		const transcriptScrollView = new ScrollView(new Container(), {
			follow: "end",
			primary: true,
			overscroll: "chain",
		});
		const root = new VStack([
			{ component: transcriptScrollView, basis: 0, grow: 6, shrink: 1, minSize: 1 },
			{ component: bottomBand, basis: 0, grow: 4, shrink: 1, minSize: 1 },
		]);
		tui.setLayoutRoot(root);
		tui.start();
		try {
			await terminal.waitForRender();
			const viewport = terminal.getViewport().join("\n");
			expect(viewport).toContain("Pair with nvim");
			// Bug: the command + copy hint are NOT rendered (truncated to 1 line).
			expect(viewport).not.toContain("Press C to copy command");
		} finally {
			tui.stop();
		}
	});
});
