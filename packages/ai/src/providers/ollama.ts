import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

/** Ollama ignores the bearer value for local requests; kept as a UX placeholder, never sent to the cloud host. */
const LOCAL_PLACEHOLDER_API_KEY = "ollama";
const DEFAULT_LOCAL_HOST = "http://localhost:11434";
const CLOUD_HOST = "https://ollama.com";
const CLOUD_BASE_URL = `${CLOUD_HOST}/v1`;
const DISCOVERY_TIMEOUT_MS = 8000;
/**
 * Local models carry this id prefix so pi's catalog can tell a local pull apart from an
 * Ollama Cloud model of the same tag — Ollama itself has no concept of a "local:" prefix.
 * `withOllamaWireId` strips it before every request and restores it on every emitted
 * event, so it never reaches the wire and never causes it.
 */
const LOCAL_ID_PREFIX = "local:";

interface OllamaTagsEntry {
	name: string;
	model?: string;
	/** Present on newer servers; absent on the cloud host's public listing. */
	capabilities?: string[];
	details?: { context_length?: number };
}

interface OllamaTagsResponse {
	models?: OllamaTagsEntry[];
}

interface OllamaShowResponse {
	capabilities?: string[];
	model_info?: Record<string, unknown>;
}

interface OllamaDiscoveryResult {
	/** Whether `/api/tags` answered at all — distinct from an empty catalog. */
	reachable: boolean;
	models: Model<"openai-completions">[];
}

function normalizeHost(raw: string): string {
	let host = raw.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(host)) host = `http://${host}`;
	return host.replace(/\/v1$/, "").replace(/\/api$/, "");
}

function getLocalHost(env: Record<string, string> | undefined): string {
	const configured = getProviderEnvValue("OLLAMA_BASE_URL", env) ?? getProviderEnvValue("OLLAMA_HOST", env);
	return normalizeHost(configured ?? DEFAULT_LOCAL_HOST);
}

function discoverySignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);
}

/** `/api/show` context length is reported as `<family>.context_length`; the family name varies per model. */
function getContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) return undefined;
	for (const [key, value] of Object.entries(modelInfo)) {
		if (key.endsWith(".context_length") && typeof value === "number") return value;
	}
	return undefined;
}

async function fetchOllamaModels(
	host: string,
	apiKey: string | undefined,
	isLocal: boolean,
	signal: AbortSignal,
): Promise<OllamaDiscoveryResult> {
	const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

	let tags: OllamaTagsResponse;
	try {
		const response = await fetch(`${host}/api/tags`, { headers, signal: discoverySignal(signal) });
		if (!response.ok) return { reachable: false, models: [] };
		tags = (await response.json()) as OllamaTagsResponse;
	} catch {
		// Unreachable local server or offline cloud host — no models from this host, not an error.
		return { reachable: false, models: [] };
	}

	const entries = tags.models ?? [];
	const models = await Promise.all(
		entries.map(async (entry) => {
			const id = entry.model ?? entry.name;
			if (!id) return undefined;

			// `/api/tags` capabilities are per-model and authoritative when present (they correctly
			// mark embedding-only models as non-tool-capable, for example); `/api/show` capability
			// detection is template-based and can false-positive "tools"/"thinking" for those same
			// models. Only fall back to `/api/show` for whatever `/api/tags` didn't already supply
			// (always true for the cloud host, which has neither field on its public listing).
			let capabilities = entry.capabilities;
			let contextWindow = entry.details?.context_length;
			if (capabilities === undefined || contextWindow === undefined) {
				try {
					const response = await fetch(`${host}/api/show`, {
						method: "POST",
						headers: { "Content-Type": "application/json", ...headers },
						body: JSON.stringify({ model: id }),
						signal: discoverySignal(signal),
					});
					if (response.ok) {
						const show = (await response.json()) as OllamaShowResponse;
						capabilities ??= show.capabilities;
						contextWindow ??= getContextWindow(show.model_info);
					}
				} catch {
					// Fall through to the tags-only entry below.
				}
			}

			// Only known-untagged-as-tool-capable models are dropped; an unknown/older
			// server without capability metadata still gets a usable, defaulted entry.
			if (capabilities && !capabilities.includes("tools")) return undefined;

			const reasoning = capabilities?.includes("thinking") ?? false;
			const input: ("text" | "image")[] = capabilities?.includes("vision") ? ["text", "image"] : ["text"];
			const window = contextWindow ?? 128000;

			const model: Model<"openai-completions"> = {
				id: isLocal ? `${LOCAL_ID_PREFIX}${id}` : id,
				name: id,
				api: "openai-completions",
				provider: "ollama",
				baseUrl: `${host}/v1`,
				reasoning,
				input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: window,
				maxTokens: Math.min(window, 32768),
				...(reasoning ? { thinkingLevelMap: { off: "none", minimal: null, max: "max" } } : {}),
			};
			return model;
		}),
	);

	return {
		reachable: true,
		models: models.filter((model): model is Model<"openai-completions"> => model !== undefined),
	};
}

