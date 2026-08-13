/**
 * slim — turn distill: every tool-using turn leaves one line in the memory
 * store via the shared __kern API (best-effort, fail-open). Tests stub
 * globalThis.__kern and drive turn_end events.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlimInlineExtension } from "../../src/core/slim/index.ts";

function createExt() {
	return createSlimInlineExtension() as { factory: (pi: any) => void };
}

function makeApi() {
	const handlers: Record<string, Array<(...args: any[]) => any>> = {};
	const api: any = {
		on(event: string, h: (...args: any[]) => any) {
			handlers[event] ??= [];
			handlers[event].push(h);
		},
		registerTool() {},
		registerCommand() {},
		sendUserMessage() {},
	};
	async function fire(event: string, ev: any) {
		for (const h of handlers[event] ?? []) await h(ev, {});
	}
	return { api, fire };
}

afterEach(() => {
	delete (globalThis as any).__kern;
});

describe("slim turn distill", () => {
	it("stores one line per tool-using turn: tools → outcome", async () => {
		const stored: Array<{ title: string; text: string; extra?: string[] }> = [];
		(globalThis as any).__kern = {
			storeObservation: vi.fn(async (title: string, text: string, extra?: string[]) => {
				stored.push({ title, text, extra });
			}),
		};
		const h = makeApi();
		createExt().factory(h.api);
		await h.fire("turn_end", {
			type: "turn_end",
			turnIndex: 7,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Fixed the mem port — 42 tests pass." },
					{ type: "thinking", text: "hidden" },
				],
			},
			toolResults: [
				{ toolCallId: "1", toolName: "read", isError: false },
				{ toolCallId: "2", toolName: "edit", isError: false },
				{ toolCallId: "3", toolName: "read", isError: false },
			],
		});
		expect(stored).toHaveLength(1);
		expect(stored[0].title).toBe("slim turn 7");
		// tool names deduped, outcome = last assistant text
		expect(stored[0].text).toBe("slim turn 7: read, edit → Fixed the mem port — 42 tests pass.");
		expect(stored[0].extra).toContain("tools: read, edit");
		expect(stored[0].extra).toContain("failed: 0");
	});

	it("skips prose-only turns", async () => {
		const storeObservation = vi.fn();
		(globalThis as any).__kern = { storeObservation };
		const h = makeApi();
		createExt().factory(h.api);
		await h.fire("turn_end", {
			type: "turn_end",
			turnIndex: 3,
			message: { role: "assistant", content: [{ type: "text", text: "just talking" }] },
			toolResults: [],
		});
		expect(storeObservation).not.toHaveBeenCalled();
	});

	it("reports failed calls when the assistant produced no text", async () => {
		const stored: Array<{ text: string }> = [];
		(globalThis as any).__kern = {
			storeObservation: vi.fn(async (_t: string, text: string) => {
				stored.push({ text });
			}),
		};
		const h = makeApi();
		createExt().factory(h.api);
		await h.fire("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: { role: "assistant", content: [] },
			toolResults: [
				{ toolCallId: "1", toolName: "bash", isError: true },
				{ toolCallId: "2", toolName: "bash", isError: true },
			],
		});
		expect(stored[0].text).toBe("slim turn 1: bash → failed 2/2 tool calls");
	});

	it("caps the outcome length and tool list", async () => {
		const stored: Array<{ text: string }> = [];
		(globalThis as any).__kern = {
			storeObservation: vi.fn(async (_t: string, text: string) => {
				stored.push({ text });
			}),
		};
		const h = makeApi();
		createExt().factory(h.api);
		const toolResults = Array.from({ length: 12 }, (_, i) => ({
			toolCallId: String(i),
			toolName: `tool_${i}`,
			isError: false,
		}));
		await h.fire("turn_end", {
			type: "turn_end",
			turnIndex: 2,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "x".repeat(500) }],
			},
			toolResults,
		});
		expect(stored[0].text.length).toBeLessThan(300); // 500-char input bounded
		expect(stored[0].text).toContain(", …"); // >8 tool names truncated
	});

	it("is a no-op without the __kern store (fail-open)", async () => {
		const h = makeApi();
		createExt().factory(h.api);
		await expect(
			h.fire("turn_end", {
				type: "turn_end",
				turnIndex: 0,
				message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
				toolResults: [{ toolCallId: "1", toolName: "read", isError: false }],
			}),
		).resolves.toBeUndefined();
	});

	it("respects PI_SLIM_OFF", async () => {
		const storeObservation = vi.fn();
		(globalThis as any).__kern = { storeObservation };
		process.env.PI_SLIM_OFF = "1";
		try {
			const h = makeApi();
			createExt().factory(h.api);
			await h.fire("turn_end", {
				type: "turn_end",
				turnIndex: 0,
				message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
				toolResults: [{ toolCallId: "1", toolName: "read", isError: false }],
			});
			expect(storeObservation).not.toHaveBeenCalled();
		} finally {
			delete process.env.PI_SLIM_OFF;
		}
	});
});
