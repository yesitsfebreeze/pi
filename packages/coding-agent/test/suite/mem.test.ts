/**
 * mem — live process memory introspection + valgrind runner, ported into pi core.
 *
 * Coverage:
 *  - pure parsers (hex, addresses, /proc maps, /proc/<pid>/syscall, vmmap
 *    table, lldb memory-read/register-dump, memscan output)
 *  - the Linux fs code path against fixture files (a regular file IS the same
 *    positional-read code as /proc/<pid>/mem — addresses are file offsets)
 *  - procs: supervised children + valgrind jobs (stub binary)
 *  - macOS integration (skipIf not darwin): live search/read/write/registers
 *    against a real child process, SIGSTOP/SIGCONT verified via ps state
 *  - inline extension lifecycle + all 11 tools
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as darwin from "../../src/core/mem/darwin.ts";
import { createMemInlineExtension } from "../../src/core/mem/index.ts";
import * as linux from "../../src/core/mem/linux.ts";
import {
	findValgrind,
	killAllChildren,
	listChildren,
	runningChildCount,
	spawnChild,
	startValgrind,
	valgrindStatus,
} from "../../src/core/mem/procs.ts";
import { hexDecode, hexEncode, parseAddress, resumeProcess, stopProcess } from "../../src/core/mem/shared.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const IS_DARWIN = process.platform === "darwin";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mem-test-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

// ── hex + addresses ─────────────────────────────────────────────────────────

describe("hex + addresses", () => {
	it("hexEncode/hexDecode round-trip", () => {
		const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
		expect(hexEncode(bytes)).toBe("deadbeef0001");
		expect([...hexDecode("deadbeef0001")]).toEqual([...bytes]);
	});

	it("hexDecode tolerates 0x prefix and spaces", () => {
		expect([...hexDecode("0xDE AD BE")]).toEqual([0xde, 0xad, 0xbe]);
	});

	it("hexDecode rejects odd length and garbage", () => {
		expect(() => hexDecode("abc")).toThrow(/even length/);
		expect(() => hexDecode("zz")).toThrow(/invalid hex/);
	});

	it("parseAddress: hex first (with/without 0x), decimal fallback, rejects garbage", () => {
		expect(parseAddress("0x10")).toBe(16n);
		expect(parseAddress("10")).toBe(0x10n); // bare digits parse as hex first (original semantics)
		expect(parseAddress("255")).toBe(0x255n);
		expect(parseAddress("0x")).toBeNull();
		expect(parseAddress("")).toBeNull();
		expect(parseAddress("zzz")).toBeNull();
	});
});

// ── linux: /proc parsers ────────────────────────────────────────────────────

describe("linux parsers", () => {
	it("parseMaps parses regions, perms, pathnames and big addresses", () => {
		const maps = [
			"00400000-00401000 r-xp 00000000 08:01 12345 /bin/foo",
			"7f0000000000-7f0000100000 rw-p 00001000 08:01 67890 /usr/lib/libx.so",
			"ffffffffff600000-ffffffffff601000 r-xp 00000000 00:00 0 [vsyscall]",
			"garbage line that should be skipped",
			"",
		].join("\n");
		const entries = linux.parseMaps(maps);
		expect(entries).toHaveLength(3);
		expect(entries[0]).toMatchObject({ start: "0x400000", end: "0x401000", perms: "r-xp", pathname: "/bin/foo" });
		expect(entries[1].perms).toBe("rw-p");
		expect(entries[1].pathname).toBe("/usr/lib/libx.so");
		// addresses beyond 2^53 survive BigInt round-trip
		expect(entries[2].start).toBe("0xffffffffff600000");
	});

	it("parseSyscallRegs: 'running' when not in a syscall", () => {
		expect(linux.parseSyscallRegs("running")).toBe("running");
	});

	it("parseSyscallRegs: nr + 6 args + sp + pc", () => {
		const parsed = linux.parseSyscallRegs("0 0x7f1234 0x0 0x0 0x0 0x0 0x0 0x7fff0000 0x55aa0000");
		expect(parsed).toEqual({
			syscall: 0,
			args: ["0x7f1234", "0x0", "0x0", "0x0", "0x0", "0x0"],
			sp: "0x7fff0000",
			pc: "0x55aa0000",
		});
	});

	it("parseSyscallRegs: garbage is null", () => {
		expect(linux.parseSyscallRegs("")).toBeNull();
		expect(linux.parseSyscallRegs("not enough tokens")).toBeNull();
	});
});

// ── linux: fs code path against fixture files ───────────────────────────────

describe("linux fs path (fixture files)", () => {
	const MEM = "fixture-mem.bin";
	const MAPS = [
		"1000-2000 rw-p 00000000 08:01 1 /heap",
		"2000-3000 r--p 00000000 08:01 2 /ro",
		"3000-4000 --xp 00000000 08:01 3 /exec", // not readable → excluded from search
	].join("\n");

	function setup(): string {
		// address space = file offsets; pattern at 0x1050, 0x2050, and inside the
		// unreadable region at 0x3050 (must NOT be found)
		const buf = Buffer.alloc(0x4000);
		buf.write("HELLO-MEMTEST", 0x1050);
		buf.write("HELLO-MEMTEST", 0x2050);
		buf.write("HELLO-MEMTEST", 0x3050);
		const memPath = join(dir, MEM);
		writeFileSync(memPath, buf);
		return memPath;
	}

	it("readMemory reads at arbitrary offsets (BigInt positions)", () => {
		const memPath = setup();
		const bytes = linux.readMemory(0, 0x1050n, 13, memPath);
		expect(bytes.toString("utf8")).toBe("HELLO-MEMTEST");
		// short read past EOF truncates
		const tail = linux.readMemory(0, 0x3ff8n, 16, memPath);
		expect(tail.length).toBe(8);
	});

	it("readMemory caps the size at 1MB", () => {
		const big = join(dir, "big.bin");
		writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 0x7f));
		const capped = linux.readMemory(0, 0x1000n, 5 * 1024 * 1024, big);
		expect(capped.length).toBe(1024 * 1024);
	});

	it("writeMemory writes at an offset and readMemory sees it", () => {
		const memPath = setup();
		linux.writeMemory(0, 0x1100n, Buffer.from("PATCHED!"), memPath);
		expect(linux.readMemory(0, 0x1100n, 8, memPath).toString("utf8")).toBe("PATCHED!");
	});

	it("writeMemory rejects addresses beyond 2^53 (Node bigint-position bug)", () => {
		const memPath = setup();
		expect(() => linux.writeMemory(0, 0x20000000000000n, Buffer.from("x"), memPath)).toThrow(/2\^53/);
	});

	it("searchMemory finds matches only in readable regions, with bounds and budget", () => {
		const memPath = setup();
		const entries = linux.parseMaps(MAPS);
		const opts = { maxBytes: 1024 * 1024 };
		const regions = linux.readableRegions(entries, opts);
		expect(regions).toEqual([
			[0x1000n, 0x2000n],
			[0x2000n, 0x3000n],
		]);
		const r = linux.scanRegions(regions, Buffer.from("HELLO-MEMTEST"), opts, memPath);
		expect(r.matches).toEqual(["0x1050", "0x2050"]); // 0x3050 excluded (unreadable region)
		expect(r.bytesScanned).toBe(0x2000);
		expect(r.regionsSearched).toBe(2);
		expect(r.truncated).toBe(false);
	});

	it("search bounds (start/end) clip the scanned regions", () => {
		const memPath = setup();
		const entries = linux.parseMaps(MAPS);
		const regions = linux.readableRegions(entries, { start: 0x2000n, end: 0x3000n, maxBytes: 1024 * 1024 });
		expect(regions).toEqual([[0x2000n, 0x3000n]]);
		const r = linux.scanRegions(regions, Buffer.from("HELLO-MEMTEST"), { maxBytes: 1024 * 1024 }, memPath);
		expect(r.matches).toEqual(["0x2050"]);
	});

	it("search honors the max_bytes budget and reports it in bytesScanned", () => {
		const memPath = setup();
		const entries = linux.parseMaps(MAPS);
		const r = linux.scanRegions(
			linux.readableRegions(entries, { maxBytes: 4096 }),
			Buffer.from("HELLO-MEMTEST"),
			{ maxBytes: 4096 },
			memPath,
		);
		expect(r.bytesScanned).toBe(4096);
	});

	it("search caps matches at 200 and flags truncated", () => {
		const memPath = join(dir, MEM);
		writeFileSync(memPath, Buffer.alloc(0x20000, 0x41)); // 4096 matches of "41"
		const regions: Array<[bigint, bigint]> = [[0x0n, 0x20000n]];
		const r = linux.scanRegions(regions, Buffer.from([0x41]), { maxBytes: 1024 * 1024 }, memPath);
		expect(r.count).toBe(200);
		expect(r.truncated).toBe(true);
	});
});

// ── darwin: parsers (fixture text captured from real vmmap/lldb) ────────────

describe("darwin parsers", () => {
	it("parseVmmapTable parses the vmmap table format", () => {
		const fixture = [
			"==== Non-writable regions for process 73918",
			"REGION TYPE                    START - END         [ VSIZE  RSDNT  DIRTY   SWAP] PRT/MAX SHRMOD PURGE    REGION DETAIL",
			"__TEXT                      104688000-104690000    [   32K    32K     0K     0K] r-x/r-x SM=COW          /opt/homebrew/Cellar/node/26.7.0/bin/node",
			"__DATA_CONST                104690000-104694000    [   16K    16K     0K     0K] r--/rw- SM=COW          /opt/homebrew/Cellar/node/26.7.0/bin/node",
			"shared memory               1046a0000-1046a8000    [   32K    32K    32K     0K] r--/r-- SM=SHM",
			"",
		].join("\n");
		const entries = darwin.parseVmmapTable(fixture);
		expect(entries).toHaveLength(3);
		expect(entries[0]).toMatchObject({
			start: "0x104688000",
			end: "0x104690000",
			perms: "r-x",
			pathname: "/opt/homebrew/Cellar/node/26.7.0/bin/node",
		});
		expect(entries[2]).toMatchObject({ perms: "r--", pathname: "" }); // multi-word type survives
	});

	it("parseLldbMemoryRead parses hex-dump lines", () => {
		const fixture = [
			"(lldb) memory read --size 1 --count 16 --force 0x16b7769e0",
			"0x16b7769e0: 40 6a 77 6b 01 00 00 00 64 ab 6f 04 01 00 00 00  @jwk....d.o.....",
			"0x16b7769f0: 00 00 00 00",
			"",
		].join("\n");
		const bytes = darwin.parseLldbMemoryRead(fixture);
		expect(bytes).not.toBeNull();
		expect(bytes!.length).toBe(20);
		expect(bytes![0]).toBe(0x40);
		expect(bytes![19]).toBe(0x00);
	});

	it("parseLldbRegisterDump parses name = 0x... lines (symbol suffix ignored)", () => {
		const fixture = [
			"General Purpose Registers:",
			"        x0 = 0x0000000000000004",
			"       x19 = 0x0000000104714298  libuv.1.0.0.dylib`default_loop_struct",
			"        pc = 0x000000019e0e4f30",
			"",
		].join("\n");
		const regs = darwin.parseLldbRegisterDump(fixture);
		expect(regs.x0).toBe("0x0000000000000004");
		expect(regs.x19).toBe("0x0000000104714298");
		expect(regs.pc).toBe("0x000000019e0e4f30");
	});

	it("parseMemScanOutput parses the embedded-python scan output", () => {
		const fixture = [
			"MEMSCAN_MATCHES:0x105f63ce4 0x105f66eec",
			"MEMSCAN_SCANNED:134217728",
			"MEMSCAN_REGIONS:41",
			"MEMSCAN_TRUNCATED:0",
			"",
		].join("\n");
		const r = darwin.parseMemScanOutput(fixture);
		expect(r).not.toBeNull();
		expect(r!.matches).toEqual(["0x105f63ce4", "0x105f66eec"]);
		expect(r!.bytesScanned).toBe(134217728);
		expect(r!.regionsSearched).toBe(41);
		expect(r!.truncated).toBe(false);
	});

	it("parseMemScanOutput: empty match line parses as no matches", () => {
		const r = darwin.parseMemScanOutput(
			"MEMSCAN_MATCHES:\nMEMSCAN_SCANNED:0\nMEMSCAN_REGIONS:0\nMEMSCAN_TRUNCATED:0\n",
		);
		expect(r).not.toBeNull();
		expect(r!.matches).toEqual([]);
		expect(r!.bytesScanned).toBe(0);
	});
});

// ── procs: supervised children + valgrind jobs ──────────────────────────────

describe("procs: supervised children", () => {
	it("spawnChild runs, listChildren reports it, killAllChildren reaps it", async () => {
		const r = await spawnChild("/bin/sleep", ["30"]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.pid).toBeGreaterThan(0);
		expect(listChildren().some((c) => c.jobId === r.jobId && c.status === "running")).toBe(true);
		expect(runningChildCount()).toBe(1);
		killAllChildren();
		await sleep(100);
		expect(runningChildCount()).toBe(0);
	});

	it("spawnChild reports a missing binary", async () => {
		const r = await spawnChild("/nonexistent/definitely-not-here", []);
		expect(r.ok).toBe(false);
	});

	it("children that exit report exited(code)", async () => {
		const r = await spawnChild("/bin/sh", ["-c", "exit 3"]);
		if (!r.ok) return;
		// Poll instead of a fixed sleep — a loaded machine can delay the exit.
		let rec = listChildren().find((c) => c.jobId === r.jobId);
		const t0 = Date.now();
		while (Date.now() - t0 < 3000 && rec?.status === "running") {
			await sleep(50);
			rec = listChildren().find((c) => c.jobId === r.jobId);
		}
		expect(rec?.status).toBe("exited(3)");
		killAllChildren();
	});
});

describe("procs: valgrind jobs", () => {
	it("findValgrind honors MEM_VALGRIND and the override", () => {
		process.env.MEM_VALGRIND = join(dir, "vg");
		expect(findValgrind()).toBe(join(dir, "vg"));
		expect(findValgrind("/custom/vg")).toBe("/custom/vg");
		delete process.env.MEM_VALGRIND;
	});

	it("startValgrind fails cleanly when no valgrind and no path", async () => {
		delete process.env.MEM_VALGRIND;
		const r = await startValgrind("/bin/true", [], "memcheck", 5);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/valgrind not found/);
	});

	it("valgrind job runs to done with output via a stub binary", async () => {
		const stub = join(dir, "vg-stub");
		writeFileSync(stub, "#!/bin/sh\nprintf 'STUB_VG_OUTPUT\\n'\nexit 0\n");
		chmodSync(stub, 0o755);
		const r = await startValgrind("/bin/true", [], "memcheck", 30, stub);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		let s = valgrindStatus(r.jobId);
		const t0 = Date.now();
		while (Date.now() - t0 < 3000 && s.ok && s.status === "running") {
			await sleep(50);
			s = valgrindStatus(r.jobId);
		}
		expect(s.ok).toBe(true);
		if (s.ok) {
			expect(s.status).toBe("done");
			expect(s.output).toContain("STUB_VG_OUTPUT");
			expect(s.exitCode).toBe(0);
		}
	});

	it("valgrind job times out and is killed", async () => {
		const stub = join(dir, "vg-slow");
		writeFileSync(stub, "#!/bin/sh\nsleep 10\n");
		chmodSync(stub, 0o755);
		const r = await startValgrind("/bin/true", [], "memcheck", 1, stub);
		if (!r.ok) return;
		await sleep(1500);
		const s = valgrindStatus(r.jobId);
		expect(s.ok).toBe(true);
		if (s.ok) expect(s.status).toBe("timeout");
	});

	it("valgrindStatus rejects an unknown job", () => {
		const s = valgrindStatus("vg_nope");
		expect(s.ok).toBe(false);
		if (!s.ok) expect(s.error).toMatch(/not found/);
	});
});

// ── macOS integration: live process introspection via lldb/vmmap ───────────

describe.skipIf(!IS_DARWIN)("macOS integration (lldb + vmmap)", () => {
	const MARKER = "ZYXWVU-MEMTEST-9876543210";
	let childPid = -1;

	beforeAll(async () => {
		const child = spawn(
			process.execPath,
			["-e", `console.log(${JSON.stringify(MARKER)}); setInterval(()=>{}, 5000);`],
			{
				stdio: "ignore",
			},
		);
		childPid = child.pid ?? -1;
		await waitAlive(childPid);
		await sleep(400); // let it boot past the first microtasks
	});

	afterAll(() => {
		try {
			process.kill(childPid, "SIGKILL");
		} catch {
			/* gone */
		}
	});

	async function waitAlive(pid: number, ms = 5000): Promise<void> {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			try {
				process.kill(pid, 0);
				return;
			} catch {
				await sleep(100);
			}
		}
		throw new Error(`child ${pid} never came up`);
	}

	/** One retry: lldb attach right after a boot/suspend can race on macOS. */
	async function retry<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (_e) {
			await sleep(500);
			return await fn();
		}
	}

	it("maps via vmmap lists many regions with readable perms and some paths", async () => {
		const { entries, count } = await retry(() => darwin.readMaps(childPid));
		expect(count).toBeGreaterThan(10);
		expect(entries.some((e) => e.perms.includes("r"))).toBe(true);
		expect(entries.some((e) => e.pathname.length > 0)).toBe(true);
	});

	it("search finds the marker, read returns it, write then read-back verifies", async () => {
		const pattern = Buffer.from(MARKER, "utf8");
		const { entries } = await retry(() => darwin.readMaps(childPid));
		const regionOf = (addr: bigint) => entries.find((e) => BigInt(e.start) <= addr && addr < BigInt(e.end));
		let found = await retry(() => darwin.searchMemory(childPid, pattern, { maxBytes: 256 * 1024 * 1024 }));
		// The child may still be booting — the marker appears once the script
		// executes; retry briefly before giving up.
		for (let i = 0; i < 6 && found.count === 0; i++) {
			await sleep(500);
			found = await retry(() => darwin.searchMemory(childPid, pattern, { maxBytes: 256 * 1024 * 1024 }));
		}
		expect(found.count).toBeGreaterThanOrEqual(1);
		expect(found.bytesScanned).toBeGreaterThan(0);
		// Prefer a match inside a writable region so the write below is safe.
		const writable = found.matches.map(BigInt).filter((a) => regionOf(a)?.perms.includes("w"));
		const addr = writable[0] ?? BigInt(found.matches[0]);
		expect(regionOf(addr)?.perms.includes("w")).toBe(true);
		const bytes = await retry(() => darwin.readMemory(childPid, addr, pattern.length + 8));
		expect(bytes.subarray(0, pattern.length).toString("utf8")).toBe(MARKER);
		// corrupt 4 bytes at the match, read back to confirm the write landed
		const written = await retry(() => darwin.writeMemory(childPid, addr, Buffer.from([0x42, 0x42, 0x42, 0x42])));
		expect(written).toBe(4);
		const after = await retry(() => darwin.readMemory(childPid, addr, 8));
		expect([...after.subarray(0, 4)]).toEqual([0x42, 0x42, 0x42, 0x42]);
	});

	it("registers via lldb return a full dump with pc", async () => {
		const regs = await retry(() => darwin.readRegisters(childPid));
		expect(Object.keys(regs).length).toBeGreaterThan(10);
		expect(regs.pc).toMatch(/^0x[0-9a-f]+$/);
	});

	it("attach stops the process (ps state T), detach resumes it", async () => {
		stopProcess(childPid);
		await sleep(300);
		const stat = execFileSync("ps", ["-o", "stat=", "-p", String(childPid)])
			.toString()
			.trim();
		expect(stat).toContain("T");
		resumeProcess(childPid);
		await sleep(300);
		const stat2 = execFileSync("ps", ["-o", "stat=", "-p", String(childPid)])
			.toString()
			.trim();
		expect(stat2).not.toContain("T");
	});
});

