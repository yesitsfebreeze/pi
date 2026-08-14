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

import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { NvimSocketClient } from "../src/core/nvim/nvim-socket-client.ts";
import { createNvimToolDefinitions } from "../src/core/nvim.ts";

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

	it("threads the advertised glob filter into the Lua", async () => {
		const { client, lua } = clientCapturing("[]");
		const tool = toolNamed(client, "nvim_search");

		await tool.execute(
			"id",
			{ pattern: "foo", glob: "*.ts" } as never,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(lua()).toContain('local glob = "*.ts"');
		expect(lua(), "the glob must actually gate the results").toContain("keep(file)");
	});

	it("omits the glob filter entirely when none was given", async () => {
		const { client, lua } = clientCapturing("[]");
		const tool = toolNamed(client, "nvim_search");

		await tool.execute(
			"id",
			{ pattern: "foo" } as never,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(lua()).toContain("local glob = nil");
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

		it("threads the glob filter into the quickfix list it edits", async () => {
			const { client, lua } = clientCapturing("[]");
			const tool = toolNamed(client, "nvim_find_replace_all");

			await tool.execute(
				"id",
				{ pattern: "foo", replacement: "bar", glob: "src/**/*.ts" } as never,
				new AbortController().signal,
				undefined,
				{} as ExtensionContext,
			);

			expect(lua()).toContain('local glob = "src/**/*.ts"');
			expect(lua()).toContain('setqflist(kept, "r")');
		});
	});
});
