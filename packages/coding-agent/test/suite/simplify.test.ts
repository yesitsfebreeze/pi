/**
 * simplify — behavior tests for the post-change follow-up extension.
 *
 * Registration was already pinned by core-inline-extensions.test.ts; this
 * covers what the extension actually decides: when it injects its principles,
 * which tool calls count as a change, and how often it is allowed to nag.
 *
 * The module keeps `changedFiles` / `simplifyReminderCount` at module scope, so
 * every test imports a fresh copy via `vi.resetModules()` — otherwise state
 * leaks between cases and the reminder cap looks satisfied when it isn't.
 */

import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve("/workspace");

interface Harness {
	tools: any[];
	commands: Record<string, any>;
	sent: string[];
	fire: (event: string, ev?: any, ctx?: any) => Promise<any>;
}

async function mountSimplify(cwd = ROOT): Promise<Harness> {
	vi.resetModules();
	const { createSimplifyExtension } = await import("../../src/core/simplify/index.ts");

	const handlers: Record<string, Array<(...a: any[]) => any>> = {};
	const tools: any[] = [];
	const commands: Record<string, any> = {};
	const sent: string[] = [];

	const api: any = {
		on(event: string, h: (...a: any[]) => any) {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(h);
		},
		registerTool(t: any) {
			tools.push(t);
		},
		registerCommand(name: string, opts: any) {
			commands[name] = opts;
		},
		sendUserMessage(msg: string) {
			sent.push(msg);
		},
	};

	createSimplifyExtension()(api);

	const fire = async (event: string, ev?: any, ctx?: any) => {
		let last: any;
		for (const h of handlers[event] ?? []) last = await h(ev, ctx);
		return last;
	};

	await fire("session_start", { type: "session_start" }, { cwd, ui: { setStatus: () => {} } });
	return { tools, commands, sent, fire };
}

/** Enter/leave the gantt work loop the extension gates most behavior on. */
function setGanttRole(role: string | undefined): void {
	const g = globalThis as Record<string, unknown>;
	if (role === undefined) delete g.__gantt;
	else g.__gantt = { role };
}

beforeEach(() => setGanttRole(undefined));
afterEach(() => setGanttRole(undefined));

describe("simplify registration", () => {
	it("registers the simplify tool and the /simplify command", async () => {
		const h = await mountSimplify();
		expect(h.tools.map((t) => t.name)).toEqual(["simplify"]);
		expect(Object.keys(h.commands)).toEqual(["simplify"]);
	});

	it("gives the tool a prompt snippet so it survives the tool band", async () => {
		const h = await mountSimplify();
		// Banded tools keep only name + snippet in the prompt; without a snippet
		// the model cannot discover the tool well enough to restore it.
		expect(h.tools[0].promptSnippet).toBeTruthy();
	});
});

describe("simplify principles injection", () => {
	it("injects nothing on an ordinary turn", async () => {
		const h = await mountSimplify();
		const result = await h.fire("before_agent_start", { systemPrompt: "BASE" });
		expect(result).toBeUndefined();
	});

	it("appends the principles inside a gantt work loop", async () => {
		const h = await mountSimplify();
		setGanttRole("work");
		const result = await h.fire("before_agent_start", { systemPrompt: "BASE" });
		expect(result.systemPrompt).toContain("BASE");
		expect(result.systemPrompt).toContain("Simplify principles");
	});

	it("stays quiet for a non-work gantt role", async () => {
		const h = await mountSimplify();
		setGanttRole("plan");
		expect(await h.fire("before_agent_start", { systemPrompt: "BASE" })).toBeUndefined();
	});
});

describe("simplify change tracking", () => {
	const settle = async (h: Harness) => {
		setGanttRole("work");
		await h.fire("agent_settled", {});
	};

	it("nags after an edit inside the workspace", async () => {
		const h = await mountSimplify();
		await h.fire("tool_call", { toolName: "edit", input: { path: `${ROOT}/src/a.ts` } });
		await settle(h);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toContain("simplify");
	});

	it("ignores non-edit tools", async () => {
		const h = await mountSimplify();
		await h.fire("tool_call", { toolName: "read", input: { path: `${ROOT}/src/a.ts` } });
		await settle(h);
		expect(h.sent).toEqual([]);
	});

	it("ignores edits that escape the workspace root", async () => {
		const h = await mountSimplify();
		await h.fire("tool_call", { toolName: "write", input: { path: "/etc/passwd" } });
		await settle(h);
		expect(h.sent).toEqual([]);
	});

	it("accepts file_path as well as path", async () => {
		const h = await mountSimplify();
		await h.fire("tool_call", { toolName: "write", input: { file_path: `${ROOT}/src/b.ts` } });
		await settle(h);
		expect(h.sent).toHaveLength(1);
	});

	it("never nags outside a gantt work loop, however much changed", async () => {
		const h = await mountSimplify();
		await h.fire("tool_call", { toolName: "edit", input: { path: `${ROOT}/src/a.ts` } });
		await h.fire("agent_settled", {});
		expect(h.sent).toEqual([]);
	});

	it("nags at most once per change, across repeated settles", async () => {
		const h = await mountSimplify();
		await h.fire("tool_call", { toolName: "edit", input: { path: `${ROOT}/src/a.ts` } });
		await settle(h);
		await settle(h);
		await settle(h);
		expect(h.sent).toHaveLength(1);
	});
});
