/**
 * Gantt — file-per-ticket routine board, ported into pi core.
 *
 * Tests cover the store model + derived views, the claim protocol (git
 * commit IS the lock), the loop step, the `gantt` tool, and the inline
 * extension lifecycle (status bar, walkie-talkie role wiring). Each test
 * builds a fresh `.pi/gantt/` under a temp repo so nothing escapes the run.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claim, claimNext, importance, release, staleClaims } from "../../src/core/gantt/claim.ts";
import { createGanttInlineExtension } from "../../src/core/gantt/index.ts";
import { step } from "../../src/core/gantt/message.ts";
import { boardClosed } from "../../src/core/gantt/prd.ts";
import { cursor, decisions, gantt, loadBoard, setGanttRoot } from "../../src/core/gantt/store.ts";

let repo: string;

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "gantt-test-"));
	// git init so claim()'s commit path works
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
	setGanttRoot(repo);
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

function ganttDir(): string {
	return join(repo, ".pi", "gantt");
}

function writeMap(text: string): void {
	writeFileSync(join(ganttDir(), "map.md"), text);
}

function ticket(id: string, header: string, body: string): void {
	writeFileSync(join(ganttDir(), "tickets", `${id}.md`), `---\n${header.trim()}\n---\n\n${body}\n`);
}

function initBoard(): void {
	mkdirSync(join(ganttDir(), "tickets"), { recursive: true });
	writeMap(`# Map\n\n## Destination — Phase 4\nShip it.\n\n## Notes\nn\n\n## Out of scope\nnone\n\n## Fog\nnone\n`);
}

function commitAll(msg = "init"): void {
	execFileSync("git", ["add", ".pi/gantt"], { cwd: repo });
	try {
		execFileSync("git", ["commit", "-q", "-m", msg], { cwd: repo });
	} catch {
		/* already committed */
	}
}

// ── store ──────────────────────────────────────────────────────────────────

describe("gantt store", () => {
	it("absent dir → null", () => {
		expect(loadBoard(ganttDir())).toBeNull();
	});

	it("parses map sections and tickets, computes gantt/cursor/decisions", () => {
		initBoard();
		ticket("d1", "kind: decision\nstate: done\nmode: afk", "# Pick git\nGit is canon.");
		ticket("d2", "kind: decision\nstate: done\nmode: afk", "# One-way mirror\nMirror.");
		ticket("b1", "kind: build\nstate: open\nmode: afk\nblocked-by: d1\nest: 2d\nverify: npm t", "# Store");
		ticket("b2", "kind: build\nstate: open\nmode: afk\nblocked-by: b1", "# Claim");
		ticket("b3", "kind: build\nstate: open\nmode: afk\nblocked-by: cut1", "# Render");
		ticket("cut1", "kind: build\nstate: out-of-scope\nmode: afk", "# Jira");
		ticket("h1", "kind: decision\nstate: open\nmode: hitl", "# Name the release");
		ticket("c1", "kind: build\nstate: claimed\nmode: afk\nclaim: s1", "# Loop");
		utimesSync(join(ganttDir(), "tickets", "d2.md"), new Date("2026-01-01"), new Date("2026-01-01"));
		utimesSync(join(ganttDir(), "tickets", "d1.md"), new Date("2026-01-02"), new Date("2026-01-02"));

		const board = loadBoard(ganttDir())!;
		expect(board.map.destination).toContain("Ship it.");
		expect(board.map.outOfScope).toContain("none");
		expect(board.tickets.size).toBe(8);

		// gantt: open ∧ unblocked ∧ unclaimed. b1 (d1 done), b3 (cut1 cut),
		// h1 (hitl) all qualify; b2 is blocked by an open ticket; c1 claimed.
		const ready = gantt(board)
			.map((t) => t.id)
			.sort();
		expect(ready).toEqual(["b1", "b3", "h1"]);

		const c = cursor(board);
		// out-of-scope excluded from both done and total
		expect(c.total).toBe(7);
		expect(c.done).toBe(2); // d1, d2
		expect(c.ready.sort()).toEqual(["b1", "b3", "h1"]);
		expect(c.waiting).toEqual(["h1"]);

		// decisions: closed decision tickets, oldest first
		const dec = decisions(board);
		expect(dec.map((d) => d.id)).toEqual(["d2", "d1"]);
	});

	it("rejects unknown blocked-by at load", () => {
		initBoard();
		ticket("x1", "kind: build\nstate: open\nmode: afk\nblocked-by: nope", "# X");
		expect(() => loadBoard(ganttDir())).toThrow(/unknown blocked-by "nope"/);
	});

	it("rejects bad kind/state/mode", () => {
		initBoard();
		ticket("bad", "kind: bug\nstate: open\nmode: afk", "# Bad");
		expect(() => loadBoard(ganttDir())).toThrow(/kind "bug"/);
	});
});

