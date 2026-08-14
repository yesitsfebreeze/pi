/**
 * One-off live end-to-end: drive the REAL nvim tools against the live socket.
 * Not a committed test — run via npx tsx, needs NVIM_SOCK to be live.
 */
import { NvimSocketClient } from "../src/core/nvim/nvim-socket-client.ts";
import { createNvimExec } from "../src/core/nvim.ts";
import { createNvimToolDefinitions } from "../src/core/nvim.ts";
import { createNvimFindReplaceAllTool, createNvimSearchTool } from "../src/core/nvim/nvim-tools.ts";

const sock = process.env.NVIM_SOCK ?? "/tmp/pi-nvim-probe.sock";
const exec = createNvimExec(sock);
const client = new NvimSocketClient({ socketPath: sock, exec });
const cwd = "/tmp/nvim-loop-demo";

async function run(name: string, tool: any, args: any) {
	const t0 = Date.now();
	const res = await tool.execute("live", args, new AbortController().signal, undefined, {} as any);
	const text = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
	console.log(`\n=== ${name} (${Date.now() - t0}ms) ===\n${text}`);
	return text;
}

const tools = createNvimToolDefinitions(cwd, client);
const byName = (n: string) => tools.find((t) => t.name === n)!;

async function main() {
	// Purge stale demo buffers from earlier runs so vimgrep reads disk truth
	// (in real sessions buffers stay in sync because edits go through nvim).
	await exec(`
for _, b in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_get_name(b):find("/tmp/nvim-loop-demo", 1, true) then
    pcall(vim.api.nvim_buf_delete, b, { force = true })
  end
end
return ""
`);

	// 1. literal search (the fixed path) — pattern has no regex meaning
	await run("nvim_search literal=true", byName("nvim_search"), {
		pattern: "GREETING",
		literal: true,
		path: cwd,
	});
	// 2. regex search — '.' matches any char
	await run("nvim_search regex", byName("nvim_search"), { pattern: "GREETING.", path: cwd });

	// 3. find_replace_all DRY RUN
	const dry = await run("nvim_find_replace_all dry-run", byName("nvim_find_replace_all"), {
		pattern: "hello-world",
		replacement: "goodbye-moon",
		path: cwd,
	});
	console.log("DRY RUN changed files on disk? ", dry.includes("REPLACED") ? "check" : "no (good)");
	await exec(`vim.fn.setqflist({}, "r")`); // clear qf between runs

	// 4. find_replace_all APPLY (glob-limited to .ts)
	await run("nvim_find_replace_all apply glob=**/*.ts", byName("nvim_find_replace_all"), {
		pattern: "hello-world",
		replacement: "goodbye-moon",
		path: cwd,
		glob: "**/*.ts",
		apply: true,
	});
	// 5. single-buffer replace on the markdown (missed by the glob)
	await run("nvim_find_replace on c.md", byName("nvim_find_replace"), {
		path: "/tmp/nvim-loop-demo/src/c.md",
		old_string: "hello-world",
		new_string: "goodbye-moon",
	});
	await exec('vim.cmd("silent! wall")');

	// 6. quickfix visible in the user's nvim: open :copen in a split? just verify qf contents
	const qf = await exec(
		`return vim.fn.json_encode(vim.tbl_map(function(i) return {buf = vim.fn.bufname(i.bufnr), l = i.lnum} end, vim.fn.getqflist()))`,
	);
	console.log("\n=== quickfix after applies ===", qf.slice(0, 300));
	console.log("\n=== on-disk contents ===");
	console.log(await import("node:fs/promises").then((f) => f.readFile("/tmp/nvim-loop-demo/src/a.ts", "utf8")));
	console.log("---");
	console.log(await import("node:fs/promises").then((f) => f.readFile("/tmp/nvim-loop-demo/src/c.md", "utf8")));
	client.disconnect();
}

main().catch((e) => {
	console.error("LIVE E2E FAILED:", e);
	process.exit(1);
});
