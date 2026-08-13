import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { catalogSignature, classifyAll, classifyModel, pickForRole, ROLE_TO_TIER } from "../src/core/model-ledger.ts";

function model(overrides: Partial<Model<Api>> & { id: string; provider: string }): Model<Api> {
	return {
		name: overrides.name ?? overrides.id,
		api: "openai-completions",
		baseUrl: "https://example.com",
		reasoning: overrides.reasoning ?? false,
		input: overrides.input ?? ["text"],
		cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: overrides.contextWindow ?? 128_000,
		maxTokens: overrides.maxTokens ?? 16_384,
		...overrides,
	} as Model<Api>;
}

describe("classifyModel", () => {
	it("tags image-capable models as vision", () => {
		const m = model({ id: "v", provider: "p", input: ["text", "image"], reasoning: true });
		expect(classifyModel(m).tags).toContain("vision");
	});

	it("tags >=1M context models as large-context", () => {
		const m = model({ id: "big", provider: "p", contextWindow: 2_000_000 });
		expect(classifyModel(m).tags).toContain("large-context");
	});

	it("classifies non-reasoning models as fast", () => {
		const m = model({ id: "fast", provider: "p", reasoning: false });
		expect(classifyModel(m).tier).toBe("fast");
	});

	it("classifies cheap reasoning models as fast", () => {
		const m = model({
			id: "flash",
			provider: "p",
			reasoning: true,
			cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 },
		});
		expect(classifyModel(m).tier).toBe("fast");
	});

	it("classifies premium large-context reasoning models as frontier", () => {
		const m = model({
			id: "opus",
			provider: "p",
			reasoning: true,
			contextWindow: 1_000_000,
			cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
		});
		expect(classifyModel(m).tier).toBe("frontier");
	});

	it("classifies an ordinary reasoning model as balanced", () => {
		const m = model({
			id: "pro",
			provider: "p",
			reasoning: true,
			contextWindow: 1_000_000,
			cost: { input: 0.435, output: 0.87, cacheRead: 0, cacheWrite: 0 },
		});
		expect(classifyModel(m).tier).toBe("balanced");
	});

	it("detects embedders by name", () => {
		const m = model({ id: "text-embedding-3-large", provider: "p", name: "Text Embedding 3 Large" });
		expect(classifyModel(m).tier).toBe("embedder");
	});
});

describe("pickForRole", () => {
	const models = [
		model({
			id: "cheap-fast",
			provider: "p",
			reasoning: false,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
		}),
		model({
			id: "flash",
			provider: "p",
			reasoning: true,
			cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 },
		}),
		model({
			id: "pro",
			provider: "p",
			reasoning: true,
			contextWindow: 1_000_000,
			cost: { input: 0.435, output: 0.87, cacheRead: 0, cacheWrite: 0 },
		}),
		model({
			id: "opus",
			provider: "p",
			reasoning: true,
			contextWindow: 1_000_000,
			cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
		}),
	];
	const entries = classifyAll(models);

	it("resolves fast role to the cheapest fast-tier model", () => {
		expect(pickForRole("fast", models, entries)?.id).toBe("cheap-fast");
	});

	it("resolves frontier role to the frontier model", () => {
		expect(pickForRole("frontier", models, entries)?.id).toBe("opus");
	});

	it("resolves balanced role to the balanced model", () => {
		expect(pickForRole("balanced", models, entries)?.id).toBe("pro");
	});

	it("falls back to balanced when the requested tier is empty", () => {
		const noFast = models.filter((m) => m.id !== "cheap-fast" && m.id !== "flash");
		expect(pickForRole("fast", noFast, entries)?.id).toBe("pro");
	});

	it("returns undefined for an empty model list", () => {
		expect(pickForRole("fast", [], {})).toBeUndefined();
	});

	it("maps every role to a valid tier", () => {
		expect(ROLE_TO_TIER.fast).toBe("fast");
		expect(ROLE_TO_TIER.frontier).toBe("frontier");
	});
});

describe("catalogSignature", () => {
	it("is stable across orderings and changes with content", () => {
		const a = [model({ id: "x", provider: "p" }), model({ id: "y", provider: "q" })];
		const b = [model({ id: "y", provider: "q" }), model({ id: "x", provider: "p" })];
		expect(catalogSignature(a)).toBe(catalogSignature(b));
		expect(catalogSignature(a)).not.toBe(catalogSignature([model({ id: "x", provider: "p" })]));
	});
});
