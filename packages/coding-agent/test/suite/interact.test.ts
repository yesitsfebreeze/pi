// Tests for interact (questionnaire + ask tools).
// Covers:
//   - normalize / bail / formatResult helper unit tests
//   - questionnaire & ask tools trigger non-TUI fallback gracefully
//   - core-inline-extensions registers both tools
//   - answer mode tracking (picked / added / replaced / typed / wrote)
import { beforeAll, describe, expect, it } from "vitest";
import { Container, type TUI } from "../../../tui/src/tui.ts";
import { TuiMainScreen } from "../../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { createAskTool } from "../../src/core/interact/ask.ts";
import { createInteractExtension } from "../../src/core/interact/index.ts";
import { createQuestionnaireTool } from "../../src/core/interact/questionnaire.ts";
import { bail, formatResult, normalize, type Question } from "../../src/core/interact/types.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

describe("normalize", () => {
	it("maps raw questions to Question[] with defaults", () => {
		const raw = [
			{
				id: "q1",
				label: "Scope",
				prompt: "Which scope?",
				options: [
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta", recommended: true },
				],
			},
		];
		const qs = normalize(raw);
		expect(qs).toHaveLength(1);
		expect(qs[0]!.id).toBe("q1");
		expect(qs[0]!.label).toBe("Scope");
		expect(qs[0]!.prompt).toBe("Which scope?");
		expect(qs[0]!.allowOther).toBe(true);
		expect(qs[0]!.options).toHaveLength(2);
		expect(qs[0]!.options[0]!.recommended).toBe(false);
		expect(qs[0]!.options[1]!.recommended).toBe(true);
		expect(qs[0]!.options[0]!.origin).toBe("agent");
	});

	it("auto-generates id and label when absent", () => {
		const raw = [{ prompt: "foo?", options: [{ value: "x", label: "X" }] }];
		const qs = normalize(raw);
		expect(qs[0]!.id).toBe("q1");
		expect(qs[0]!.label).toBe("Q1");
	});

	it("respects allowOther: false", () => {
		const raw = [
			{
				prompt: "foo?",
				allowOther: false,
				options: [{ value: "x", label: "X" }],
			},
		];
		const qs = normalize(raw);
		expect(qs[0]!.allowOther).toBe(false);
	});

	it("coerces option labels from values when absent", () => {
		const raw = [{ prompt: "x?", options: [{ value: "opt-a" }] }];
		const qs = normalize(raw);
		expect(qs[0]!.options[0]!.label).toBe("opt-a");
	});

	it("carries the multi flag (default false)", () => {
		const qs = normalize([
			{ prompt: "a?", options: [{ value: "x", label: "X" }] },
			{ prompt: "b?", multi: true, options: [{ value: "y", label: "Y" }] },
		]);
		expect(qs[0]!.multi).toBe(false);
		expect(qs[1]!.multi).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// bail
// ---------------------------------------------------------------------------

describe("bail", () => {
	it("returns cancelled result with text content", () => {
		const r = bail("nope");
		expect(r.content[0].text).toBe("nope");
		expect(r.details.answers).toEqual([]);
		expect(r.details.cancelled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// formatResult
// ---------------------------------------------------------------------------

describe("formatResult", () => {
	const qs: Question[] = [
		{
			id: "q1",
			label: "Scope",
			prompt: "Which?",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta", recommended: true },
			],
			allowOther: true,
		},
		{
			id: "q2",
			label: "Mode",
			prompt: "How?",
			options: [{ value: "x", label: "X-ray" }],
			allowOther: true,
		},
	];

	it("handles cancelled", () => {
		expect(formatResult({ answers: [], cancelled: true }, qs)).toBe("User cancelled");
	});

	it("describes a picked answer", () => {
		const r = {
			answers: [
				{
					id: "q1",
					value: "a",
					label: "Alpha",
					mode: "picked" as const,
					wasRecommended: false,
				},
			],
			cancelled: false,
		};
		expect(formatResult(r, qs)).toBe("Scope: user selected: Alpha");
	});

	it("notes when a recommendation was adopted", () => {
		const r = {
			answers: [
				{
					id: "q1",
					value: "b",
					label: "Beta",
					mode: "picked" as const,
					wasRecommended: true,
				},
			],
			cancelled: false,
		};
		expect(formatResult(r, qs)).toBe("Scope: user selected (your recommendation): Beta");
	});

	it("describes an added answer", () => {
		const r = {
			answers: [
				{
					id: "q1",
					value: "custom",
					label: "custom",
					mode: "added" as const,
					basedOn: "a",
					wasRecommended: false,
				},
			],
			cancelled: false,
		};
		expect(formatResult(r, qs)).toBe('Scope: user added their own option based on "a": custom');
	});

	it("describes a replaced answer", () => {
		const r = {
			answers: [
				{
					id: "q1",
					value: "edited",
					label: "edited",
					mode: "replaced" as const,
					basedOn: "b",
					wasRecommended: true,
				},
			],
			cancelled: false,
		};
		expect(formatResult(r, qs)).toBe('Scope: user rewrote an option "b": edited');
	});

	it("describes a typed answer", () => {
		const r = {
			answers: [
				{
					id: "q1",
					value: "free text",
					label: "free text",
					mode: "typed" as const,
					wasRecommended: false,
				},
			],
			cancelled: false,
		};
		expect(formatResult(r, qs)).toBe("Scope: user wrote: free text");
	});

	it("describes a multi-select answer with every picked value", () => {
		const r = {
			answers: [
				{
					id: "q1",
					value: "a",
					label: "Alpha, Beta",
					mode: "multi" as const,
					values: ["a", "b"],
					labels: ["Alpha", "Beta"],
					wasRecommended: true,
				},
			],
			cancelled: false,
		};
		expect(formatResult(r, qs)).toBe("Scope: user selected (your recommendation): Alpha, Beta");
	});

	it("describes a multi-select answer with a typed extra value", () => {
		const r = {
			answers: [
				{
					id: "q1",
					value: "b",
					label: "Beta, gamma thing",
					mode: "multi" as const,
					values: ["b", "gamma thing"],
					labels: ["Beta", "gamma thing"],
					wasRecommended: false,
				},
			],
			cancelled: false,
		};
		expect(formatResult(r, qs)).toBe("Scope: user selected: Beta, gamma thing");
	});

	it("handles multiple answers", () => {
		const r = {
			answers: [
				{
					id: "q1",
					value: "b",
					label: "Beta",
					mode: "picked" as const,
					wasRecommended: true,
				},
				{
					id: "q2",
					value: "x",
					label: "X-ray",
					mode: "picked" as const,
					wasRecommended: false,
				},
			],
			cancelled: false,
		};
		const lines = formatResult(r, qs).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("Scope: user selected (your recommendation): Beta");
		expect(lines[1]).toBe("Mode: user selected: X-ray");
	});
});

// ---------------------------------------------------------------------------
// questionnaire tool — non-TUI fallback
// ---------------------------------------------------------------------------

describe("questionnaire tool", () => {
	const tool = createQuestionnaireTool();

	it("bails in non-TUI mode", async () => {
		const result = await tool.execute(
			"id1",
			{ questions: [{ id: "q1", prompt: "x?", options: [{ value: "a", label: "A" }] }] },
			undefined,
			undefined,
			{ mode: "headless", ui: {} } as any,
		);
		expect((result.content[0] as any).text).toContain("questionnaire needs the TUI");
	});

	it("bails with zero questions", async () => {
		const result = await tool.execute("id1", { questions: [] }, undefined, undefined, { mode: "tui", ui: {} } as any);
		expect((result.content[0] as any).text).toBe("questionnaire: no questions given");
	});

	it("has correct name and label", () => {
		expect(tool.name).toBe("questionnaire");
		expect(tool.label).toBe("Questionnaire");
	});

	it("returns a Text component from renderCall", () => {
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };
		const rendered = tool.renderCall!(
			{
				questions: [{ id: "q1", label: "Scope", prompt: "Which?", options: [] }],
			},
			theme as any,
			{} as any,
		);
		expect(rendered).toBeDefined();
	});

	it("renderResult handles cancelled", () => {
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };
		const result = {
			content: [{ type: "text", text: "User cancelled" }],
			details: { answers: [], cancelled: true },
		};
		const r = tool.renderResult!(result as any, {} as any, theme as any, {} as any);
		expect(r).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// ask tool — non-TUI fallback
// ---------------------------------------------------------------------------

describe("ask tool", () => {
	const tool = createAskTool();

	it("bails in non-TUI mode", async () => {
		const result = await tool.execute(
			"id1",
			{ questions: [{ id: "q1", prompt: "x?", options: [{ value: "a", label: "A" }] }] },
			undefined,
			undefined,
			{ mode: "headless", ui: {} } as any,
		);
		expect((result.content[0] as any).text).toContain("ask needs the TUI");
	});

	it("bails with zero questions", async () => {
		const result = await tool.execute("id1", { questions: [] }, undefined, undefined, { mode: "tui", ui: {} } as any);
		expect((result.content[0] as any).text).toBe("ask: no questions given");
	});

	it("has correct name and label", () => {
		expect(tool.name).toBe("ask");
		expect(tool.label).toBe("Ask");
	});

	it("renderResult handles success", () => {
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };
		const result = {
			content: [{ type: "text", text: "q1: user selected: Alpha" }],
			details: {
				answers: [{ id: "q1", value: "a", label: "Alpha", mode: "picked", wasRecommended: false }],
				cancelled: false,
			},
		};
		const r = tool.renderResult!(result as any, {} as any, theme as any, {} as any);
		expect(r).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// inline extension registration
// ---------------------------------------------------------------------------

describe("createInteractExtension", () => {
	it("registers questionnaire and ask tools", () => {
		const ext = createInteractExtension() as { factory: (...args: any[]) => any; hidden?: boolean };
		const registered: string[] = [];

		const pi = {
			registerTool: (def: any) => {
				registered.push(def.name);
			},
		};

		ext.factory(pi as any);

		expect(registered).toEqual(["questionnaire", "ask"]);
	});

	it("is hidden", () => {
		const ext = createInteractExtension() as { factory: (...args: any[]) => any; hidden?: boolean };
		expect(ext.hidden).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// ask panel — multi-select integration (real TUI, virtual terminal)
// ---------------------------------------------------------------------------

import type { Component, Focusable } from "../../../tui/src/tui.ts";

class TestFocusableComponent implements Component, Focusable {
	focused = false;
	private readonly label: string;
	private text = "";

	constructor(label: string) {
		this.label = label;
	}

	handleInput(_data: string): void {}

	getText(): string {
		return this.text;
	}
	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}
}

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

describe("ask multi-select panel", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	async function drive(questions: any[], keys: string[]): Promise<any> {
		const terminal = new VirtualTerminal(100, 30);
		const ui: TUI = new TuiMainScreen(terminal);
		const editor = new TestFocusableComponent("EDITOR");
		const editorContainer = new Container();
		const palette = new TestFocusableComponent("PALETTE");
		const fakeThis = {
			editor,
			editorContainer,
			keybindings: {},
			ui,
			disposeActiveSelector: () => {},
		};
		const showExtensionCustom = <T>(
			factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (r: T) => void) => Component,
		): Promise<T> => (InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, factory) as Promise<T>;

		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.addChild(palette);
		ui.setFocus(palette);
		ui.start();

		const tool = createAskTool();
		const resultPromise = tool.execute("1", { questions }, undefined, undefined, {
			mode: "tui",
			ui: { custom: (factory: any) => showExtensionCustom(factory) },
		} as any);
		await flushTui(ui, terminal);
		for (const key of keys) {
			terminal.sendInput(key);
			await flushTui(ui, terminal);
		}
		const result = await resultPromise;
		ui.stop();
		return result;
	}

	it("space toggles several options, enter submits the set", async () => {
		const result = await drive(
			[
				{
					id: "pick",
					label: "Pick",
					prompt: "Which concepts?",
					multi: true,
					options: [
						{ value: "a", label: "Alpha" },
						{ value: "b", label: "Beta" },
						{ value: "c", label: "Gamma" },
					],
				},
			],
			["\x1b[B", " ", "\x1b[B", " ", "\r"], // Beta + Gamma, submit
		);
		const a = result.details.answers[0];
		expect(a.mode).toBe("multi");
		expect(a.values).toEqual(["b", "c"]);
		expect(a.labels).toEqual(["Beta", "Gamma"]);
	});

	it("recommended options arrive pre-checked", async () => {
		const result = await drive(
			[
				{
					id: "pick",
					label: "Pick",
					prompt: "Which?",
					multi: true,
					options: [
						{ value: "a", label: "Alpha" },
						{ value: "b", label: "Beta", recommended: true },
						{ value: "c", label: "Gamma" },
					],
				},
			],
			["\r"], // enter with the pre-checked recommendation
		);
		expect(result.details.answers[0].values).toEqual(["b"]);
		expect(result.details.answers[0].wasRecommended).toBe(true);
	});

	it("submitting nothing shows a notice instead of an empty answer", async () => {
		const result = await drive(
			[
				{
					id: "pick",
					label: "Pick",
					prompt: "Which?",
					multi: true,
					options: [
						{ value: "a", label: "Alpha" },
						{ value: "b", label: "Beta" },
					],
				},
			],
			["\r", " ", "\r"], // first enter: empty → notice; then toggle a, submit
		);
		const a = result.details.answers[0];
		expect(a.mode).toBe("multi");
		expect(a.values).toEqual(["a"]);
	});

	it("single-select questions are unchanged (enter picks the highlighted option)", async () => {
		const result = await drive(
			[
				{
					id: "one",
					label: "One",
					prompt: "Which?",
					options: [
						{ value: "a", label: "Alpha" },
						{ value: "b", label: "Beta" },
					],
				},
			],
			["\x1b[B", "\r"], // down to Beta, pick
		);
		expect(result.details.answers[0].mode).toBe("picked");
		expect(result.details.answers[0].value).toBe("b");
	});
});
