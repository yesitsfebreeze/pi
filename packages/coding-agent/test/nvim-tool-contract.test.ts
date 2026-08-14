/**
 * Regression tests for the nvim tool contract — the class of bug where a tool
 * *advertises* a capability it does not have, so the model gets a confidently
 * wrong answer instead of an error.
 *
 * Two defects are pinned here:
 *
 * 1. Lua results were returned with `vim.inspect(...)`, which emits Lua table
 *    syntax (`{ { file = "a.ts" } }`), not JSON. Every caller then ran
 *    `JSON.parse` on it, which always threw for a non-empty result. nvim_search
 *    and nvim_find_files silently degraded to dumping raw Lua, and the
 *    nvim-backed `find` operation swallowed the throw and returned `[]` — so
 *    with nvim connected, `find` reported no files at all. Results must be
 *    encoded with `vim.fn.json_encode`.
 *
 * 2. nvim_search accepted a `glob` parameter that was computed into an unused
 *    local and never reached the Lua, and both search tools accepted a
 *    `backend` parameter whose every branch called vimgrep/globpath anyway.
 *    A parameter the schema advertises must actually do something.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	listNotes,
	memoryBankStatus,
	readAuditStamp,
	readNote,
	setNvimLearningRoot,
} from "../src/core/nvim/nvim-learning.ts";
import { createNvimEditOps } from "../src/core/nvim/nvim-operations.ts";
import type { NvimSocketClient } from "../src/core/nvim/nvim-socket-client.ts";
import { NvimSocketClient as RealNvimSocketClient } from "../src/core/nvim/nvim-socket-client.ts";
import type { NvimExec } from "../src/core/nvim.ts";
import { createNvimLearnTool, createNvimToolDefinitions } from "../src/core/nvim.ts";

/** Capture the Lua a tool sends, and reply with whatever the test wants. */
function clientCapturing(reply: string): { client: NvimSocketClient; lua: () => string } {
	let seen = "";
	const client = {
		evalLua: async (code: string) => {
			seen = code;
			return reply;
		},
		getBufferState: async () => undefined,
	} as unknown as NvimSocketClient;
	return { client, lua: () => seen };
}

