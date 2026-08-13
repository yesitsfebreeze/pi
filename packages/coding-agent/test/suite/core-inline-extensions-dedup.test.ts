/**
 * Core inline extensions — uniqueness / duplicate-removal guard.
 *
 * getCoreInlineExtensions() returns the always-on extensions loaded into every
 * session. The loader (resource-loader.loadExtensionFactories) does NOT dedup
 * inline extensions by name — each factory is instantiated and given the path
 * `<inline:<name>>`, and its factory runs in full (registerTool, registerCommand,
 * lifecycle hooks). A duplicate name therefore double-registers the `kern_*`
 * tools, double-paints the `memory` status line, double-fires `before_agent_start`
 * (injecting the kern/ontology doctrine twice), and double-polls health every
 * 30s. The 2026-08-13 wiring change added `memory` (and 10 others) to this array;
 * this test guards against a future re-add reintroducing a duplicate.
 *
 * Failure modes guarded:
 *   - `memory` (or any name) appearing twice → duplicate registration.
 *   - the array silently shrinking → a feature dropped from every session.
 *   - the array silently growing beyond the documented set → an unreviewed
 *     extension now runs in every session.
 */
import { describe, expect, it } from "vitest";
import { getCoreInlineExtensions } from "../../src/core/core-inline-extensions.ts";

// The authoritative set, in load order. If getCoreInlineExtensions legitimately
// grows, update this list deliberately — do not let it drift silently.
const EXPECTED_NAMES = [
	"file-awareness",
	"persona",
	"vitals",
	"model-ledger",
	"search-guard",
	"rigor",
	"simplify",
	"reflex",
	"slim",
	"forest",
	"layers",
	"launch",
	"until",
	"issue-reporter",
	"memory",
	"crew",
	"pi-backup",
	"init",
	"gantt",
	"btw",
	"crawl",
	"recipes",
	"mem",
	"interact",
	"nvim-surface",
] as const;

describe("getCoreInlineExtensions — uniqueness and completeness", () => {
	it("returns exactly the documented set, in order (no silent add/drop)", () => {
		const exts = getCoreInlineExtensions();
		const names = exts.map((e) => e.name);
		expect(names).toEqual([...EXPECTED_NAMES]);
	});

	it("every extension name is unique (no duplicate registration)", () => {
		const exts = getCoreInlineExtensions();
		const names = exts.map((e) => e.name);
		const seen = new Set<string>();
		const dupes: string[] = [];
		for (const n of names) {
			if (seen.has(n)) dupes.push(n);
			else seen.add(n);
		}
		// Guard the specific regression: `memory` was at risk of being added
		// twice when it moved into the core array alongside other ported
		// features. A duplicate would double-register the kern_* tools and
		// double-inject the memory doctrine.
		expect(dupes, "no extension name may appear more than once").toEqual([]);
		expect(seen.has("memory"), "memory must be present").toBe(true);
		expect(
			names.filter((n) => n === "memory"),
			"memory must appear exactly once — a second copy double-registers kern_* tools and double-fires before_agent_start",
		).toHaveLength(1);
	});

	it("every entry is a named InlineExtension with a factory (not a bare function)", () => {
		// The loader distinguishes `typeof input !== "function"` to build the
		// `<inline:name>` path. A bare function slipped into the array would
		// get a numeric path `<inline:N>` and lose its name identity — making
		// duplicate detection impossible. Narrow to the object form: the
		// element type is `InlineExtension = ExtensionFactory | { name, factory }`,
		// so reading `.name`/`.factory` requires narrowing out the bare-function branch.
		for (const ext of getCoreInlineExtensions()) {
			const obj = ext as { name?: string; factory?: unknown };
			expect(typeof obj.name, `${JSON.stringify(ext)}: must have a string name`).toBe("string");
			expect(typeof obj.factory, `${obj.name}: must have a factory function`).toBe("function");
		}
	});
});