// ── claim ──────────────────────────────────────────────────────────────────

describe("gantt claim (git commit is the lock)", () => {
	it("claims an open ticket by rewriting its header and committing", async () => {
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk\nverify: true", "# Store");
		commitAll();
		const r = await claim(ganttDir(), "b1", "sess-A");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.ticket.state).toBe("claimed");
			expect(r.ticket.claim).toBe("sess-A");
		}
		// the file on disk reflects the claim
		const onDisk = readFileSync(join(ganttDir(), "tickets", "b1.md"), "utf8");
		expect(onDisk).toMatch(/state: claimed/);
		expect(onDisk).toMatch(/claim: sess-A/);
		// and it is committed (no staged changes)
		const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
		expect(status.trim()).toBe("");
	});

	it("a claimed ticket cannot be claimed again (taken)", async () => {
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		expect((await claim(ganttDir(), "b1", "sess-A")).ok).toBe(true);
		const r = await claim(ganttDir(), "b1", "sess-B");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("taken");
	});

	it("release closes a ticket (done) or returns it to open", async () => {
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		await claim(ganttDir(), "b1", "sess-A");
		const done = await release(ganttDir(), "b1", "sess-A", "done");
		expect(done.ok).toBe(true);
		const board = loadBoard(ganttDir())!;
		expect(board.tickets.get("b1")!.state).toBe("done");
		expect(board.tickets.get("b1")!.claim).toBeUndefined();

		// reopen
		ticket("b2", "kind: build\nstate: open\nmode: afk", "# Two");
		commitAll();
		await claim(ganttDir(), "b2", "sess-A");
		const back = await release(ganttDir(), "b2", "sess-A", "open");
		expect(back.ok).toBe(true);
		const b = loadBoard(ganttDir())!;
		expect(b.tickets.get("b2")!.state).toBe("open");
		expect(b.tickets.get("b2")!.claim).toBeUndefined();
	});

	it("importance ranks by how much open work a ticket transitively blocks", () => {
		initBoard();
		ticket("a", "kind: build\nstate: open\nmode: afk", "# a");
		ticket("b", "kind: build\nstate: open\nmode: afk\nblocked-by: a", "# b");
		ticket("c", "kind: build\nstate: open\nmode: afk\nblocked-by: b", "# c");
		ticket("d", "kind: build\nstate: open\nmode: afk", "# d");
		const board = loadBoard(ganttDir())!;
		const rank = importance(board);
		const ready = gantt(board).sort(rank);
		// a blocks b and c (2), d blocks nothing (0) → a first
		expect(ready[0].id).toBe("a");
		expect(ready[ready.length - 1].id).toBe("d");
	});

	it("claimNext claims the first ready ticket and returns none when the gantt is empty", async () => {
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		ticket("b2", "kind: build\nstate: open\nmode: afk", "# Two");
		commitAll();
		const r1 = await claimNext(ganttDir(), "sess-A");
		expect(r1.kind).toBe("claimed");
		const r2 = await claimNext(ganttDir(), "sess-A");
		expect(r2.kind).toBe("claimed");
		const r3 = await claimNext(ganttDir(), "sess-A");
		expect(r3.kind).toBe("none");
	});

	it("staleClaims surfaces a claimed ticket past threshold with no work commit", async () => {
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		await claim(ganttDir(), "b1", "sess-A");
		// backdate the claim's mtime
		const old = Date.now() - 10 * 60 * 60 * 1000;
		utimesSync(join(ganttDir(), "tickets", "b1.md"), new Date(old), new Date(old));
		const board = loadBoard(ganttDir())!;
		const stale = await staleClaims(board, 6 * 60 * 60 * 1000, Date.now());
		expect(stale.map((t) => t.id)).toEqual(["b1"]);
		// land a work commit naming the ticket → not stale
		writeFileSync(join(repo, "work.txt"), "progress");
		execFileSync("git", ["add", "work.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-q", "-m", "b1: implement store"], { cwd: repo });
		const stale2 = await staleClaims(board, 6 * 60 * 60 * 1000, Date.now());
		expect(stale2).toHaveLength(0);
	});
});

