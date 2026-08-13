/**
 * until extension — input confirmation behavior.
 *
 * The `until` core inline extension arms a goal loop when the user's
 * interactive input contains the trigger word. As of the 2026-08-13 change it
 * NO LONGER arms silently: with a UI present it prompts the user first.
 *
 * Behavior contract (core-inline-extensions.ts createUntilExtension, `input`
 * handler):
 *   - non-interactive source (rpc/extension) → never prompts, returns undefined
 *     (fall-through continue), and does NOT arm.
 *   - interactive source WITHOUT a UI (hasUI false) → arms immediately
 *     (auto-confirm "Yes"), returns { action: "continue" }.
 *   - interactive source WITH a UI + trigger word:
 *       * select returns "Yes — arm the loop" → arms, returns continue.
 *       * select returns "No — send once, no loop" → does NOT arm, returns
 *         continue (message proceeds once, no loop).
 *       * select returns undefined (Esc/cancel) → does NOT arm, returns
 *         { action: "handled" } (input is swallowed).
 *   - input with no trigger word → returns undefined (fall-through), no prompt,
 *     no arming.
 *   - input when a goal is already active → returns undefined, no prompt, no
 *     re-arming (the trigger word inside loop continuation must not re-prompt).
 *
 * These tests guard the regression where the prompt was added: a silent change
 * to "always prompt" would break headless/rpc usage (no UI) that relied on
 * auto-arm; a regression to "arm silently when UI present" would re-introduce
 * the accidental-trigger problem the prompt was added to solve.
 *
 * NOTE: UntilManager reads its trigger word from `~/.pi/agent/until-config.json`
 * via os.homedir() at construction time. To make the test deterministic and
 * independent of the developer's machine config (which may use a non-default
 * trigger word), we point HOME at a temp dir with a known config before the
 * manager is constructed.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUntilExtension } from "../../src/core/core-inline-extensions.ts";
import type { InputEvent, InputEventResult } from "../../src/core/extensions/types.ts";

let realHome: string | undefined;
let fakeHome: string;

beforeEach(() => {
	// Isolate the trigger-word config from the host machine.
	realHome = process.env.HOME;
	fakeHome = join(tmpdir(), `pi-until-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
	// Known, fixed trigger word for every assertion below.
	writeFileSync(
		join(fakeHome, ".pi", "agent", "until-config.json"),
		JSON.stringify({ triggerWord: "until", maxIterations: 50 }),
	);
	process.env.HOME = fakeHome;
});

afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(fakeHome, { recursive: true, force: true });
});

/** Minimal fake pi that captures the `input` handler the factory registers. */
interface CapturedInput {
	handler: (event: InputEvent, ctx: FakeCtx) => Promise<InputEventResult | undefined>;
}
class FakePi {
	inputs: CapturedInput[] = [];
	tools: string[] = [];
	commands: string[] = [];
	// satisfy the surface the factory touches
	on(event: string, handler: any) {
		if (event === "input") this.inputs.push({ handler });
	}
	registerTool(t: { name: string }) {
		this.tools.push(t.name);
	}
	registerCommand(name: string) {
		this.commands.push(name);
	}
	sendUserMessage() {}
	sendMessage() {}
}

interface FakeCtx {
	hasUI: boolean;
	ui: { select: (title: string, options: string[]) => Promise<string | undefined> };
}

function load(): { pi: FakePi; getInput: () => CapturedInput } {
	const pi = new FakePi();
	const ext = createUntilExtension();
	// InlineExtension.factory is the wiring function.
	(ext as any).factory(pi);
	expect(pi.inputs.length, "until extension registers exactly one input handler").toBe(1);
	return { pi, getInput: () => pi.inputs[0] };
}

/** Invoke the captured input handler with a fabricated event + ctx. */
async function fire(
	ci: CapturedInput,
	text: string,
	ctx: FakeCtx,
	source: InputEvent["source"] = "interactive",
): Promise<InputEventResult | undefined> {
	const event: InputEvent = { type: "input", text, source };
	return ci.handler(event, ctx as any);
}

