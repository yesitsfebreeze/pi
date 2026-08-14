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

import { visibleWidth } from "@earendil-works/pi-tui";
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
		nvimConnected: false,
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
		expect(out).toMatch(/\x1b\[4[0-7]m\x1b\[3[07]m crew: 1 to resume \x1b\[0m/); // some bg pill, picked fg
	});

	it("never lets adjacent pills share a background", () => {
		const out = new StatusLineComponent(() => base({ extensionStatuses: ["launch 2 jobs", "until: watching"] }), ui)
			.render(200)
			.join("");
		const bgs = [...out.matchAll(/\x1b\[(4[0-7])m/g)].map((m) => m[1]);
		expect(bgs.length).toBeGreaterThan(3);
		for (let i = 1; i < bgs.length; i++) {
			expect(bgs[i]).not.toBe(bgs[i - 1]); // every meeting pair differs
		}
	});

	it("assigns backgrounds deterministically from the flow, not the slot index", () => {
		const render = (slots: string[]) =>
			new StatusLineComponent(() => base({ extensionStatuses: slots }), ui).render(200).join("");
		const one = render(["launch 2 jobs"]);
		const refreshed = render(["launch 3 jobs"]);
		expect(refreshed.replace("launch 3 jobs", "launch 2 jobs")).toBe(one);
		// slot 0 lands on green here (version magenta → cwd yellow → ext green);
		// slot 1 skips to cyan so the pair differs.
		expect(one).toContain("\x1b[42m\x1b[30m launch 2 jobs ");
		expect(render(["launch 2 jobs", "until: watching"])).toContain("\x1b[46m\x1b[30m until: watching ");
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

	it("shows an nvim pill in front of the version while paired", () => {
		const out = new StatusLineComponent(() => base({ nvimConnected: true }), ui).render(200).join("");
		expect(out).toContain("\x1b[0m\x1b[40m\x1b[37m nvim \x1b[0m\x1b[45m\x1b[30m pi v1.0.0 ");
	});

	it("hides the nvim pill when not paired", () => {
		const out = new StatusLineComponent(() => base(), ui).render(200).join("");
		expect(out).not.toContain(" nvim ");
	});

	it("wraps to a new line when the flow overflows, still flowing left to right", () => {
		const c = new StatusLineComponent(
			() =>
				base({
					cwd: "/some/really/long/working/directory/name/that/takes/space",
					extensionStatuses: ["persona: scout", "launch 2 jobs", "until: watching"],
					sessionCost: 0.42,
				}),
			ui,
		);
		const lines = c.render(60);
		expect(lines.length).toBeGreaterThan(1);
		const joined = lines.join("\n");
		for (const text of [
			"/some/really/long/working/directory/name/that/takes/space",
			"persona: scout",
			"launch 2 jobs",
			"until: watching",
			"$0.42",
		]) {
			expect(joined).toContain(text);
		}
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60); // nothing overflows the terminal
			expect(line[0]).not.toBe(" "); // every line starts at column 0
		}
	});
});
