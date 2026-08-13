import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../src/auth/types.ts";
import type { RefreshModelsContext } from "../src/models.ts";
import { ollamaProvider, withOllamaWireId } from "../src/providers/ollama.ts";
import type { Api, AssistantMessage, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function fakeAuthContext(env: Record<string, string> = {}): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

const neverAbortedSignal = new AbortController().signal;

function fakeRefreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		credential: undefined,
		stored: undefined,
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
		allowNetwork: true,
		signal: neverAbortedSignal,
		...overrides,
	};
}

function jsonResponse(body: unknown, ok = true): Response {
	return {
		ok,
		json: async () => body,
	} as Response;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ollama provider auth", () => {
	it("falls back to a local placeholder key when nothing is configured", async () => {
		const provider = ollamaProvider();
		const result = await provider.auth.apiKey!.resolve({
			ctx: fakeAuthContext(),
			credential: undefined,
			signal: neverAbortedSignal,
		});
		expect(result?.auth.apiKey).toBe("ollama");
		expect(result?.source).toContain("no cloud key");
	});

	it("prefers a stored credential over the environment", async () => {
		const provider = ollamaProvider();
		const result = await provider.auth.apiKey!.resolve({
			ctx: fakeAuthContext({ OLLAMA_API_KEY: "env-key" }),
			credential: { type: "api_key", key: "stored-key" },
			signal: neverAbortedSignal,
		});
		expect(result?.auth.apiKey).toBe("stored-key");
	});

	it("falls back to OLLAMA_API_KEY when no credential is stored", async () => {
		const provider = ollamaProvider();
		const result = await provider.auth.apiKey!.resolve({
			ctx: fakeAuthContext({ OLLAMA_API_KEY: "env-key" }),
			credential: undefined,
			signal: neverAbortedSignal,
		});
		expect(result?.auth.apiKey).toBe("env-key");
	});
});

