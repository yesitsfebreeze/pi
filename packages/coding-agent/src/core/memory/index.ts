// memory inline extension — kern knowledge graph + ontology world model.
// Thin wrappers around the kern CLI (storage, embedding, semantic search).
// Ontology digest lives as a plain markdown file at .pi/ontology/digest.md.
// Fail-open: no kern on PATH degrades gracefully — tools return clear errors.
//
// Lifecycle:
//   session_start       — latch cwd, seed digest, paint status
//   before_agent_start  — inject doctrine (once) + memory hits + digest
//   message_end         — strip <kern> blocks, ingest via kern CLI
//   agent_settled       — repaint status
//   session_shutdown    — clear status

import { autoInjectedBlock, createVolatileChannel } from "../context-injection.ts";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.ts";
import { countEntities, digestPath, ensureDigest, readDigest, setOntologyRoot } from "./ontology.ts";
import {
	ingestBlock,
	kernAvailable,
	memoryHealth,
	queryThoughts,
	setKernRoot,
	setLastIngestCount,
	storeDecision,
	storeLink,
	storeObservation,
} from "./store.ts";
import { MEMORY_TOOLS } from "./tools.ts";

// ── constants ───────────────────────────────────────────────────────────

const KERN_RE = /^<kern>([\s\S]*?)<\/kern>/m;
const STATUS_KEY = "memory";

const KERN_INSTRUCTION = `
# Kern memory (auto-maintained)

Emit a <kern> block — immediately BEFORE the <recap> block, never after it —
ONLY when this turn established something durable: a fact, decision, root cause,
correction, or architecture detail a future session in this repo should recall.
One entry per line: the statement, then " — ", then why it holds. Nothing
durable → omit the block. The block is stripped from the visible reply and
ingested into this repo's knowledge graph. Use kern_query before researching
from scratch — facts from prior sessions surface there.

<kern>
- <statement> — <why>
</kern>
`;

const ONTOLOGY_INSTRUCTION = `
# Ontology — world model (auto-maintained)

The ontology digest (.pi/ontology/digest.md) is this project's world model.
It lists entities, their kern IDs, typed relations, and search hints — never
full text. Follow its pointers before researching from scratch.

## End-of-turn self-review

Ask: did the user CORRECT you, or did you TRIP on something non-obvious the
first time? If neither → do nothing. If yes → record it THIS turn:

1. kern_ingest the fact (use object_id "ontology/<repo-slug>/<entity>" to
   update in place).
2. Add/update a digest line under ## Entities:
   - <Name> kern:<8hex> — <one-line hook> | rel: <type> -> <Entity>, … | see: <hint>
3. For connections between entities: kern_link with reason "<type>: <why>"
4. Keep the digest current — add lines for new entities, update changed ones,
   remove lines that no longer hold.
`;

// ── helpers ─────────────────────────────────────────────────────────────

/** How much of the digest ships as standing context. The rest is one read away. */
const DIGEST_PREVIEW_CHARS = 1200;

// ── inline extension factory ────────────────────────────────────────────

