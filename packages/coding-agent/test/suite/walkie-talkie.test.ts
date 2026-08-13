/**
 * Walkie-talkie — the maildir channel, presence, and the crew bridge.
 *
 * The channel lives under XDG_STATE_HOME (read lazily by `stateRoot()`), so
 * every test points that env at a fresh temp dir to isolate the maildir and
 * the presence directory from the host's real state.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	adopt,
	channelDir,
	drain,
	dropCursor,
	mailDir,
	parseMessage,
	post,
	sweep,
} from "../../src/core/crew/channel.ts";
import { createWalkieTalkie, registerWalkieTalkieTools, startWalkieTalkie } from "../../src/core/crew/crew-bridge.ts";
import { createCrewExtension } from "../../src/core/crew/index.ts";
import {
	activeDir,
	announce,
	displayName,
	hotness,
	leave,
	parseRecap,
	peers,
	renderPeers,
	resolve,
	STALE_MS,
	scopes,
} from "../../src/core/crew/presence.ts";
import {
	answerQuestion,
	listQuestions,
	questionsBy,
	questionsFor,
	raiseQuestion,
} from "../../src/core/crew/questions.ts";
import { runs } from "../../src/core/crew/runner.ts";
import type { CrewRun } from "../../src/core/crew/types.ts";

const REPO = "/tmp/fake-repo";

let stateDir: string;
let savedXdg: string | undefined;

beforeEach(() => {
	savedXdg = process.env.XDG_STATE_HOME;
	stateDir = mkdtempSync(join(tmpdir(), "crew-test-"));
	process.env.XDG_STATE_HOME = stateDir;
});

afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(stateDir, { recursive: true, force: true });
});

function makeApi() {
	const tools: Record<string, { execute: (...args: any[]) => any; parameters: unknown }> = {};
	const handlers: Record<string, Array<(...args: any[]) => any>> = {};
	const sent: { text: string; opts?: { deliverAs?: string } }[] = [];
	const api: any = {
		on(event: string, h: (...args: any[]) => any) {
			handlers[event] ??= [];
			handlers[event].push(h);
		},
		registerTool(t: any) {
			tools[t.name] = t;
		},
		registerCommand() {},
		sendUserMessage(text: string, opts?: { deliverAs?: string }) {
			sent.push({ text, opts });
		},
	};
	async function fire(event: string, ev: any, ctx?: any) {
		let last: any;
		for (const h of handlers[event] ?? []) last = await h(ev, ctx);
		return last;
	}
	return { api, tools, fire, sent };
}

// ── channel.ts ─────────────────────────────────────────────────────────────

describe("walkie-talkie channel", () => {
	it("posts messages as lexically-ordered files and parses them back", () => {
		const f1 = post(REPO, { to: "alice", from: "bob", text: "hello" });
		const f2 = post(REPO, { to: "alice", from: "bob", text: "world" });
		expect(f1).toMatch(/^\d{4}-\d{2}-\d{2}T.*-0000\.md$/);
		expect(f2 > f1).toBe(true);
		const files = readdirSync(mailDir(REPO)).filter((f) => f.endsWith(".md"));
		expect(files).toHaveLength(2);
		const msg = parseMessage(f1, readFileSync(join(mailDir(REPO), f1), "utf8"));
		expect(msg.to).toBe("alice");
		expect(msg.from).toBe("bob");
		expect(msg.kind).toBe("say");
		expect(msg.text).toBe("hello");
	});

	it("rejects broadcast addresses at the wire", () => {
		expect(() => post(REPO, { to: "all", from: "x", text: "hi" })).toThrow();
		expect(() => post(REPO, { to: "", from: "x", text: "hi" })).toThrow();
		expect(() => post(REPO, { to: "all", from: "x", text: "hi" })).toThrow(/no broadcast address/);
	});

	it("drains only messages addressed to the reader, once", () => {
		post(REPO, { to: "alice", from: "bob", text: "for alice" });
		post(REPO, { to: "carol", from: "bob", text: "for carol" });
		const mine = drain(REPO, "alice");
		expect(mine).toHaveLength(1);
		expect(mine[0].text).toBe("for alice");
		// second drain reads nothing — the cursor advanced
		expect(drain(REPO, "alice")).toHaveLength(0);
	});

	it("drains by id and by scope via addrs", () => {
		post(REPO, { to: "alice", from: "bob", text: "1" });
		post(REPO, { to: "auth", from: "bob", text: "2" });
		// alice answers to both her id and the `auth` scope
		const mine = drain(REPO, "alice", ["auth"]);
		expect(mine.map((m) => m.text).sort()).toEqual(["1", "2"]);
	});

	it("adopt advances the cursor without delivering, so past mail is not a trigger", () => {
		post(REPO, { to: "alice", from: "bob", text: "old" });
		adopt(REPO, "alice");
		expect(drain(REPO, "alice")).toHaveLength(0);
	});

	it("dropCursor resets the reader so a fresh drain re-reads", () => {
		post(REPO, { to: "alice", from: "bob", text: "again" });
		expect(drain(REPO, "alice")).toHaveLength(1);
		dropCursor(REPO, "alice");
		expect(drain(REPO, "alice")).toHaveLength(1);
	});

	it("sweep deletes messages older than maxAgeMs and leaves newer ones", () => {
		const now = Date.now();
		post(REPO, { to: "alice", from: "bob", text: "old" }, now - 2 * 60 * 60 * 1000);
		post(REPO, { to: "alice", from: "bob", text: "new" }, now);
		const n = sweep(REPO, 60 * 60 * 1000, now);
		expect(n).toBe(1);
		const remaining = readdirSync(mailDir(REPO)).filter((f) => f.endsWith(".md"));
		expect(remaining).toHaveLength(1);
		expect(parseMessage(remaining[0], readFileSync(join(mailDir(REPO), remaining[0]), "utf8")).text).toBe("new");
	});

	it("slug keeps two checkouts of the same project apart", () => {
		expect(channelDir("/Users/x/proj")).not.toBe(channelDir("/Users/y/proj"));
		expect(channelDir("/Users/x/proj")).toContain("Users-x-proj");
	});
});

// ── presence.ts ────────────────────────────────────────────────────────────

describe("walkie-talkie presence", () => {
	it("announces a peer and lists it while its heartbeat is fresh", () => {
		const now = Date.now();
		announce(REPO, {
			sessionId: "s1",
			pid: 1,
			cwd: REPO,
			scopes: ["auth"],
			doing: "writing tests",
			startedAt: new Date(now).toISOString(),
			lastHeartbeat: new Date(now).toISOString(),
		});
		const list = peers(REPO, now);
		expect(list).toHaveLength(1);
		expect(list[0].sessionId).toBe("s1");
		expect(list[0].scopes).toEqual(["auth"]);
		expect(list[0].doing).toBe("writing tests");
	});

	it("reaps stale peers", () => {
		const now = Date.now();
		announce(REPO, {
			sessionId: "stale",
			pid: 1,
			cwd: REPO,
			scopes: [],
			startedAt: new Date(now - STALE_MS * 2).toISOString(),
			lastHeartbeat: new Date(now - STALE_MS * 2).toISOString(),
		});
		expect(peers(REPO, now)).toHaveLength(0);
		// the stale file was unlinked
		expect(existsSync(join(activeDir(REPO), "stale.json"))).toBe(false);
	});

	it("leave removes the peer file and drops the cursor", () => {
		announce(REPO, {
			sessionId: "gone",
			pid: 1,
			cwd: REPO,
			scopes: [],
			startedAt: new Date().toISOString(),
			lastHeartbeat: new Date().toISOString(),
		});
		leave(REPO, "gone");
		expect(peers(REPO)).toHaveLength(0);
	});

	it("resolve matches a session id prefix, then a scope, and never 'all'", () => {
		const now = Date.now();
		announce(REPO, {
			sessionId: "crew-scout-abcd1234",
			pid: 1,
			cwd: REPO,
			scopes: ["auth-rewrite"],
			startedAt: new Date(now).toISOString(),
			lastHeartbeat: new Date(now).toISOString(),
		});
		announce(REPO, {
			sessionId: "pi-deadbeef",
			pid: 2,
			cwd: REPO,
			scopes: [],
			startedAt: new Date(now).toISOString(),
			lastHeartbeat: new Date(now).toISOString(),
		});
		// prefix match
		expect(resolve(REPO, "pi-dead", now)).toEqual(["pi-deadbeef"]);
		// scope match
		expect(resolve(REPO, "auth-rewrite", now)).toEqual(["crew-scout-abcd1234"]);
		// 'all' resolves to nothing
		expect(resolve(REPO, "all", now)).toEqual([]);
		// unknown resolves to nothing
		expect(resolve(REPO, "nobody", now)).toEqual([]);
	});

	it("scopes maps every scope with a live member to its members", () => {
		const now = Date.now();
		announce(REPO, {
			sessionId: "a",
			pid: 1,
			cwd: REPO,
			scopes: ["auth", "plan"],
			startedAt: new Date(now).toISOString(),
			lastHeartbeat: new Date(now).toISOString(),
		});
		announce(REPO, {
			sessionId: "b",
			pid: 2,
			cwd: REPO,
			scopes: ["auth"],
			startedAt: new Date(now).toISOString(),
			lastHeartbeat: new Date(now).toISOString(),
		});
		const map = scopes(REPO, now);
		expect(
			map
				.get("auth")!
				.map((p) => p.sessionId)
				.sort(),
		).toEqual(["a", "b"]);
		expect(map.get("plan")!.map((p) => p.sessionId)).toEqual(["a"]);
	});

	it("hotness ranks working+fresh above idle+stale, and big above small", () => {
		const now = Date.now();
		const iso = (ms: number) => new Date(ms).toISOString();
		announce(REPO, {
			sessionId: "idle-big",
			pid: 1,
			cwd: REPO,
			scopes: [],
			state: "idle",
			messageCount: 500,
			startedAt: iso(now - 1000),
			lastActivity: iso(now - 90_000),
			lastHeartbeat: iso(now),
		});
		announce(REPO, {
			sessionId: "working-fresh",
			pid: 2,
			cwd: REPO,
			scopes: [],
			state: "working",
			messageCount: 10,
			startedAt: iso(now - 1000),
			lastActivity: iso(now),
			lastHeartbeat: iso(now),
		});
		expect(hotness(peers(REPO, now)[0], now)).toBeGreaterThan(hotness(peers(REPO, now)[1], now));
		expect(peers(REPO, now).map((p) => p.sessionId)).toEqual(["working-fresh", "idle-big"]);
	});

	it("parseRecap extracts mission/task/next and drops angle-bracket placeholders", () => {
		const recap = parseRecap(
			"done.\n<recap>\nMISSION: ship it\nTASK: <one short sentence — the specific thing>\nNEXT: run tests\n</recap>",
		);
		expect(recap).toEqual({ mission: "ship it", next: "run tests" });
		expect(parseRecap("no recap block here")).toEqual({});
	});

	it("displayName prefers the session's own name over the id prefix", () => {
		expect(
			displayName({
				sessionId: "abcdef1234567890",
				pid: 1,
				cwd: REPO,
				scopes: [],
				startedAt: "",
				lastHeartbeat: "",
			}),
		).toBe("abcdef123456");
		expect(
			displayName({
				sessionId: "abcdef1234567890",
				pid: 1,
				cwd: REPO,
				scopes: [],
				name: "Auth Rework",
				startedAt: "",
				lastHeartbeat: "",
			}),
		).toBe("Auth Rework");
	});

	it("renderPeers shows name, state, size, age, and mission lines", () => {
		const now = Date.now();
		announce(REPO, {
			sessionId: "aaa",
			pid: 1,
			cwd: REPO,
			scopes: ["auth"],
			name: "Auth Rework",
			state: "working",
			messageCount: 42,
			doing: "editing presence",
			mission: "ship",
			task: "sort",
			next: "test",
			startedAt: new Date(now).toISOString(),
			lastActivity: new Date(now).toISOString(),
			lastHeartbeat: new Date(now).toISOString(),
		});
		const out = renderPeers(peers(REPO, now), "me", now);
		expect(out).toContain("Auth Rework");
		expect(out).toContain("working");
		expect(out).toContain("42 msgs");
		expect(out).toContain("mission: ship");
	});
});

// ── bridge + crew action=say ────────────────────────────────────────────────

describe("walkie-talkie bridge", () => {
	it("createWalkieTalkie exposes addr/scopes/send/drain", () => {
		const now = Date.now();
		announce(REPO, {
			sessionId: "alice",
			pid: 1,
			cwd: REPO,
			scopes: [],
			startedAt: new Date(now).toISOString(),
			lastHeartbeat: new Date(now).toISOString(),
		});
		const crew = createWalkieTalkie(REPO, "me", () => ["auth"]);
		expect(crew.addr()).toBe("me");
		expect(crew.scopes()).toEqual(["auth"]);
		crew.send("alice", "hi");
		expect(drain(REPO, "alice").map((m) => m.text)).toEqual(["hi"]);
		// send resolves the target — 'all' sends to nobody
		crew.send("all", "broadcast");
		expect(drain(REPO, "alice")).toHaveLength(0);
	});

	it("registerWalkieTalkieTools registers crew_send/crew_recv/crew_scope/crew_list", () => {
		const h = makeApi();
		const crew = createWalkieTalkie(REPO, "me", () => []);
		registerWalkieTalkieTools(h.api, crew, REPO, "me", () => {});
		for (const name of ["crew_send", "crew_recv", "crew_scope", "crew_list"]) {
			expect(h.tools[name]).toBeDefined();
		}
	});

	it("crew_send resolves the target and posts one message per recipient", async () => {
		const now = Date.now();
		announce(REPO, {
			sessionId: "alice1234",
			pid: 1,
			cwd: REPO,
			scopes: ["auth"],
			startedAt: new Date(now).toISOString(),
			lastHeartbeat: new Date(now).toISOString(),
		});
		const h = makeApi();
		const crew = createWalkieTalkie(REPO, "me", () => []);
		registerWalkieTalkieTools(h.api, crew, REPO, "me", () => {});
		const res = await h.tools.crew_send.execute("1", { to: "auth", body: "team hi" });
		expect(res.details.targets).toEqual(["alice1234"]);
		expect(drain(REPO, "alice1234").map((m) => m.text)).toEqual(["team hi"]);
	});

	it("crew_send rejects 'all' with guidance", async () => {
		const h = makeApi();
		const crew = createWalkieTalkie(REPO, "me", () => []);
		registerWalkieTalkieTools(h.api, crew, REPO, "me", () => {});
		const res = await h.tools.crew_send.execute("1", { to: "all", body: "x" });
		expect(res.content[0].text).toMatch(/no broadcast address/);
		expect(res.details.targets).toEqual([]);
	});

	it("crew_recv drains messages for this session", async () => {
		const now = Date.now();
		announce(REPO, {
			sessionId: "me",
			pid: 1,
			cwd: REPO,
			scopes: [],
			startedAt: new Date(now).toISOString(),
			lastHeartbeat: new Date(now).toISOString(),
		});
		const h = makeApi();
		const crew = createWalkieTalkie(REPO, "me", () => []);
		registerWalkieTalkieTools(h.api, crew, REPO, "me", () => {});
		post(REPO, { to: "me", from: "alice", text: "ping" });
		const res = await h.tools.crew_recv.execute("1", {});
		expect(res.content[0].text).toContain("ping");
		expect(res.details.count).toBe(1);
		// second recv is quiet — read once
		const res2 = await h.tools.crew_recv.execute("1", {});
		expect(res2.content[0].text).toBe("channel is quiet");
	});

	it("crew_scope joins/leaves scopes and reports change", async () => {
		const h = makeApi();
		startWalkieTalkie(h.api, REPO, "me", [], REPO);
		const bus = (globalThis as any).__crew;
		const res = await h.tools.crew_scope.execute("1", { join: ["auth", "plan"], doing: "tests" });
		expect(bus.scopes().sort()).toEqual(["auth", "plan"]);
		expect(res.details.doing).toBe("tests");
		const res2 = await h.tools.crew_scope.execute("1", { leave: ["auth"] });
		expect(bus.scopes()).toEqual(["plan"]);
		expect(res2.content[0].text).toMatch(/left: auth/);
		await h.fire("session_shutdown", { type: "session_shutdown" });
	});

	it("crew_list renders peers and scopes", async () => {
		const now = Date.now();
		announce(REPO, {
			sessionId: "other",
			pid: 1,
			cwd: REPO,
			scopes: ["auth"],
			startedAt: new Date(now).toISOString(),
			lastHeartbeat: new Date(now).toISOString(),
		});
		const h = makeApi();
		const crew = createWalkieTalkie(REPO, "me", () => []);
		registerWalkieTalkieTools(h.api, crew, REPO, "me", () => {});
		const res = await h.tools.crew_list.execute("1", {});
		expect(res.content[0].text).toContain("other");
		expect(res.content[0].text).toContain("Scopes:");
	});

	it("urgent mail is re-injected as a follow-up on agent_settled", async () => {
		const h = makeApi();
		startWalkieTalkie(h.api, REPO, "me", [], REPO);
		post(REPO, { to: "me", from: "alice", text: "STOP", urgent: true });
		await h.fire("agent_settled", { type: "agent_settled" });
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].opts?.deliverAs).toBe("followUp");
		expect(h.sent[0].text).toMatch(/URGENT/);
		// non-urgent mail is NOT re-injected (it waits for crew_recv)
		h.sent.length = 0;
		post(REPO, { to: "me", from: "alice", text: "whenever" });
		await h.fire("agent_settled", { type: "agent_settled" });
		expect(h.sent).toHaveLength(0);
	});

	it("publishes working/idle state and mission/task/next from the recap", async () => {
		const h = makeApi();
		startWalkieTalkie(h.api, REPO, "me", [], REPO, () => ({ name: "My Session", messageCount: 7 }));
		await h.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
		let list = peers(REPO, Date.now());
		expect(list[0].state).toBe("working");
		await h.fire("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: {
				role: "assistant",
				content: "done\n<recap>\nMISSION: goal\nTASK: step\nNEXT: next\n</recap>",
			},
		});
		list = peers(REPO, Date.now());
		expect(list[0].mission).toBe("goal");
		expect(list[0].task).toBe("step");
		expect(list[0].next).toBe("next");
		await h.fire("agent_settled", { type: "agent_settled" });
		list = peers(REPO, Date.now());
		expect(list[0].state).toBe("idle");
		expect(list[0].name).toBe("My Session");
		expect(list[0].messageCount).toBe(7);
		await h.fire("session_shutdown", { type: "session_shutdown" });
	});

	it("session_shutdown leaves the channel and clears the bus", async () => {
		const h = makeApi();
		startWalkieTalkie(h.api, REPO, "me", [], REPO);
		expect((globalThis as any).__crew).toBeDefined();
		await h.fire("session_shutdown", { type: "session_shutdown" });
		expect((globalThis as any).__crew).toBeUndefined();
		expect(existsSync(join(activeDir(REPO), "me.json"))).toBe(false);
	});
});

// ── crew integration: action=say round-trip ────────────────────────────────

describe("crew action=say over the walkie-talkie bus", () => {
	async function withCrew(fn: (h: ReturnType<typeof makeApi>) => Promise<void>) {
		const h = makeApi();
		const ext = createCrewExtension();
		ext.factory(h.api);
		await h.fire(
			"session_start",
			{ type: "session_start" },
			{
				cwd: REPO,
				ui: { setStatus: () => {}, notify: () => {} },
				sessionManager: { getSessionId: () => "parent-session" },
			},
		);
		await fn(h);
		await h.fire("session_shutdown", { type: "session_shutdown" }, {});
	}

	it("registers the wt_* tools alongside the crew tool", async () => {
		await withCrew(async (h) => {
			expect(h.tools.crew).toBeDefined();
			for (const name of ["crew_send", "crew_recv", "crew_scope", "crew_list"]) {
				expect(h.tools[name]).toBeDefined();
			}
		});
	});

	it("action=say steers a running run via the bus (urgent mail to the handle)", async () => {
		await withCrew(async (h) => {
			// The child announces itself under its handle scope — the runner
			// seeds PI_SCOPES with the handle, so a real child joins it.
			const now = Date.now();
			announce(REPO, {
				sessionId: "child-session",
				pid: 99,
				cwd: REPO,
				scopes: ["scout"],
				startedAt: new Date(now).toISOString(),
				lastHeartbeat: new Date(now).toISOString(),
			});
			// Inject a fake running run so doSay finds it. The bus is live
			// (lit by crew's session_start), so doSay sends over the channel.
			const run: CrewRun = {
				handle: "scout",
				agent: "scout",
				task: "survey",
				cwd: REPO,
				sessionId: "child-session",
				state: "running",
				resumes: 0,
				started: now,
				tools: 0,
				turns: 0,
				text: "",
				stderr: "",
				dir: REPO,
				depth: 1,
			};
			runs.set("scout", run);
			const res = await h.tools.crew.execute(
				"1",
				{ action: "say", handle: "scout", message: "change course" },
				undefined,
				undefined,
				{ cwd: REPO },
			);
			expect(res.content[0].text).toMatch(/sent to scout/);
			// the child (joined `scout`) received the urgent steer
			const inbox = drain(REPO, "child-session");
			expect(inbox).toHaveLength(1);
			expect(inbox[0].urgent).toBe(true);
			expect(inbox[0].text).toBe("change course");
			expect(inbox[0].re).toBe("scout");
			runs.delete("scout");
		});
	});

	it("action=say reports 'not loaded' is gone — the bus is live", async () => {
		await withCrew(async (h) => {
			// With the bridge wired, a say on a non-running handle should say
			// "nothing to steer", NOT "walkie-talkie is not loaded".
			const res = await h.tools.crew.execute(
				"1",
				{ action: "say", handle: "nope", message: "x" },
				undefined,
				undefined,
				{ cwd: REPO },
			);
			expect(res.content[0].text).not.toMatch(/walkie-talkie is not loaded/);
			expect(res.content[0].text).toMatch(/no run "nope"/);
		});
	});
});

// ── questions: raise → answer → resolve over the channel ───────────────────

describe("crew questions", () => {
	it("raiseQuestion writes a durable open question; list/for/by find it", () => {
		const q = raiseQuestion(REPO, "alice", "alice", ["bob"], "Which branch do we target?");
		expect(q.state).toBe("open");
		expect(q.answers).toEqual([]);
		const list = listQuestions(REPO);
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(q.id);
		expect(questionsFor(REPO, "bob").map((x) => x.id)).toEqual([q.id]);
		expect(questionsFor(REPO, "nobody")).toEqual([]);
		expect(questionsBy(REPO, "alice").map((x) => x.id)).toEqual([q.id]);
	});

	it("the first answer resolves; later answers still append", () => {
		const q = raiseQuestion(REPO, "alice", "alice", ["bob", "carol"], "Pick a model?");
		const r1 = answerQuestion(REPO, q.id, "bob", "use claude-sonnet");
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		expect(r1.question.state).toBe("resolved");
		expect(r1.question.answers).toHaveLength(1);
		const r2 = answerQuestion(REPO, q.id, "carol", "seconding sonnet");
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		expect(r2.question.answers).toHaveLength(2);
		expect(r2.question.state).toBe("resolved");
	});

	it("a non-audience member cannot answer", () => {
		const q = raiseQuestion(REPO, "alice", "alice", ["bob"], "Secret?");
		const r = answerQuestion(REPO, q.id, "eve", "no peeking");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/not in the audience/);
		expect(listQuestions(REPO)[0].state).toBe("open");
	});

	it("unknown question and empty answer are rejected", () => {
		expect(answerQuestion(REPO, "q-nope", "bob", "x").ok).toBe(false);
		const q = raiseQuestion(REPO, "alice", "alice", ["bob"], "?");
		expect(answerQuestion(REPO, q.id, "bob", "  ").ok).toBe(false);
	});

	it("crew_ask raises to resolved addresses; crew_answer resolves; crew_questions lists", async () => {
		announce(REPO, {
			sessionId: "peer-session-abc",
			pid: 1,
			cwd: REPO,
			scopes: [],
			state: "idle",
			lastActivity: new Date().toISOString(),
			lastHeartbeat: new Date().toISOString(),
			startedAt: new Date().toISOString(),
		});
		const h = makeApi();
		const crew = createWalkieTalkie(REPO, "asker", () => []);
		registerWalkieTalkieTools(h.api, crew, REPO, "asker", () => {});
		for (const name of ["crew_ask", "crew_answer", "crew_questions"]) {
			expect(h.tools[name]).toBeDefined();
		}
		const raised = await h.tools.crew_ask.execute("1", { prompt: "Which branch?", to: "peer-session-abc" });
		const qid = raised.details.questionId as string;
		expect(qid).toMatch(/^q-/);
		// the peer answers
		const h2 = makeApi();
		registerWalkieTalkieTools(h2.api, crew, REPO, "peer-session-abc", () => {});
		const answered = await h2.tools.crew_answer.execute("1", { question_id: qid, answer: "main" });
		expect(answered.content[0].text).toContain("answered");
		// asker lists it resolved
		const list = await h.tools.crew_questions.execute("1", { direction: "raised" });
		expect(list.content[0].text).toContain(qid);
		expect(list.content[0].text).toContain("main");
		// receiver sees open questions addressed to it
		const open = await h2.tools.crew_questions.execute("1", { direction: "received" });
		expect(open.content[0].text).toContain("no questions");
	});

	it("crew_ask rejects 'all'", async () => {
		const h = makeApi();
		registerWalkieTalkieTools(
			h.api,
			createWalkieTalkie(REPO, "me", () => []),
			REPO,
			"me",
			() => {},
		);
		const res = await h.tools.crew_ask.execute("1", { prompt: "?", to: "all" });
		expect(res.content[0].text).toMatch(/no broadcast address/);
	});

	it("an answered question is re-injected as a follow-up at the asker's settle", async () => {
		const h = makeApi();
		startWalkieTalkie(h.api, REPO, "asker", [], REPO);
		const q = raiseQuestion(REPO, "asker", "asker", ["bob"], "Which branch?");
		await h.fire("agent_settled", { type: "agent_settled" });
		expect(h.sent).toHaveLength(0); // unanswered → no notification
		answerQuestion(REPO, q.id, "bob", "main");
		await h.fire("agent_settled", { type: "agent_settled" });
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].text).toMatch(new RegExp(q.id));
		expect(h.sent[0].text).toContain("main");
		// notified once only
		await h.fire("agent_settled", { type: "agent_settled" });
		expect(h.sent).toHaveLength(1);
	});
});
