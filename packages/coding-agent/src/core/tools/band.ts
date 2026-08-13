// band — tool schema economy: cold by default.
//
// Every registered tool costs its schema + description on EVERY request,
// whether or not it is ever called. Measured on this codebase: the 7 builtins
// cost ~4.7KB, the core inline extensions cost ~27KB — 85% of the surface, most
// of it idle in any given session.
//
// The `rare` flag (ToolDefinition.rare) already withholds a schema and the
// `tools` meta-tool already restores it. What was missing is the default: an
// opt-in flag means every new tool ships hot and nobody remembers to mark it.
// So the default is inverted here — a small HOT set stays on the surface and
// every tool any extension registers is deferred unless it opts back in. It is
// applied in `createExtensionApi` (extensions/loader.ts), which every extension
// goes through: pi's own inline set, disk-installed extensions, and an MCP
// adapter registering a server's entire tool list.
//
// Deferred is NOT forbidden. buildSystemPrompt lists every deferred tool as
// `name — snippet` (~15 tokens) and `tools action=on <name>` brings the schema
// back for the rest of the session. Capability is preserved; only the schema
// is withheld until something asks for it.
//
// Escape hatch: PI_BAND_OFF=1 registers everything hot (A/B measurements, or a
// session that wants the full surface up front).

import type { ToolDefinition } from "../extensions/types.ts";

/**
 * Tools whose schema is worth paying for on every turn.
 *
 * The builtins are here because they are the work itself. The rest earn their
 * slot by being unreachable when deferred:
 *
 * - `tools` is the way back from a deferred schema. Banding it is a wall.
 * - `ask` fires at the moment work stops for a question; a deferred ask surface
 *   costs one extra round trip exactly when the model is deciding whether to
 *   guess instead. `questionnaire` is the same capability in a different
 *   overlay and takes the same parameters, so it is deferred: paying twice for
 *   one blocking-question surface buys nothing.
 * - `crew` is delegation. The model has to see the option at the moment it
 *   notices a job is slow and self-contained, not one restore call later.
 */
export const HOT_TOOLS: ReadonlySet<string> = new Set([
	// builtins
	"bash",
	"read",
	"write",
	"edit",
	"grep",
	"find",
	// the way back
	"tools",
	// blocking-question surface
	"ask",
	// delegation
	"crew",
]);

/** True when the band is disabled for this process (PI_BAND_OFF=1). */
export function bandDisabled(): boolean {
	return process.env.PI_BAND_OFF === "1" || process.env.PI_BAND_OFF === "true";
}

/**
 * The one-liner a deferred tool contributes to the system prompt — ~15 tokens
 * against the few hundred its schema costs, and the whole reason deferral is
 * safe rather than a silent capability loss.
 */
export function deferredSnippet(definition: Pick<ToolDefinition, "promptSnippet" | "description">): string {
	// promptSnippet only, never the description: a tool that omits its snippet has
	// opted out of the Available-tools listing, and the band must not smuggle its
	// description into the prompt through the back door. Such a tool is still
	// listed by name — deferred has to stay reachable — just without prose.
	return clip(definition.promptSnippet?.trim() ?? "", 100);
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Stamp `rare: true` on a tool unless it is hot or opted out.
 *
 * Applied at `createExtensionApi`'s `registerTool` — the one choke point every
 * extension goes through, core inline or user-installed, including an MCP
 * adapter registering a server's whole tool list. A server with twenty tools
 * costs twenty one-liners instead of twenty schemas, and the model restores the
 * one it needs. `rare: false` is the explicit opt-out for a tool that has
 * argued its way onto the hot surface.
 */
export function bandTool(tool: ToolDefinition): ToolDefinition {
	if (bandDisabled()) return tool;
	if (!tool || typeof tool !== "object") return tool;
	if (tool.rare !== undefined || HOT_TOOLS.has(tool.name)) return tool;
	return { ...tool, rare: true };
}
