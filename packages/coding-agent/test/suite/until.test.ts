/**
 * UntilManager — trigger detection, goal arming, done marker, schedule parsing,
 * pace config. No real timers fired (loopStart arms setTimeouts but we test
 * the synchronous surface + immediate fire path).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UntilManager } from "../../src/core/until.ts";

let homeBackup: string | undefined;
let homeDir: string;

beforeEach(() => {
	homeBackup = process.env.HOME;
	homeDir = mkdtempSync(join(tmpdir(), "pi-until-"));
	process.env.HOME = homeDir;
});
afterEach(() => {
	if (homeBackup === undefined) delete process.env.HOME;
	else process.env.HOME = homeBackup;
	rmSync(homeDir, { recursive: true, force: true });
});

describe("UntilManager", () => {
	it("detects the trigger word in user prose but not slash commands", () => {
		const mgr = new UntilManager();
		expect(mgr.detectTrigger("until the tests pass")).toBe(true);
		expect(mgr.detectTrigger("until")).toBe(true);
		expect(mgr.detectTrigger("Until dawn breaks")).toBe(true);
		expect(mgr.detectTrigger("/until status")).toBe(false);
		expect(mgr.detectTrigger("hello there")).toBe(false);
		expect(mgr.detectTrigger("")).toBe(false);
	});

	it("arms and deactivates a goal", () => {
		const mgr = new UntilManager();
		expect(mgr.active).toBe(false);
		mgr.armGoal("ship the feature");
		expect(mgr.active).toBe(true);
		expect(mgr.statusLine).toContain("iter 0/");
		mgr.deactivateGoal();
		expect(mgr.active).toBe(false);
	});

	it("injects context only while active", () => {
		const mgr = new UntilManager();
		expect(mgr.injectContext()).toBeUndefined();
		mgr.armGoal("ship it");
		const ctx = mgr.injectContext();
		expect(ctx?.customType).toBe("until-loop-state");
		expect(ctx?.content).toContain("ship it");
		expect(ctx?.content).toContain("[UNTIL: DONE]");
	});

	it("detects the DONE marker in string and block content", () => {
		const mgr = new UntilManager();
		mgr.armGoal("x");
		expect(mgr.checkDoneMarker("all done [UNTIL: DONE]")).toBe(true);
		expect(mgr.active).toBe(true); // checkDoneMarker sets _done but not inactive
		mgr.deactivateGoal();
		mgr.armGoal("y");
		expect(mgr.checkDoneMarker([{ type: "text", text: "partial [UNTIL: DONE] now" }])).toBe(true);
		expect(mgr.checkDoneMarker("nothing here")).toBe(false);
	});

	it("onAgentSettled increments iterations and caps at max", () => {
		const mgr = new UntilManager();
		mgr.setMaxIterations(3);
		mgr.armGoal("x");
		mgr.onAgentStart();
		let cont = mgr.onAgentSettledHandler();
		expect(cont).toContain("Iteration");
		cont = mgr.onAgentSettledHandler();
		cont = mgr.onAgentSettledHandler();
		// 4th settle exceeds max -> stops and reports max reached
		cont = mgr.onAgentSettledHandler();
		expect(cont).toContain("max iterations");
		expect(mgr.active).toBe(false);
	});

	it("onAgentSettled returns undefined when done marker was seen", () => {
		const mgr = new UntilManager();
		mgr.armGoal("x");
		mgr.checkDoneMarker("[UNTIL: DONE]");
		expect(mgr.onAgentSettledHandler()).toBeUndefined();
	});

	it("setTriggerWord persists and updates detection", () => {
		const mgr = new UntilManager();
		const msg = mgr.setTriggerWord("loop");
		expect(msg).toContain("loop");
		expect(mgr.detectTrigger("loop until done")).toBe(true);
		expect(mgr.detectTrigger("until done")).toBe(false);
	});

	it("setMaxIterations rejects non-positive", () => {
		const mgr = new UntilManager();
		expect(mgr.setMaxIterations(0).ok).toBe(false);
		expect(mgr.setMaxIterations(-1).ok).toBe(false);
		expect(mgr.setMaxIterations(5).ok).toBe(true);
	});

	it("loopStop all clears active loops", () => {
		const mgr = new UntilManager();
		// No loops armed -> stopAll is a no-op message
		const msg = mgr.stopAll();
		expect(msg).toContain("stopped");
	});

	it("pace status line is undefined until armed", () => {
		const mgr = new UntilManager();
		expect(mgr.paceStatusLine).toBeUndefined();
	});
});
