/**
 * Terminal-session registry for pi.
 *
 * Tracks which terminal ran which session, so a fresh startup in the same
 * terminal can offer to resume the last session.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi", "sessions");
const LEDGER_PATH = join(STATE_DIR, "ledger.json");
const MAX_ENTRIES = 50;

export interface LedgerEntry {
	sessionId: string;
	sessionFile: string | null;
	cwd: string;
	pid: number;
	tty: string;
	startedAt: string;
	endedAt: string | null;
	lastReason: string;
}

function getTty(pid: number): string {
	try {
		const r = spawnSync("ps", ["-p", String(pid), "-o", "tty="], {
			encoding: "utf8",
			timeout: 2000,
		});
		return (r.stdout || "").trim() || "?";
	} catch {
		return "?";
	}
}

export function loadLedger(): LedgerEntry[] {
	try {
		return JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as LedgerEntry[];
	} catch {
		return [];
	}
}

function saveLedger(entries: LedgerEntry[]): void {
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2));
}

/** Upsert a ledger entry for a started session. */
export function ledgerSessionStart(sessionId: string, sessionFile: string | null, cwd: string): void {
	const entries = loadLedger();
	const tty = getTty(process.pid);
	const now = new Date().toISOString();

	// Remove previous entry for this sessionId (upsert)
	const filtered = entries.filter((e) => e.sessionId !== sessionId);
	filtered.push({
		sessionId,
		sessionFile,
		cwd,
		pid: process.pid,
		tty,
		startedAt: now,
		endedAt: null,
		lastReason: "startup",
	});

	// Trim to max entries
	if (filtered.length > MAX_ENTRIES) {
		filtered.splice(0, filtered.length - MAX_ENTRIES);
	}

	saveLedger(filtered);
}

/** Stamp the end of a session. */
export function ledgerSessionEnd(sessionId: string, reason: string): void {
	const entries = loadLedger();
	const entry = entries.find((e) => e.sessionId === sessionId);
	if (entry) {
		entry.endedAt = new Date().toISOString();
		entry.lastReason = reason;
		saveLedger(entries);
	}
}

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Look up the most recent OTHER session from the same tty that ended
 * within the recent window. Returns the resume command or null.
 */
export function ledgerSuggestResume(): string | null {
	if (!process.env.PI_AUTO_RESUME && process.env.PI_AUTO_RESUME !== "1") return null;
	const entries = loadLedger();
	if (entries.length === 0) return null;

	const tty = getTty(process.pid);
	if (tty === "?") return null;

	const now = Date.now();
	const recent = entries
		.filter(
			(e) =>
				e.tty === tty &&
				e.sessionId !== "" &&
				e.endedAt !== null &&
				now - new Date(e.endedAt).getTime() < RECENT_WINDOW_MS,
		)
		.sort((a, b) => new Date(b.endedAt!).getTime() - new Date(a.endedAt!).getTime());

	if (recent.length === 0) return null;

	const last = recent[0];
	if (last.sessionFile) {
		return `pi --session ${last.sessionFile}`;
	}
	return `pi --session ${last.sessionId}`;
}
