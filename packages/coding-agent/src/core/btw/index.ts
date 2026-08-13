// btw — the side channel, ported from the ontology extension's /btw.
//
// Ask something without spending the main session on it: a read-only subagent
// (tools restricted to read,grep,find,ls — nothing that can modify anything)
// answers in its OWN resumable session (`--session-id`), and you carry the key
// to another terminal: `pi --session <id>` resumes the whole exchange,
// `pi --fork <id>` branches a new session off it.
//
// Folded in, the two halves of "what is this called / where does it live":
// the index over ontology digest entities + registered tools (the oilrig's
// third source, splinter symbols, has no counterpart in core), and rename as
// a dispatch — digest entities are renamed in place (+ a kern correction),
// tools become a NO-COMPAT rename task handed to the agent.
//
// The full TUI panel is not ported — `/btw <question>` answers via the toast
// and hands over the resume command, which is the whole ROI in one line.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { parseDigest, readDigest, setOntologyRoot, writeDigest } from "../memory/ontology.ts";
import { getPiInvocation } from "../pi-invocation.ts";

const ASK_TIMEOUT_MS = 180_000;
const READ_ONLY_TOOLS = "read,grep,find,ls";
const BRIEF =
	"You are answering a side question from a developer working in this " +
	"repository. Answer concretely and concisely; read the repo when it is " +
	"relevant, say so plainly when it is not. Read-only: never modify " +
	"anything. Question: ";

export interface SideAnswer {
	ok: boolean;
	text: string;
	sessionId: string;
}

export function resumeCommand(root: string, id: string): string {
	return `cd ${root} && pi --session ${id}`;
}
export function forkCommand(root: string, id: string): string {
	return `cd ${root} && pi --fork ${id}`;
}

/** Spawn the read-only side subagent in its own resumable session. */
export function runSideQuestion(question: string, cwd: string): Promise<SideAnswer> {
	const sessionId = randomUUID();
	return new Promise((resolve) => {
		const invocation = getPiInvocation([
			"--session-id",
			sessionId,
			"--tools",
			READ_ONLY_TOOLS,
			"-p",
			BRIEF + question,
		]);
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			timeout: ASK_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d: Buffer) => {
			out += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			err += d.toString();
		});
		child.on("error", (e: Error) => resolve({ ok: false, text: e.message, sessionId }));
		child.on("close", (code: number | null) => {
			if (code === 0) resolve({ ok: true, text: out.trim(), sessionId });
			else
				resolve({
					ok: false,
					text:
						err
							.split("\n")
							.map((l) => l.trim())
							.filter(Boolean)
							.at(-1) ?? `pi exited ${code}`,
					sessionId,
				});
		});
	});
}

/** The folded index: digest entities + every registered tool. */
export function buildIndex(pi: ExtensionAPI): Array<{ term: string; summary: string; source: string }> {
	const digest = readDigest();
	const entities = digest ? parseDigest(digest).map((e) => ({ ...e, source: "entity" as const })) : [];
	const tools = (pi.getAllTools?.() ?? [])
		.map((t: { name?: string; description?: string }) => ({
			term: t?.name ?? "",
			summary: t?.description?.split("\n")[0]?.slice(0, 140) ?? "",
			source: "tool" as const,
		}))
		.filter((e) => e.term);
	return [...entities, ...tools];
}

/**
 * Rename-as-dispatch: digest entities are edited in place (+ a kern naming
 * correction); tools become a NO-COMPAT rename task for the agent.
 */
export function renameEntry(pi: ExtensionAPI, term: string, next: string, cwd: string): string {
	const digest = readDigest();
	if (digest) {
		const lines = digest.split("\n");
		const idx = lines.findIndex((l) => l.replace(/^-\s+/, "").startsWith(term));
		if (idx >= 0) {
			lines[idx] = lines[idx].replace(term, next);
			writeDigest(lines.join("\n"));
			const kern = (globalThis as any).__kern;
			kern
				?.storeObservation?.(
					`btw: renamed ${term} → ${next}`,
					`User renamed ontology entity "${term}" to "${next}" in /btw. Use "${next}" as the canonical name.`,
				)
				.catch?.(() => {});
			return `renamed → ${next} (digest + memory updated)`;
		}
	}
	const tools = (pi.getAllTools?.() ?? []) as Array<{ name?: string }>;
	const isTool = tools.some((t) => t.name === term);
	if (isTool) {
		pi.sendUserMessage(
			`Rename the tool \`${term}\` to \`${next}\`: update the definition, every reference, registration and doc in one change — no compat aliases (NO-COMPAT). Verify with the test suite.`,
			{ deliverAs: "followUp" },
		);
		return "rename task dispatched to the agent — no compat aliases";
	}
	void cwd;
	return `"${term}" not found in the digest or the tool surface`;
}