// ── step (the loop) ──────────────────────────────────────────────────────────

describe("gantt step (the loop)", () => {
	it("no-board → no-board", async () => {
		const s = await step(ganttDir(), "sess-A");
		expect(s.kind).toBe("no-board");
	});

	it("claims the next AFK ticket and returns a dispatch brief", async () => {
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk\nverify: npm t", "# Store\n\nBuild the store.");
		ticket("h1", "kind: decision\nstate: open\nmode: hitl", "# Name it");
		commitAll();
		const s = await step(ganttDir(), "sess-A");
		expect(s.kind).toBe("dispatch");
		if (s.kind === "dispatch") {
			expect(s.ticket.id).toBe("b1");
			expect(s.prompt).toContain("Ticket b1");
			expect(s.prompt).toContain("npm t");
			expect(s.unlocked).toBe(false);
		}
	});

	it("HITL tickets are never dispatched — surfaced as waiting", async () => {
		initBoard();
		ticket("h1", "kind: decision\nstate: open\nmode: hitl", "# Name it");
		commitAll();
		const s = await step(ganttDir(), "sess-A");
		expect(s.kind).toBe("empty");
		if (s.kind === "empty") expect(s.waiting).toEqual(["h1"]);
	});

	it("fans out research tickets via the spawn callback", async () => {
		initBoard();
		ticket("r1", "kind: research\nstate: open\nmode: afk", "# Research X");
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Build");
		commitAll();
		const spawned: string[] = [];
		const s = await step(ganttDir(), "sess-A", (r) => spawned.push(r.id));
		expect(spawned).toEqual(["r1"]);
		if (s.kind === "dispatch") expect(s.ticket.id).toBe("b1");
	});

	it("work-here claims inline, does not fan out research, ranks by importance", async () => {
		initBoard();
		ticket("r1", "kind: research\nstate: open\nmode: afk", "# Research X");
		ticket("a", "kind: build\nstate: open\nmode: afk", "# a");
		ticket("b", "kind: build\nstate: open\nmode: afk\nblocked-by: a", "# b");
		commitAll();
		const spawned: string[] = [];
		const s = await step(ganttDir(), "sess-A", (r) => spawned.push(r.id), true);
		expect(spawned).toHaveLength(0); // no fan-out in work-here
		expect(s.kind).toBe("dispatch");
		if (s.kind === "dispatch") expect(s.ticket.id).toBe("a"); // unblocks b
	});

	it("empty afk gantt → empty, not dispatch", async () => {
		initBoard();
		ticket("b1", "kind: build\nstate: done\nmode: afk", "# Done");
		commitAll();
		const s = await step(ganttDir(), "sess-A");
		expect(s.kind).toBe("empty");
	});
});

// ── prd idle ──────────────────────────────────────────────────────────────────

describe("gantt prd idle", () => {
	it("boardClosed is true when every ticket is done or out-of-scope", () => {
		initBoard();
		ticket("b1", "kind: build\nstate: done\nmode: afk", "# Done");
		ticket("b2", "kind: build\nstate: out-of-scope\nmode: afk", "# Cut");
		const board = loadBoard(ganttDir())!;
		expect(boardClosed(board)).toBe(true);
	});

	it("boardClosed is false when any ticket is open/claimed", () => {
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Open");
		const board = loadBoard(ganttDir())!;
		expect(boardClosed(board)).toBe(false);
	});
});

// ── inline extension ──────────────────────────────────────────────────────────

function makeApi() {
	const tools: Record<string, { execute: (...args: any[]) => any }> = {};
	const commands: Record<string, { description: string; handler: (...args: any[]) => any }> = {};
	const handlers: Record<string, Array<(...args: any[]) => any>> = {};
	const sent: { text: string; opts?: { deliverAs?: string } }[] = [];
	const notices: { text: string; level?: string }[] = [];
	const status: Record<string, string | undefined> = {};
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
		sendUserMessage(text: string, opts?: { deliverAs?: string }) {
			sent.push({ text, opts });
		},
	};
	const ctx = (cwd: string) => ({
		cwd,
		ui: {
			setStatus: (k: string, t: string | undefined) => {
				status[k] = t;
			},
			notify: (text: string, level?: string) => {
				notices.push({ text, level });
			},
		},
		sessionManager: { getSessionId: () => "test-session" },
	});
	async function fire(event: string, ev: any, c: any) {
		for (const h of handlers[event] ?? []) await h(ev, c);
	}
	return { api, tools, commands, fire, sent, notices, status, ctx };
}

