/**
 * reflex — measured tool surface: usage ledger, verdicts, learned triggers,
 * and the band override. State lives at <XDG_STATE_HOME>/pi/reflex/surface.json
 * (lazily resolved), so every test points XDG_STATE_HOME at a temp dir.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReflexInlineExtension } from "../../src/core/reflex/index.ts";
import {
	draw,
	exempt,
	flush,
	learnedTriggers,
	PROMOTE_AT,
	promotable,
	prune,
	rate,
	rated,
	recordUse,
	reset,
	surfaceAwareBand,
	totals,
	verdictBanded,
} from "../../src/core/reflex/surface.ts";

let stateDir: string;
let stateFile: string;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "reflex-test-"));
	stateFile = join(stateDir, "pi", "reflex", "surface.json");
	process.env.XDG_STATE_HOME = stateDir;
	reset();
});

afterEach(() => {
	delete process.env.XDG_STATE_HOME;
	reset();
	rmSync(stateDir, { recursive: true, force: true });
});

const state = () => JSON.parse(readFileSync(stateFile, "utf8"));

// ── ledger: count → flush → totals ─────────────────────────────────────────

describe("ledger counts", () => {
	it("recordUse + flush persists session counts", () => {
		recordUse("crawl");
		recordUse("crawl");
		recordUse("gantt");
		expect(totals()).toEqual({ crawl: 2, gantt: 1 }); // live, before flush
		flush();
		expect(state().counts).toEqual({ crawl: 2, gantt: 1 });
		expect(totals()).toEqual({ crawl: 2, gantt: 1 });
	});

	it("flush does not persist an empty session", () => {
		flush();
		expect(require("node:fs").existsSync(stateFile)).toBe(false);
	});

	it("session counts accumulate across flushes", () => {
		recordUse("crawl");
		flush();
		recordUse("crawl");
		flush();
		expect(state().counts.crawl).toBe(2);
	});
});

// ── prune: retire unregistered names, revive returning ones ────────────────

describe("prune", () => {
	it("retires names no longer registered, preserving history", () => {
		recordUse("gone_tool");
		flush();
		rate("gone_tool", "dead", "nobody needs it");
		const r = prune(["crawl", "gantt"]);
		expect(r.retired).toContain("gone_tool");
		const s = state();
		expect(s.retired.gone_tool.count).toBe(1);
		expect(s.retired.gone_tool.verdict.verdict).toBe("dead");
		expect(s.counts.gone_tool).toBeUndefined();
	});

	it("revives a returning name with accumulated history", () => {
		recordUse("gone_tool");
		flush();
		prune(["crawl"]);
		const r = prune(["crawl", "gone_tool"]);
		expect(r.revived).toContain("gone_tool");
		expect(state().counts.gone_tool).toBe(1);
	});

	it("never guesses when no surface is given", () => {
		recordUse("x");
		flush();
		expect(prune([])).toEqual({ retired: [], revived: [] });
		expect(state().counts.x).toBe(1);
	});
});

// ── draw: the cold half, one per session ───────────────────────────────────

describe("draw", () => {
	it("draws from the cold half (least-used), none for empty", () => {
		recordUse("hot_a");
		recordUse("hot_b");
		recordUse("hot_c");
		recordUse("hot_d");
		recordUse("hot_e");
		recordUse("hot_f");
		flush();
		const cold = new Set(["cold1", "cold2", "cold3", "cold4"]);
		for (let i = 0; i < 40; i++) {
			const d = draw(["cold1", "cold2", "cold3", "cold4", "hot_a", "hot_b", "hot_c", "hot_d"]);
			expect(d).not.toBeNull();
			expect(cold.has(d!.name)).toBe(true);
		}
	});

	it("a fresh tool has no count and enters the rotation by construction", () => {
		const d = draw(["fresh_tool", "old_thing"]);
		expect(d?.name).toBe("fresh_tool");
	});

	it("recent verdicts are excluded from the draw", () => {
		rate("rated_tool", "situational", "fine where it is");
		// two candidates: one just rated (excluded), one fresh (drawn)
		const d = draw(["rated_tool", "fresh_tool"]);
		expect(d?.name).toBe("fresh_tool");
	});

	it("returns null with no names", () => {
		expect(draw([])).toBeNull();
	});
});

// ── rate: verdicts, triggers, validation ───────────────────────────────────

describe("rate", () => {
	it("rejects an unknown verdict", () => {
		expect(rate("x", "maybe", "")).toContain("verdict must be one of");
		expect(require("node:fs").existsSync(stateFile)).toBe(false); // nothing written
	});

	it("requires a trigger for a useful verdict", () => {
		expect(rate("crawl_status", "useful", "should have checked")).toContain("needs `trigger`");
	});

	it("records useful with trigger and the learned trigger survives", () => {
		const r = rate(
			"crawl_status",
			"useful",
			"should have checked the store",
			"new repo, unknown state: crawl_status",
		);
		expect(r).toContain("rated useful");
		expect(state().verdicts.crawl_status.verdict).toBe("useful");
		expect(learnedTriggers()).toContain("new repo, unknown state: crawl_status");
	});

	it("dead drops the trigger and leaves a verdict", () => {
		rate("x", "useful", "r", "situation: x");
		rate("x", "dead", "nothing needs it");
		expect(state().verdicts.x.verdict).toBe("dead");
		expect(learnedTriggers()).toEqual([]);
	});

	it("rated() lists recent verdicts newest first", () => {
		rate("a", "dead", "old");
		rate("b", "useful", "new", "situation: b");
		const lines = rated();
		expect(lines[0]).toContain("b: useful");
		expect(lines[1]).toContain("a: dead");
	});
});

// ── band override ──────────────────────────────────────────────────────────

describe("surfaceAwareBand", () => {
	it("leaves hot builtins (rare undefined) untouched", () => {
		rate("read", "dead", "not needed");
		expect(surfaceAwareBand({ name: "read", rare: undefined })).toEqual({ name: "read", rare: undefined });
	});

	it("exempts a useful-rated tool from deferral", () => {
		rate("crawl", "useful", "should have been reached", "new topic: crawl");
		expect(surfaceAwareBand({ name: "crawl", rare: true })).toEqual({ name: "crawl", rare: false });
	});

	it("bands a dead-rated tool whatever its registration said", () => {
		rate("launch", "dead", "nobody needs it");
		expect(surfaceAwareBand({ name: "launch", rare: false })).toEqual({ name: "launch", rare: true });
	});

	it("promotes a rare tool that fired enough", () => {
		recordUse("gantt");
		recordUse("gantt");
		recordUse("gantt");
		expect(surfaceAwareBand({ name: "gantt", rare: true })).toEqual({ name: "gantt", rare: false });
	});

	it("keeps an unused rare tool rare", () => {
		expect(surfaceAwareBand({ name: "until", rare: true })).toEqual({ name: "until", rare: true });
	});

	it("respects PI_REFLEX_OFF", () => {
		rate("crawl", "useful", "r", "situation: crawl");
		process.env.PI_REFLEX_OFF = "1";
		try {
			expect(surfaceAwareBand({ name: "crawl", rare: true })).toEqual({ name: "crawl", rare: true });
		} finally {
			delete process.env.PI_REFLEX_OFF;
		}
	});
});

describe("exempt / verdictBanded / promotable", () => {
	it("exempt lists useful-rated and over-fired tools", () => {
		rate("crawl", "useful", "r", "situation: crawl");
		recordUse("gantt");
		recordUse("gantt");
		recordUse("gantt");
		const list = exempt(new Set(["crawl", "gantt", "until"])).sort();
		expect(list).toEqual(["crawl", "gantt"].sort());
	});

	it("verdictBanded lists situational and dead tools", () => {
		rate("a", "situational", "idle");
		rate("b", "dead", "gone");
		rate("c", "useful", "keep", "situation: c");
		expect(verdictBanded().sort()).toEqual(["a", "b"].sort());
	});

	it("promotable names over-fired rare tools with counts", () => {
		recordUse("until");
		recordUse("until");
		recordUse("until");
		const list = promotable(new Set(["until"]));
		expect(list).toEqual([`until (${PROMOTE_AT})`]);
	});
});

// ── inline extension lifecycle ─────────────────────────────────────────────

function makeApi() {
	const tools: Record<string, { execute: (...args: any[]) => any }> = {};
	const handlers: Record<string, Array<(...args: any[]) => any>> = {};
	const api: any = {
		on(event: string, h: (...args: any[]) => any) {
			handlers[event] ??= [];
			handlers[event].push(h);
		},
		registerTool(t: any) {
			tools[t.name] = t;
		},
		registerCommand() {},
		sendUserMessage() {},
		getAllTools() {
			return [{ name: "crawl" }, { name: "gantt" }, { name: "until" }];
		},
	};
	async function fire(event: string, ev: any) {
		const out: any[] = [];
		for (const h of handlers[event] ?? []) out.push(await h(ev, {}));
		return out;
	}
	return { api, tools, fire, handlers };
}

describe("reflex inline extension", () => {
	it("registers the reflex tool", () => {
		const h = makeApi();
		createReflexInlineExtension().factory(h.api);
		expect(Object.keys(h.tools)).toEqual(["reflex"]);
	});

	it("counts tool fires via tool_call and flushes on shutdown", async () => {
		const h = makeApi();
		createReflexInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" });
		await h.fire("tool_call", { toolName: "crawl" });
		await h.fire("tool_call", { toolName: "crawl" });
		await h.fire("session_shutdown", { type: "session_shutdown" });
		expect(state().counts.crawl).toBe(2);
	});

	it("injects the evaluation request when a tool is drawn", async () => {
		const h = makeApi();
		createReflexInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" });
		const out = await h.fire("before_agent_start", { systemPrompt: "base" });
		const sp = out?.[0]?.systemPrompt ?? "";
		expect(sp).toContain("Tool evaluation due");
		expect(sp).toContain("action=rate");
	});

	it("injects learned triggers from past useful verdicts", async () => {
		rate("crawl", "useful", "r", "new topic, need store overview: crawl");
		const h = makeApi();
		createReflexInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" });
		const out = await h.fire("before_agent_start", { systemPrompt: "base" });
		const sp = out?.[0]?.systemPrompt ?? "";
		expect(sp).toContain("new topic, need store overview: crawl");
	});

	it("rate round-trips through the tool", async () => {
		const h = makeApi();
		createReflexInlineExtension().factory(h.api);
		const res = await h.tools.reflex.execute(
			"1",
			{ action: "rate", name: "crawl", verdict: "useful", reason: "needed it", trigger: "new topic: crawl" },
			undefined,
			undefined,
			{},
		);
		expect(res.content[0].text).toContain("rated useful");
		expect(state().verdicts.crawl.verdict).toBe("useful");
	});

	it("reflex tool validates and reports", async () => {
		const h = makeApi();
		createReflexInlineExtension().factory(h.api);
		const bad = await h.tools.reflex.execute(
			"1",
			{ action: "rate", name: "x", verdict: "maybe" },
			undefined,
			undefined,
			{},
		);
		expect(bad.content[0].text).toContain("verdict must be one of");
		const report = await h.tools.reflex.execute("1", { action: "report" }, undefined, undefined, {});
		expect(report.content[0].text).toBe("reflex: no verdicts recorded yet");
	});
});
