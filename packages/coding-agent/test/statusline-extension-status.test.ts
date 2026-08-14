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

	it("renders slots as background pills, not bare text", () => {
		const c = new StatusLineComponent(() => base({ extensionStatuses: ["crew: 1 to resume"] }), ui);
		const out = c.render(200).join("");
		expect(out).toContain("\x1b[40m\x1b[37m crew: 1 to resume "); // first slot: black pill, white fg
	});

	it("gives each status slot a deterministic, distinct background", () => {
		const bgOf = (slots: string[]) =>
			new StatusLineComponent(() => base({ extensionStatuses: slots }), ui).render(200).join("");
		const one = bgOf(["launch 2 jobs"]);
		const two = bgOf(["launch 2 jobs", "until: watching"]);
		const refreshed = bgOf(["launch 3 jobs"]);
		expect(one).toContain("\x1b[40m\x1b[37m launch 2 jobs "); // slot 0: black pill
		expect(two).toContain("\x1b[47m\x1b[30m until: watching "); // slot 1: white pill
		expect(refreshed).toContain("\x1b[40m\x1b[37m launch 3 jobs "); // same position keeps its color
	});

	it("keeps the pill background through the truncation ellipsis", () => {
		const long = "next test layout: routing tests into gossip/tests (follow-up)";
		const c = new StatusLineComponent(() => base({ extensionStatuses: [long] }), ui);
		const out = c.render(200).join("");
		expect(out).toContain("…");
		expect(out).not.toContain("\x1b[0m…"); // truncateToWidth's injected reset is stripped
	});

	it("renders tokens and cost as their own pills", () => {
		const c = new StatusLineComponent(() => base({ sessionCost: 0.42 }), ui);
		const out = c.render(200).join("");
		expect(out).toContain("\x1b[40m\x1b[37m ↑1 ↓1 "); // tokens: black pill
		expect(out).toContain("\x1b[47m\x1b[30m $0.42 "); // cost: white pill
	});

	it("caps verbose slots to a short pill", () => {
		const long = "next test layout: routing tests into gossip/tests (follow-up)";
		const c = new StatusLineComponent(() => base({ extensionStatuses: [long] }), ui);
		const out = c.render(200).join("");
		expect(out).not.toContain(long);
		expect(out).toContain("…");
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
