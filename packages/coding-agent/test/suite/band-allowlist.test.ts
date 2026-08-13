/**
 * Naming a tool in the allowlist must actually activate it, even when the band
 * has marked it deferred.
 *
 * The band (`core/tools/band.ts` `bandTool`, applied in `extensions/loader.ts`)
 * registers every extension tool as `rare`, so their schemas are withheld until something
 * asks. `_refreshToolRegistry` pushed each allowlisted name into the active set
 * and then ran the whole set through `_filterDeferredTools`, which drops
 * `rare && !restored` — so `pi.query({ tools: [..., "gantt"] })` silently
 * produced a session with no `gantt`. Fewer tools than requested, no error.
 *
 * An explicit by-name request is now treated as a restore, so deferral has one
 * source of truth.
 */
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness } from "../suite/harness.ts";

/** Explicitly `rare`, so this asserts the allowlist-vs-deferral contract itself
 * rather than whatever the band's current default policy happens to be. */
const extensionFactories: ExtensionFactory[] = [
	(pi) => {
		pi.registerTool({
			name: "banded_tool",
			label: "Banded Tool",
			description: "A deferred extension tool",
			promptSnippet: "Do the deferred thing",
			rare: true,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
	},
];

describe("band vs. explicit tool allowlist", () => {
	it("leaves a rare tool deferred when nothing names it", async () => {
		const harness = await createHarness({ extensionFactories });
		try {
			await harness.session.bindExtensions({});
			expect(harness.session.getAllTools().map((t) => t.name)).toContain("banded_tool");
			expect(harness.session.getActiveToolNames()).not.toContain("banded_tool");
			expect(harness.session.getDeferredToolNames()).toContain("banded_tool");
		} finally {
			harness.cleanup();
		}
	});

	it("activates the banded tool when the allowlist names it", async () => {
		const harness = await createHarness({
			allowedToolNames: ["read", "bash", "banded_tool"],
			extensionFactories,
		});
		try {
			await harness.session.bindExtensions({});
			expect(
				harness.session.getActiveToolNames(),
				"a tool named in the allowlist must be active, not silently deferred",
			).toContain("banded_tool");
			expect(harness.session.getDeferredToolNames()).not.toContain("banded_tool");
		} finally {
			harness.cleanup();
		}
	});
});