/**
 * The local, already-signed-in (`ollama signin`) server proxies any Ollama Cloud model
 * without a separate API key — it just needs the right tag: append `-cloud` when the
 * catalog tag already carries a size/variant after `:`, otherwise use `:cloud` as the tag.
 * Verified against the real API: `gpt-oss:20b` -> `gpt-oss:20b-cloud`, `glm-5.2` -> `glm-5.2:cloud`.
 */
function toLocalCloudProxyTag(tag: string): string {
	return tag.includes(":") ? `${tag}-cloud` : `${tag}:cloud`;
}

function withEventModel(event: AssistantMessageEvent, id: string): AssistantMessageEvent {
	if (event.type === "done") {
		return event.message.model === id ? event : { ...event, message: { ...event.message, model: id } };
	}
	if (event.type === "error") {
		return event.error.model === id ? event : { ...event, error: { ...event.error, model: id } };
	}
	return event.partial.model === id ? event : { ...event, partial: { ...event.partial, model: id } };
}

function unexpectedRelayFailure(model: Model<Api>, id: string, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * Computes the wire model id actually sent to Ollama, purely from `id`/`baseUrl` (both are
 * fully determined at discovery time, so this is deterministic — no external lookup needed):
 *  - a local pull (`local:` prefix): strip the prefix.
 *  - an Ollama Cloud catalog entry dispatched through the local proxy (no prefix, but
 *    `baseUrl` isn't the direct cloud host — see `ollamaProvider`'s `fetchModels`): apply
 *    the cloud-proxy tag transform.
 *  - a direct Ollama Cloud request (`baseUrl` is the cloud host): unchanged.
 */
function wireModelId(model: Model<Api>): string | undefined {
	if (model.id.startsWith(LOCAL_ID_PREFIX)) return model.id.slice(LOCAL_ID_PREFIX.length);
	if (model.baseUrl !== CLOUD_BASE_URL) return toLocalCloudProxyTag(model.id);
	return undefined;
}

/**
 * Rewrites the model id pi's catalog uses to whatever Ollama actually expects on the wire
 * (see `wireModelId`), then restores the catalog id on every emitted event so downstream
 * consumers (cost lookup, "did this reply come from the currently selected model" checks,
 * session persistence) keep matching against pi's own id, never the wire-only variant.
 */
export function withOllamaWireId(streams: ProviderStreams): ProviderStreams {
	const relay = (
		inner: AssistantMessageEventStream,
		model: Model<Api>,
		displayId: string,
	): AssistantMessageEventStream => {
		const out = new AssistantMessageEventStream();
		(async () => {
			for await (const event of inner) out.push(withEventModel(event, displayId));
		})().catch((error) => {
			// `inner` already turns request failures into "error" events per the stream contract;
			// this only guards against a genuinely unexpected throw so `out` cannot hang forever.
			out.end(unexpectedRelayFailure(model, displayId, error));
		});
		return out;
	};

	return {
		stream: (model, context, options) => {
			const wireId = wireModelId(model);
			if (wireId === undefined) return streams.stream(model, context, options);
			return relay(streams.stream({ ...model, id: wireId }, context, options), model, model.id);
		},
		streamSimple: (model, context, options) => {
			const wireId = wireModelId(model);
			if (wireId === undefined) return streams.streamSimple(model, context, options);
			return relay(streams.streamSimple({ ...model, id: wireId }, context, options), model, model.id);
		},
	};
}

function ollamaApiKeyAuth(): ApiKeyAuth {
	return {
		name: "Ollama Cloud API key",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({
				type: "secret",
				message:
					"Enter Ollama Cloud API key (from ollama.com/settings/keys — leave blank if `ollama signin` already covers this machine)",
			});
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}
			const envKey = await ctx.env("OLLAMA_API_KEY");
			signal.throwIfAborted();
			if (envKey) return { auth: { apiKey: envKey }, source: "OLLAMA_API_KEY" };
			// No cloud key configured. Local Ollama ignores this value entirely — including for
			// cloud models proxied through a signed-in (`ollama signin`) local server — so keep
			// the provider "configured" out of the box. A *direct* Ollama Cloud request made
			// without a real key (no local server reachable) fails with the server's own auth error.
			return { auth: { apiKey: LOCAL_PLACEHOLDER_API_KEY }, source: "local (no cloud key configured)" };
		},
	};
}

