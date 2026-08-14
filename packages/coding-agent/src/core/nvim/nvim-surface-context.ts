/**
 * Auto-injection of the live nvim surface into the agent's context at the
 * start of every turn — so the agent sees every open buffer, window, cursor,
 * mode, and modified-state without having to call a tool.
 *
 * Wiring: nvim connects at runtime (via `/nvim` or `--nvim-socket`), after
 * core inline extensions have loaded. So this module owns a process-level
 * holder for the connected {@link NvimSocketClient}; the connect sites
 * (interactive-mode, main.ts CLI flag) call {@link setNvimSurfaceClient} on
 * connect and on disconnect. The inline extension reads the holder on each
 * `before_agent_start` and, when a client is connected, pulls a cheap
 * `getStateBrief()` snapshot and appends it to the system prompt.
 *
 * Resilience: the snapshot RPC is raced against a short timeout (default
 * 2.5s, well under the 10s transport timeout) so a stuck nvim never blocks a
 * turn. Any failure is swallowed — injection is best-effort, never fatal.
 */

import { autoInjectedBlock, createVolatileChannel } from "../context-injection.ts";
import type { InlineExtension } from "../extensions/types.ts";
import type { NvimSocketClient } from "./nvim-socket-client.ts";
import type { NvimBriefDiagnostic, NvimLspClient, NvimStateBrief } from "./nvim-transport-types.ts";

// ── shared client holder ──

let nvimClient: NvimSocketClient | undefined;

/** Connect sites call this to publish/clear the live nvim client. */
export function setNvimSurfaceClient(client: NvimSocketClient | undefined): void {
	nvimClient = client;
}

/** True when a client is connected and injection should run. */
export function isNvimSurfaceConnected(): boolean {
	return !!nvimClient?.connected;
}

// ── one-shot connect notice ──

/**
 * Passive, one-shot notice injected into the system prompt on the next real
 * agent turn after nvim connects. This replaces firing a `session.prompt()`
 * on connect — which sends the notice as a *user* message and kicks off an
 * agent run (a "loop until continuation") that disrupts the session. Passive
 * injection informs the agent without triggering a turn.
 */
let nvimNotice: string | undefined;

export function setNvimSurfaceNotice(text: string | undefined): void {
	nvimNotice = text;
}

// ── formatting ──

const severityLabel = (s: number) => ({ 1: "E", 2: "W", 3: "I", 4: "H" })[s] ?? "?";

/** Format attached LSP clients (or a hint when none are attached). */
function formatLspClients(clients?: NvimLspClient[]): string {
	if (!clients?.length) {
		return "lsp: none (no language server attached — open a source file and it auto-attaches)";
	}
	return clients
		.map((c) => `lsp: ${c.name} (root=${c.root_dir}${c.filetypes?.length ? `, ft=${c.filetypes.join(",")}` : ""})`)
		.join("\n");
}

/** Format a capped diagnostic list for a window. */
function formatDiagnostics(label: string, diags?: NvimBriefDiagnostic[], total?: number): string[] {
	if (!diags?.length) return [];
	const lines = [`diagnostics (${label}${total !== undefined ? `, ${total}` : ""}):`];
	for (const d of diags) {
		lines.push(`  ${severityLabel(d.severity)} ${d.source}:${d.lnum + 1}:${d.col + 1}  ${d.message}`);
	}
	return lines;
}

