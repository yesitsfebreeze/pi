// mem/shared.ts — platform-agnostic primitives shared by the linux and darwin
// process-introspection backends. Ported from the pi-mem MCP server (Rust):
// the syscall-level parts (process_vm_readv / ptrace) are replaced by what
// plain Node can do — /proc/<pid>/mem on Linux, vmmap + lldb on macOS — and
// everything else (hex, address parsing, SIGSTOP/SIGCONT) is identical here.

export interface MapEntry {
	/** hex string, e.g. "0x104688000" */
	start: string;
	end: string;
	/** protection string, e.g. "r-x" — readable when it contains 'r' */
	perms: string;
	offset: string;
	pathname: string;
}

export interface SearchOptions {
	start?: bigint;
	end?: bigint;
	/** bytes to scan at most (default 64MB, hard cap 1GB) */
	maxBytes: number;
}

export interface SearchResult {
	matches: string[];
	count: number;
	bytesScanned: number;
	regionsSearched: number;
	truncated: boolean;
}

export const MAX_READ = 1024 * 1024; // per-read cap, same as the original server
export const MAX_WRITE = 1024 * 1024;
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_MAX_BYTES = 1024 * 1024 * 1024;
export const MATCH_CAP = 200; // keep tool responses bounded

export function platformName(): string {
	return process.platform;
}
export function isLinux(): boolean {
	return process.platform === "linux";
}
export function isDarwin(): boolean {
	return process.platform === "darwin";
}

export function hexEncode(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}

export function hexDecode(s: string): Uint8Array {
	const clean = s.trim().replace(/^0x/i, "").replace(/\s+/g, "");
	if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < clean.length; i += 2) {
		const v = Number.parseInt(clean.slice(i, i + 2), 16);
		if (!Number.isFinite(v)) throw new Error(`invalid hex at position ${i}`);
		out[i / 2] = v;
	}
	return out;
}

/** Hex first (with or without 0x), decimal fallback — same order as the original. */
export function parseAddress(s: string): bigint | null {
	const t = s.trim();
	if (!t) return null;
	const hex = t.replace(/^0x/i, "");
	try {
		if (/^[0-9a-fA-F]+$/.test(hex)) return BigInt(`0x${hex}`);
		return BigInt(t);
	} catch {
		return null;
	}
}

/** Stop a process (SIGSTOP) — makes memory reads stable. Works everywhere. */
export function stopProcess(pid: number): void {
	try {
		process.kill(pid, "SIGSTOP");
	} catch (e) {
		throw new Error(`SIGSTOP pid ${pid}: ${(e as Error).message}`);
	}
}

/** Resume a stopped process (SIGCONT). */
export function resumeProcess(pid: number): void {
	try {
		process.kill(pid, "SIGCONT");
	} catch (e) {
		throw new Error(`SIGCONT pid ${pid}: ${(e as Error).message}`);
	}
}
