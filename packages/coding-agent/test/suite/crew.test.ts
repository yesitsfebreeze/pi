/**
 * Crew — profile loading + list/status formatting. We avoid spawning real
 * headless pi processes; the runner's spawn path is exercised only through
 * the full tool action=start, which we do not call here.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCrewExtension } from "../../src/core/crew/index.ts";
import { getProfile, loadProfiles, parseProfile, renderProfileList } from "../../src/core/crew/profiles.ts";
import { runs } from "../../src/core/crew/runner.ts";

// Crew state lives under XDG_STATE_HOME, and `session_start` hydrates the
// module-level `runs` map from it. Without this the suite reads the developer's
// real ~/.local/state/pi/crew and fails the moment they have actually
// dispatched a crew agent in this repo — which is exactly what happened.
let stateHome: string | undefined;
let prevStateHome: string | undefined;

beforeEach(() => {
	prevStateHome = process.env.XDG_STATE_HOME;
	stateHome = mkdtempSync(join(tmpdir(), "pi-crew-state-"));
	process.env.XDG_STATE_HOME = stateHome;
	runs.clear();
});

afterEach(() => {
	runs.clear();
	if (prevStateHome === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = prevStateHome;
	if (stateHome) rmSync(stateHome, { recursive: true, force: true });
	stateHome = undefined;
});

function makeApi(_cwd: string) {
	const tools: Record<string, { name: string; execute: (...args: any[]) => any }> = {};
	const handlers: Record<string, Array<(...args: any[]) => any>> = {};
	const api: any = {
		on(event: string, h: (...args: any[]) => any) {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(h);
		},
		registerTool(t: any) {
			tools[t.name] = t;
		},
		registerCommand() {},
		sendUserMessage() {},
	};
	async function fire(event: string, ev: any, ctx?: any) {
		let last: any;
		for (const h of handlers[event] ?? []) last = await h(ev, ctx);
		return last;
	}
	return { api, tools, fire };
}

async function withCrew(cwd: string, fn: (h: ReturnType<typeof makeApi>) => Promise<void>) {
	const h = makeApi(cwd);
	const ext = createCrewExtension();
	ext.factory(h.api);
	await h.fire(
		"session_start",
		{ type: "session_start" },
		{
			cwd,
			ui: { setStatus: () => {}, notify: () => {} },
			sessionManager: { getSessionId: () => "test-session" },
		},
	);
	await fn(h);
	await h.fire("session_shutdown", { type: "session_shutdown" }, {});
}

describe("crew profiles", () => {
	it("loads the shipped built-in profiles", () => {
		const profiles = loadProfiles(process.cwd());
		expect(profiles.size).toBeGreaterThan(5);
		for (const id of ["worker", "scout", "code-reviewer"]) {
			expect(profiles.has(id)).toBe(true);
		}
	});

	it("parseProfile extracts description and prompt from frontmatter", () => {
		const p = parseProfile(
			"tester",
			"---\ndescription: writes tests\nmodel: claude-sonnet\n---\nYou write tests.",
			"(test)",
		);
		expect(p.name).toBe("tester");
		expect(p.description).toBe("writes tests");
		expect(p.model).toBe("claude-sonnet");
		expect(p.prompt).toContain("You write tests.");
	});

	it("renderProfileList lists names and descriptions", () => {
		const text = renderProfileList(process.cwd());
		expect(text).toContain("worker");
		expect(text).toContain("scout");
	});

	it("getProfile returns undefined for an unknown agent", () => {
		expect(getProfile(process.cwd(), "nope-no-such-agent")).toBeUndefined();
	});
});

describe("crew tool", () => {
	it("registers the crew tool and agents action lists profiles", async () => {
		await withCrew(process.cwd(), async (h) => {
			expect(h.tools.crew).toBeDefined();
			const res = await h.tools.crew.execute("1", { action: "agents" }, undefined, undefined, {
				cwd: process.cwd(),
			});
			expect(res.content[0].text).toContain("worker");
		});
	});

	it("list shows no runs initially", async () => {
		await withCrew(process.cwd(), async (h) => {
			const res = await h.tools.crew.execute("1", { action: "list" }, undefined, undefined, {
				cwd: process.cwd(),
			});
			expect(res.content[0].text).toContain("no crew dispatched");
		});
	});

	it("clear with nothing settled reports zero", async () => {
		await withCrew(process.cwd(), async (h) => {
			const res = await h.tools.crew.execute("1", { action: "clear" }, undefined, undefined, {
				cwd: process.cwd(),
			});
			expect(res.content[0].text).toContain("0 settled");
		});
	});

	it("status without a handle summarizes the runner", async () => {
		await withCrew(process.cwd(), async (h) => {
			const res = await h.tools.crew.execute("1", { action: "status" }, undefined, undefined, {
				cwd: process.cwd(),
			});
			expect(res.content[0].text).toContain("crew");
		});
	});

	it("result on an unknown handle reports no run", async () => {
		await withCrew(process.cwd(), async (h) => {
			const res = await h.tools.crew.execute("1", { action: "result", handle: "ghost" }, undefined, undefined, {
				cwd: process.cwd(),
			});
			expect(res.content[0].text).toContain("no run");
		});
	});

	it("update-node records a node in the discovery map", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-crew-disc-"));
		mkdirSync(join(dir, "packages", "a", "src"), { recursive: true });
		writeFileSync(join(dir, "packages", "a", "src", "index.ts"), "export {};\n");
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["add", "-A"], { cwd: dir });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
		try {
			await withCrew(dir, async (h) => {
				const res = await h.tools.crew.execute(
					"1",
					{ action: "update-node", node: "packages/a", note: "memory/packages-a.md" },
					undefined,
					undefined,
					{ cwd: dir },
				);
				expect(res.content[0].text).toContain("discovery map updated");
				expect(res.content[0].text).toContain("packages/a");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