describe("until input confirmation", () => {
	it("non-interactive source never prompts and does not arm (rpc/extension fall-through)", async () => {
		const { getInput } = load();
		const ci = getInput();
		let prompted = false;
		const ctx: FakeCtx = {
			hasUI: true,
			ui: {
				select: async () => {
					prompted = true;
					return "Yes — arm the loop";
				},
			},
		};
		for (const src of ["rpc", "extension"] as const) {
			prompted = false;
			const result = await fire(ci, "until this is done", ctx, src);
			expect(result, `${src}: no result → fall-through continue`).toBeUndefined();
			expect(prompted, `${src}: must not prompt`).toBe(false);
		}
	});

	it("interactive source with no UI arms immediately and continues (headless auto-confirm)", async () => {
		const { getInput } = load();
		const ci = getInput();
		let prompted = false;
		const ctx: FakeCtx = {
			hasUI: false,
			ui: {
				select: async () => {
					prompted = true;
					return "Yes — arm the loop";
				},
			},
		};
		const result = await fire(ci, "until the tests pass", ctx);
		expect(prompted, "no-UI path must not call ui.select").toBe(false);
		expect(result).toEqual({ action: "continue" });
		// Arming is observable: a second trigger input while active must NOT
		// re-prompt (the `if (mgr.active) return` guard). Prove the goal armed
		// by driving a second interactive trigger and asserting fall-through.
		prompted = false;
		const second = await fire(ci, "until something else", {
			hasUI: true,
			ui: {
				select: async () => {
					prompted = true;
					return "Yes — arm the loop";
				},
			},
		});
		expect(second, "active goal → no re-arm, fall-through").toBeUndefined();
		expect(prompted, "active goal must short-circuit before the prompt").toBe(false);
	});

	it("interactive + UI: user picks Yes → arms and continues", async () => {
		const { getInput } = load();
		const ci = getInput();
		const ctx: FakeCtx = {
			hasUI: true,
			ui: { select: async () => "Yes — arm the loop" },
		};
		const result = await fire(ci, "until done", ctx);
		expect(result).toEqual({ action: "continue" });
		// Active now: a follow-up trigger falls through (proves arming happened).
		const second = await fire(ci, "until again", ctx);
		expect(second).toBeUndefined();
	});

	it("interactive + UI: user picks No → does NOT arm and continues (send once, no loop)", async () => {
		const { getInput } = load();
		const ci = getInput();
		const ctx: FakeCtx = {
			hasUI: true,
			ui: { select: async () => "No — send once, no loop" },
		};
		const result = await fire(ci, "until done", ctx);
		expect(result).toEqual({ action: "continue" });
		// Not armed: a fresh trigger must prompt again (goal not active).
		let prompted = 0;
		const ctx2: FakeCtx = {
			hasUI: true,
			ui: {
				select: async () => {
					prompted++;
					return "No — send once, no loop";
				},
			},
		};
		await fire(ci, "until again", ctx2);
		expect(prompted, "No did not arm → next trigger re-prompts").toBe(1);
	});

	it("interactive + UI: user cancels (select returns undefined) → handled, input swallowed, no arm", async () => {
		const { getInput } = load();
		const ci = getInput();
		const ctx: FakeCtx = {
			hasUI: true,
			ui: { select: async () => undefined },
		};
		const result = await fire(ci, "until done", ctx);
		expect(result).toEqual({ action: "handled" });
		// Not armed: a fresh trigger prompts again.
		let prompted = 0;
		await fire(ci, "until again", {
			hasUI: true,
			ui: {
				select: async () => {
					prompted++;
					return undefined;
				},
			},
		});
		expect(prompted, "cancel did not arm → next trigger re-prompts").toBe(1);
	});

	it("input without the trigger word never prompts and falls through", async () => {
		const { getInput } = load();
		const ci = getInput();
		let prompted = false;
		const ctx: FakeCtx = {
			hasUI: true,
			ui: {
				select: async () => {
					prompted = true;
					return "Yes — arm the loop";
				},
			},
		};
		const result = await fire(ci, "just a normal question", ctx);
		expect(result).toBeUndefined();
		expect(prompted).toBe(false);
	});

	it("slash-command input is not treated as a trigger (detectTrigger ignores leading /)", async () => {
		const { getInput } = load();
		const ci = getInput();
		let prompted = false;
		const ctx: FakeCtx = {
			hasUI: true,
			ui: {
				select: async () => {
					prompted = true;
					return "Yes — arm the loop";
				},
			},
		};
		// "/until foo" is a command invocation, not a goal trigger.
		const result = await fire(ci, "/until do the thing", ctx);
		expect(result).toBeUndefined();
		expect(prompted).toBe(false);
	});

	it("registers the until tool and /until + /pace commands", async () => {
		const { pi } = load();
		expect(pi.tools).toContain("until");
		expect(pi.commands).toContain("until");
		expect(pi.commands).toContain("pace");
	});
});