describe("ollama provider model discovery", () => {
	it("merges local and cloud listings, preferring local on id collisions", async () => {
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			if (href === "http://localhost:11434/api/tags") {
				return jsonResponse({ models: [{ name: "gpt-oss:20b", model: "gpt-oss:20b" }] });
			}
			if (href === "https://ollama.com/api/tags") {
				return jsonResponse({
					models: [
						{ name: "gpt-oss:20b", model: "gpt-oss:20b" },
						{ name: "glm-5.2", model: "glm-5.2" },
					],
				});
			}
			if (href.endsWith("/api/show")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
				if (body.model === "gpt-oss:20b") {
					return jsonResponse({
						capabilities: ["completion", "tools", "thinking"],
						model_info: { "gptoss.context_length": 131072 },
					});
				}
				if (body.model === "glm-5.2") {
					return jsonResponse({
						capabilities: ["completion", "tools", "thinking"],
						model_info: { "glm5.2.context_length": 1000000 },
					});
				}
			}
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = ollamaProvider();
		await provider.refreshModels!(fakeRefreshContext());
		const models = provider.getModels();

		expect(models.map((m) => m.id).sort()).toEqual(["glm-5.2", "gpt-oss:20b", "local:gpt-oss:20b"]);
		const local = models.find((m) => m.id === "local:gpt-oss:20b")!;
		expect(local.baseUrl).toBe("http://localhost:11434/v1");
		expect(local.reasoning).toBe(true);
		expect(local.contextWindow).toBe(131072);
		const cloud = models.find((m) => m.id === "glm-5.2")!;
		// No cloud key configured and the local server answered: routed through the local
		// (presumed signed-in) proxy rather than directly, so no API key is required.
		expect(cloud.baseUrl).toBe("http://localhost:11434/v1");
		expect(cloud.contextWindow).toBe(1000000);
	});

	it("dispatches cloud models directly when no local server answers", async () => {
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			if (href === "http://localhost:11434/api/tags") throw new Error("connect ECONNREFUSED");
			if (href === "https://ollama.com/api/tags")
				return jsonResponse({ models: [{ name: "glm-5.2", model: "glm-5.2" }] });
			if (href.endsWith("/api/show")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
				if (body.model === "glm-5.2") {
					return jsonResponse({ capabilities: ["completion", "tools"], model_info: {} });
				}
			}
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = ollamaProvider();
		await provider.refreshModels!(fakeRefreshContext());
		const models = provider.getModels();
		expect(models).toHaveLength(1);
		expect(models[0].baseUrl).toBe("https://ollama.com/v1");
	});

	it("dispatches cloud models directly when a real cloud key is explicitly configured, even if local answers", async () => {
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			if (href === "http://localhost:11434/api/tags") return jsonResponse({ models: [] });
			if (href === "https://ollama.com/api/tags")
				return jsonResponse({ models: [{ name: "glm-5.2", model: "glm-5.2" }] });
			if (href.endsWith("/api/show")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
				if (body.model === "glm-5.2") {
					return jsonResponse({ capabilities: ["completion", "tools"], model_info: {} });
				}
			}
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = ollamaProvider();
		await provider.refreshModels!(fakeRefreshContext({ credential: { type: "api_key", key: "real-key" } }));
		const models = provider.getModels();
		expect(models).toHaveLength(1);
		expect(models[0].baseUrl).toBe("https://ollama.com/v1");
	});

	it("still proxies through local when the resolved credential is only the placeholder key", async () => {
		// Regression test: `Models.refresh()` always calls `apiKey.resolve()` to produce the
		// credential handed to `fetchModels` — including our own always-succeeding fallback to
		// `LOCAL_PLACEHOLDER_API_KEY` when nothing real is configured (see `ollamaApiKeyAuth`).
		// That placeholder must not be mistaken for "the user explicitly configured a real key".
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			if (href === "http://localhost:11434/api/tags") return jsonResponse({ models: [] });
			if (href === "https://ollama.com/api/tags")
				return jsonResponse({ models: [{ name: "glm-5.2", model: "glm-5.2" }] });
			if (href.endsWith("/api/show")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
				if (body.model === "glm-5.2") {
					return jsonResponse({ capabilities: ["completion", "tools"], model_info: {} });
				}
			}
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = ollamaProvider();
		await provider.refreshModels!(fakeRefreshContext({ credential: { type: "api_key", key: "ollama" } }));
		const models = provider.getModels();
		expect(models).toHaveLength(1);
		expect(models[0].baseUrl).toBe("http://localhost:11434/v1");
	});

	it("trusts /api/tags capabilities and context_length over /api/show, skipping the extra call", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const href = String(url);
			if (href === "http://localhost:11434/api/tags") {
				return jsonResponse({
					models: [
						{
							name: "qwen3.5:latest",
							model: "qwen3.5:latest",
							capabilities: ["vision", "completion", "tools", "thinking"],
							details: { context_length: 262144 },
						},
					],
				});
			}
			if (href === "https://ollama.com/api/tags") return jsonResponse({ models: [] });
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = ollamaProvider();
		await provider.refreshModels!(fakeRefreshContext());
		const models = provider.getModels();

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ id: "local:qwen3.5:latest", reasoning: true, contextWindow: 262144 });
		expect(models[0].input).toEqual(["text", "image"]);
		expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/api/show"), expect.anything());
	});

	it("drops a model /api/tags marks embedding-only even though /api/show over-reports tool/thinking support", async () => {
		// Real-world Ollama quirk: /api/show's template-based capability detection can
		// false-positive "tools"/"thinking" for an embedding-only model. /api/tags' own
		// per-model capabilities are authoritative and must win.
		const fetchMock = vi.fn(async (url: string | URL) => {
			const href = String(url);
			if (href === "http://localhost:11434/api/tags") {
				return jsonResponse({
					models: [
						{
							name: "qwen3-embedding:0.6b",
							model: "qwen3-embedding:0.6b",
							capabilities: ["embedding"],
							details: { context_length: 32768 },
						},
					],
				});
			}
			if (href === "https://ollama.com/api/tags") return jsonResponse({ models: [] });
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = ollamaProvider();
		await provider.refreshModels!(fakeRefreshContext());
		expect(provider.getModels()).toEqual([]);
	});

	it("drops models that explicitly lack tool-calling support", async () => {
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			if (href === "http://localhost:11434/api/tags") {
				return jsonResponse({ models: [{ name: "llava", model: "llava" }] });
			}
			if (href === "https://ollama.com/api/tags") return jsonResponse({ models: [] });
			if (href.endsWith("/api/show")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
				if (body.model === "llava") return jsonResponse({ capabilities: ["completion", "vision"] });
			}
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = ollamaProvider();
		await provider.refreshModels!(fakeRefreshContext());
		expect(provider.getModels()).toEqual([]);
	});

	it("keeps a tags-only entry when /api/show is unavailable", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const href = String(url);
			if (href === "http://localhost:11434/api/tags") {
				return jsonResponse({ models: [{ name: "custom-model", model: "custom-model" }] });
			}
			if (href === "https://ollama.com/api/tags") return jsonResponse({ models: [] });
			if (href.endsWith("/api/show")) return jsonResponse({}, false);
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = ollamaProvider();
		await provider.refreshModels!(fakeRefreshContext());
		const models = provider.getModels();
		expect(models).toHaveLength(1);
		expect(models[0].id).toBe("local:custom-model");
		expect(models[0].contextWindow).toBe(128000);
		expect(models[0].reasoning).toBe(false);
	});

	it("tolerates an unreachable local server and still lists cloud models", async () => {
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			if (href === "http://localhost:11434/api/tags") throw new Error("connect ECONNREFUSED");
			if (href === "https://ollama.com/api/tags") {
				return jsonResponse({ models: [{ name: "gpt-oss:20b", model: "gpt-oss:20b" }] });
			}
			if (href.endsWith("/api/show")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
				if (body.model === "gpt-oss:20b") {
					return jsonResponse({ capabilities: ["completion", "tools"], model_info: {} });
				}
			}
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = ollamaProvider();
		await provider.refreshModels!(fakeRefreshContext());
		const models = provider.getModels();
		expect(models).toHaveLength(1);
		expect(models[0].baseUrl).toBe("https://ollama.com/v1");
	});

	it("respects OLLAMA_BASE_URL for local discovery", async () => {
		const fetchMock = vi.fn(async (url: string | URL) => {
			const href = String(url);
			if (href === "http://my-box:1234/api/tags") return jsonResponse({ models: [] });
			if (href === "https://ollama.com/api/tags") return jsonResponse({ models: [] });
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = ollamaProvider();
		await provider.refreshModels!(
			fakeRefreshContext({ credential: { type: "api_key", env: { OLLAMA_BASE_URL: "my-box:1234" } } }),
		);
		expect(fetchMock).toHaveBeenCalledWith("http://my-box:1234/api/tags", expect.anything());
	});
});

describe("withOllamaWireId", () => {
	const context: Context = { messages: [] };
	const baseModel: Model<Api> = {
		id: "local:gpt-oss:20b",
		name: "gpt-oss:20b",
		api: "openai-completions",
		provider: "ollama",
		baseUrl: "http://localhost:11434/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};

	function fakeMessage(model: string): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "ollama",
			model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
	}

	function capturingStreams(captured: { id?: string }) {
		return {
			stream: (requestModel: Model<Api>) => {
				captured.id = requestModel.id;
				const out = new AssistantMessageEventStream();
				out.push({ type: "start", partial: fakeMessage(requestModel.id) });
				out.push({ type: "done", reason: "stop" as const, message: fakeMessage(requestModel.id) });
				return out;
			},
			streamSimple: () => new AssistantMessageEventStream(),
		};
	}

	it("strips the local: prefix for a real local pull and restores the catalog id on every event", async () => {
		const captured: { id?: string } = {};
		const streams = withOllamaWireId(capturingStreams(captured));

		const events: string[] = [];
		const stream = streams.stream(baseModel, context);
		for await (const event of stream) {
			if (event.type === "start") events.push(event.partial.model);
			if (event.type === "done") events.push(event.message.model);
		}

		expect(captured.id).toBe("gpt-oss:20b");
		expect(events).toEqual(["local:gpt-oss:20b", "local:gpt-oss:20b"]);
		expect((await stream.result()).model).toBe("local:gpt-oss:20b");
	});

	it("applies the cloud-proxy tag transform for a cloud model dispatched through the local server", () => {
		const captured: { id?: string } = {};
		const streams = withOllamaWireId(capturingStreams(captured));
		// Bare id (no local: prefix) but baseUrl is the local host: a cloud-catalog entry
		// routed through the signed-in local server, per ollamaProvider's fetchModels.
		const cloudViaLocal: Model<Api> = { ...baseModel, id: "glm-5.2" };

		streams.stream(cloudViaLocal, context);
		expect(captured.id).toBe("glm-5.2:cloud");

		streams.stream({ ...cloudViaLocal, id: "gpt-oss:20b" }, context);
		expect(captured.id).toBe("gpt-oss:20b-cloud");
	});

	it("passes a direct cloud request through unchanged", () => {
		const captured: { id?: string } = {};
		const streams = withOllamaWireId(capturingStreams(captured));
		const directCloud: Model<Api> = { ...baseModel, id: "glm-5.2", baseUrl: "https://ollama.com/v1" };

		streams.stream(directCloud, context);
		expect(captured.id).toBe("glm-5.2");
	});
});
