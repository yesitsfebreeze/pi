// Walkie-talkie bridge — wires the maildir channel into globalThis.__wt
// so crew subagents can steer and be steered. Registers wt_send, wt_recv,
// wt_scope, wt_list as built-in tools.
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import {
	adopt,
	announce,
	drain,
	HEARTBEAT_MS,
	leave,
	Peer,
	peers,
	post,
	renderPeers,
	renderScopes,
	resolve,
	scopes,
	sweep,
} from "./channel.ts";

// ── bridge interface ────────────────────────────────────────────────
export interface WalkieTalkie {
	addr(): string;
	scopes(): string[];
	send(to: string, body: string, opts?: { re?: string; urgent?: boolean }): void;
	drain(): ChannelMessage[];
}

export type ChannelMessage = ReturnType<typeof drain>[number];

export function createWalkieTalkie(repo: string, sessionId: string, myScopes: string[]): WalkieTalkie {
	return {
		addr: () => sessionId,
		scopes: () => myScopes,
		send(to: string, body: string, opts?: { re?: string; urgent?: boolean }) {
			post(repo, {
				to,
				from: sessionId,
				text: body,
				kind: "say",
				re: opts?.re,
				urgent: opts?.urgent,
			});
		},
		drain() {
			return drain(repo, sessionId, myScopes);
		},
	};
}

// ── tool registration ───────────────────────────────────────────────
export function registerWalkieTalkieTools(
	pi: ExtensionAPI,
	wt: WalkieTalkie,
	repo: string,
	sessionId: string,
	onScopesChange: (scopes: string[]) => void,
): void {
	// wt_send — send a message to a session or scope
	pi.registerTool({
		name: "wt_send",
		label: "Walkie-Talkie: Send",
		description:
			"Send a message to a peer session or scope. to=id prefix for one session, scope name for a group. No broadcast.",
		parameters: Type.Object({
			to: Type.String({ description: "Session id prefix or scope name" }),
			body: Type.String({ description: "The message" }),
			re: Type.Optional(Type.String({ description: "What this is about — ticket id, file, question id" })),
			urgent: Type.Optional(Type.Boolean({ description: "Interrupt receiver mid-turn (default false)" })),
		}),
		execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined) {
			wt.send(params.to as string, params.body as string, {
				re: params.re as string | undefined,
				urgent: Boolean(params.urgent),
			});
			return {
				content: [{ type: "text" as const, text: `sent to ${params.to}` }],
				details: {},
			};
		},
	} as ToolDefinition);

	// wt_recv — drain incoming messages for this session
	pi.registerTool({
		name: "wt_recv",
		label: "Walkie-Talkie: Receive",
		description: "Pull anything waiting on the channel for this session right now.",
		parameters: Type.Object({}),
		execute() {
			const msgs = wt.drain();
			if (!msgs.length) return { content: [{ type: "text" as const, text: "(no messages)" }], details: {} };
			const lines = msgs.map((m: ChannelMessage) => {
				const tags = [m.from, m.re ? `re ${m.re}` : "", m.urgent ? "URGENT" : ""].filter(Boolean);
				return `[${tags.join(", ")}]\n${m.text}`;
			});
			return {
				content: [{ type: "text" as const, text: lines.join("\n\n") }],
				details: {},
			};
		},
	} as ToolDefinition);

	// wt_scope — join/leave scopes, publish what you're doing
	pi.registerTool({
		name: "wt_scope",
		label: "Walkie-Talkie: Scope",
		description:
			"Join or leave a scope (group address) and publish what you are working on. " +
			"Scopes lets peers discover and address you.",
		parameters: Type.Object({
			join: Type.Optional(
				Type.Array(Type.String(), { description: "Scopes to join (kebab-case names for areas, not actions)" }),
			),
			leave: Type.Optional(Type.Array(Type.String(), { description: "Scopes to leave" })),
			doing: Type.Optional(
				Type.String({
					description: "One line: what you are working on right now. Empty string to clear.",
				}),
			),
		}),
		execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined) {
			const current = new Set(wt.scopes());
			const joined = (params.join as string[]) ?? [];
			const left = (params.leave as string[]) ?? [];
			for (const s of joined) current.add(s);
			for (const s of left) current.delete(s);
			const updated = [...current];
			onScopesChange(updated);
			const doing = typeof params.doing === "string" ? params.doing : undefined;
			const parts: string[] = [];
			if (joined.length) parts.push(`joined: ${joined.join(", ")}`);
			if (left.length) parts.push(`left: ${left.join(", ")}`);
			if (doing !== undefined) parts.push(`doing: ${doing || "(cleared)"}`);
			return {
				content: [{ type: "text" as const, text: parts.length ? parts.join("  ") : "no change" }],
				details: {},
			};
		},
	} as ToolDefinition);

	// wt_list — list peers and scopes
	pi.registerTool({
		name: "wt_list",
		label: "Walkie-Talkie: List",
		description: "List every session on the channel and its scopes.",
		parameters: Type.Object({}),
		execute() {
			const now = Date.now();
			const all = peers(repo, now);
			const text = [renderPeers(all, sessionId, now), "", renderScopes(repo, now)].join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: {},
			};
		},
	} as ToolDefinition);
}

// ── lifecycle ───────────────────────────────────────────────────────
export function startWalkieTalkie(
	pi: ExtensionAPI,
	repo: string,
	sessionId: string,
	initialScopes: string[],
): { wt: WalkieTalkie; stop: () => void } {
	let myScopes = [...initialScopes];
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const wt = createWalkieTalkie(repo, sessionId, myScopes);

	const refreshPeer = () => {
		announce(repo, {
			sessionId,
			pid: process.pid,
			cwd: process.cwd(),
			scopes: myScopes,
			startedAt: new Date().toISOString(),
			lastHeartbeat: new Date().toISOString(),
		});
	};

	(globalThis as Record<string, unknown>).__wt = wt;

	pi.on("session_start", () => {
		adopt(repo, sessionId);
		refreshPeer();
		heartbeat = setInterval(refreshPeer, HEARTBEAT_MS);
		heartbeat?.unref?.();
		sweep(repo);
	});

	pi.on("agent_settled", () => {
		// drain urgent messages first — they interrupt the settled state
		const msgs = drain(repo, sessionId, myScopes);
		const urgent = msgs.filter((m) => m.urgent);
		if (urgent.length) {
			const text = urgent.map((m) => `[${m.from}, URGENT${m.re ? `, re ${m.re}` : ""}]\n${m.text}`).join("\n\n");
			pi.sendUserMessage(`# Walkie-Talkie — URGENT\n\n${text}\n\nAct on this at your next boundary.`, {
				deliverAs: "followUp",
			});
		}
	});

	pi.on("session_shutdown", () => {
		if (heartbeat) clearInterval(heartbeat);
		leave(repo, sessionId);
		delete (globalThis as Record<string, unknown>).__wt;
	});

	registerWalkieTalkieTools(pi, wt, repo, sessionId, (updated) => {
		myScopes = updated;
		refreshPeer();
	});

	return { wt, stop: () => leave(repo, sessionId) };
}
