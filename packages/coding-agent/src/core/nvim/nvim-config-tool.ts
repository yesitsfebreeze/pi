/**
 * nvim_config tool — exposes the running nvim instance's configuration as a
 * structured reference document the agent can grep and search. Covers keymaps,
 * options, LSP servers, plugin list, and available search tools (telescope,
 * fzf-lua, etc).
 */

import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { NvimSocketClient } from "./nvim-socket-client.ts";
import type { NvimKeymap, NvimLspServer } from "./nvim-transport-types.ts";

const nvimConfigSchema = Type.Object({
	section: Type.Optional(
		Type.String({
			description: "Section to query: keymaps, options, lsp, plugins, search_tools, or all. Default: all.",
		}),
	),
});

export function createNvimConfigTool(client: NvimSocketClient): ToolDefinition<typeof nvimConfigSchema> {
	return {
		name: "nvim_config",
		label: "nvim_config",
		promptSnippet: "Query the running nvim config: keymaps, options, LSP, plugins, search tools",
		description:
			"Query the running nvim instance's configuration: keymaps, editor options, " +
			"LSP servers, loaded plugins, and available search tools (telescope, fzf-lua). " +
			"Use this to understand the user's nvim setup before offering nvim-specific guidance.",
		parameters: nvimConfigSchema,
		async execute(_id, { section }, _signal) {
			const sections = section ? [section] : ["keymaps", "options", "lsp", "plugins", "search_tools"];
			const parts: string[] = [];
			for (const sec of sections) {
				switch (sec) {
					case "keymaps": {
						const result = (await client.getNvimConfig("keymaps")) as NvimKeymap[];
						parts.push(formatKeymapsSection(result));
						break;
					}
					case "options": {
						const result = (await client.getNvimConfig("options")) as Record<string, unknown>;
						parts.push(formatOptionsSection(result));
						break;
					}
					case "lsp": {
						const result = (await client.getNvimConfig("lsp")) as NvimLspServer[];
						parts.push(formatLspSection(result));
						break;
					}
					case "plugins": {
						const result = (await client.getNvimConfig("plugins")) as string[];
						parts.push(formatPluginsSection(result));
						break;
					}
					case "search_tools": {
						const result = await client.evalLua(`
local tools = {}
if pcall(require, "telescope.builtin") then table.insert(tools, "telescope") end
if pcall(require, "fzf-lua") then table.insert(tools, "fzf-lua") end
if pcall(require, "snacks.picker") then table.insert(tools, "snacks.picker") end
if pcall(require, "mini.pick") then table.insert(tools, "mini.pick") end
if vim.fn.exists("*vimgrep") == 1 then table.insert(tools, "vimgrep") end
return vim.fn.json_encode(tools)
`);
						parts.push(formatSearchToolsSection(result));
						break;
					}
				}
			}
			const text = parts.join("\n\n---\n\n");
			return {
				content: [{ type: "text" as const, text: text || "No configuration data available." }],
				details: undefined,
			};
		},
		renderCall(args, theme, _context) {
			const sec = args.section ?? "all";
			return new Text(`${theme.fg("toolTitle", theme.bold("nvim_config"))} ${sec}`, 0, 0);
		},
		renderResult(result, _options, theme, _context) {
			const output = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

function formatKeymapsSection(keymaps: NvimKeymap[] | null): string {
	if (!keymaps || keymaps.length === 0) {
		return "## Keymaps\n\n(no custom keymaps found)";
	}
	const lines = ["## Keymaps"];
	for (const km of keymaps) {
		const desc = km.desc ? ` — ${km.desc}` : "";
		lines.push(`- \`${km.lhs}\` (${km.mode}): \`${km.rhs}\`${desc}`);
	}
	return lines.join("\n");
}

function formatOptionsSection(options: Record<string, unknown> | null): string {
	const interesting = [
		"expandtab",
		"tabstop",
		"shiftwidth",
		"softtabstop",
		"textwidth",
		"colorcolumn",
		"number",
		"relativenumber",
		"list",
		"wrap",
		"linebreak",
		"foldmethod",
		"foldlevel",
		"scrolloff",
		"sidescrolloff",
		"mouse",
		"clipboard",
		"completeopt",
		"pumblend",
		"winblend",
		"shell",
		"shellcmdflag",
	];
	const lines = ["## Editor Options"];
	if (options) {
		for (const opt of interesting) {
			const val = options[opt];
			if (val !== undefined && val !== null) {
				lines.push(`- \`${opt}\`: ${JSON.stringify(val)}`);
			}
		}
		const formatOptions = (options.formatoptions as string) ?? "";
		if (formatOptions) {
			lines.push(`- \`formatoptions\`: ${formatOptions}`);
		}
	}
	return lines.join("\n");
}

function formatLspSection(servers: NvimLspServer[] | null): string {
	if (!servers || servers.length === 0) {
		return "## LSP Servers\n\n(no LSP servers active)";
	}
	const lines = ["## LSP Servers"];
	for (const s of servers) {
		lines.push(`- **${s.name}** (root: ${s.root_dir})`);
		if (s.capabilities.length > 0) {
			for (const cap of s.capabilities) {
				lines.push(`  - ${cap}`);
			}
		}
	}
	return lines.join("\n");
}

function formatPluginsSection(plugins: string[] | null): string {
	if (!plugins || plugins.length === 0) {
		return "## Loaded Plugins\n\n(no plugins listed)";
	}
	const lines = ["## Loaded Plugins"];
	for (const p of plugins) {
		lines.push(`- ${p}`);
	}
	return lines.join("\n");
}

function formatSearchToolsSection(raw: string): string {
	const lines = ["## Available Search Tools"];
	try {
		const tools = JSON.parse(raw) as string[];
		if (tools.length === 0) {
			lines.push("\n(no fuzzy finder or search plugins detected. Consider installing telescope.nvim or fzf-lua)");
		} else {
			for (const tool of tools) {
				lines.push(`- \`${tool}\``);
			}
		}
	} catch {
		lines.push(`\n${raw}`);
	}
	return lines.join("\n");
}
