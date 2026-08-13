/**
 * recipes — behavior tests for the executable knowledge base.
 *
 * The extension's registration was already pinned by
 * core-inline-extensions.test.ts, but nothing exercised what the recipes
 * actually *do*: parse frontmatter into the retrieval contract, extract
 * named ```!bash blocks and @links, and rank a query with the weighting and
 * veto rules the tool's usefulness depends on.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rank, words } from "../../src/core/recipes/search.ts";
import { countRecipes, loadRecipes, resolveRecipe, setRecipesRoot } from "../../src/core/recipes/store.ts";

let root: string;

/** Write a recipe at .pi/recipes/<relPath>. */
function recipe(relPath: string, content: string): void {
	const full = join(root, ".pi", "recipes", relPath);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content, "utf-8");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "recipes-"));
	setRecipesRoot(root);
});

afterEach(() => {
	setRecipesRoot(process.cwd());
});

describe("recipes store", () => {
	it("returns nothing when the recipes dir does not exist", () => {
		expect(loadRecipes()).toEqual([]);
	});

	it("parses frontmatter, prose, executable blocks and links", () => {
		recipe(
			"git/squash.md",
			[
				"---",
				"name: squash",
				"kind: workflow",
				"description: Squash the branch onto main",
				'tags: ["git", "history"]',
				'use_when: ["messy commits"]',
				'not_when: ["shared branch"]',
				"danger: medium",
				'requires: ["git"]',
				"---",
				"",
				"Squash a branch. See @git/rebase for the alternative.",
				"",
				"```!bash squash(base)",
				"git rebase -i $base",
				"```",
			].join("\n"),
		);

		const [r] = loadRecipes();

		// key + category are derived from the path, not the frontmatter.
		expect(r.key).toBe("git/squash");
		expect(r.category).toBe("git");
		expect(r.path).toBe("git/squash.md");

		expect(r.kind).toBe("workflow");
		expect(r.danger).toBe("medium");
		expect(r.tags).toEqual(["git", "history"]);
		expect(r.useWhen).toEqual(["messy commits"]);
		expect(r.notWhen).toEqual(["shared branch"]);
		expect(r.requires).toEqual(["git"]);

		// the executable block carries its parsed parameter list
		expect(r.blocks).toHaveLength(1);
		expect(r.blocks[0].name).toBe("squash");
		expect(r.blocks[0].params).toEqual(["base"]);
		expect(r.blocks[0].body).toContain("git rebase -i $base");

		// @refs in prose become links
		expect(r.links).toContain("git/rebase");
	});

	it("parses both documented block signature forms, so blockName can match either", () => {
		recipe(
			"forms.md",
			[
				"---",
				"---",
				"",
				"```!bash parens(count, message)",
				"echo paren",
				"```",
				"",
				"```!bash spaced count message",
				"echo spaced",
				"```",
				"",
				"```!bash bare",
				"echo bare",
				"```",
			].join("\n"),
		);

		const [r] = loadRecipes();
		// The name must be the bare identifier in every form — `run` matches on it
		// exactly, so a retained "(...)" suffix makes the block unreachable.
		expect(r.blocks.map((b) => b.name)).toEqual(["parens", "spaced", "bare"]);
		expect(r.blocks.map((b) => b.params)).toEqual([["count", "message"], ["count", "message"], []]);
	});

	it("falls back to the key for name and to sane defaults when frontmatter is thin", () => {
		recipe("solo.md", ["---", "description: bare", "---", "", "body"].join("\n"));

		const [r] = loadRecipes();
		expect(r.name).toBe("solo");
		expect(r.danger).toBe("none");
		expect(r.tags).toEqual([]);
		expect(r.blocks).toEqual([]);
	});

	it("resolves a ref by key, name, path and basename", () => {
		recipe("git/squash.md", ["---", "name: squashy", "---", "", "body"].join("\n"));
		const recipes = loadRecipes();

		expect(resolveRecipe("git/squash", recipes)?.key).toBe("git/squash");
		expect(resolveRecipe("@git/squash", recipes)?.key).toBe("git/squash");
		expect(resolveRecipe("squashy", recipes)?.key).toBe("git/squash");
		expect(resolveRecipe("git/squash.md", recipes)?.key).toBe("git/squash");
		expect(resolveRecipe("squash", recipes)?.key).toBe("git/squash");
		expect(resolveRecipe("nope", recipes)).toBeNull();
	});

	it("counts recipes per category", () => {
		recipe("git/a.md", "---\n---\nbody");
		recipe("git/b.md", "---\n---\nbody");
		recipe("shell/c.md", "---\n---\nbody");

		const counts = countRecipes();
		expect(counts.get("git")).toBe(2);
		expect(counts.get("shell")).toBe(1);
	});
});

describe("recipes search", () => {
	const withRecipes = () => {
		recipe(
			"git/squash.md",
			[
				"---",
				"name: squash",
				"kind: workflow",
				"description: tidy history",
				'tags: ["history"]',
				'use_when: ["messy commits"]',
				"---",
				"",
				"prose about rebasing",
			].join("\n"),
		);
		recipe(
			"shell/deploy.md",
			["---", "name: deploy", "kind: tool", "description: ship it", 'not_when: ["friday"]', "---", "", "prose"].join(
				"\n",
			),
		);
		return loadRecipes();
	};

	it("tokenizes on alphanumerics and +, dropping punctuation", () => {
		expect(words("git-rebase, c++ 2x!")).toEqual(["git", "rebase", "c++", "2x"]);
	});

	it("returns nothing for a query made only of stopwords", () => {
		expect(rank(withRecipes(), "the and of")).toEqual([]);
	});

	it("ranks a name/use_when hit above a prose-only hit", () => {
		const results = rank(withRecipes(), "squash");
		expect(results[0].recipe.key).toBe("git/squash");
		expect(results[0].score).toBeGreaterThan(0);
	});

	it("vetoes a recipe whose not_when matches the query", () => {
		const results = rank(withRecipes(), "deploy friday");
		expect(results.map((r) => r.recipe.key)).not.toContain("shell/deploy");
	});

	it("filters by kind and category", () => {
		const recipes = withRecipes();
		expect(rank(recipes, "history", "tool").map((r) => r.recipe.key)).toEqual([]);
		expect(rank(recipes, "history", "workflow").map((r) => r.recipe.key)).toEqual(["git/squash"]);
		expect(rank(recipes, "history", undefined, "shell").map((r) => r.recipe.key)).toEqual([]);
	});
});
