import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function jsonResponse(body: unknown): Response {
	return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ModelRuntime ollama discovery", () => {
	it("runs ollama's own local/cloud discovery instead of the pi.dev remote-catalog overlay", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const href = String(url);
			if (href === "http://localhost:11434/api/tags") {
				return jsonResponse({
					models: [
						{
							name: "qwen3.5:latest",
							model: "qwen3.5:latest",
							capabilities: ["completion", "tools", "thinking"],
							details: { context_length: 262144 },
						},
					],
				});
			}
			if (href === "https://ollama.com/api/tags") return jsonResponse({ models: [] });
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: true,
			refreshOnCreate: false,
		});
		await runtime.refresh({ providers: ["ollama"], allowNetwork: true, signal: AbortSignal.timeout(5000) });

		const model = runtime.getModel("ollama", "local:qwen3.5:latest");
		expect(model).toMatchObject({ baseUrl: "http://localhost:11434/v1", reasoning: true, contextWindow: 262144 });

		// The pi.dev remote-catalog overlay must never be consulted for a purely dynamic provider.
		expect(fetchMock).not.toHaveBeenCalledWith(
			expect.stringContaining("pi.dev/api/models/providers/ollama"),
			expect.anything(),
		);
	});
});
