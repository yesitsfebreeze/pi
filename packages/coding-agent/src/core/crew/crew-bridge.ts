// Walkie-talkie bridge — wires the maildir channel into globalThis.__crew
// so crew subagents can steer and be steered. Registers crew_send, crew_recv,
// crew_scope, crew_list as core tools.
//
// The channel is a sorted maildir outside the repo (XDG state, keyed by repo
// root): filenames are ISO stamps so lexical order is arrival order, and a
// per-reader cursor file is the whole delivery protocol (read once, never
// twice). No daemon, no socket, no external dependency. See channel.ts and
// presence.ts for the wire and discovery protocol.
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../extensions/types.ts";
import { adopt, drain as drainChannel, type Message, post, sweep } from "./channel.ts";
import {
	announce,
	HEARTBEAT_MS,
	leave,
	parseRecap,
	peers,
	renderPeers,
	renderScopes,
	resolve,
	scopes as scopeMap,
} from "./presence.ts";
import { answerQuestion, questionsBy, questionsFor, raiseQuestion } from "./questions.ts";

// ── bridge interface ────────────────────────────────────────────────
export interface WalkieTalkie {
	addr(): string;
	scopes(): string[];
	send(to: string, body: string, opts?: { re?: string; urgent?: boolean }): void;
	drain(): Message[];
}

/** The bus published on `globalThis.__crew` — walkie-talkie plus scope/doing steering. */
export interface WalkieTalkieBus extends WalkieTalkie {
	/** Join a scope — the same set the `crew_scope` tool mutates. */
	join(scope: string): void;
	/** Leave a scope. */
	leave(scope: string): void;
	/** Publish one line about current work to peers (undefined clears). */
	doing(text: string | undefined): void;
}

export type { Message as ChannelMessage };

export function createWalkieTalkie(repo: string, sessionId: string, getScopes: () => string[]): WalkieTalkie {
	return {
		addr: () => sessionId,
		scopes: () => getScopes(),
		send(to: string, body: string, opts?: { re?: string; urgent?: boolean }) {
			// Resolve a user-typed target to real addresses. There is no
			// broadcast: `all` resolves to nothing, because an unaddressed update
			// is what every other session has to stop and reconcile.
			const targets = resolve(repo, to);
			for (const t of targets) {
				post(repo, {
					to: t,
					from: sessionId,
					text: body,
					kind: "say",
					re: opts?.re,
					urgent: opts?.urgent,
				});
			}
		},
		drain() {
			return drainChannel(repo, sessionId, getScopes());
		},
	};
}

