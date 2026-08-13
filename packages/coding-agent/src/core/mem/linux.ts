// mem/linux.ts — Linux process introspection via /proc, no native code.
//
// Ported from the pi-mem MCP server: process_vm_readv/process_vm_writev are
// replaced by plain fs reads/writes on /proc/<pid>/mem (same permission model —
// same-uid target or ptrace access — and what gdb itself uses), ptrace attach
// is replaced by SIGSTOP, and PTRACE_GETREGS is replaced by /proc/<pid>/syscall
// (registers only when the process is stopped inside a syscall; an honest
// limitation, see readRegisters).
//
// All /proc-touching functions take an optional memPath seam so tests can run
// the identical fs code path against a fixture file (addresses at arbitrary
// offsets work the same way).

import { closeSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { MATCH_CAP, MAX_MAX_BYTES, MAX_READ, type MapEntry, type SearchOptions, type SearchResult } from "./shared.ts";

export function memFilePath(pid: number): string {
	return `/proc/${pid}/mem`;
}

// ── maps ──────────────────────────────────────────────────────────────────

export function parseMaps(text: string): MapEntry[] {
	const entries: MapEntry[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		const parts = t.split(/\s+/);
		if (parts.length < 5) continue;
		const [range, perms, offset] = parts;
		const pathname = parts.slice(5).join(" ");
		const addrs = range.split("-");
		if (addrs.length !== 2) continue;
		try {
			const start = BigInt(`0x${addrs[0]}`);
			const end = BigInt(`0x${addrs[1]}`);
			entries.push({ start: `0x${start.toString(16)}`, end: `0x${end.toString(16)}`, perms, offset, pathname });
		} catch {
			/* unparseable range — skip */
		}
	}
	return entries;
}

export function readMaps(pid: number): { pid: number; entries: MapEntry[]; count: number } {
	const entries = parseMaps(readFileSync(`/proc/${pid}/maps`, "utf8"));
	return { pid, entries, count: entries.length };
}

// ── mem_read / mem_write via /proc/<pid>/mem ──────────────────────────────

export function readMemory(pid: number, addr: bigint, size: number, memPath?: string): Buffer {
	const path = memPath ?? memFilePath(pid);
	const want = Math.min(size, MAX_READ);
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(want);
		const n = readSync(fd, buf, 0, want, addr);
		return n < want ? buf.subarray(0, n) : buf;
	} finally {
		closeSync(fd);
	}
}

export function writeMemory(pid: number, addr: bigint, data: Uint8Array, memPath?: string): number {
	const path = memPath ?? memFilePath(pid);
	// Node 26.7.0 regression: writeSync/writevSync/async write all ignore a
	// bigint position (writes land at the wrong offset). Number positions work,
	// so use them and reject addresses beyond 2^53 explicitly rather than
	// silently corrupting memory.
	if (addr > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`address 0x${addr.toString(16)} exceeds 2^53 — write not supported by this Node build`);
	}
	const fd = openSync(path, "r+");
	try {
		return writeSync(fd, data, 0, data.length, Number(addr));
	} finally {
		closeSync(fd);
	}
}

// ── mem_search ────────────────────────────────────────────────────────────

/** Filter a parsed maps list down to readable regions, bounds applied, sorted. */
export function readableRegions(entries: MapEntry[], opts: SearchOptions): Array<[bigint, bigint]> {
	const regions: Array<[bigint, bigint]> = [];
	for (const e of entries) {
		if (!e.perms.includes("r")) continue;
		const start = BigInt(e.start);
		const end = BigInt(e.end);
		if (opts.start !== undefined && end <= opts.start) continue;
		if (opts.end !== undefined && start >= opts.end) continue;
		const effStart = opts.start !== undefined && opts.start > start ? opts.start : start;
		const effEnd = opts.end !== undefined && opts.end < end ? opts.end : end;
		if (effEnd > effStart) regions.push([effStart, effEnd]);
	}
	regions.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return regions;
}

/** Scan precomputed regions for a pattern, reading via the given mem file. */
export function scanRegions(
	regions: Array<[bigint, bigint]>,
	pattern: Uint8Array,
	opts: SearchOptions,
	memPath: string,
): SearchResult {
	const matches: string[] = [];
	let scanned = 0n;
	let truncated = false;
	const maxBytes = Math.min(opts.maxBytes, MAX_MAX_BYTES);
	const budget = BigInt(maxBytes);
	const CHUNK = BigInt(1024 * 1024);
	outer: for (const [rstart, rend] of regions) {
		if (scanned >= budget) break;
		let pos = rstart;
		while (pos < rend && scanned < budget) {
			let remaining = rend - pos;
			const cap = budget - scanned;
			if (remaining > cap) remaining = cap;
			const want = remaining > CHUNK ? CHUNK : remaining;
			let bytes: Buffer;
			try {
				bytes = readMemory(0, pos, Number(want), memPath);
			} catch {
				pos += want; // unreadable region — skip past it
				continue;
			}
			scanned += BigInt(bytes.length);
			if (bytes.length >= pattern.length) {
				let idx = bytes.indexOf(pattern);
				while (idx !== -1) {
					if (matches.length >= MATCH_CAP) {
						truncated = true;
						break outer;
					}
					matches.push(`0x${(pos + BigInt(idx)).toString(16)}`);
					idx = bytes.indexOf(pattern, idx + 1);
				}
			}
			pos += BigInt(bytes.length);
		}
	}
	return { matches, count: matches.length, bytesScanned: Number(scanned), regionsSearched: regions.length, truncated };
}

export function searchMemory(pid: number, pattern: Uint8Array, opts: SearchOptions, memPath?: string): SearchResult {
	const regions = readableRegions(readMaps(pid).entries, opts);
	return scanRegions(regions, pattern, opts, memPath ?? memFilePath(pid));
}

// ── registers via /proc/<pid>/syscall ─────────────────────────────────────

/**
 * Parse /proc/<pid>/syscall: either the literal `running` (process is not in a
 * syscall right now — no register snapshot available) or a 9-token line
 * `nr a0 a1 a2 a3 a4 a5 sp pc` (layout is identical on x86_64 and arm64).
 */
export function parseSyscallRegs(
	text: string,
): { syscall: number; args: string[]; sp: string; pc: string } | "running" | null {
	const t = text.trim();
	if (!t) return null;
	if (t === "running") return "running";
	const parts = t.split(/\s+/);
	if (parts.length < 9) return null;
	const nr = Number.parseInt(parts[0], 10);
	if (!Number.isFinite(nr)) return null;
	return { syscall: nr, args: parts.slice(1, 7), sp: parts[7], pc: parts[8] };
}

export function readRegisters(
	pid: number,
): { syscall: number; args: string[]; sp: string; pc: string } | { note: string } {
	const text = readFileSync(`/proc/${pid}/syscall`, "utf8");
	const parsed = parseSyscallRegs(text);
	if (parsed === null) throw new Error("unparseable /proc/<pid>/syscall");
	if (parsed === "running") {
		return {
			note:
				"process is not in a syscall — /proc/<pid>/syscall has no register snapshot. " +
				"Attach then stop the process inside a syscall (e.g. a blocked read/sleep) to capture registers.",
		};
	}
	return parsed;
}
