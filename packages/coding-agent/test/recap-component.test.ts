import { describe, expect, test } from "vitest";
import { parseRecap, parseRecapPartial, stripRecapBlock } from "../src/modes/interactive/recap-component.ts";

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
