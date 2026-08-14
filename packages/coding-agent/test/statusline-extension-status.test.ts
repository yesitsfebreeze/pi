/**
 * Extension status slots reach the rendered status line.
 *
 * Regression guard: `ctx.ui.setStatus(key, text)` is the documented channel for
 * an extension to publish status, and twelve core inline extensions call it.
 * For a while the TUI's `setExtensionStatus` was `// no-op: footer slot removed`,
 * so every one of those calls painted into a void — and nothing caught it,
 * because the only tests asserted that the *callers* fired. This asserts the
 * sink: text handed to the component must appear in its rendered output.
 */
import { describe, expect, it } from "vitest";
import { StatusLineComponent, type StatusLineData } from "../src/modes/interactive/components/status-line.ts";

function base(over: Partial<StatusLineData> = {}): StatusLineData {
	return {
		version: "1.0.0",
		updateAvailable: false,
		cwd: "/tmp/p",
		contextPercent: 10,
		contextWindow: 1000,
		inputTokens: 1,
		outputTokens: 1,
		sessionCost: 0,
		autoCompact: false,
		working: false,
		now: 0,
		...over,
	};
}

const ui = { requestRender() {} } as unknown as ConstructorParameters<typeof StatusLineComponent>[1];

describe("status line renders extension statuses", () => {
	it("renders each slot published via setStatus", () => {
		const c = new StatusLineComponent(() => base({ extensionStatuses: ["persona: scout", "launch 2 jobs"] }), ui);
		const out = c.render(200).join("");
		expect(out).toContain("persona: scout");
		expect(out).toContain("launch 2 jobs");
	});

	it("renders nothing extra when there are no slots", () => {
		const c = new StatusLineComponent(() => base(), ui);
		expect(c.render(200).join("")).not.toContain("persona");
	});

	it("skips empty slot text", () => {
		const c = new StatusLineComponent(() => base({ extensionStatuses: ["", "kern 3T·2R"] }), ui);
		const out = c.render(200).join("");
		expect(out).toContain("kern 3T·2R");
	});
});
