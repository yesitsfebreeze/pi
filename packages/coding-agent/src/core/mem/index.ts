// mem — live process memory introspection + valgrind runner, ported into pi
// core as an inline extension. Ported from the pi-mem MCP server (Rust,
// 997 lines): the syscall-level primitives are replaced by what plain Node
// can do with zero native code —
//
//   maps        /proc/<pid>/maps        (linux)   vmmap          (darwin)
//   mem_read    /proc/<pid>/mem fs      (linux)   lldb CLI       (darwin)
//   mem_write   /proc/<pid>/mem fs      (linux)   lldb CLI       (darwin)
//   mem_search  region scan over read   (linux)   one lldb+Py    (darwin)
//   registers   /proc/<pid>/syscall     (linux)   lldb register  (darwin)
//   attach      SIGSTOP (works everywhere)
//   detach      SIGCONT (works everywhere)
//   run/children/valgrind — pure Node child_process (works everywhere)
//
// Every tool fails open on an unsupported platform with a clear message, and
// the Linux /proc paths take a test seam (memPath) so the identical fs code
// runs against fixture files in tests.

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import * as darwin from "./darwin.ts";
import * as linux from "./linux.ts";
import {
	killAllChildren,
	killAllValgrind,
	listChildren,
	runningChildCount,
	runningValgrindCount,
	spawnChild,
	startValgrind,
	valgrindStatus,
} from "./procs.ts";
import {
	DEFAULT_MAX_BYTES,
	hexDecode,
	hexEncode,
	isDarwin,
	isLinux,
	parseAddress,
	platformName,
	resumeProcess,
	type SearchOptions,
	stopProcess,
} from "./shared.ts";

const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const err = (text: string) => ({ content: [{ type: "text" as const, text: `error: ${text}` }], details: {} });

function int(v: unknown, dflt: number): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function pidOf(v: unknown): number | null {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isInteger(n) && n > 0 ? n : null;
}