/** Compact one-block summary of the live editor, for system-prompt injection. */
function formatSurfaceBlock(s: NvimStateBrief): string {
	const lines: string[] = [];
	lines.push(`mode: ${s.mode}  cwd: ${s.cwd}  tab ${s.current_tab}/${s.tab_count}`);
	const bufs = (s.buffers ?? []).join(", ") ?? "(none)";
	lines.push(`buffers (${s.buffers?.length ?? 0}): ${bufs}`);
	if (s.modified_buffers?.length) lines.push(`modified: ${s.modified_buffers.join(", ")}`);
	lines.push(formatLspClients(s.lsp_clients));
	const a = s.active;
	if (a) {
		lines.push(
			`active: ${a.file}:${a.line}:${a.col} (${a.filetype || "?"}, ${a.total_lines} lines${a.modified ? ", mod" : ""}, ${a.buftype})`,
		);
		if (a.context?.length) lines.push(a.context.join("\n"));
		lines.push(...formatDiagnostics("active", a.diagnostics, a.diagnostics_total));
	}
	const alt = s.alternate;
	if (alt) {
		lines.push(
			`alternate: ${alt.file}:${alt.line}:${alt.col} (${alt.filetype || "?"}, ${alt.total_lines} lines${alt.modified ? ", mod" : ""})`,
		);
		if (alt.context?.length) lines.push(alt.context.join("\n"));
		lines.push(...formatDiagnostics("alternate", alt.diagnostics, alt.diagnostics_total));
	}
	if (s.terminals?.length) {
		lines.push(
			`terminals: ${s.terminals.map((t) => `${t.buf}(${t.name}${t.visible ? ", visible" : ""})`).join(", ")}`,
		);
	}
	return lines.join("\n");
}

// ── inline extension ──

/** Inline extension that injects the live nvim surface at turn start. */
export function createNvimSurfaceExtension(timeoutMs = 2500): InlineExtension {
	return {
		name: "nvim-surface",
		hidden: true,
		factory(pi) {
			// The surface is the most volatile payload in the tree — cursor, buffer
			// list and diagnostics move every turn. Appending it to the system
			// prompt moved the cache breakpoint and rewrote the whole cached prefix
			// (system prompt + every tool schema + the conversation) at write price
			// every single turn. It rides a change-gated custom message instead.
			const channel = createVolatileChannel("nvim-surface");
			pi.on("session_start", () => channel.reset());

			pi.on("before_agent_start", (event) => {
				// Skip slash commands — they don't reach the model as edits.
				const prompt = (event.prompt ?? "").trim();
				if (prompt.startsWith("/")) return;

				// The connection gate — shared by every surface consumer.
				const live = isNvimSurfaceConnected() ? nvimClient : undefined;

				// Consume the one-shot connect notice (if any) before anything else.
				let notice: string | undefined;
				if (nvimNotice) {
					notice = nvimNotice;
					nvimNotice = undefined;
				}

				if (!live && !notice) return;

				// Race the snapshot against a short timeout so a stuck nvim
				// never blocks the turn. Best-effort: swallow all failures.
				const snapshot: Promise<NvimStateBrief | null> = live
					? Promise.race([live.getStateBrief(5), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))])
					: Promise.resolve(null);

				// `before_agent_start` handlers may be async; the runner awaits
				// them. We return a thenable so the runner waits for the RPC.
				return (async () => {
					let s: NvimStateBrief | null = null;
					if (live) {
						try {
							s = await snapshot;
						} catch {
							return;
						}
					}

					const blocks: string[] = [];
					if (notice) {
						blocks.push(autoInjectedBlock(`# nvim connected\n${notice}`));
					}
					if (s) {
						blocks.push(
							autoInjectedBlock(
								[
									"# nvim surface (live snapshot at turn start)",
									"LSP clients and diagnostics for active/alternate buffers are injected above.",
									"Use the lsp_* tools (definition/references/hover/rename/code_action) for symbols,",
									"nvim_format to format, nvim_table_realign for markdown tables, or nvim_state for a deeper view.",
									"WORK VISIBLY — the editor is your stage: edits auto-reveal the changed line, and",
									"nvim_reveal switches the window/cursor/scroll to whatever you're working on.",
									"Prefer nvim-native search (nvim_search → quickfix) and nvim_read_buf over bash for file work.",
									"",
									formatSurfaceBlock(s),
								].join("\n"),
							),
						);
					}
					return channel.emit(blocks.join("\n"));
				})();
			});
		},
	};
}