// ── tool registration ───────────────────────────────────────────────
export function registerWalkieTalkieTools(
	pi: ExtensionAPI,
	crew: WalkieTalkie,
	repo: string,
	sessionId: string,
	onScopesChange: (scopes: string[]) => void,
	onDoing?: (doing: string | undefined) => void,
): void {
	// crew_send — send a message to a session or scope
	pi.registerTool({
		name: "crew_send",
		label: "Crew: Send",
		promptSnippet: "Send a message to a peer session or scope over the channel",
		description:
			"Send a message to a peer session or scope. `to` is a session id prefix (first 8-12 chars) for one session, or a scope name for a group. There is no broadcast address — name whoever must act. Ordinary talk lands at the receiver's next boundary; urgent talk cuts into what it is doing right now.",
		parameters: Type.Object({
			to: Type.String({ description: "Session id prefix or scope name. 'all' is not an address." }),
			body: Type.String({ description: "The message" }),
			re: Type.Optional(Type.String({ description: "What this is about — ticket id, file, question id" })),
			urgent: Type.Optional(Type.Boolean({ description: "Interrupt receiver mid-turn (default false)" })),
		}),
		async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined) {
			const to = String(params.to ?? "").trim();
			if (!to || to === "all") {
				return {
					content: [
						{
							type: "text" as const,
							text: "crew: there is no broadcast address. Name the session id prefix or the scope that has to act — crew_list shows who is on. If several sessions need this, they are a group: send to their scope.",
						},
					],
					details: { targets: [] },
				};
			}
			const targets = resolve(repo, to);
			if (!targets.length) {
				return {
					content: [{ type: "text" as const, text: `no session matches "${to}" — crew_list to see who is on` }],
					details: { targets: [] },
				};
			}
			for (const t of targets) {
				try {
					post(repo, {
						to: t,
						from: sessionId,
						text: String(params.body),
						re: params.re as string | undefined,
						urgent: Boolean(params.urgent),
					});
				} catch (e) {
					return {
						content: [{ type: "text" as const, text: (e as Error).message }],
						details: { targets: [] },
					};
				}
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `sent to ${targets.length === 1 ? targets[0].slice(0, 8) : `${targets.length} sessions`}`,
					},
				],
				details: { targets },
			};
		},
	} as ToolDefinition);

	// crew_recv — drain incoming messages for this session
	pi.registerTool({
		name: "crew_recv",
		label: "Crew: Receive",
		promptSnippet: "Pull anything waiting on the channel for this session now",
		description:
			"Pull anything waiting on the channel for this session right now, instead of waiting for the next settle.",
		parameters: Type.Object({}),
		async execute() {
			const msgs = crew.drain();
			if (!msgs.length) return { content: [{ type: "text" as const, text: "channel is quiet" }], details: {} };
			const lines = msgs.map((m) => {
				const tags = [m.from, m.re ? `re ${m.re}` : "", m.urgent ? "URGENT" : ""].filter(Boolean);
				return `[${tags.join(", ")}]\n${m.text}`;
			});
			return {
				content: [{ type: "text" as const, text: lines.join("\n\n") }],
				details: { count: msgs.length },
			};
		},
	} as ToolDefinition);

	// crew_scope — join/leave scopes, publish what you're doing
	pi.registerTool({
		name: "crew_scope",
		label: "Crew: Scope",
		promptSnippet: "Join/leave a scope and publish what you are working on",
		description:
			"Organise yourself on the channel. A scope is a group address: every session that joins `auth-rewrite` receives mail sent to `auth-rewrite`. Join one per area of work you take on and leave it when you move off, so a peer looking for whoever owns that ground finds exactly the right sessions. `doing` publishes one line about your current work to every peer.",
		parameters: Type.Object({
			join: Type.Optional(
				Type.Array(Type.String(), {
					description: "Scopes to join — short kebab-case names for areas, not actions",
				}),
			),
			leave: Type.Optional(Type.Array(Type.String(), { description: "Scopes to leave" })),
			doing: Type.Optional(
				Type.String({
					description: "One line: what you are working on right now. Empty string to clear.",
				}),
			),
		}),
		async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined) {
			const current = new Set(crew.scopes());
			const joined = (params.join as string[]) ?? [];
			const left = (params.leave as string[]) ?? [];
			for (const s of joined) if (s.trim()) current.add(s.trim());
			for (const s of left) current.delete(s);
			const updated = [...current];
			onScopesChange(updated);
			const doing = typeof params.doing === "string" ? params.doing : undefined;
			// Publish through the bus so peers actually see it — the description
			// promises "doing publishes one line about your current work to every
			// peer", and only bus.doing() feeds the announce payload.
			if (doing !== undefined) onDoing?.(doing);
			const parts: string[] = [];
			if (joined.length) parts.push(`joined: ${joined.join(", ")}`);
			if (left.length) parts.push(`left: ${left.join(", ")}`);
			if (doing !== undefined) parts.push(`doing: ${doing || "(cleared)"}`);
			return {
				content: [{ type: "text" as const, text: parts.length ? parts.join("  ") : "no change" }],
				details: { scopes: updated, doing },
			};
		},
	} as ToolDefinition);

	// crew_list — list peers and scopes, hottest first
	pi.registerTool({
		name: "crew_list",
		label: "Crew: List",
		promptSnippet: "Who else is working in this directory right now",
		description:
			"List every session on the channel, sorted by hotness (recently active, working vs idle, session size, scope breadth). Shows each session's name, state, message count, last-activity age, scopes, cwd, and its published doing/mission/task/next lines.",
		parameters: Type.Object({}),
		async execute() {
			const now = Date.now();
			const all = peers(repo, now);
			const text = [renderPeers(all, sessionId, now), "", "Scopes:", renderScopes(repo, now)].join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: {
					count: all.length,
					working: all.filter((p) => p.state === "working").length,
					idle: all.filter((p) => p.state !== "working").length,
				},
			};
		},
	} as ToolDefinition);

	// crew_ask — raise a durable question to specific sessions
	pi.registerTool({
		name: "crew_ask",
		label: "Crew: Ask",
		promptSnippet: "Raise a question to specific peer sessions, answerable once",
		description:
			"Raise a question to specific peer sessions (id prefix or scope). The question is durable on disk and recorded to kern; the first audience member to answer resolves it and you are notified at your next settle. Check outcomes with crew_questions.",
		parameters: Type.Object({
			prompt: Type.String({ description: "The question — one line, with what a good answer looks like" }),
			to: Type.String({ description: "Session id prefix or scope name. 'all' is not an address." }),
		}),
		async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined) {
			const to = String(params.to ?? "").trim();
			if (!to || to === "all") {
				return {
					content: [
						{
							type: "text" as const,
							text: "crew: there is no broadcast address. Name the session id prefix or scope that has to answer — crew_list shows who is on.",
						},
					],
					details: {},
				};
			}
			const audience = resolve(repo, to);
			if (!audience.length) {
				return {
					content: [{ type: "text" as const, text: `no session matches "${to}" — crew_list to see who is on` }],
					details: {},
				};
			}
			const q = raiseQuestion(repo, sessionId.slice(0, 8), sessionId, audience, String(params.prompt ?? ""));
			return {
				content: [
					{
						type: "text" as const,
						text: `question ${q.id} raised to ${audience.length} session(s): ${q.prompt} — you will be notified when it is answered; crew_questions lists it meanwhile`,
					},
				],
				details: { questionId: q.id, audience },
			};
		},
	} as ToolDefinition);

	// crew_answer — answer a question addressed to me
	pi.registerTool({
		name: "crew_answer",
		label: "Crew: Answer",
		promptSnippet: "Answer a question addressed to this session",
		description:
			"Answer a question that was raised to this session (see crew_questions for open ones). The first answer resolves it and the asker is notified at their next settle. You cannot answer a question that was not addressed to you.",
		parameters: Type.Object({
			question_id: Type.String({ description: "Question id from crew_questions" }),
			answer: Type.String({ description: "Your answer — concrete, one or two lines" }),
		}),
		async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined) {
			const r = answerQuestion(repo, String(params.question_id ?? ""), sessionId, String(params.answer ?? ""));
			if (!r.ok) return { content: [{ type: "text" as const, text: `crew: ${r.error}` }], details: {} };
			return {
				content: [{ type: "text" as const, text: `answered ${r.question.id} — the asker is notified` }],
				details: { questionId: r.question.id, state: r.question.state },
			};
		},
	} as ToolDefinition);

	// crew_questions — list questions: raised by me, or open ones for me
	pi.registerTool({
		name: "crew_questions",
		label: "Crew: Questions",
		promptSnippet: "List questions raised to or by this session",
		description:
			"List questions: raised by you (with answers, resolved or not) or open questions addressed to you. Questions are durable decision points — use crew_ask to raise one, crew_answer to settle one addressed to you.",
		parameters: Type.Object({
			direction: Type.Optional(
				Type.String({
					enum: ["raised", "received"],
					description: "raised = questions I asked; received = questions addressed to me (default: both)",
				}),
			),
		}),
		async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined) {
			const dir = String(params.direction ?? "");
			const mine = dir === "received" ? [] : questionsBy(repo, sessionId);
			const theirs = dir === "raised" ? [] : questionsFor(repo, sessionId);
			const all = [...mine, ...theirs];
			if (!all.length) return { content: [{ type: "text" as const, text: "no questions" }], details: {} };
			const lines = all.map((q) => {
				const head = `${q.state === "resolved" ? "✓" : "○"} ${q.id} (${q.from}) — ${q.prompt}`;
				const answers = q.answers.map((a) => `    ${a.by}: ${a.text}`);
				return [head, ...answers].join("\n");
			});
			return { content: [{ type: "text" as const, text: lines.join("\n\n") }], details: { count: all.length } };
		},
	} as ToolDefinition);
}

