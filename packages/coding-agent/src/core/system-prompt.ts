/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

/** Instruction appended to the system prompt when recap is enabled. */
const RECAP_INSTRUCTION = `
## Recap (required output)

Every assistant message MUST end with a recap block as the LAST thing in the
message — no exceptions, no matter how short the turn. If you emit any text at
all, you emit a recap block. Format, EXACTLY:

<recap>
MISSION: <one short sentence — the user's overall goal for this session>
TASK: <one short sentence — the specific thing you are working on right now>
NEXT: <one short sentence — the immediate next step you plan>
</recap>

Rules:
- Emit the block on EVERY turn. No exceptions, no skipping, no "every 10 turns".
- Each of MISSION, TASK, NEXT is exactly one line. Keep them concise.
- Nothing goes after the block — it is the last thing in your message.
- The <kern> memory block (if any) goes immediately BEFORE <recap>, never after it. <recap> is always final.
- MISSION is the stable big-picture goal; only change it when the goal changes.
- TASK and NEXT reflect your current, in-progress focus — update them every turn.`;

/** Render the loaded recipes as a short pointer to the `recipes` tool. */
export function formatRecipesForPrompt(recipes: Array<{ name: string; content: string }>): string {
	if (recipes.length === 0) return "";
	const lines = [
		"\n\nThe following executable recipes are available. Use the `recipes` tool to",
		"search, read, or run one when a task matches.",
		"",
		"<available_recipes>",
		...recipes.map((recipe) => `- ${recipe.name}`),
		"</available_recipes>",
	];
	return lines.join("\n");
}

/**
 * The other half of the tool band: a deferred tool keeps its name and one line
 * of purpose in the prompt, and the model restores its schema on demand. Costs
 * ~15 tokens where the schema costs hundreds, and keeps the capability
 * reachable — deferred is not forbidden.
 */
export function formatDeferredTools(deferred: Array<{ name: string; snippet: string }> | undefined): string {
	if (!deferred || deferred.length === 0) return "";
	const lines = deferred
		.filter((t) => t.name)
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((t) => (t.snippet ? `- ${t.name} — ${t.snippet}` : `- ${t.name}`));
	if (lines.length === 0) return "";
	return `

## Deferred tools (registered, schema not loaded)

These are NOT forbidden — only their parameter schemas are withheld to keep the
context small. To use one, make a real tool call to \`tools\`:

tools({ action: "on", names: ["<tool-name>"] })

That loads the schema and makes the tool directly callable for the rest of the
session. Prefer restoring the right tool over improvising with a worse fit.

${lines.join("\n")}`;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/**
	 * Tools that are registered but whose schema is withheld from the request
	 * (see ToolDefinition.rare). Listed as one line each so the capability stays
	 * discoverable at ~15 tokens instead of the few hundred a schema costs.
	 */
	deferredTools?: Array<{ name: string; snippet: string }>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** When true, append the recap instruction so the agent emits <recap> blocks. */
	recap?: boolean;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Pre-loaded recipes. */
	recipes?: Array<{ name: string; content: string }>;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		deferredTools,
		promptGuidelines,
		appendSystemPrompt,
		recap,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		recipes: providedRecipes,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const recapSection = recap ? `${RECAP_INSTRUCTION}` : "";
	const deferredSection = formatDeferredTools(deferredTools);

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const recipes = providedRecipes ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		if (recipes.length > 0) {
			prompt += formatRecipesForPrompt(recipes);
		}

		prompt += deferredSection;

		prompt += `\nCurrent working directory: ${promptCwd}\n`;

		if (recapSection) {
			prompt += recapSection;
		}

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	if (recipes.length > 0) {
		prompt += formatRecipesForPrompt(recipes);
	}

	prompt += deferredSection;

	prompt += `\nCurrent working directory: ${promptCwd}`;

	if (recapSection) {
		prompt += recapSection;
	}

	return prompt;
}
