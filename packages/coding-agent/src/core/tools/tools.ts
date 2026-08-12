// tools — meta-tool for deferred tool management. Lets the model list and
// restore tools whose schema is withheld to save prompt bytes. Always hot
// (never deferred itself).

import { Type } from "typebox";
import type { AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "../extensions/types.ts";

const actionSchema = Type.Enum({
	list: "list",
	on: "on",
} as const);

export interface ToolsToolState {
	getDeferredNames(): string[];
	getAllToolNames(): string[];
	restoreTools(names: string[]): string[];
}

export function createToolsToolDefinition(state: ToolsToolState): ToolDefinition {
	return {
		name: "tools",
		label: "Tools",
		description:
			"Manage the tool surface. action=on <name…> restores a deferred tool to the active surface (ls and extension tools may be deferred — they are registered but their schema is withheld to save context). action=list shows every tool including deferred ones. Use this when the task needs a tool whose schema is not visible.",
		promptSnippet: "Tool surface management: list all or restore deferred tools",
		promptGuidelines: [
			"Call `tools action=on <name>` when you need a tool whose schema is not visible — typically ls or an extension tool",
		],
		parameters: Type.Object({
			action: actionSchema,
			names: Type.Optional(Type.Array(Type.String(), { description: "Tool names to restore (action=on only)" })),
		}),
		async execute(
			_id: string,
			params: { action: "list" | "on"; names?: string[] },
			_signal?: AbortSignal,
			_onUpdate?: AgentToolUpdateCallback,
			_ctx?: ExtensionContext,
		) {
			if (params.action === "list") {
				const all = state.getAllToolNames().sort();
				const deferred = new Set(state.getDeferredNames());
				const lines = all.map((name) => {
					const marker = deferred.has(name) ? " [deferred]" : "";
					return `- ${name}${marker}`;
				});
				const text = lines.length > 0 ? lines.join("\n") : "(no tools registered)";
				return { content: [{ type: "text", text }], details: {} };
			}

			if (params.action === "on") {
				if (!params.names || params.names.length === 0)
					return { content: [{ type: "text", text: "tools: action=on requires at least one name" }], details: {} };
				const restored = state.restoreTools(params.names);
				if (restored.length === 0) {
					return {
						content: [{ type: "text", text: `tools: ${params.names.join(" ")} not found — nothing to restore` }],
						details: {},
					};
				}
				const notRestored = params.names.filter((n) => !restored.includes(n));
				const msg = [`tools: restored ${restored.join(" ")}`];
				if (notRestored.length > 0) msg.push(`(already active: ${notRestored.join(" ")})`);
				return { content: [{ type: "text", text: msg.join(" ") }], details: {} };
			}

			return { content: [{ type: "text", text: "tools: unknown action" }], details: {} };
		},
	};
}