// ── lifecycle ───────────────────────────────────────────────────────
//
// The caller (the crew inline extension) invokes this from its own
// `session_start` handler, once `repo` and `sessionId` are latched from the
// event context. This bridge does NOT register its own `session_start` — it
// would miss the current start (the event is already firing) and race on the
// real repo/session. It owns only the parts that need the live values: the
// heartbeat, the urgent-drain on settle, and the leave on shutdown.

/** Extra facts the caller can supply about this session, read live on each heartbeat. */
export interface PeerMeta {
	name?: string;
	messageCount?: number;
}

/** Text of a message's content — string or content blocks — for recap parsing. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { text?: string } => typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
		)
		.map((c) => c.text ?? "")
		.join("\n")
		.trim();
}

export function startWalkieTalkie(
	pi: ExtensionAPI,
	repo: string,
	sessionId: string,
	initialScopes: string[],
	cwd: string,
	getMeta?: () => PeerMeta,
): { crew: WalkieTalkieBus; stop: () => void } {
	let myScopes = [...initialScopes];
	let doing: string | undefined;
	let state: "working" | "idle" = "idle";
	let lastActivity: string | undefined;
	let mission: string | undefined;
	let task: string | undefined;
	let next: string | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const notifiedQuestions = new Set<string>();
	const startedAt = new Date().toISOString();
	const crew = createWalkieTalkie(repo, sessionId, () => myScopes);

	// The bus exposed on globalThis also carries join/leave/doing so other core
	// modules (e.g. gantt) can steer the same scopes the crew_scope tool uses.
	const bus: WalkieTalkieBus = {
		...crew,
		join(scope: string) {
			if (!scope.trim() || myScopes.includes(scope)) return;
			myScopes = [...myScopes, scope];
			refreshPeer();
		},
		leave(scope: string) {
			if (!myScopes.includes(scope)) return;
			myScopes = myScopes.filter((s) => s !== scope);
			refreshPeer();
		},
		doing(text: string | undefined) {
			doing = text;
			refreshPeer();
		},
	};

	const touch = () => {
		lastActivity = new Date().toISOString();
	};

	const refreshPeer = () => {
		const meta = getMeta?.() ?? {};
		announce(repo, {
			sessionId,
			pid: process.pid,
			cwd,
			scopes: myScopes,
			name: meta.name,
			doing,
			state,
			messageCount: meta.messageCount,
			lastActivity,
			mission,
			task,
			next,
			startedAt,
			lastHeartbeat: new Date().toISOString(),
		});
	};

	// Publish the bus on globalThis so the crew extension (and any other core
	// module) can steer subagents without opening a second transport.
	(globalThis as Record<string, unknown>).__crew = bus;

	// Adopt the cursor and announce immediately — past chatter is not a
	// trigger, only mail newer than this start delivers.
	adopt(repo, sessionId);
	refreshPeer();
	sweep(repo);
	heartbeat = setInterval(refreshPeer, HEARTBEAT_MS);
	heartbeat.unref?.();

	// A turn starts when the agent begins working and settles when it has
	// nothing left to do — that is the live working/idle signal peers see.
	pi.on("turn_start", () => {
		state = "working";
		touch();
		refreshPeer();
	});

	// The recap block is the cheapest durable "what is this session doing" —
	// parse it off each assistant turn and publish mission/task/next.
	pi.on("turn_end", (ev) => {
		touch();
		const msg = ev?.message as { role?: string; content?: unknown } | undefined;
		if (msg?.role !== "assistant") return;
		const recap = parseRecap(messageText(msg.content));
		if (recap.mission || recap.task || recap.next) {
			mission = recap.mission ?? mission;
			task = recap.task ?? task;
			next = recap.next ?? next;
			refreshPeer();
		}
	});

	pi.on("agent_settled", () => {
		state = "idle";
		touch();
		refreshPeer();
		// A settle is the cheap delivery point for ordinary talk. Urgent mail
		// is drained here too and re-injected as a follow-up so it lands at the
		// next boundary even when no urgent poll is running.
		const msgs = crew.drain();
		if (msgs.length) {
			const urgent = msgs.filter((m) => m.urgent);
			const ordinary = msgs.filter((m) => !m.urgent);
			// Ordinary talk must be delivered, not just consumed by the cursor —
			// a non-urgent crew_send to an idle session would otherwise be
			// silently lost. It lands as a plain followUp; urgent cuts in as before.
			if (ordinary.length) {
				const text = ordinary.map((m) => `[${m.from}${m.re ? `, re ${m.re}` : ""}]\n${m.text}`).join("\n\n");
				pi.sendUserMessage(`# Walkie-Talkie\n\n${text}`, { deliverAs: "followUp" });
			}
			if (urgent.length) {
				const text = urgent.map((m) => `[${m.from}, URGENT${m.re ? `, re ${m.re}` : ""}]\n${m.text}`).join("\n\n");
				pi.sendUserMessage(`# Walkie-Talkie — URGENT\n\n${text}\n\nAct on this at your next boundary.`, {
					deliverAs: "followUp",
				});
			}
		}
		// Questions I raised that have since been answered: notify once, at the
		// next boundary, exactly as ordinary mail would arrive.
		for (const q of questionsBy(repo, sessionId)) {
			if (q.state !== "resolved" || !q.answers.length) continue;
			if (notifiedQuestions.has(q.id)) continue;
			notifiedQuestions.add(q.id);
			const a = q.answers[0];
			pi.sendUserMessage(`# Crew — answer to ${q.id}\n\nQ: ${q.prompt}\nA: ${a.text}\n\n(from ${a.by})`, {
				deliverAs: "followUp",
			});
		}
	});

	pi.on("session_shutdown", () => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		leave(repo, sessionId);
		if ((globalThis as Record<string, unknown>).__crew === bus) {
			delete (globalThis as Record<string, unknown>).__crew;
		}
	});

	registerWalkieTalkieTools(
		pi,
		bus,
		repo,
		sessionId,
		(updated) => {
			myScopes = updated;
			refreshPeer();
		},
		(doingText) => bus.doing(doingText),
	);

	return { crew: bus, stop: () => leave(repo, sessionId) };
}

// Re-export the scope map for callers that want to render scopes without
// reaching into presence.ts directly.
export { scopeMap };
