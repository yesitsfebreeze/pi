/**
 * Interact — user-decision tools (questionnaire, ask).
 *
 * Both tools let the agent ask the user one or more questions with briefing,
 * options, and recommendations.  The user can pick an option, rewrite one,
 * or type a free-text answer.  The answer carries *how* it was reached so
 * the agent knows whether a recommendation was adopted or overridden.
 */
import type { InlineExtension } from "../extensions/types.ts";
import { createAskTool } from "./ask.ts";
import { createQuestionnaireTool } from "./questionnaire.ts";

export function createInteractExtension(): InlineExtension {
	return {
		name: "interact",
		hidden: true,
		factory(pi) {
			pi.registerTool(createQuestionnaireTool());
			pi.registerTool(createAskTool());
		},
	};
}
