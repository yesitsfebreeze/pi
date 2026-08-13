// recipes — executable knowledge base, ported into pi core as an inline
// extension. `.pi/recipes/` at repo root stores .md files with YAML
// frontmatter (the retrieval contract), a prose body (the reasoning),
// and optional named ```!bash blocks (the executable procedures).
//
// Concept ported from yesitsfebreeze/justdown, adapted for pi core:
// - No `jd` CLI — everything in TypeScript
// - No `.jd` extension — standard `.md` files
// - No `just` dependency — executable blocks are pure bash
// - No SQLite — pure filesystem store (pattern: crawl/gantt)
// - Named ```!bash recipe_name(args...) blocks (the `!` distinguishes
//   them from ordinary code fences)
//
// The search logic is ported from justdown's exact-mode Rank():
// weights name/use_when=3, tags=2, description=1, not_when vetoes,
// link-degree tiebreaker.

import { existsSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { rank } from "./search.ts";
import { countRecipes, createRecipe, loadRecipes, recipesDir, resolveRecipe, setRecipesRoot } from "./store.ts";
import type { RecipeBlock } from "./types.ts";

const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

// ── inline extension factory ────────────────────────────────────────────
export function createRecipesInlineExtension(): {
	name: string;
	factory: (pi: ExtensionAPI) => void;
} {
	return {
		name: "recipes",
		factory(pi: ExtensionAPI) {
			let root = process.cwd();
			let ui: ExtensionContext["ui"] | undefined;
			const STATUS_KEY = "recipes";

			function paint(): void {
				if (!existsSync(recipesDir())) {
					ui?.setStatus?.(STATUS_KEY, undefined);
					return;
				}
				const counts = countRecipes();
				let total = 0;
				for (const n of counts.values()) total += n;
				ui?.setStatus?.(STATUS_KEY, `recipes ${counts.size} categories · ${total} recipes`);
			}

			// ── lifecycle ────────────────────────────────────────────
			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
				root = ctx?.cwd ?? root;
				setRecipesRoot(root);
				ui = ctx?.ui;
				paint();
			});

			pi.on("agent_settled", () => paint());

			pi.on("session_shutdown", () => {
				ui?.setStatus?.(STATUS_KEY, undefined);
				ui = undefined;
			});

			// Re-assert the repo root at the top of every call path
			// (same pitfall as gantt/crawl — module singleton latch).
			const latch = (ctx: ExtensionContext) => {
				root = ctx?.cwd ?? root;
				setRecipesRoot(root);
				ui = ctx?.ui ?? ui;
			};

			// ── tools ────────────────────────────────────────────────
			pi.registerTool({
				name: "recipes",
				label: "Recipes",
				description:
					"Search, read, create, and run executable recipes. Recipes are markdown files with YAML frontmatter " +
					"(retrieval contract), prose body (reasoning), and named ```!bash blocks (executable procedures). " +
					"Store: .pi/recipes/*.md. Actions: search|get|run|ls|links|status|create.",
				promptSnippet: "Search/read/run executable recipes from the knowledge base",
				parameters: Type.Object({
					action: Type.Union(
						[
							Type.Literal("search"),
							Type.Literal("get"),
							Type.Literal("run"),
							Type.Literal("ls"),
							Type.Literal("links"),
							Type.Literal("status"),
							Type.Literal("create"),
						],
						{ description: "search|get|run|ls|links|status|create" },
					),
					query: Type.Optional(Type.String({ description: "search query, or recipe name for get/run/links" })),
					kind: Type.Optional(
						Type.String({ description: "filter by kind: tool|agent|knowledge|workflow (search only)" }),
					),
					limit: Type.Optional(Type.Number({ description: "max results (search only, default 10)" })),
					blockName: Type.Optional(
						Type.String({ description: "name of the ```!bash block to run (run only, omit for first)" }),
					),
					blockArgs: Type.Optional(
						Type.String({ description: "arguments for the bash block, space-separated (run only)" }),
					),
					name: Type.Optional(Type.String({ description: "recipe name (create only)" })),
					frontmatter: Type.Optional(
						Type.Object(
							{},
							{
								additionalProperties: Type.Union([Type.String(), Type.Array(Type.String())]),
								description: "YAML frontmatter fields (create only)",
							},
						),
					),
					body: Type.Optional(Type.String({ description: "markdown body with ```!bash blocks (create only)" })),
				}),
				async execute(
					_id: string,
					params: Record<string, unknown>,
					_signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					latch(ctx);
					const action = String(params?.action ?? "status");

					if (action === "search") {
						const query = String(params?.query ?? "");
						if (!query) return out("error: query required for search");
						const kind = params?.kind ? String(params.kind) : undefined;
						const limit = Number(params?.limit) || 10;

						const recipes = loadRecipes();
						if (recipes.length === 0) return out("No recipes found in .pi/recipes/");

						const results = rank(recipes, query, kind);
						const shown = results.slice(0, limit);

						if (shown.length === 0) return out(`No recipe matched: "${query}"`);

						const lines: string[] = [];
						for (let i = 0; i < shown.length; i++) {
							const { recipe, score } = shown[i];
							const danger = recipe.danger !== "none" ? `  danger=${recipe.danger}` : "";
							lines.push(`${i + 1}. ${recipe.name}  [${recipe.kind}]  score=${score}  @${recipe.key}${danger}`);
							lines.push(`   ${recipe.description}`);
							lines.push(`   path: ${recipe.path}`);
							if (recipe.tags.length) lines.push(`   tags: ${recipe.tags.join(", ")}`);
							if (recipe.requires.length) lines.push(`   requires: ${recipe.requires.join(", ")}`);
							if (recipe.blocks.length) lines.push(`   blocks: ${recipe.blocks.map((b) => b.name).join(", ")}`);
						}
						return out(lines.join("\n"));
					}

					if (action === "get") {
						const query = String(params?.query ?? "");
						if (!query) return out("error: query (recipe name/key) required for get");

						const recipes = loadRecipes();
						const recipe = resolveRecipe(query, recipes);
						if (!recipe) return out(`Recipe not found: "${query}"`);

						const lines: string[] = [
							`# ${recipe.name}  [${recipe.kind}]  @${recipe.key}`,
							`path: ${recipe.path}`,
							``,
						];
						if (recipe.frontmatter) {
							lines.push("## Frontmatter", recipe.frontmatter.trim(), "");
						}
						if (recipe.prose) {
							lines.push("## Reasoning", recipe.prose.trim(), "");
						}
						if (recipe.blocks.length) {
							lines.push("## Executable Blocks");
							for (const b of recipe.blocks) {
								const sig = b.params.length > 0 ? `${b.name}(${b.params.join(", ")})` : b.name;
								lines.push(`### ${sig}`);
								lines.push("```!bash");
								lines.push(b.body);
								lines.push("```");
								lines.push("");
							}
						}
						return out(lines.join("\n"));
					}

					if (action === "run") {
						const query = String(params?.query ?? "");
						if (!query) return out("error: query (recipe name/key) required for run");

						const recipes = loadRecipes();
						const recipe = resolveRecipe(query, recipes);
						if (!recipe) return out(`Recipe not found: "${query}"`);
						if (recipe.blocks.length === 0) return out(`Recipe "${recipe.name}" has no executable blocks`);

						const blockName = params?.blockName ? String(params.blockName) : undefined;
						let block: RecipeBlock;
						if (blockName) {
							const found = recipe.blocks.find((b) => b.name === blockName);
							if (!found)
								return out(
									`Block "${blockName}" not found in "${recipe.name}". Available: ${recipe.blocks.map((b) => b.name).join(", ")}`,
								);
							block = found;
						} else {
							block = recipe.blocks[0];
						}

						const blockArgs = params?.blockArgs ? String(params.blockArgs) : "";
						const argValues = blockArgs ? blockArgs.split(/\s+/) : [];

						// Interpolate $1, $2, ... and ${param} into the body
						let body = block.body;
						for (let i = 0; i < block.params.length; i++) {
							const param = block.params[i];
							const val = argValues[i] ?? "";
							// Replace ${param} patterns
							while (body.includes(`\${${param}}`)) {
								body = body.replace(`\${${param}}`, val);
							}
						}
						// Replace positional $1, $2, ...
						for (let i = 0; i < argValues.length; i++) {
							body = body.replace(`$${i + 1}`, argValues[i]);
						}

						const sig = block.params.length > 0 ? `${block.name}(${block.params.join(", ")})` : block.name;
						return out(
							`# ${recipe.name}:${sig}\n` +
								`Run the following bash block. Review for safety before executing.\n\n` +
								"```bash\n" +
								body +
								"\n```",
						);
					}

					if (action === "ls") {
						const recipes = loadRecipes();
						if (recipes.length === 0) return out("No recipes found in .pi/recipes/");

						// Group by category
						const cats = new Map<string, string[]>();
						for (const r of recipes) {
							const cat = r.category || "misc";
							if (!cats.has(cat)) cats.set(cat, []);
							cats.get(cat)!.push(`${r.name} [${r.kind}]`);
						}

						const lines: string[] = [];
						const sorted = [...cats.keys()].sort();
						for (const cat of sorted) {
							lines.push(`${cat}:`);
							for (const m of cats.get(cat)!.sort()) lines.push(`  ${m}`);
						}
						return out(lines.join("\n"));
					}

					if (action === "links") {
						const query = String(params?.query ?? "");
						if (!query) return out("error: query (recipe name/key) required for links");

						const recipes = loadRecipes();
						const recipe = resolveRecipe(query, recipes);
						if (!recipe) return out(`Recipe not found: "${query}"`);

						const lines: string[] = [];
						for (const l of recipe.links) lines.push(`out  @${l}`);
						for (const l of recipe.fuzzyLinks) lines.push(`fuzz @?${l}`);

						// Inbound: which recipes link to this one?
						for (const r of recipes) {
							if (r.key === recipe.key) continue;
							if (r.links.includes(recipe.key)) {
								lines.push(`in   ${r.name}  (@${r.key})`);
							}
						}
						if (lines.length === 0) return out(`No links for "${recipe.name}"`);
						return out(lines.join("\n"));
					}

					if (action === "status") {
						const counts = countRecipes();
						if (counts.size === 0)
							return out("No recipes. Create one with recipes create, or add .md files to .pi/recipes/");
						const lines: string[] = [`store: ${existsSync(recipesDir()) ? ".pi/recipes/" : "empty"}`];
						for (const [cat, n] of [...counts.entries()].sort())
							lines.push(`${cat}: ${n} recipe${n > 1 ? "s" : ""}`);
						return out(lines.join("\n"));
					}

					if (action === "create") {
						const name = String(params?.name ?? "");
						if (!name) return out("error: name required for create");
						const fm = (params?.frontmatter ?? {}) as Record<string, unknown>;
						const body = String(params?.body ?? `# ${name}\n\n`);
						const recipe = createRecipe(name, fm, body);
						paint();
						return out(`Created recipe "${recipe.name}" → ${recipe.path} (key: @${recipe.key})`);
					}

					return out(`Unknown action: ${action}`);
				},
			} as ToolDefinition);
		},
	};
}
