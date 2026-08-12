import type { Component, Terminal } from "@earendil-works/pi-tui";
import { Container, isViewportTUI, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { GitStatus } from "../src/modes/interactive/components/status-line.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

describe("createInteractiveTui", () => {
	it("always uses the alternate-screen (fullscreen) renderer", async () => {
		const terminal = new RecordingTerminal();
		const tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		expect(tui.mode).toBe("fullscreen");
		expect(isViewportTUI(tui)).toBe(true);
		tui.start();
		await terminal.waitForRender();
		expect(terminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(true);
		tui.stop();
	});
});

describe("InteractiveMode right-click paste", () => {
	it("feeds clipboard text to the focused component as a bracketed paste", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("clipboard text");
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const requestRender = vi.fn();
		const context = {
			renderer: { getFocusedComponent: () => target },
			ui: { requestRender },
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleRightClickPaste(this: typeof context): Promise<void>;
		};

		await prototype.handleRightClickPaste.call(context);

		expect(handleInput).toHaveBeenCalledWith("\x1b[200~clipboard text\x1b[201~");
		expect(requestRender).toHaveBeenCalledOnce();
	});
});

type CopyCommandContext = {
	session: { getLastAssistantText: () => string | undefined };
	ui: ReturnType<typeof createInteractiveTui>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type CopyCommandOptions = { flashConfirmation?: boolean };

type CopyCommandPrototype = {
	handleCopyCommand(this: CopyCommandContext, options?: CopyCommandOptions): Promise<void>;
};

const copyCommandPrototype = InteractiveMode.prototype as unknown as CopyCommandPrototype;

describe("InteractiveMode copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	});

	it("flashes Copied! for the copy shortcut in fullscreen mode", async () => {
		const terminal = new RecordingTerminal(40, 4);
		const ui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			showStatus,
			showError,
		};

		ui.start();
		try {
			await terminal.waitForRender();
			await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true });
			await terminal.waitForRender();

			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
			expect(showStatus).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBe(true);
		} finally {
			ui.stop();
		}
	});

	it("keeps the status-line confirmation when flashConfirmation is false", async () => {
		const ui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			showStatus,
			showError,
		};

		await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: false });

		expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});
});

type ClearStatusContext = {
	activeStatusIndicator: { kind: "working"; dispose: () => void } | undefined;
	statusContainer: Container;
	ui: { getClearOnShrink: () => boolean };
	idleStatus: Component;
};

type InteractiveModePrototype = {
	clearStatusIndicator(this: ClearStatusContext, kind?: "working"): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type GitStatusContext = {
	sessionManager: { getCwd: () => string | undefined };
	ui: { requestRender: () => void };
	gitCache: { result: GitStatus | undefined; ts: number; cwd: string } | undefined;
	gitRefreshInFlight: boolean;
};

type GitStatusPrototype = {
	getGitStatus(this: GitStatusContext): GitStatus | undefined;
	refreshGitStatus(this: GitStatusContext, cwd: string): void;
};

const gitStatusPrototype = InteractiveMode.prototype as unknown as GitStatusPrototype;

describe("status-line git status", () => {
	it("returns the cached value synchronously without spawning git or re-rendering", () => {
		const requestRender = vi.fn();
		const status = { branch: "main", ahead: 1, behind: 2, added: 3, deleted: 4 };
		const context: GitStatusContext = {
			sessionManager: { getCwd: () => "/repo" },
			ui: { requestRender },
			gitCache: { result: status, ts: Date.now(), cwd: "/repo" },
			gitRefreshInFlight: false,
		};

		// Must return immediately from cache — never block the render/input thread.
		const result = gitStatusPrototype.getGitStatus.call(context);

		expect(result).toStrictEqual(status);
		// Fresh cache: no background refresh, no render request.
		expect(requestRender).not.toHaveBeenCalled();
		expect(context.gitRefreshInFlight).toBe(false);
	});

	it("does not start a second refresh while one is already in flight", () => {
		const requestRender = vi.fn();
		const status = { branch: "main", ahead: 0, behind: 0, added: 0, deleted: 0 };
		const context: GitStatusContext = {
			sessionManager: { getCwd: () => "/repo" },
			ui: { requestRender },
			// stale cache (old timestamp) so a refresh would normally trigger
			gitCache: { result: status, ts: 0, cwd: "/repo" },
			gitRefreshInFlight: true,
		};

		const result = gitStatusPrototype.getGitStatus.call(context);

		// Returns the stale cached value (non-blocking) and does not schedule work.
		expect(result).toStrictEqual(status);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("returns undefined without blocking when the cwd has no cached status", () => {
		const requestRender = vi.fn();
		const context: GitStatusContext = {
			sessionManager: { getCwd: () => "/other-repo" },
			ui: { requestRender },
			gitCache: undefined,
			gitRefreshInFlight: true, // prevent the real async git spawn in this unit test
		};

		const result = gitStatusPrototype.getGitStatus.call(context);

		expect(result).toBeUndefined();
		expect(requestRender).not.toHaveBeenCalled();
	});
});

describe("clear-on-shrink status spacing", () => {
	it("clears the status container without reserving idle height in fullscreen mode", () => {
		const dispose = vi.fn();
		const context: ClearStatusContext = {
			activeStatusIndicator: { kind: "working", dispose },
			statusContainer: new Container(),
			ui: { getClearOnShrink: () => true },
			idleStatus: new Text("", 0, 0),
		};

		interactiveModePrototype.clearStatusIndicator.call(context);

		expect(dispose).toHaveBeenCalledOnce();
		expect(context.statusContainer.children).toHaveLength(0);
	});
});