export function createMemoryInlineExtension(): {
	name: string;
	factory: (pi: ExtensionAPI) => void;
} {
	return {
		name: "memory",
		factory(pi: ExtensionAPI) {
			const channel = createVolatileChannel("memory-context");
			let root = process.cwd();
			let ui: ExtensionContext["ui"] | undefined;
			let doctrineSeen = false;
			let ontologyDoctrineSeen = false;
			let lastInput = "";
			let lastHits = "";
			let lastQueriedInput = "";
			let pollTimer: ReturnType<typeof setInterval> | null = null;
			let lastHealth: { thoughts: number; edges: number } | null = null;

			function formatStatus(h: { thoughts: number; edges: number } | null): string {
				const digest = readDigest();
				const ent = digest ? countEntities(digest) : 0;
				const parts: string[] = [];
				if (h) {
					parts.push(`${h.thoughts}T·${h.edges}R`);
				} else if (!kernAvailable()) {
					parts.push("kern off");
				}
				if (ent > 0) parts.push(`ont ${ent}E`);
				return parts.length ? parts.join(" · ") : "mem —";
			}

			function paint(): void {
				if (!ui) return;
				// Show cached health immediately, then refresh async
				if (lastHealth || !kernAvailable()) {
					ui.setStatus?.(STATUS_KEY, formatStatus(lastHealth));
				}
				memoryHealth()
					.then((h) => {
						if (!ui) return;
						if (h) lastHealth = h;
						ui.setStatus?.(STATUS_KEY, formatStatus(h));
					})
					.catch(() => {});
			}

			// Re-assert root on every tool call path
			const latchRoot = (ctx?: { cwd?: string }) => {
				root = ctx?.cwd ?? root;
				setOntologyRoot(root);
				setKernRoot(root);
			};

			// ── lifecycle ────────────────────────────────────────────

			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
				latchRoot(ctx);
				ui = ctx?.ui;
				doctrineSeen = false;
				channel.reset();
				try {
					ensureDigest();
				} catch {
					/* non-git or no-write dir */
				}
				paint();

				// Poll health every 30s
				if (pollTimer) {
					clearInterval(pollTimer);
					pollTimer = null;
				}
				pollTimer = setInterval(() => paint(), 30_000);
				if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
			});

			pi.on("agent_settled", () => paint());

			pi.on("session_shutdown", () => {
				if (pollTimer) {
					clearInterval(pollTimer);
					pollTimer = null;
				}
				ui?.setStatus?.(STATUS_KEY, undefined);
				ui = undefined;
			});

			// ── capture input for recall ────────────────────────────

			pi.on("input", (event: any) => {
				lastInput = event.text ?? "";
			});

			// Reset the per-response ingestion counter when a new assistant
			// message starts, so the delta line shows only this response's
			// <kern> block, not a stale count from an earlier response.
			pi.on("message_start", (event: any) => {
				if (event.message?.role === "assistant") setLastIngestCount(0);
			});

			// ── before_agent_start: doctrine + hits + digest ────────

			// Everything this handler produces is per-turn state — doctrine on the
			// first turn, memory hits keyed to the current input, a digest that grows
			// as the session learns. Appending any of it to the system prompt moved
			// the cache breakpoint and rewrote the whole cached prefix; it rides a
			// change-gated custom message instead.
			pi.on("before_agent_start", async (_event: any, ctx: any) => {
				latchRoot(ctx);
				// No kern on PATH means the whole memory doctrine is dead weight: the
				// <kern> blocks it asks for have nowhere to land, kern_query returns an
				// error, and the ontology workflow it describes is written in terms of
				// kern_ingest/kern_link. ~2.5KB of instructions for a store that does
				// not exist — the tools already degrade gracefully, so say nothing.
				if (!kernAvailable()) return;
				const blocks: string[] = [];

				// 1. Doctrine — once per session
				if (!doctrineSeen) {
					doctrineSeen = true;
					blocks.push(autoInjectedBlock(KERN_INSTRUCTION.trim()));
				}

				// 2. Memory hits for current input
				if (lastInput.trim() && lastInput !== lastQueriedInput) {
					const hits = await queryThoughts(lastInput, 5);
					lastQueriedInput = lastInput;
					if (hits.length > 0) {
						const hitsText = hits.map((h) => `- ${h.text.slice(0, 300)} (${h.id})`).join("\n");
						if (hitsText !== lastHits) {
							lastHits = hitsText;
							blocks.push(autoInjectedBlock(`# Kern memory (relevant to current task)\n${hitsText}`));
						}
					}
				}

				// 3. Ontology digest. The cap used to be 6000 chars — ~1.5k tokens of
				// standing context on every turn, for a document the agent can read in
				// full whenever it actually needs it. It is a pointer with a preview,
				// not a copy: `/ontology` and the digest file hold the rest.
				const digest = readDigest();
				if (digest) {
					const ent = countEntities(digest);
					if (ent > 0) {
						let body = digest.trimEnd();
						if (body.length > DIGEST_PREVIEW_CHARS) {
							body = `${body.slice(0, DIGEST_PREVIEW_CHARS)}\n… digest truncated (${digest.length} chars total — read ${digestPath()} for the rest)`;
						}
						blocks.push(autoInjectedBlock(`# Ontology digest (current)\n${body}`));
					}

					// Ontology doctrine — once per session, regardless of entity count,
					// so an empty digest bootstraps: the agent is told to populate it on
					// its first correction or first-time trip.
					if (!ontologyDoctrineSeen) {
						ontologyDoctrineSeen = true;
						blocks.push(autoInjectedBlock(ONTOLOGY_INSTRUCTION.trim()));
					}
				}

				if (blocks.length === 0) return;
				return channel.emit(blocks.join("\n"));
			});

			// ── message_end: strip <kern> blocks, ingest ───────────

			pi.on("message_end", async (event: any) => {
				if (event.message.role !== "assistant") return;
				const content = event.message.content as Array<{
					type?: string;
					text?: string;
				}>;
				if (!Array.isArray(content)) return;

				let capturedBlock = "";
				const next = content.map((b) => {
					if (b.type !== "text" || typeof b.text !== "string") return b;
					const m = b.text.match(KERN_RE);
					if (!m) return b;
					capturedBlock = m[1].trim();
					return { ...b, text: b.text.replace(KERN_RE, "").replace(/\s+$/, "") };
				});

				if (!capturedBlock) return;
				const lines = capturedBlock.split("\n").filter(Boolean);
				if (lines.length > 0) {
					setLastIngestCount(lines.length);
					void ingestBlock(lines).then(() => paint());
				}
				return { message: { ...event.message, content: next } };
			});

			// ── tools ───────────────────────────────────────────────

			for (const tool of MEMORY_TOOLS) {
				pi.registerTool(tool);
			}

			// ── commands ────────────────────────────────────────────

			pi.registerCommand("ontology", {
				description: "World model digest: status | sync (reconcile session → digest) | path",
				async handler(args: string, ctx: any) {
					latchRoot(ctx);
					ui = ctx.ui ?? ui;
					const arg = (args ?? "").trim();
					if (arg === "path") {
						ctx.ui?.notify?.(`.pi/ontology/digest.md`, "info");
						return;
					}
					if (arg === "sync") {
						ensureDigest();
						pi.sendUserMessage(
							`Reconcile this session against the ontology digest (.pi/ontology/digest.md). ` +
								`For every correction the user made or thing you tripped on the first time: ` +
								`kern_ingest it. For every connection between entities: kern_link. ` +
								`Then update the digest — one line per entity with kern IDs, relation types, ` +
								`and search hints — and remove lines that no longer hold. Report what changed.`,
							{ deliverAs: "followUp" },
						);
						ctx.ui?.notify?.("ontology sync dispatched", "info");
						return;
					}
					const digest = readDigest();
					const ent = digest ? countEntities(digest) : 0;
					ctx.ui?.notify?.(
						digest ? `ontology: ${ent} entities, ${digest.length} chars` : "no digest — not a git repository",
						"info",
					);
				},
			});

			// ── shared store API ────────────────────────────────────

			const n = globalThis as any;
			if (!n.__kern) {
				n.__kern = {
					storeDecision,
					storeObservation,
					link: storeLink,
				};
			}
		},
	};
}
