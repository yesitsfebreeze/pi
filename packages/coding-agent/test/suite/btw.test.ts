/**
 * btw — the side channel: read-only subagent in a resumable session, the
 * folded index (digest entities + tools), and rename-as-dispatch. The spawn
 * round-trip is tested with a stub `pi` binary via PI_BIN (getPiInvocation's
 * override seam); the digest halves use a temp repo with a .pi/ontology digest.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildIndex,
	createBtwInlineExtension,
	forkCommand,
	renameEntry,
	resumeCommand,
	runSideQuestion,
} from "../../src/core/btw/index.ts";
import { ensureDigest, readDigest, setOntologyRoot, writeDigest } from "../../src/core/memory/ontology.ts";

let repo: string;
let savedBin: string | undefined;

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "btw-test-"));
	savedBin = process.env.PI_BIN;
});

afterEach(() => {
	if (savedBin === undefined) delete process.env.PI_BIN;
	else process.env.PI_BIN = savedBin;
	delete (globalThis as any).__kern;
	rmSync(repo, { recursive: true, force: true });
});

function makeApi() {
	const tools: Record<string, { execute: (...args: any[]) => any }> = {};
	const handlers: Record<string, Array<(...args: any[]) => any>> = {};
	const commands: Record<string, { handler: (...args: any[]) => any }> = {};
	const sent: string[] = [];
	const api: any = {
		on(event: string, h: (...args: any[]) => any) {
			handlers[event] ??= [];
			handlers[event].push(h);
		},
		registerTool(t: any) {
			tools[t.name] = t;
		},
		registerCommand(name: string, def: any) {
			commands[name] = def;
		},
		sendUserMessage(t: string) {
			sent.push(t);
		},
		getAllTools() {
			return [{ name: "crawl", description: "Crawl a web page into the local crawl store" }];
		},
	};
	async function fire(event: string, ev: any, ctx: any) {
		for (const h of handlers[event] ?? []) await h(ev, ctx);
	}
	return { api, tools, commands, sent, fire };
}

const ctx = (cwd: string) => ({ cwd, ui: { notify: () => {}, setStatus: () => {} } });

describe("btw commands + index + rename", () => {
	it("resumeCommand/forkCommand format the carry-to-another-terminal commands", () => {
		expect(resumeCommand("/repo", "abc")).toBe("cd /repo && pi --session abc");
		expect(forkCommand("/repo", "abc")).toBe("cd /repo && pi --fork abc");
	});

	it("index folds digest entities and registered tools", () => {
		setOntologyRoot(repo);
		ensureDigest();
		const digest = readDigest() ?? "";
		writeDigest(`${digest}\n- gantt kern:abcd1234 — the ticket board | rel: crew -> crew | see: gantt tests\n`);
		const h = makeApi();
		const idx = buildIndex(h.api);
		expect(idx.some((e) => e.term === "gantt" && e.source === "entity")).toBe(true);
		expect(idx.some((e) => e.term === "crawl" && e.source === "tool")).toBe(true);
	});

	it("rename edits a digest entity in place and records a kern correction", () => {
		setOntologyRoot(repo);
		ensureDigest();
		writeDigest("- gantt kern:abcd1234 — the ticket board\n");
		const corrections: string[] = [];
		(globalThis as any).__kern = {
			storeObservation: async (_t: string, text: string) => {
				corrections.push(text);
			},
		};
		const h = makeApi();
		const r = renameEntry(h.api, "gantt", "board", repo);
		expect(r).toContain("renamed → board");
		expect(readDigest()).toContain("- board kern:abcd1234");
		expect(corrections[0]).toContain("gantt");
	});

	it("rename dispatches a NO-COMPAT task for a registered tool", () => {
		const h = makeApi();
		const r = renameEntry(h.api, "crawl", "harvest", repo);
		expect(r).toContain("dispatched");
		expect(h.sent[0]).toContain("harvest");
		expect(h.sent[0]).toContain("NO-COMPAT");
	});

	it("rename reports an unknown term", () => {
		const h = makeApi();
		expect(renameEntry(h.api, "nope", "x", repo)).toContain("not found");
	});
});

describe("btw side question (stub pi binary)", () => {
	it("runSideQuestion answers via the stubbed pi and returns the session key", async () => {
		const stub = join(repo, "stub-pi");
		writeFileSync(stub, "#!/bin/sh\nprintf 'stub answer for %s\\n' \"$*\"\n");
		chmodSync(stub, 0o755);
		process.env.PI_BIN = stub;
		const r = await runSideQuestion("what is the plan?", repo);
		expect(r.ok).toBe(true);
		expect(r.text).toContain("stub answer");
		expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("runSideQuestion reports a failing binary", async () => {
		const stub = join(repo, "stub-fail");
		writeFileSync(stub, "#!/bin/sh\necho 'boom' >&2\nexit 3\n");
		chmodSync(stub, 0o755);
		process.env.PI_BIN = stub;
		const r = await runSideQuestion("x", repo);
		expect(r.ok).toBe(false);
		expect(r.text).toContain("boom");
	});
});

describe("btw inline extension", () => {
	it("registers the btw tool and /btw command", () => {
		const h = makeApi();
		createBtwInlineExtension().factory(h.api);
		expect(h.tools.btw).toBeDefined();
		expect(h.commands.btw).toBeDefined();
	});

	it("btw tool: index lists entries", async () => {
		setOntologyRoot(repo);
		ensureDigest();
		writeDigest("- gantt kern:abcd1234 — the ticket board\n");
		const h = makeApi();
		createBtwInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" }, ctx(repo));
		const res = await h.tools.btw.execute("1", { action: "index", filter: "gantt" }, undefined, undefined, ctx(repo));
		expect(res.content[0].text).toContain("gantt");
	});

	it("btw tool: ask validates the question", async () => {
		const h = makeApi();
		createBtwInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" }, ctx(repo));
		const res = await h.tools.btw.execute("1", { action: "ask", question: "" }, undefined, undefined, ctx(repo));
		expect(res.content[0].text).toContain("btw: ask needs a question");
	});

	it("btw tool: rename dispatches for a tool", async () => {
		const h = makeApi();
		createBtwInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" }, ctx(repo));
		const res = await h.tools.btw.execute(
			"1",
			{ action: "rename", term: "crawl", next: "harvest" },
			undefined,
			undefined,
			ctx(repo),
		);
		expect(res.content[0].text).toContain("dispatched");
		expect(h.sent[0]).toContain("harvest");
	});
});