export function createMemInlineExtension(): { name: string; factory: (pi: ExtensionAPI) => void } {
	return {
		name: "mem",
		factory(pi: ExtensionAPI) {
			let ui: ExtensionContext["ui"] | undefined;

			function statusLine(): string | undefined {
				const parts: string[] = [];
				const kids = runningChildCount();
				const vgs = runningValgrindCount();
				if (kids) parts.push(`${kids} child${kids === 1 ? "" : "ren"}`);
				if (vgs) parts.push(`${vgs} vg job${vgs === 1 ? "" : "s"}`);
				return parts.length ? `mem ${parts.join(" · ")}` : undefined;
			}

			const paint = () => ui?.setStatus?.("mem", statusLine());

			// ── lifecycle ──────────────────────────────────────────────────
			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
				ui = ctx?.ui;
				paint();
			});

			pi.on("agent_settled", () => paint());

			pi.on("session_shutdown", () => {
				killAllChildren();
				killAllValgrind();
				ui?.setStatus?.("mem", undefined);
				ui = undefined;
			});

			const latch = (ctx: ExtensionContext) => {
				ui = ctx?.ui ?? ui;
			};

			// ── dispatch helpers ──────────────────────────────────────────
			const unsupported = (_tool: string) => `not supported on ${platformName()} (linux /proc, darwin vmmap+lldb)`;

			async function maps(pid: number) {
				if (isLinux()) return linux.readMaps(pid);
				if (isDarwin()) return darwin.readMaps(pid);
				throw new Error(unsupported("maps"));
			}
			async function readMem(pid: number, addr: bigint, size: number) {
				if (isLinux()) return linux.readMemory(pid, addr, size);
				if (isDarwin()) return darwin.readMemory(pid, addr, size);
				throw new Error(unsupported("mem_read"));
			}
			async function writeMem(pid: number, addr: bigint, data: Uint8Array) {
				if (isLinux()) return linux.writeMemory(pid, addr, data);
				if (isDarwin()) return darwin.writeMemory(pid, addr, data);
				throw new Error(unsupported("mem_write"));
			}
			async function searchMem(pid: number, pattern: Uint8Array, opts: SearchOptions) {
				if (isLinux()) return linux.searchMemory(pid, pattern, opts);
				if (isDarwin()) return darwin.searchMemory(pid, pattern, opts);
				throw new Error(unsupported("mem_search"));
			}
			async function regs(pid: number) {
				if (isLinux()) return linux.readRegisters(pid);
				if (isDarwin()) return darwin.readRegisters(pid);
				throw new Error(unsupported("registers"));
			}

			// ── tools ─────────────────────────────────────────────────────
			pi.registerTool({
				name: "mem_maps",
				label: "Process memory maps",
				promptSnippet: "Read a process's memory map (/proc maps or vmmap)",
				description:
					"Read the memory layout of a process — regions with protection bits and backing files. " +
					"Linux reads /proc/<pid>/maps; macOS runs vmmap. The map is the first step before mem_search/mem_read: " +
					"it tells you where code, heap, and stacks live and what is readable.",
				parameters: Type.Object({
					pid: Type.Integer({ description: "target process ID" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const pid = pidOf(params?.pid);
					if (pid === null) return err("pid required (integer)");
					try {
						const r = await maps(pid);
						return out(JSON.stringify(r, null, 2));
					} catch (e) {
						return err((e as Error).message);
					}
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "mem_read",
				label: "Read process memory",
				promptSnippet: "Read bytes from a process's address space",
				description:
					"Read up to 1MB of bytes from a process's address space at a given address. " +
					"address is hex (0x...) or decimal. Returns the bytes as hex. Works on a live process without stopping it; " +
					"attach first (mem_attach) if you want a stable snapshot.",
				parameters: Type.Object({
					pid: Type.Integer({ description: "target process ID" }),
					address: Type.String({ description: "starting address, hex (0x...) or decimal" }),
					size: Type.Integer({ description: "number of bytes to read (max 1MB)" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const pid = pidOf(params?.pid);
					if (pid === null) return err("pid required (integer)");
					const addr = parseAddress(String(params?.address ?? ""));
					if (addr === null) return err("address must be hex (0x...) or decimal");
					try {
						const bytes = await readMem(pid, addr, int(params?.size, 0));
						return out(
							JSON.stringify(
								{ address: `0x${addr.toString(16)}`, size: bytes.length, data: hexEncode(bytes) },
								null,
								2,
							),
						);
					} catch (e) {
						return err((e as Error).message);
					}
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "mem_write",
				label: "Write process memory",
				promptSnippet: "Write bytes into a process's address space",
				description:
					"DANGEROUS — writes bytes into a live process's address space and can crash or corrupt the target. " +
					"data is hex (e.g. deadbeef). Only use when you have identified the exact bytes and address from mem_read/mem_search.",
				parameters: Type.Object({
					pid: Type.Integer({ description: "target process ID" }),
					address: Type.String({ description: "starting address, hex (0x...) or decimal" }),
					data: Type.String({ description: "hex-encoded bytes to write (e.g. deadbeef)" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const pid = pidOf(params?.pid);
					if (pid === null) return err("pid required (integer)");
					const addr = parseAddress(String(params?.address ?? ""));
					if (addr === null) return err("address must be hex (0x...) or decimal");
					let data: Uint8Array;
					try {
						data = hexDecode(String(params?.data ?? ""));
					} catch (e) {
						return err((e as Error).message);
					}
					if (data.length === 0) return err("data must be non-empty hex");
					try {
						const n = await writeMem(pid, addr, data);
						return out(JSON.stringify({ address: `0x${addr.toString(16)}`, bytes_written: n }, null, 2));
					} catch (e) {
						return err((e as Error).message);
					}
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "mem_search",
				label: "Search process memory",
				promptSnippet: "Search process memory for a hex byte pattern",
				description:
					"Scan a process's readable memory regions for a hex byte pattern (e.g. deadbeef). " +
					"Optional start/end bound the scan; max_bytes caps the scan budget (default 64MB, hard cap 1GB). " +
					"Returns matching addresses — feed one to mem_read. Searches only readable regions; " +
					"reports bytesScanned so you can raise max_bytes if nothing matched.",
				parameters: Type.Object({
					pid: Type.Integer({ description: "target process ID" }),
					pattern: Type.String({ description: "hex-encoded bytes to search for (e.g. deadbeef)" }),
					start: Type.Optional(Type.String({ description: "optional start address, hex (0x...)" })),
					end: Type.Optional(Type.String({ description: "optional end address, hex (0x...)" })),
					max_bytes: Type.Optional(
						Type.Integer({ description: "max bytes to scan (default 67108864, limit 1073741824)" }),
					),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const pid = pidOf(params?.pid);
					if (pid === null) return err("pid required (integer)");
					let pattern: Uint8Array;
					try {
						pattern = hexDecode(String(params?.pattern ?? ""));
					} catch (e) {
						return err((e as Error).message);
					}
					if (pattern.length === 0) return err("pattern must be non-empty hex");
					const opts: SearchOptions = { maxBytes: int(params?.max_bytes, DEFAULT_MAX_BYTES) };
					if (params?.start !== undefined && params?.start !== "") {
						const s = parseAddress(String(params.start));
						if (s === null) return err("start must be hex (0x...) or decimal");
						opts.start = s;
					}
					if (params?.end !== undefined && params?.end !== "") {
						const e = parseAddress(String(params.end));
						if (e === null) return err("end must be hex (0x...) or decimal");
						opts.end = e;
					}
					try {
						const r = await searchMem(pid, pattern, opts);
						return out(JSON.stringify(r, null, 2));
					} catch (e) {
						return err((e as Error).message);
					}
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "mem_attach",
				label: "Attach to a process",
				promptSnippet: "Stop a process (SIGSTOP) for stable inspection",
				description:
					"Stop a process with SIGSTOP so memory reads are stable and it cannot mutate while you inspect. " +
					"mem_detach (SIGCONT) resumes it. On Linux, a process stopped inside a syscall also exposes registers via mem_registers.",
				parameters: Type.Object({
					pid: Type.Integer({ description: "target process ID" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const pid = pidOf(params?.pid);
					if (pid === null) return err("pid required (integer)");
					try {
						stopProcess(pid);
						return out(`stopped pid ${pid} (SIGSTOP) — memory is now stable; mem_detach resumes it`);
					} catch (e) {
						return err((e as Error).message);
					}
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "mem_registers",
				label: "Read CPU registers",
				promptSnippet: "Read CPU registers of a stopped process",
				description:
					"Read CPU registers of a process. macOS: full register dump via lldb (attach + read + detach). " +
					"Linux: /proc/<pid>/syscall — only works when the process is stopped inside a syscall (e.g. blocked on read/sleep); " +
					"otherwise it reports the process is running. Returns registers as a JSON map.",
				parameters: Type.Object({
					pid: Type.Integer({ description: "target process ID (attach first on linux)" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const pid = pidOf(params?.pid);
					if (pid === null) return err("pid required (integer)");
					try {
						const r = await regs(pid);
						return out(JSON.stringify(r, null, 2));
					} catch (e) {
						return err((e as Error).message);
					}
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "mem_detach",
				label: "Detach from a process",
				promptSnippet: "Resume a stopped process (SIGCONT)",
				description:
					"Resume a process previously stopped with mem_attach (SIGCONT). Safe to call on a running process.",
				parameters: Type.Object({
					pid: Type.Integer({ description: "target process ID" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const pid = pidOf(params?.pid);
					if (pid === null) return err("pid required (integer)");
					try {
						resumeProcess(pid);
						return out(`resumed pid ${pid} (SIGCONT)`);
					} catch (e) {
						return err((e as Error).message);
					}
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "mem_run",
				label: "Run an inspectable process",
				promptSnippet: "Spawn a command as a child, fully inspectable",
				description:
					"Spawn a command as a child of this session, making it fully inspectable via mem_maps/mem_read/mem_write/mem_search/mem_attach/mem_registers. " +
					"stdout/stderr are discarded — use mem_* to inspect state instead. Track it with mem_children; " +
					"all children are killed at session end.",
				parameters: Type.Object({
					command: Type.String({ description: "command to run" }),
					args: Type.Optional(Type.Array(Type.String(), { description: "command arguments" })),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const command = String(params?.command ?? "");
					if (!command) return err("command required");
					const args = Array.isArray(params?.args) ? (params.args as unknown[]).map(String) : [];
					const r = await spawnChild(command, args);
					if (!r.ok) return err(r.error);
					paint();
					return out(
						JSON.stringify(
							{
								job_id: r.jobId,
								pid: r.pid,
								command,
								status: "running",
								note: "inspect via mem_maps / mem_read / mem_search / mem_attach / mem_registers",
							},
							null,
							2,
						),
					);
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "mem_children",
				label: "List supervised processes",
				promptSnippet: "List processes spawned via mem_run",
				description:
					"List all child processes spawned via mem_run, with pid, command, status (running/exited), and elapsed time.",
				parameters: Type.Object({}),
				async execute(
					_id: string,
					_params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					return out(JSON.stringify({ children: listChildren() }, null, 2));
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "mem_valgrind_run",
				label: "Run under valgrind",
				promptSnippet: "Run a command under valgrind (memcheck etc.)",
				description:
					"Run a command under valgrind and return a job ID — poll with mem_valgrind_status. " +
					"tool selects the valgrind tool (memcheck, cachegrind, helgrind, ...). valgrind_path overrides PATH lookup " +
					"(or set MEM_VALGRIND). Fails cleanly when valgrind is not installed.",
				parameters: Type.Object({
					command: Type.String({ description: "command to run" }),
					args: Type.Optional(Type.Array(Type.String(), { description: "command arguments" })),
					tool: Type.Optional(Type.String({ description: "valgrind tool (default memcheck)" })),
					timeout_secs: Type.Optional(Type.Integer({ description: "max runtime in seconds (default 300)" })),
					valgrind_path: Type.Optional(Type.String({ description: "valgrind binary path override" })),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const command = String(params?.command ?? "");
					if (!command) return err("command required");
					const args = Array.isArray(params?.args) ? (params.args as unknown[]).map(String) : [];
					const tool = String(params?.tool ?? "memcheck");
					const r = await startValgrind(
						command,
						args,
						tool,
						int(params?.timeout_secs, 300),
						params?.valgrind_path !== undefined && params?.valgrind_path !== ""
							? String(params.valgrind_path)
							: undefined,
					);
					if (!r.ok) return err(r.error);
					paint();
					return out(
						JSON.stringify(
							{
								job_id: r.jobId,
								status: "running",
								tool,
								command,
								timeout_secs: int(params?.timeout_secs, 300),
							},
							null,
							2,
						),
					);
				},
			} as ToolDefinition);

			pi.registerTool({
				name: "mem_valgrind_status",
				label: "Poll a valgrind job",
				promptSnippet: "Check status of a valgrind job from mem_valgrind_run",
				description:
					"Check a valgrind job started by mem_valgrind_run: running (with output so far), done (with full output + exit code), or timeout.",
				parameters: Type.Object({
					job_id: Type.String({ description: "job ID from mem_valgrind_run" }),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const jobId = String(params?.job_id ?? "");
					if (!jobId) return err("job_id required");
					const r = valgrindStatus(jobId);
					if (!r.ok) return err(r.error);
					paint();
					return out(JSON.stringify({ job_id: jobId, ...r }, null, 2));
				},
			} as ToolDefinition);
		},
	};
}