/**
 * Ollama provider: local server plus Ollama Cloud, both discovered dynamically.
 *
 * There is no static catalog — the local model list depends entirely on what the user has
 * pulled, and the cloud catalog changes independently of pi releases. Every refresh queries
 * the local server's native API (`OLLAMA_BASE_URL`/`OLLAMA_HOST`, default
 * `http://localhost:11434`) and `https://ollama.com` (listing cloud models requires no auth).
 *
 * When the local server answers and no cloud key is explicitly configured, Ollama Cloud models
 * are dispatched *through it* instead of directly — a server signed in with `ollama signin`
 * proxies any cloud model with no separate API key, so this is the no-key path the CLI itself
 * uses. A configured `OLLAMA_API_KEY`/`/login ollama` key always wins and dispatches directly
 * to `https://ollama.com`, since setting one is a deliberate choice to use it; it's otherwise
 * only needed as a fallback for direct cloud access when no local server is reachable at all.
 *
 * Local model ids get a `local:` prefix so a locally pulled model and a same-tagged Ollama
 * Cloud model both show up in `/model` instead of colliding — see `LOCAL_ID_PREFIX` and
 * `withOllamaWireId`.
 */
export function ollamaProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "ollama",
		name: "Ollama",
		auth: { apiKey: ollamaApiKeyAuth() },
		models: [],
		fetchModels: async (context: RefreshModelsContext) => {
			const credentialEnv = context.credential?.type === "api_key" ? context.credential.env : undefined;
			const resolvedKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			// `Models.refresh()` always resolves *some* credential for a refresh pass — including
			// our own always-succeeding `LOCAL_PLACEHOLDER_API_KEY` fallback when nothing real is
			// configured. Treat that placeholder as "no key", not as an explicit real cloud key.
			const cloudKey = resolvedKey && resolvedKey !== LOCAL_PLACEHOLDER_API_KEY ? resolvedKey : undefined;
			const localHost = getLocalHost(credentialEnv);

			const [local, cloud] = await Promise.all([
				fetchOllamaModels(localHost, undefined, true, context.signal),
				fetchOllamaModels(CLOUD_HOST, cloudKey, false, context.signal),
			]);

			// Route cloud models through the local server when there's no explicitly configured cloud
			// key — an `ollama serve` that answers is very likely signed in (`ollama signin`), and
			// that proxy path needs no API key at all. A real configured key is a deliberate signal
			// to use it directly instead, so it always wins even when a local server is reachable.
			const cloudModels =
				!cloudKey && local.reachable
					? cloud.models.map((model) => ({ ...model, baseUrl: `${localHost}/v1` }))
					: cloud.models;

			const merged = new Map<string, Model<"openai-completions">>();
			for (const model of [...cloudModels, ...local.models]) merged.set(model.id, model);
			return Array.from(merged.values());
		},
		api: withOllamaWireId(openAICompletionsApi()),
	});
}