describe("gantt inline extension", () => {
	it("registers the gantt tool and /gantt command", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		expect(h.tools.gantt).toBeDefined();
	});

	it("is inert (no status bar) when .pi/gantt/ is absent", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		expect(h.status.gantt).toBeUndefined();
	});

	it("sets a status bar when a board exists", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		expect(h.status.gantt).toContain("gantt 0/1");
		expect(h.status.gantt).toContain("next Store");
	});

	it("gantt tool action=status returns the one-line state", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const res = await h.tools.gantt.execute("1", { action: "status" }, undefined, undefined, h.ctx(repo));
		expect(res.content[0].text).toContain("gantt 0/1");
	});

	it("gantt tool action=work claims the next ticket and returns the brief", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk\nverify: npm t", "# Store\n\nBuild it.");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const res = await h.tools.gantt.execute("1", { action: "work" }, undefined, undefined, h.ctx(repo));
		expect(res.content[0].text).toContain("Ticket b1");
		expect(res.content[0].text).toContain("npm t");
		// the ticket is now claimed on disk
		const board = loadBoard(ganttDir())!;
		expect(board.tickets.get("b1")!.state).toBe("claimed");
	});

	it("gantt tool on an invalid board returns a reconcileError, not a crash", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		initBoard();
		ticket("bad", "kind: bug\nstate: open\nmode: afk", "# Bad");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const res = await h.tools.gantt.execute("1", { action: "status" }, undefined, undefined, h.ctx(repo));
		expect(res.content[0].text).toMatch(/invalid board data/);
		expect(res.content[0].text).toContain("kind");
	});

	it("clears status and leaves walkie-talkie scopes on shutdown", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		// stub the walkie-talkie bus so wear()'s join/leave are observable
		const joined: string[] = [];
		const left: string[] = [];
		(globalThis as any).__crew = {
			join: (s: string) => joined.push(s),
			leave: (s: string) => left.push(s),
			send: () => {},
		};
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		// enter work mode via the tool
		await h.tools.gantt.execute("1", { action: "work" }, undefined, undefined, h.ctx(repo));
		expect(joined).toContain("work");
		await h.fire("session_shutdown", { type: "session_shutdown" }, h.ctx(repo));
		expect(left).toContain("work");
		expect(h.status.gantt).toBeUndefined();
		expect((globalThis as any).__gantt).toBeUndefined();
		delete (globalThis as any).__crew;
	});

	it("work→plan auto-notify fires over the walkie-talkie bus on agent_settled", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		const sent: string[] = [];
		(globalThis as any).__crew = {
			send: (to: string, text: string) => sent.push(`${to}: ${text}`),
			join: () => {},
			leave: () => {},
		};
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		// enter work mode and claim b1
		await h.tools.gantt.execute("1", { action: "work" }, undefined, undefined, h.ctx(repo));
		// close b1 → done
		await release(ganttDir(), "b1", "test-session", "done");
		// settle should detect the new done and notify the planner
		await h.fire("agent_settled", { type: "agent_settled" }, h.ctx(repo));
		expect(sent.some((s) => s.startsWith("plan: closed b1"))).toBe(true);
		delete (globalThis as any).__crew;
	});
});

// ── conductor (continuous /gantt loop) ───────────────────────────────────────