const toolNamed = (client: NvimSocketClient, name: string) => {
	const tool = createNvimToolDefinitions("/workspace", client).find((t) => t.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return tool;
};

/**
 * A REAL NvimSocketClient whose exec captures the Lua and replies with the
 * given payload — needed for tools that route through client methods
 * (renameSymbol, codeActions, formatBuffer, realignTable), which a plain
 * object mock does not implement.
 */
function realClientCapturing(reply: string | ((code: string) => string)): {
	client: NvimSocketClient;
	lua: () => string;
} {
	let seen = "";
	const client = new RealNvimSocketClient({
		socketPath: "/tmp/pi-test.sock",
		exec: async (code: string) => {
			seen = code;
			return typeof reply === "function" ? reply(code) : reply;
		},
	});
	return { client, lua: () => seen };
}

describe("nvim tool contract", () => {
	it("encodes Lua results as JSON, never vim.inspect", async () => {
		for (const name of ["nvim_search", "nvim_find_files"]) {
			const { client, lua } = clientCapturing("[]");
			const tool = toolNamed(client, name);
			await tool.execute(
				"id",
				{ pattern: "x" } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua(), `${name} must json_encode its results`).toContain("vim.fn.json_encode");
			expect(lua(), `${name} must not return vim.inspect`).not.toContain("return vim.inspect(");
		}
	});

	it("parses a real JSON payload into formatted matches", async () => {
		const payload = JSON.stringify([{ file: "src/a.ts", lnum: 12, col: 3, text: "const a = 1" }]);
		const { client } = clientCapturing(payload);
		const tool = toolNamed(client, "nvim_search");

		const result = await tool.execute(
			"id",
			{ pattern: "const" } as never,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");

		// The formatted path must be reached — not the raw-dump fallback.
		expect(text).toContain("src/a.ts:12:3");
		expect(text).toContain("const a = 1");
	});

	it("folds the glob into the vimgrep target (basename and dir-spanning)", async () => {
		const { client, lua } = clientCapturing("[]");
		const tool = toolNamed(client, "nvim_search");

		await tool.execute(
			"id",
			{ pattern: "foo", glob: "*.ts" } as never,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		// The glob is folded into the vimgrep target so vimgrep itself skips
		// non-matching files — not filtered in Lua after grepping everything.
		expect(lua()).toContain('local target = "/workspace/**/*.ts"');
		expect(lua()).not.toContain("keep(file)");

		const dirGlob = clientCapturing("[]");
		const tool2 = toolNamed(dirGlob.client, "nvim_search");
		await tool2.execute(
			"id",
			{ pattern: "foo", glob: "src/**/*.ts" } as never,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);
		expect(dirGlob.lua()).toContain('local target = "/workspace/src/**/*.ts"');
	});

	it("targets a single file without appending /** (which matches nothing)", async () => {
		const { client, lua } = clientCapturing("[]");
		const tool = toolNamed(client, "nvim_search");
		const file = join(process.cwd(), "test", "nvim-tool-contract.test.ts");

		await tool.execute(
			"id",
			{ pattern: "foo", path: file } as never,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(lua()).toContain(`local target = "${file}"`);
		expect(lua(), "a file path must not get / ** appended").not.toContain(`${file}/**`);
	});

	it("defaults to dir/** for a directory path", async () => {
		const { client, lua } = clientCapturing("[]");
		const tool = toolNamed(client, "nvim_search");

		await tool.execute(
			"id",
			{ pattern: "foo", path: "/workspace" } as never,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(lua()).toContain('local target = "/workspace/**"');
	});

	it("uses very-nomagic (\\V) for literal searches instead of an inline flag", async () => {
		const { client, lua } = clientCapturing("[]");
		const tool = toolNamed(client, "nvim_search");

		await tool.execute(
			"id",
			{ pattern: "a.b", literal: true } as never,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		// The emitted Lua must switch to very-nomagic (\V) — the old literal
		// mode inlined an "F" into the pattern so vimgrep searched for
		// "F <pattern>" and found nothing.
		expect(lua()).toContain('literal and "\\\\V"');
		expect(lua(), "must not inline a flag into the pattern").not.toContain("/F ");
	});

	describe("nvim_find_replace_all (multi-file replace via quickfix)", () => {
		it("encodes results as JSON and defaults to a dry run", async () => {
			const { client, lua } = clientCapturing(
				JSON.stringify({ applied: false, total_matches: 0, changed: 0, files: [], matches: [] }),
			);
			const tool = toolNamed(client, "nvim_find_replace_all");

			await tool.execute(
				"id",
				{ pattern: "foo", replacement: "bar" } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain("vim.fn.json_encode");
			expect(lua()).toContain("local apply = false");
			expect(lua()).toContain("silent! vimgrep");
		});

		it("gates the :cdo substitute on apply=true", async () => {
			const { client, lua } = clientCapturing("[]");
			const tool = toolNamed(client, "nvim_find_replace_all");

			await tool.execute(
				"id",
				{ pattern: "foo", replacement: "bar", apply: true } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain("local apply = true");
			expect(lua()).toContain('silent! cdo s" .. d .. magic .. pattern .. d .. replacement .. d .. "g');
			expect(lua()).toContain("silent! cdo update");
		});

		it("picks a vimgrep delimiter absent from pattern and replacement", async () => {
			const { client, lua } = clientCapturing("[]");
			const tool = toolNamed(client, "nvim_find_replace_all");

			await tool.execute(
				"id",
				{ pattern: "a/b", replacement: "c" } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain("pick_delim");
			expect(lua()).not.toContain("vimgrep /a/b"); // a '/' in the pattern must not split the command
		});

		it("folds the glob into the vimgrep target so the quickfix list is pre-filtered", async () => {
			const { client, lua } = clientCapturing("[]");
			const tool = toolNamed(client, "nvim_find_replace_all");

			await tool.execute(
				"id",
				{ pattern: "foo", replacement: "bar", glob: "src/**/*.ts" } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			// The glob is folded into the target: the quickfix list vimgrep fills
			// already contains exactly the files to edit — no in-Lua post-filter.
			expect(lua()).toContain('local target = "/workspace/src/**/*.ts"');
			expect(lua()).not.toContain("keep(file)");
		});
	});

	describe("lsp_rename", () => {
		it("encodes results as JSON and defaults write to true", async () => {
			const { client, lua } = realClientCapturing(
				JSON.stringify({ renamed: true, edits: 3, files: ["a.ts"], wrote: true }),
			);
			const tool = toolNamed(client, "lsp_rename");

			const result = await tool.execute(
				"id",
				{ newName: "Foo" } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain("vim.json.encode");
			expect(lua()).toContain("textDocument/rename");
			// The write gate must default to true (rename is a mutation like an edit).
			expect(lua()).toContain("local wrote = false\nif true then");
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			expect(text).toContain('Renamed to "Foo" (3 edit(s) across 1 file(s))');
		});

		it("honors write=false and reports a server error instead of a silent success", async () => {
			const { client, lua } = realClientCapturing(JSON.stringify({ error: "No identifier found" }));
			const tool = toolNamed(client, "lsp_rename");

			const result = await tool.execute(
				"id",
				{ newName: "Foo", write: false } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain("if false then");
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			expect(text).toBe("No identifier found");
		});

		it("quotes the new name so a quote in it cannot break the Lua", async () => {
			const { client, lua } = realClientCapturing("[]");
			const tool = toolNamed(client, "lsp_rename");

			await tool.execute(
				"id",
				{ newName: 'say "hi"' } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain('params.newName = "say \\"hi\\""');
		});
	});

	describe("lsp_code_action", () => {
		it("lists actions with JSON results when no action is requested", async () => {
			const payload = JSON.stringify({
				actions: [
					{ title: "Fix all auto-fixable problems", kind: "quickfix", is_preferred: false },
					{ title: "Organize imports", kind: "source", is_preferred: true },
				],
				count: 2,
			});
			const { client, lua } = realClientCapturing(payload);
			const tool = toolNamed(client, "lsp_code_action");

			const result = await tool.execute(
				"id",
				{} as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain("textDocument/codeAction");
			expect(lua()).toContain("local want = nil");
			expect(lua()).toContain("vim.json.encode");
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			expect(text).toContain("1. Fix all auto-fixable problems [quickfix]");
			expect(text).toContain("2. Organize imports (preferred) [source]");
		});

		it("emits the apply machinery (execute_command) when an action index is given", async () => {
			const { client, lua } = realClientCapturing(
				JSON.stringify({ applied: "Organize imports", edit: true, command: false, wrote: 1 }),
			);
			const tool = toolNamed(client, "lsp_code_action");

			await tool.execute(
				"id",
				{ action: 2 } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain("local want = 2");
			expect(lua()).toContain("vim.lsp.buf.execute_command");
		});
	});

	describe("nvim_format", () => {
		it("prefers conform, runs it synchronously, and JSON-encodes the result", async () => {
			const { client, lua } = realClientCapturing(
				JSON.stringify({ backend: "conform", formatters: ["prettier"], changed: true, error: null }),
			);
			const tool = toolNamed(client, "nvim_format");

			const result = await tool.execute(
				"id",
				{} as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain('pcall(require, "conform")');
			expect(lua()).toContain('lsp_format = "fallback"');
			expect(lua()).toContain("vim.json.encode");
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			expect(text).toContain("Formatted via conform [prettier]");
		});

		it("threads an explicit formatter into conform's opts.formatters", async () => {
			const { client, lua } = realClientCapturing("[]");
			const tool = toolNamed(client, "nvim_format");

			await tool.execute(
				"id",
				{ formatter: "black" } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain('local formatter = "black"');
			expect(lua()).toContain("opts.formatters = { formatter }");
		});

		it("falls back to vim.lsp.buf.format when conform is absent", async () => {
			const { client, lua } = realClientCapturing(JSON.stringify({ backend: "lsp", changed: true, error: null }));
			const tool = toolNamed(client, "nvim_format");

			await tool.execute("id", {} as never, new AbortController().signal, undefined, {} as ExtensionContext);

			expect(lua()).toContain("vim.lsp.buf.format({ bufnr = bufnr, async = false })");
		});
	});

	describe("nvim_table_realign", () => {
		it("calls vim-table-mode's autoload function and JSON-encodes the result", async () => {
			const { client, lua } = realClientCapturing(
				JSON.stringify({ realigned: true, line: 4, filetype: "markdown" }),
			);
			const tool = toolNamed(client, "nvim_table_realign");

			const result = await tool.execute(
				"id",
				{ line: 4 } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain('vim.fn["tablemode#table#Realign"]');
			expect(lua()).toContain("vim.json.encode");
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			expect(text).toContain("Table realigned at line 4");
		});

		it("refuses non-markdown buffers instead of silently doing nothing", async () => {
			const { client, lua } = realClientCapturing(
				JSON.stringify({ error: "vim-table-mode only aligns markdown tables" }),
			);
			const tool = toolNamed(client, "nvim_table_realign");

			await tool.execute("id", {} as never, new AbortController().signal, undefined, {} as ExtensionContext);

			expect(lua()).toContain('ft ~= "markdown"');
		});
	});

	describe("lsp position tools", () => {
		it("threads the advertised line/col into the Lua instead of ignoring them", async () => {
			// Contract: a parameter the schema advertises must actually do something.
			// The old implementation always built params from the current cursor and
			// dropped path/line/col entirely.
			const stateReply = JSON.stringify({
				path: "",
				cursor: [0, 0],
				modified: false,
				filetype: "typescript",
				content: "",
			});
			for (const name of ["lsp_definition", "lsp_references", "lsp_hover"]) {
				const { client, lua } = realClientCapturing((code) => {
					if (code.includes('nvim_buf_get_option(bufnr, "modified")')) return stateReply;
					if (code.includes("textDocument/hover")) return "null";
					return "[]";
				});
				const tool = toolNamed(client, name);

				await tool.execute(
					"id",
					{ line: 5, col: 3 } as never,
					new AbortController().signal,
					undefined,
					{} as ExtensionContext,
				);

				expect(lua(), `${name} must build params for the given position`).toContain(
					"make_position_params(bufnr, 5, 3)",
				);
				expect(lua(), `${name} must not use the cursor-only helper`).not.toContain(
					"vim.lsp.util.make_position_params()",
				);
			}
		});
	});
});
describe("nvim_learn audit (memory-bank onboarding)", () => {
	const probePayload = JSON.stringify({
		config_dir: "/Users/test/.config/nvim",
		data_dir: "/Users/test/.local/share/nvim",
		config_files: ["/Users/test/.config/nvim/init.lua", "/Users/test/.config/nvim/lua/plugins/lsp.lua"],
		keymaps: {
			n: [{ lhs: "<leader>ff", rhs: "<cmd>Telescope find_files<CR>", desc: "Find files" }],
			v: [],
		},
		commands: ["Telescope", "Oil"],
		options: { expandtab: true, shiftwidth: 2 },
		lsp: [{ name: "ts_ls", root: "/workspace", caps: ["definition", "rename"], encoding: "utf-16" }],
		mason: ["typescript-language-server", "rust-analyzer"],
		plugins: [
			{ name: "telescope.nvim", loaded: false },
			{ name: "conform.nvim", loaded: true },
		],
		parsers: ["lua", "markdown"],
		probes: {
			telescope: true,
			oil: true,
			conform: true,
			table_mode: true,
			smear_cursor: false,
		},
		formatters: { lua: ["stylua"], markdown: ["prettier"] },
		cur_formatters: [],
	});

	it("audit regenerates the factual notes, stamps the bank, and reports broken probes", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-nvim-audit-"));
		setNvimLearningRoot(root);

		let calls = 0;
		const exec: NvimExec = async () => {
			calls += 1;
			// First call: config file list; second: the probe.
			if (calls === 1) {
				return JSON.stringify({
					configdir: "/Users/test/.config/nvim",
					files: ["/Users/test/.config/nvim/init.lua", "/Users/test/.config/nvim/lua/plugins/lsp.lua"],
				});
			}
			return probePayload;
		};
		const tool = createNvimLearnTool(root, exec);
		const result = await tool.execute(
			"id",
			{ action: "audit" } as never,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");

		expect(text).toContain("Probes: 5 capabilities checked, 1 broken (smear_cursor)");
		expect(text).toContain("Notes written/updated: keymaps, options, plugins, lsp, recipes");

		// The factual notes exist with derived content.
		const pluginsNote = readNote("plugins");
		expect(pluginsNote).toContain("✅ `conform`");
		expect(pluginsNote).toContain("❌ `smear_cursor`");
		expect(pluginsNote).toContain("conform formatters_by_ft");
		const recipesNote = readNote("recipes");
		expect(recipesNote).toContain("`nvim_format`");
		expect(recipesNote).toContain("conform (lua, markdown)");
		const keymapsNote = readNote("keymaps");
		expect(keymapsNote).toContain("<leader>ff");
		const lspNote = readNote("lsp");
		expect(lspNote).toContain("ts_ls");

		// The bank is stamped and the config is recorded.
		expect(readAuditStamp()).not.toBeNull();
		const status = memoryBankStatus(
			["/Users/test/.config/nvim/init.lua", "/Users/test/.config/nvim/lua/plugins/lsp.lua"],
			listNotes(),
			readAuditStamp(),
		);
		expect(status.needsAudit).toBe(false);

		rmSync(root, { recursive: true, force: true });
	});
});

describe("nvim_reveal + visible edits", () => {
	it("registers nvim_reveal and encodes its results as JSON", async () => {
		const { client, lua } = realClientCapturing(
			JSON.stringify({ path: "/workspace/a.ts", bufnr: 5, window: 2, line: 12 }),
		);
		const tool = toolNamed(client, "nvim_reveal");

		const result = await tool.execute(
			"id",
			{ path: "/workspace/a.ts", line: 12 } as never,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(lua()).toContain("vim.json.encode");
		expect(lua()).toContain("vim.api.nvim_buf_get_lines");
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
		expect(text).toContain("revealed /workspace/a.ts:12");
	});

	it("jumps the cursor and centers the view when a line is given", async () => {
		const { client, lua } = realClientCapturing("[]");
		const tool = toolNamed(client, "nvim_reveal");

		await tool.execute(
			"id",
			{ path: "a.ts", line: 3, col: 5, split: "vsplit" } as never,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		const emitted = lua();
		expect(emitted).toContain('local path, line, col, split = "a.ts", 3, 5, "vsplit"');
		expect(emitted).toContain("nvim_win_set_cursor");
		expect(emitted).toContain("normal! zz");
		expect(emitted).toContain('vim.cmd("vsplit")');
	});
});

describe("edit ops reveal the edit site", () => {
	it("writeFile reveals the first changed line", async () => {
		const target = join(mkdtempSync(join(tmpdir(), "pi-reveal-")), "a.ts");
		const seen: string[] = [];
		const client = {
			getBufferState: async () => ({
				path: target,
				content: "line1\nline2\nline3",
				cursor: [0, 0] as [number, number],
				modified: false,
				filetype: "typescript",
			}),
			applyEdits: async () => {},
			revealFile: async (p: string, line?: number) => {
				seen.push(`reveal ${p} ${line}`);
			},
		} as unknown as NvimSocketClient;

		const ops = createNvimEditOps(() => client);
		await ops.writeFile(target, "line1\nCHANGED\nline3\n");
		expect(seen).toEqual([`reveal ${target} 2`]);
	});

	it("does not reveal when nothing changed", async () => {
		const target = join(mkdtempSync(join(tmpdir(), "pi-reveal-")), "a.ts");
		const seen: string[] = [];
		const client = {
			getBufferState: async () => ({
				path: target,
				content: "same\ncontent",
				cursor: [0, 0] as [number, number],
				modified: false,
				filetype: "typescript",
			}),
			applyEdits: async () => {},
			revealFile: async (p: string, line?: number) => {
				seen.push(`reveal ${p} ${line}`);
			},
		} as unknown as NvimSocketClient;

		const ops = createNvimEditOps(() => client);
		await ops.writeFile(target, "same\ncontent\n");
		expect(seen).toEqual([]);
	});
});
