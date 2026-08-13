/**
 * Prompt history — cross-session persistence for the interactive input box.
 *
 * Every submitted prompt is appended to ~/.pi/agent/pi-history.jsonl so ↑ in a
 * fresh session can recall prompts from earlier sessions, and the fuzzy
 * recall menu (ctrl+r / shift+↑) can search the full corpus.
 *
 * The in-editor history (Editor.addToHistory) is per-session; this module is
 * the durable layer under it.  Load returns most-recent-first, deduped.
 */
import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";

/**
 * Resolved per call, not at import: `getAgentDir()` honours PI_CODING_AGENT_DIR
 * and CONFIG_DIR_NAME, so a sandboxed or alternate-profile run must not append
 * to the real ~/.pi/agent history.
 */
export function historyDir(): string {
	return getAgentDir();
}
export function historyFile(): string {
	return join(historyDir(), "pi-history.jsonl");
}

/** Read at most this much of the tail. The file is append-only and never rotates. */
const MAX_TAIL_BYTES = 256 * 1024;

export interface HistoryEntry {
	text: string;
	cwd?: string;
	ts: number;
}

export async function ensureHistoryDir(dir: string = historyDir()): Promise<void> {
	await mkdir(dir, { recursive: true });
}

/** Append a prompt to the durable history file. Never throws. */
export async function recordPrompt(text: string, cwd?: string, file: string = historyFile()): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed) return;
	try {
		await ensureHistoryDir(dirname(file));
		const entry = `${JSON.stringify({ text: trimmed, cwd, ts: Date.now() })}\n`;
		await appendFile(file, entry, "utf8");
	} catch {
		// History is best-effort; never let a write failure break a session.
	}
}

/**
 * Load recent prompt history, most-recent-first, deduped by trimmed text.
 * Malformed lines are skipped; a missing file yields [].
 */
export async function loadPrompts(limit = 500, file: string = historyFile()): Promise<HistoryEntry[]> {
	// Read only the tail. This runs on the blocking interactive-startup path and
	// the file never rotates — reading it whole meant a growing startup cost to
	// recover the last few hundred entries.
	let data: string;
	try {
		const handle = await open(file, "r");
		try {
			const { size } = await handle.stat();
			const start = Math.max(0, size - MAX_TAIL_BYTES);
			const { buffer, bytesRead } = await handle.read({
				buffer: Buffer.alloc(Math.min(size, MAX_TAIL_BYTES)),
				position: start,
			});
			data = buffer.subarray(0, bytesRead).toString("utf8");
			// A mid-line start would parse as garbage; drop the partial first line.
			if (start > 0) data = data.slice(data.indexOf("\n") + 1);
		} finally {
			await handle.close();
		}
	} catch {
		return [];
	}

	const seen = new Set<string>();
	const out: HistoryEntry[] = [];
	// File is append-only (oldest first), so walk it in reverse to surface the
	// most recent entries first — matching how the editor's ↑ history walks.
	const lines = data.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const rec = parsed as Partial<HistoryEntry>;
		const text = typeof rec.text === "string" ? rec.text.trim() : "";
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push({
			text,
			cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
			ts: typeof rec.ts === "number" ? rec.ts : 0,
		});
		if (out.length >= limit) break;
	}
	return out;
}
