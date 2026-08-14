import { describe, expect, test, vi } from "vitest";
import { ContextBar, Separator, ViewHeader } from "../src/modes/interactive/components/context-bar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

initTheme("dark");

describe("Separator", () => {
	test("renders a single full-width rule line", () => {
		const sep = new Separator();
		const lines = sep.render(20);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0]!)).toBe("─".repeat(20));
	});

	test("clamps to zero on non-positive width", () => {
		const lines = new Separator().render(0);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0]!)).toBe("");
	});

	test("invalidate is a no-op without a render callback", () => {
		expect(() => new Separator().invalidate()).not.toThrow();
	});

	test("calls the render callback on invalidate when provided", () => {
		const cb = vi.fn();
		const sep = new Separator(cb);
		sep.invalidate();
		expect(cb).toHaveBeenCalledOnce();
	});
});

describe("ViewHeader", () => {
	test("defaults to the Sessions title", () => {
		const lines = new ViewHeader().render(30);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0]!)).toContain("Sessions");
	});

	test("setTitle updates the rendered title and pads to width", () => {
		const cb = vi.fn();
		const h = new ViewHeader(cb);
		h.setTitle("Model");
		const lines = h.render(20);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0]!)).toContain("Model");
		expect(stripAnsi(lines[0]!)).not.toContain("Sessions");
		// only fires when the title actually changes
		h.setTitle("Model");
		expect(cb).toHaveBeenCalledTimes(1);
	});
});

describe("ContextBar", () => {
	test("renders the title followed by shortcuts", () => {
		const bar = new ContextBar();
		bar.setView("Resume session", "hints");
		const line = bar.render(40)[0]!;
		const plain = stripAnsi(line);
		expect(plain).toContain("Resume session");
		expect(plain).toContain("hints");
	});

	test("setView only re-renders when content changes", () => {
		const cb = vi.fn();
		const bar = new ContextBar(cb);
		bar.setView("Sessions", "a");
		bar.setView("Sessions", "a");
		expect(cb).toHaveBeenCalledTimes(1);
		bar.setView("Sessions", "b");
		expect(cb).toHaveBeenCalledTimes(2);
	});

	test("omits the separator when shortcuts is empty", () => {
		const bar = new ContextBar();
		bar.setView("Sessions", "");
		const plain = stripAnsi(bar.render(30)[0]!);
		expect(plain.trim()).toBe("Sessions");
	});

	test("pads the line to the full width", () => {
		const bar = new ContextBar();
		bar.setView("Sessions", "x");
		const line = bar.render(50)[0]!;
		expect(stripAnsi(line)).toHaveLength(50);
	});
});