describe("gantt conductor (continuous /gantt loop)", () => {
	it("bare /gantt arms the conductor and sends the bootstrap", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		await h.commands.gantt.handler("", h.ctx(repo));
		const boot = h.sent.find((m) => m.text.includes("gantt CONDUCTOR"));
		expect(boot).toBeDefined();
		expect(boot?.opts?.deliverAs).toBe("followUp");
		expect(boot?.text).toContain("[GANTT: DONE]");
		expect(boot?.text).toContain('action "dispatch-all"');
		// conductor state visible in the status line
		expect(h.status.gantt).toContain("conductor");
	});

	it("conductor joins both plan and work walkie-talkie scopes; stop leaves them", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		const joined: string[] = [];
		const left: string[] = [];
		(globalThis as any).__crew = {
			join: (s: string) => joined.push(s),
			leave: (s: string) => left.push(s),
			send: () => {},
		};
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		await h.commands.gantt.handler("", h.ctx(repo));
		expect(joined).toContain("plan");
		expect(joined).toContain("work");
		await h.commands.gantt.handler("stop", h.ctx(repo));
		expect(left).toContain("plan");
		expect(left).toContain("work");
		delete (globalThis as any).__crew;
	});

	it("agent_settled injects a board-derived continuation naming the ready tickets", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		await h.commands.gantt.handler("", h.ctx(repo));
		const before = h.sent.length;
		await h.fire("agent_settled", { type: "agent_settled" }, h.ctx(repo));
		const cont = h.sent.slice(before).find((m) => m.text.includes("<gantt-conductor>"));
		expect(cont).toBeDefined();
		expect(cont?.text).toContain("ready: b1");
		expect(cont?.text).toContain('action "dispatch-all"');
	});

	it("stays quiet while the board is unchanged and tickets are in flight", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		await h.commands.gantt.handler("", h.ctx(repo));
		await claim(ganttDir(), "b1", "test-session"); // in flight
		await h.fire("agent_settled", { type: "agent_settled" }, h.ctx(repo));
		const afterFirst = h.sent.length;
		expect(h.sent.slice(afterFirst - 1).some((m) => m.text.includes("<gantt-conductor>"))).toBe(true);
		await h.fire("agent_settled", { type: "agent_settled" }, h.ctx(repo));
		const injected = h.sent.slice(afterFirst).filter((m) => m.text.includes("<gantt-conductor>"));
		expect(injected).toHaveLength(0);
	});

	it("[GANTT: DONE] in an assistant message ends the loop", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		await h.commands.gantt.handler("", h.ctx(repo));
		expect(h.status.gantt).toContain("conductor");
		await h.fire(
			"message_end",
			{ type: "message_end", message: { role: "assistant", content: "All done. [GANTT: DONE]" } },
			h.ctx(repo),
		);
		expect(h.status.gantt).not.toContain("conductor");
		// a settle after DONE injects nothing
		await h.fire("agent_settled", { type: "agent_settled" }, h.ctx(repo));
		const injected = h.sent.filter((m) => m.text.includes("<gantt-conductor>"));
		expect(injected).toHaveLength(0);
	});

	it("tool action dispatch-all claims every ready ticket and returns one brief each", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		ticket("b2", "kind: build\nstate: open\nmode: afk\nblocked-by: b1", "# Claim");
		ticket("r1", "kind: research\nstate: open\nmode: afk", "# Research");
		ticket("h1", "kind: decision\nstate: open\nmode: hitl", "# Name it");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const res = await h.tools.gantt.execute("1", { action: "dispatch-all" }, undefined, undefined, h.ctx(repo));
		const text = res.content[0].text;
		expect(text).toContain("=== b1 (build)");
		expect(text).toContain("=== r1 (research)");
		expect(text).not.toContain("=== b2"); // blocked by open b1 → not ready
		expect(text).not.toContain("h1"); // hitl never dispatched
		const board = loadBoard(ganttDir())!;
		expect(board.tickets.get("b1")!.state).toBe("claimed");
		expect(board.tickets.get("r1")!.state).toBe("claimed");
		expect(board.tickets.get("b2")!.state).toBe("open");
	});

	it("tool actions conductor and stop arm and end the loop", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		initBoard();
		ticket("b1", "kind: build\nstate: open\nmode: afk", "# Store");
		commitAll();
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		const armed = await h.tools.gantt.execute("1", { action: "conductor" }, undefined, undefined, h.ctx(repo));
		expect(armed.content[0].text).toContain("gantt CONDUCTOR");
		expect(h.status.gantt).toContain("conductor");
		const stopped = await h.tools.gantt.execute("1", { action: "stop" }, undefined, undefined, h.ctx(repo));
		expect(stopped.content[0].text).toContain("conductor stopped");
		expect(h.status.gantt).not.toContain("conductor");
	});

	it("plan/work command args point at the single /gantt loop", async () => {
		const h = makeApi();
		const ext = createGanttInlineExtension();
		ext.factory(h.api);
		await h.fire("session_start", { type: "session_start" }, h.ctx(repo));
		await h.commands.gantt.handler("work", h.ctx(repo));
		expect(h.notices.some((n) => n.text.includes("one loop now"))).toBe(true);
	});
});
