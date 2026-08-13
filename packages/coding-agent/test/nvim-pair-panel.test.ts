/**
 * Unit tests for the nvim pairing panel shown in place of the session tree
 * when `/nvim` waits for the nvim server socket.
 *
 * Framework: vitest. `copyToClipboard` is mocked so no native clipboard / OS
 * tool is invoked.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Mock the clipboard module before importing the panel, which imports it for
// its `C` copy action.
vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import { NvimPairPanel } from "../src/modes/interactive/components/nvim-pair-panel.ts";
import { copyToClipboard } from "../src/utils/clipboard.ts";

const SOCKET = "/run/user/1000/nvim-deadbeef.sock";

function makePanel(onDone = vi.fn()): NvimPairPanel {
	return new NvimPairPanel({
		socketPath: SOCKET,
		requestRender: () => {},
		onDone,
	});
}

describe("NvimPairPanel", () => {
	beforeAll(() => initTheme("dark"));
	// The clipboard mock is created once by the module factory, so without this
	// its call history carries between tests and a `toHaveBeenCalledWith` is
	// satisfied by an *earlier* test's call — the "lowercase c" case passed even
	// with the handler deleted.
	beforeEach(() => vi.clearAllMocks());
	it("renders the socket path and the Ex command", () => {
		const panel = makePanel();
		const lines = panel.render(80).join("\n");
		expect(lines).toContain(SOCKET);
		// Display command includes the leading `:`.
		expect(lines).toContain(`:lua vim.fn.serverstart('${SOCKET}')`);
	});

	it("C copies the command WITHOUT the leading colon", async () => {
		const panel = makePanel();
		panel.focused = true;
		panel.handleInput("C");
		// copyToClipboard is async; let the microtask settle.
		await Promise.resolve();
		await Promise.resolve();
		expect(copyToClipboard).toHaveBeenCalledWith(`lua vim.fn.serverstart('${SOCKET}')`);
	});

	it("Esc cancels via onDone", () => {
		const onDone = vi.fn();
		const panel = makePanel(onDone);
		panel.focused = true;
		panel.handleInput("\x1b"); // Esc
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it("lowercase c also copies", async () => {
		const panel = makePanel();
		panel.focused = true;
		panel.handleInput("c");
		await Promise.resolve();
		await Promise.resolve();
		expect(copyToClipboard).toHaveBeenCalledTimes(1);
		expect(copyToClipboard).toHaveBeenCalledWith(`lua vim.fn.serverstart('${SOCKET}')`);
	});
});
