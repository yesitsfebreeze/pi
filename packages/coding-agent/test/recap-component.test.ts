import { describe, expect, test } from "vitest";
import {
	parseRecap,
	parseRecapPartial,
	RecapComponent,
	stripRecapBlock,
} from "../src/modes/interactive/recap-component.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const stubTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

describe("parseRecap", () => {
	test("parses a well-formed block", () => {
		const text =
			"Here is work.\n<recap>\nMISSION: build recap feature\nTASK: writing extension\nNEXT: test it\n</recap>";
		expect(parseRecap(text)).toEqual({
			mission: "build recap feature",
			task: "writing extension",
			next: "test it",
		});
	});

	test("returns null when a field is missing", () => {
		expect(parseRecap("<recap>\nMISSION: x\nTASK: y\n</recap>")).toBeNull();
	});

	test("returns null when no block present", () => {
		expect(parseRecap("no recap here")).toBeNull();
	});

	test("ignores extra lines and whitespace", () => {
		const text = "<recap>\n\n  MISSION:  goal  \nRANDOM: noise\nTASK: focus\nNEXT: step\n</recap>";
		expect(parseRecap(text)).toEqual({ mission: "goal", task: "focus", next: "step" });
	});

	test("parses trailing block (last thing in message)", () => {
		const text = "body text\n\n<recap>\nMISSION: a\nTASK: b\nNEXT: c\n</recap>";
		expect(parseRecap(text)).toEqual({ mission: "a", task: "b", next: "c" });
	});
});

describe("stripRecapBlock", () => {
	test("removes a recap block", () => {
		const text = "before\n<recap>\nMISSION: a\nTASK: b\nNEXT: c\n</recap>\nafter";
		expect(stripRecapBlock(text)).toBe("before\nafter");
	});

	test("leaves text without a block unchanged", () => {
		expect(stripRecapBlock("just text")).toBe("just text");
	});

	test("removes a trailing block cleanly", () => {
		const text = "body\n<recap>\nMISSION: a\nTASK: b\nNEXT: c\n</recap>";
		expect(stripRecapBlock(text)).toBe("body");
	});

	test("drops an unclosed recap block while streaming", () => {
		const text = "body\n<recap>\nMISSION: a\nTASK: b";
		expect(stripRecapBlock(text)).toBe("body");
	});

	test("drops an empty unclosed recap tag while streaming", () => {
		expect(stripRecapBlock("body\n<recap>")).toBe("body");
	});

	test("returns empty when a recap opens mid-stream with no preceding body", () => {
		expect(stripRecapBlock("<recap>\nMISSION: a")).toBe("");
	});

	test("leaves text before an unclosed recap untouched", () => {
		const text = "first paragraph\n\nsecond paragraph\n<recap>\nNEXT: ";
		expect(stripRecapBlock(text)).toBe("first paragraph\n\nsecond paragraph");
	});

	test("drops a trailing partial opening tag split across stream tokens", () => {
		expect(stripRecapBlock("body\n<recap")).toBe("body");
		expect(stripRecapBlock("body\n<rec")).toBe("body");
		expect(stripRecapBlock("body\n<re")).toBe("body");
	});

	test("leaves a bare trailing '<' alone (likely ordinary content)", () => {
		expect(stripRecapBlock("a < b")).toBe("a < b");
		expect(stripRecapBlock("value is ")).toBe("value is");
	});
});

describe("parseRecapPartial", () => {
	test("returns null when no block present", () => {
		expect(parseRecapPartial("no recap here")).toBeNull();
	});

	test("returns all fields for a complete block", () => {
		expect(parseRecapPartial("<recap>\nMISSION: a\nTASK: b\nNEXT: c\n</recap>")).toEqual({
			mission: "a",
			task: "b",
			next: "c",
		});
	});

	test("returns only the fields present (partial)", () => {
		expect(parseRecapPartial("<recap>\nTASK: refreshed\nNEXT: step\n</recap>")).toEqual({
			task: "refreshed",
			next: "step",
		});
	});

	test("returns a single-field update", () => {
		expect(parseRecapPartial("<recap>\nTASK: new focus\n</recap>")).toEqual({ task: "new focus" });
	});

	test("ignores unknown fields", () => {
		expect(parseRecapPartial("<recap>\nMISSION: a\nNOISE: x\nNEXT: c\n</recap>")).toEqual({
			mission: "a",
			next: "c",
		});
	});

	test("returns null when block has no recognized fields", () => {
		expect(parseRecapPartial("<recap>\nNOISE: x\n</recap>")).toBeNull();
	});
});

describe("RecapComponent.render", () => {
	test("renders nothing when no recap is set", () => {
		const component = new RecapComponent({ requestRender: () => {}, theme: stubTheme });
		try {
			expect(component.render(40)).toEqual([]);
		} finally {
			component.dispose();
		}
	});

	test("renders three recap lines plus a separator once set", () => {
		const component = new RecapComponent({ requestRender: () => {}, theme: stubTheme });
		try {
			component.setRecap({ mission: "goal", task: "work", next: "step" });
			const lines = component.render(40);
			expect(lines).toHaveLength(4);
			expect(lines[0]).toContain("MISSION: goal");
			expect(lines[1]).toContain("TASK: work");
			expect(lines[2]).toContain("NEXT: step");
			expect(lines[3]).toBe("─".repeat(40));
		} finally {
			component.dispose();
		}
	});
});
