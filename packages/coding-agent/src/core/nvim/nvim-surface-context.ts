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

import type { InlineExtension } from "../extensions/types.js";
import type { NvimSocketClient } from "./nvim-socket-client.js";
import type { NvimStateBrief } from "./nvim-transport-types.js";

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

// ── formatting ──

/** Compact one-block summary of the live editor, for system-prompt injection. */
function formatSurfaceBlock(s: NvimStateBrief): string {
	const lines: string[] = [];
	lines.push(`mode: ${s.mode}  cwd: ${s.cwd}  tab ${s.current_tab}/${s.tab_count}`);
	const bufs = (s.buffers ?? []).join(", ") ?? "(none)";
	lines.push(`buffers (${s.buffers?.length ?? 0}): ${bufs}`);
	if (s.modified_buffers?.length) lines.push(`modified: ${s.modified_buffers.join(", ")}`);
	const a = s.active;
	if (a) {
		lines.push(
			`active: ${a.file}:${a.line}:${a.col} (${a.filetype || "?"}, ${a.total_lines} lines${a.modified ? ", mod" : ""}, ${a.buftype})`,
		);
		if (a.context?.length) lines.push(a.context.join("\n"));
	}
	const alt = s.alternate;
	if (alt) {
		lines.push(
			`alternate: ${alt.file}:${alt.line}:${alt.col} (${alt.filetype || "?"}, ${alt.total_lines} lines${alt.modified ? ", mod" : ""})`,
		);
		if (alt.context?.length) lines.push(alt.context.join("\n"));
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
			pi.on("before_agent_start", (event) => {
				const client = nvimClient;
				if (!client?.connected) return;
				// Skip slash commands — they don't reach the model as edits.
				const prompt = (event.prompt ?? "").trim();
				if (prompt.startsWith("/")) return;

				// Race the snapshot against a short timeout so a stuck nvim
				// never blocks the turn. Best-effort: swallow all failures.
				const snapshot = Promise.race([
					client.getStateBrief(5),
					new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
				]);

				// `before_agent_start` handlers may be async; the runner awaits
				// them. We return a thenable so the runner waits for the RPC.
				return (async () => {
					let s: NvimStateBrief | null;
					try {
						s = await snapshot;
					} catch {
						return;
					}
					if (!s) return;
					const block = [
						"",
						"<auto-injected-context>",
						"# nvim surface (live snapshot at turn start)",
						"Background reference — not a user message; do not respond to it.",
						"Use nvim_state for a deeper view (every window, folds, marks, diagnostics)",
						"or nvim_read_buf to read any open buffer.",
						"",
						formatSurfaceBlock(s),
						"</auto-injected-context>",
					].join("\n");
					return { systemPrompt: `${event.systemPrompt}\n${block}` };
				})();
			});
		},
	};
}
