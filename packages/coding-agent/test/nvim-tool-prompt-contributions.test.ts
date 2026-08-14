/**
 * Regression test: nvim tools must contribute to the system prompt.
 *
 * Without promptSnippet/promptGuidelines, the built system prompt never
 * advertises nvim-native tools or instructs the agent to prefer them over
 * bash — the model only sees them as function schemas and defaults to
 * running `find`/`ls`/`nvim` from bash. See nvimPromptGuidelines.
 */

import { describe, expect, it } from "vitest";
import type { NvimSocketClient } from "../src/core/nvim/nvim-socket-client.ts";
import { nvimPromptGuidelines } from "../src/core/nvim/nvim-surface.ts";
import { createNvimLearnTool, createNvimToolDefinitions, nvimBasicToolDefinitions } from "../src/core/nvim.ts";

describe("nvim tool system prompt contributions", () => {
	it("gives every nvim-native tool a prompt snippet so it appears in Available tools", () => {
		const client = {} as NvimSocketClient;
		const tools = createNvimToolDefinitions("/workspace", client);

		expect(tools.length).toBeGreaterThan(0);
		for (const tool of tools) {
			expect(tool.promptSnippet, `${tool.name} must have a promptSnippet`).toBeTruthy();
		}
	});

	it("gives the direct-control tools (nvim_exec/nvim_lua) a prompt snippet", () => {
		const exec = async () => "";
		const tools = nvimBasicToolDefinitions(exec);

		expect(tools.map((t) => t.name)).toEqual(["nvim_exec", "nvim_lua"]);
		for (const tool of tools) {
			expect(tool.promptSnippet, `${tool.name} must have a promptSnippet`).toBeTruthy();
		}
	});

	it("ships the core nvim tools hot (rare: false) and the situational ones deferred", () => {
		const client = {} as NvimSocketClient;
		const tools = createNvimToolDefinitions("/workspace", client);
		const basic = nvimBasicToolDefinitions(async () => "");
		const learn = createNvimLearnTool("/workspace", async () => "");
		const all = [...tools, ...basic, learn];

		// The "work itself" set when nvim is connected — same argument that
		// keeps bash/read/edit hot. These are only registered while connected,
		// so their schemas cost nothing outside nvim sessions. Deferred tools
		// stay one-liners until restored with tools action=on.
		const hot = new Set([
			"nvim_state",
			"nvim_read_buf",
			"nvim_find_replace",
			"nvim_find_replace_all",
			"nvim_search",
			"nvim_find_files",
			"buffers",
			"nvim_exec",
			"nvim_lua",
			"nvim_keys",
			"nvim_config",
			"nvim_learn",
		]);

		for (const tool of all) {
			if (hot.has(tool.name)) {
				expect(tool.rare, `${tool.name} must ship hot when nvim is connected`).toBe(false);
			} else {
				expect(tool.rare, `${tool.name} stays deferred (one-liner until restored)`).not.toBe(false);
			}
		}
		expect(all.map((t) => t.name)).toEqual(expect.arrayContaining([...hot]));
	});

	it("attaches the nvim-over-bash guidelines to the always-active nvim_state tool", () => {
		const client = {} as NvimSocketClient;
		const tools = createNvimToolDefinitions("/workspace", client);
		const state = tools.find((t) => t.name === "nvim_state");

		expect(state).toBeDefined();
		expect(state!.promptGuidelines).toEqual(nvimPromptGuidelines);
	});
});