export function createBtwInlineExtension(): { name: string; factory: (pi: ExtensionAPI) => void } {
	return {
		name: "btw",
		factory(pi: ExtensionAPI) {
			let root = process.cwd();

			const latch = (ctx: ExtensionContext) => {
				root = ctx?.cwd ?? root;
				setOntologyRoot(root);
			};

			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => latch(ctx));

			const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

			async function ask(question: string, ctx: ExtensionContext): Promise<string> {
				if (!question.trim()) return "btw: ask needs a question — /btw <question>";
				const r = await runSideQuestion(question, root);
				void ctx;
				if (r.ok) {
					return `answered (${r.text.length} chars) — continue it in another terminal:\n  ${resumeCommand(root, r.sessionId)}\n  ${forkCommand(root, r.sessionId)}\n\n${r.text.slice(0, 400)}${r.text.length > 400 ? "…" : ""}`;
				}
				return `btw: side session failed — ${r.text} (key ${r.sessionId})`;
			}

			function index(filter: string): string {
				const entries = buildIndex(pi);
				if (!entries.length) return "btw: nothing indexed yet — the ontology digest fills as you work";
				const q = filter.trim().toLowerCase();
				const shown = q
					? entries.filter((e) => e.term.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q))
					: entries;
				if (!shown.length) return `btw: no match for "${filter}"`;
				const lines = shown.map((e) => `${e.term} — ${e.summary} (${e.source})`);
				return lines.slice(0, 60).join("\n");
			}

			// ── tool (headless/agent surface) ──────────────────────────────
			pi.registerTool({
				name: "btw",
				label: "Btw — side question",
				promptSnippet: "Ask a side question in a resumable read-only session, or look up the index",
				description:
					"Ask a question without spending this session: a read-only subagent (read,grep,find,ls only) answers in its own resumable session; the answer includes the resume/fork commands to continue it in another terminal. action=index lists ontology entities + tools (filter to narrow); action=rename renames a digest entity in place or dispatches a NO-COMPAT rename task for a tool.",
				parameters: Type.Object({
					action: Type.String({ enum: ["ask", "index", "rename"], description: "ask | index | rename" }),
					question: Type.Optional(Type.String({ description: "the side question (action=ask)" })),
					filter: Type.Optional(Type.String({ description: "index filter (action=index)" })),
					term: Type.Optional(Type.String({ description: "current name (action=rename)" })),
					next: Type.Optional(Type.String({ description: "new name (action=rename)" })),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const action = String(params?.action ?? "");
					if (action === "ask") return out(await ask(String(params?.question ?? ""), ctx));
					if (action === "index") return out(index(String(params?.filter ?? "")));
					if (action === "rename") {
						const term = String(params?.term ?? "");
						const next = String(params?.next ?? "");
						if (!term || !next) return out("btw: rename needs term and next");
						return out(renameEntry(pi, term, next, root));
					}
					return out("btw: action must be ask | index | rename");
				},
			} as ToolDefinition);

			// ── /btw command (the human's path) ────────────────────────────
			pi.registerCommand("btw", {
				description:
					"The side channel: /btw <question> answers via a read-only subagent in a resumable session (the reply carries pi --session/--fork commands); /btw index [filter] lists entities + tools; /btw rename <term> <next> renames.",
				async handler(args: string, ctx: ExtensionContext) {
					latch(ctx);
					const note = (t: string, k: "info" | "warning" | "error" = "info") => ctx.ui?.notify?.(t, k);
					const parts = args.trim().split(/\s+/);
					const head = parts[0] ?? "";
					if (head === "index") return note(index(parts.slice(1).join(" ")));
					if (head === "rename") {
						const term = parts[1] ?? "";
						const next = parts[2] ?? "";
						if (!term || !next) return note("btw: rename needs <term> <next>", "warning");
						return note(renameEntry(pi, term, next, root), "info");
					}
					const q = args.trim();
					if (!q)
						return note(
							"btw: ask something — /btw <question> | index [filter] | rename <term> <next>",
							"warning",
						);
					const text = await ask(q, ctx);
					note(text.split("\n").slice(0, 3).join("\n"), "info");
				},
			});
		},
	};
}
