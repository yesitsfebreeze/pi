/**
 * Tests for the embedded terminal editor (Ctrl+G in the lower half).
 *
 * Framework: vitest. The component integration tests spawn a small shell
 * script through the PTY instead of a full editor, so they are deterministic
 * and don't depend on the user's $EDITOR or a specific editor binary.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type EmbeddedEditorResult,
	EmbeddedTerminal,
	isTerminalEditorCommand,
} from "../src/modes/interactive/components/embedded-terminal.ts";

describe("isTerminalEditorCommand", () => {
	it("classifies terminal editors", () => {
		expect(isTerminalEditorCommand("nvim")).toBe(true);
		expect(isTerminalEditorCommand("vim")).toBe(true);
		expect(isTerminalEditorCommand("nano")).toBe(true);
		expect(isTerminalEditorCommand("/usr/bin/nano")).toBe(true);
		expect(isTerminalEditorCommand("nvim --clean")).toBe(true);
	});

	it("rejects GUI editors and empty commands", () => {
		expect(isTerminalEditorCommand("code")).toBe(false);
		expect(isTerminalEditorCommand("notepad")).toBe(false);
		expect(isTerminalEditorCommand("gedit")).toBe(false);
		expect(isTerminalEditorCommand("")).toBe(false);
	});
});

describe("EmbeddedTerminal", () => {
	function makeScript(body: string): { dir: string; script: string } {
		const dir = mkdtempSync(join(tmpdir(), "pi-embed-"));
		const script = join(dir, "edit.sh");
		writeFileSync(script, body);
		chmodSync(script, 0o755);
		return { dir, script };
	}

	it("writes content to a temp file, runs the editor, and reads the result back", async () => {
		const { dir, script } = makeScript('printf "MODIFIED" > "$1"\n');

		const result = await new Promise<EmbeddedEditorResult>((resolve) => {
			new EmbeddedTerminal({
				command: `sh ${script}`,
				content: "original",
				cwd: dir,
				requestRender: () => {},
				onExit: resolve,
			});
		});

		expect(result.status).toBe("complete");
		expect((result as { content: string }).content).toBe("MODIFIED");
		rmSync(dir, { recursive: true, force: true });
	});

	it("renders the editor's terminal output into sized lines", async () => {
		const { dir, script } = makeScript('printf "\\033[31mhello\\033[0m\\n"; sleep 0.5\n');

		const component = new EmbeddedTerminal({
			command: `sh ${script}`,
			content: "",
			cwd: dir,
			requestRender: () => {},
			onExit: () => {},
		});

		const deadline = Date.now() + 5000;
		let lines: string[] = [];
		while (Date.now() < deadline) {
			lines = component.renderSized(20, 3);
			if (lines.join("").includes("hello")) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		expect(lines).toHaveLength(3);
		expect(lines.join("")).toContain("hello");
		component.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("renders empty cells with their background so the row is fully painted", async () => {
		// A line shorter than the width must still carry the trailing background.
		const { dir, script } = makeScript('printf "\\033[48;2;200;30;30mhi"; sleep 0.5\n');

		const component = new EmbeddedTerminal({
			command: `sh ${script}`,
			content: "",
			cwd: dir,
			requestRender: () => {},
			onExit: () => {},
		});

		const deadline = Date.now() + 5000;
		let first = "";
		while (Date.now() < deadline) {
			first = component.renderSized(10, 2)[0] ?? "";
			if (first.includes("hi")) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		// The trailing cells beyond "hi" are spaces painted with the red background.
		expect(first).toContain("hi");
		expect(first).toContain("48;2;200;30;30");
		component.dispose();
		rmSync(dir, { recursive: true, force: true });
	});
});
