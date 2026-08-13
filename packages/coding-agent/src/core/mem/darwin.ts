// mem/darwin.ts — macOS process introspection via vmmap + lldb.
//
// Ported from the pi-mem MCP server: /proc/<pid>/maps → vmmap, and
// process_vm_readv/writev/ptrace → the lldb CLI (present with Xcode CLT).
// lldb attaches, runs the requested command, then detaches — verified on
// macOS 26 arm64 that lldb resumes the target even when the command errors,
// and an explicit `detach` is issued before `quit` as a second line of
// defense so a failed read never leaves a process stopped.
//
// Search runs inside ONE lldb session via a small embedded Python script
// (SBProcess.ReadMemory over readable regions) — dozens of per-chunk lldb
// spawns would take minutes; one session takes the same time as one read.

import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hexEncode,
	MATCH_CAP,
	MAX_MAX_BYTES,
	MAX_READ,
	type MapEntry,
	type SearchOptions,
	type SearchResult,
} from "./shared.ts";

const LLDB_TIMEOUT_MS = 20_000;
const CMD_TIMEOUT_MS = 20_000;

interface CmdResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<CmdResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let errOut = "";
		child.stdout?.on("data", (d: Buffer) => {
			out += d.toString("utf8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			errOut += d.toString("utf8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ stdout: out, stderr: errOut, code: null });
		}, timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout: out, stderr: errOut, code });
		});
	});
}

/** One lldb session against a pid: attach, run commands in order, detach, quit. */
function lldb(pid: number, commands: string[]): Promise<CmdResult> {
	const args = ["-p", String(pid)];
	for (const c of commands) args.push("-o", c);
	args.push("-o", "detach", "-o", "quit");
	return runCmd("lldb", args, LLDB_TIMEOUT_MS);
}

function firstLldbError(stdout: string): string | null {
	const m = stdout.match(/^error:.*$/m);
	return m ? m[0].replace(/^error:\s*/, "").trim() : null;
}

// ── maps via vmmap ────────────────────────────────────────────────────────

/**
 * Parse the vmmap table format (macOS 26.x):
 *
 *   REGION TYPE                    START - END         [ VSIZE  RSDNT  DIRTY   SWAP] PRT/MAX SHRMOD PURGE    REGION DETAIL
 *   __TEXT                      104688000-104690000    [   32K    32K     0K     0K] r-x/r-x SM=COW          /opt/homebrew/.../node
 *   shared memory               1046a0000-1046a8000    [   32K    32K    32K     0K] r--/r-- SM=SHM
 */
export function parseVmmapTable(text: string): MapEntry[] {
	const entries: MapEntry[] = [];
	const ROW = /^\s*(\S.*?)\s+([0-9a-f]{4,})-([0-9a-f]{4,})\s+\[\s*[^\]]*\]\s+([rwx-]+)\/([rwx-]+)\s+(\S+)\s*(.*)$/;
	for (const line of text.split("\n")) {
		const m = line.match(ROW);
		if (!m) continue;
		// m[6] is SHRMOD (SM=COW/SHM/...) — not part of the pathname. The tail
		// may start with the PURGE column (N/A, E, P, R) when present.
		const pathname = m[7].trim().replace(/^(N\/A|E|P|R)\s+/, "");
		entries.push({
			start: `0x${m[2]}`,
			end: `0x${m[3]}`,
			perms: m[4],
			offset: "",
			pathname,
		});
	}
	return entries;
}

export async function readMaps(pid: number): Promise<{ pid: number; entries: MapEntry[]; count: number }> {
	const { stdout, stderr, code } = await runCmd("vmmap", [String(pid)], CMD_TIMEOUT_MS);
	if (code !== 0 || /cannot examine|fatal|failed|not.*running/i.test(stderr) || !stdout) {
		const detail =
			stderr.split("\n").find((l) => l.includes("cannot examine")) ??
			stderr.split("\n").find((l) => /fatal|failed/i.test(l)) ??
			stdout.split("\n").find((l) => /error/i.test(l)) ??
			"failed";
		throw new Error(`vmmap pid ${pid}: ${detail.trim().slice(0, 200)}`);
	}
	const entries = parseVmmapTable(stdout);
	return { pid, entries, count: entries.length };
}

// ── mem_read / mem_write / registers via lldb ─────────────────────────────

/** Parse `0x<addr>: <hex bytes>` lines from `memory read` output. */
export function parseLldbMemoryRead(text: string): Buffer | null {
	const bytes: number[] = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^0x[0-9a-f]+:\s+((?:[0-9a-f]{2}\s+)*[0-9a-f]{2})/);
		if (!m) continue;
		for (const b of m[1].split(/\s+/)) bytes.push(Number.parseInt(b, 16));
	}
	return bytes.length ? Buffer.from(bytes) : null;
}

export async function readMemory(pid: number, addr: bigint, size: number): Promise<Buffer> {
	const n = Math.min(size, MAX_READ);
	const { stdout } = await lldb(pid, [`memory read --size 1 --count ${n} 0x${addr.toString(16)}`]);
	const e = firstLldbError(stdout);
	if (e) throw new Error(e);
	const bytes = parseLldbMemoryRead(stdout);
	if (bytes === null) throw new Error("could not parse lldb memory read output");
	return bytes;
}

export async function writeMemory(pid: number, addr: bigint, data: Uint8Array): Promise<number> {
	if (data.length === 0) return 0;
	const n = Math.min(data.length, MAX_READ);
	const vals: string[] = [];
	for (let i = 0; i < n; i++) vals.push(`0x${data[i].toString(16).padStart(2, "0")}`);
	const { stdout } = await lldb(pid, [`memory write --size 1 0x${addr.toString(16)} ${vals.join(" ")}`]);
	const e = firstLldbError(stdout);
	if (e) throw new Error(e);
	return n;
}

