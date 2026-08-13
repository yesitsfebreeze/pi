// recipes types — a recipe is a markdown file with YAML frontmatter
// (the retrieval contract), a prose body (the reasoning), and optional
// named ```!bash blocks (executable procedures).

export interface Recipe {
	/** key: derived from file path — category/basename (e.g. "git/squash") */
	key: string;
	/** name: from frontmatter name, or key if not given */
	name: string;
	/** kind: tool | agent | knowledge | workflow */
	kind: string;
	/** description: one-line purpose, used as fallback in ranking */
	description: string;
	/** tags: categorical search terms (weight 2) */
	tags: string[];
	/** use_when: trigger conditions (weight 3, same as name) */
	useWhen: string[];
	/** not_when: veto conditions — any term hit kills the match */
	notWhen: string[];
	/** danger: none | low | medium | high */
	danger: string;
	/** requires: external dependencies */
	requires: string[];
	/** category: derived from directory (e.g. "git" from "git/squash") */
	category: string;
	/** path: relative path from .pi/recipes/ (e.g. "git/squash.md") */
	path: string;
	/** frontmatter: raw YAML text for display */
	frontmatter: string;
	/** prose: body text minus fences, for full-text search */
	prose: string;
	/** blocks: named executable ```!bash name(args...) blocks */
	blocks: RecipeBlock[];
	/** links: @refs found in prose (resolved keys) */
	links: string[];
	/** fuzzy: @?refs found in prose */
	fuzzyLinks: string[];
}

export interface RecipeBlock {
	/** name of the executable block (e.g. "squash") */
	name: string;
	/** parameters: parsed from name(args...) */
	params: string[];
	/** body: the bash code inside the fence */
	body: string;
}

export interface SearchResult {
	recipe: Recipe;
	score: number;
}