// ── inline extension lifecycle ──────────────────────────────────────────────

function makeApi() {
	const tools: Record<string, { execute: (...args: any[]) => any }> = {};
	const handlers: Record<string, Array<(...args: any[]) => any>> = {};
	const status: Record<string, string | undefined> = {};
	const api: any = {
		on(event: string, h: (...args: any[]) => any) {
			handlers[event] ??= [];
			handlers[event].push(h);
		},
		registerTool(t: any) {
			tools[t.name] = t;
		},
		registerCommand() {},
		sendUserMessage() {},
	};
	const ctx = (cwd: string) => ({
		cwd,
		ui: {
			setStatus: (k: string, t: string | undefined) => {
				status[k] = t;
			},
			notify: () => {},
		},
	});
	async function fire(event: string, ev: any, c: any) {
		for (const h of handlers[event] ?? []) await h(ev, c);
	}
	return { api, tools, fire, status, ctx };
}

describe("mem inline extension", () => {
	it("registers all 11 mem tools", () => {
		const h = makeApi();
		createMemInlineExtension().factory(h.api);
		expect(Object.keys(h.tools).sort()).toEqual(
			[
				"mem_attach",
				"mem_children",
				"mem_detach",
				"mem_maps",
				"mem_read",
				"mem_registers",
				"mem_run",
				"mem_search",
				"mem_valgrind_run",
				"mem_valgrind_status",
				"mem_write",
			].sort(),
		);
	});

	it("shows no status bar with nothing running", async () => {
		const h = makeApi();
		createMemInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" }, h.ctx(dir));
		expect(h.status.mem).toBeUndefined();
	});

	it("mem_run starts a child and paints the status bar; session_shutdown reaps it", async () => {
		const h = makeApi();
		createMemInlineExtension().factory(h.api);
		await h.fire("session_start", { type: "session_start" }, h.ctx(dir));
		const res = await h.tools.mem_run.execute(
			"1",
			{ command: "/bin/sleep", args: ["30"] },
			undefined,
			undefined,
			h.ctx(dir),
		);
		const parsed = JSON.parse(res.content[0].text);
		expect(parsed.pid).toBeGreaterThan(0);
		expect(h.status.mem).toContain("1 child");
		const kids = await h.tools.mem_children.execute("1", {}, undefined, undefined, h.ctx(dir));
		expect(kids.content[0].text).toContain("running");
		await h.fire("session_shutdown", { type: "session_shutdown" }, h.ctx(dir));
		expect(h.status.mem).toBeUndefined();
		expect(listChildren().length).toBe(0);
	});

	it("mem_maps errors without a pid", async () => {
		const h = makeApi();
		createMemInlineExtension().factory(h.api);
		const res = await h.tools.mem_maps.execute("1", {}, undefined, undefined, h.ctx(dir));
		expect(res.content[0].text).toContain("error: pid required");
	});

	it("mem_read rejects a bad address", async () => {
		const h = makeApi();
		createMemInlineExtension().factory(h.api);
		const res = await h.tools.mem_read.execute(
			"1",
			{ pid: 1, address: "zz", size: 4 },
			undefined,
			undefined,
			h.ctx(dir),
		);
		expect(res.content[0].text).toContain("error: address must be hex");
	});

	it("mem_write rejects empty data", async () => {
		const h = makeApi();
		createMemInlineExtension().factory(h.api);
		const res = await h.tools.mem_write.execute(
			"1",
			{ pid: 1, address: "0x1000", data: "" },
			undefined,
			undefined,
			h.ctx(dir),
		);
		expect(res.content[0].text).toContain("error: data must be non-empty hex");
	});

	it("mem_search rejects an empty pattern", async () => {
		const h = makeApi();
		createMemInlineExtension().factory(h.api);
		const res = await h.tools.mem_search.execute("1", { pid: 1, pattern: "" }, undefined, undefined, h.ctx(dir));
		expect(res.content[0].text).toContain("error: pattern must be non-empty hex");
	});

	it("mem_run rejects a missing command", async () => {
		const h = makeApi();
		createMemInlineExtension().factory(h.api);
		const res = await h.tools.mem_run.execute("1", {}, undefined, undefined, h.ctx(dir));
		expect(res.content[0].text).toContain("error: command required");
	});

	it("mem_valgrind_status rejects an unknown job", async () => {
		const h = makeApi();
		createMemInlineExtension().factory(h.api);
		const res = await h.tools.mem_valgrind_status.execute(
			"1",
			{ job_id: "vg_nope" },
			undefined,
			undefined,
			h.ctx(dir),
		);
		expect(res.content[0].text).toContain("error: job 'vg_nope' not found");
	});
});