export function parseLldbRegisterDump(text: string): Record<string, string> {
	const regs: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*([a-z0-9_]+)\s+=\s+(0x[0-9a-f]+)/);
		if (m) regs[m[1]] = m[2];
	}
	return regs;
}

export async function readRegisters(pid: number): Promise<Record<string, string>> {
	const { stdout } = await lldb(pid, ["register read"]);
	const e = firstLldbError(stdout);
	if (e) throw new Error(e);
	return parseLldbRegisterDump(stdout);
}

// ── mem_search via one lldb session + embedded Python ─────────────────────

// Runs inside lldb's interpreter after `command script import`. Iterates
// readable regions with SBProcess.ReadMemory (chunked, budget-capped, with
// optional start/end bounds) and prints one parseable line per field.
//
// Two lldb gotchas, both verified empirically on macOS 26:
//   - the script FILE must be named pi_memscan.py so `import` names the module
//     pi_memscan, and the registered command name is `memscan` (a mismatched
//     module ref in `command script add` silently registers nothing);
//   - a Python exception inside the command does NOT stop the remaining -o
//     commands (detach still runs) — but a plain `memory read` error DOES stop
//     the whole command list, which is why the scan is done in Python and not
//     as a sequence of -o memory reads.
const SCAN_SCRIPT = `import lldb

def run(debugger, command, result, internal_dict):
    args = command.split()
    pattern = bytes.fromhex(args[0])
    limit = int(args[1]) if len(args) > 1 else 67108864
    start = int(args[2], 16) if len(args) > 2 else 0
    end = int(args[3], 16) if len(args) > 3 else 0
    cap = ${MATCH_CAP}
    process = debugger.GetSelectedTarget().GetProcess()
    matches = []
    scanned = 0
    regions = 0
    truncated = False
    done = False
    addr = start
    while not done and scanned < limit:
        region = lldb.SBMemoryRegionInfo()
        if not process.GetMemoryRegionInfo(addr, region):
            break
        rstart = region.GetRegionBase()
        rend = region.GetRegionEnd()
        if rend <= addr:
            addr = rend
            continue
        if rstart > addr:
            addr = rstart
            continue
        if end and addr >= end:
            break
        if region.IsReadable():
            regions += 1
            pos = addr
            while pos < rend and scanned < limit and not done:
                want = min(rend - pos, 1048576, limit - scanned)
                if end and pos + want > end:
                    want = end - pos
                if want <= 0:
                    break
                err = lldb.SBError()
                data = process.ReadMemory(pos, want, err)
                if data is None or not err.Success():
                    break
                scanned += len(data)
                idx = data.find(pattern)
                while idx != -1:
                    if len(matches) >= cap:
                        truncated = True
                        done = True
                        break
                    matches.append(hex(pos + idx))
                    idx = data.find(pattern, idx + 1)
                pos += len(data)
        addr = rend
        if addr == 0:
            break
    print("MEMSCAN_MATCHES:" + " ".join(matches))
    print("MEMSCAN_SCANNED:" + str(scanned))
    print("MEMSCAN_REGIONS:" + str(regions))
    print("MEMSCAN_TRUNCATED:" + ("1" if truncated else "0"))

def __lldb_init_module(debugger, internal_dict):
    debugger.HandleCommand('command script add -f pi_memscan.run memscan')
`;

export function parseMemScanOutput(text: string): SearchResult | null {
	let matches: string[] = [];
	let scanned = -1;
	let regions = 0;
	let truncated = false;
	for (const line of text.split("\n")) {
		if (line.startsWith("MEMSCAN_MATCHES:")) {
			const rest = line.slice(16).trim();
			matches = rest ? rest.split(" ") : [];
		} else if (line.startsWith("MEMSCAN_SCANNED:")) {
			scanned = Number.parseInt(line.slice(16).trim(), 10);
		} else if (line.startsWith("MEMSCAN_REGIONS:")) {
			regions = Number.parseInt(line.slice(16).trim(), 10);
		} else if (line.startsWith("MEMSCAN_TRUNCATED:")) {
			truncated = line.slice(17).trim() === "1";
		}
	}
	if (scanned < 0) return null;
	return { matches, count: matches.length, bytesScanned: scanned, regionsSearched: regions, truncated };
}

export async function searchMemory(pid: number, pattern: Uint8Array, opts: SearchOptions): Promise<SearchResult> {
	// Fixed file name: the lldb Python bridge names the module after the file
	// basename, and the registered command must reference that module name.
	const scriptPath = join(tmpdir(), "pi_memscan.py");
	writeFileSync(scriptPath, SCAN_SCRIPT);
	try {
		let scanArgs = `memscan ${hexEncode(pattern)} ${Math.min(opts.maxBytes, MAX_MAX_BYTES)}`;
		if (opts.start !== undefined) scanArgs += ` 0x${opts.start.toString(16)}`;
		if (opts.end !== undefined) scanArgs += ` 0x${opts.end.toString(16)}`;
		const { stdout } = await lldb(pid, [`command script import ${scriptPath}`, scanArgs]);
		const e = firstLldbError(stdout);
		if (e) throw new Error(e);
		const parsed = parseMemScanOutput(stdout);
		if (parsed === null) throw new Error("could not parse memscan output");
		return parsed;
	} finally {
		try {
			rmSync(scriptPath, { force: true });
		} catch {
			/* tmp cleanup is best-effort */
		}
	}
}
