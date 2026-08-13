import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/index.ts";

function getText(message: AgentSession["messages"][number]): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((p): p is { type: "text"; text: string } => p.type === "text")
				.map((p) => p.text)
				.join("");
}

describe("repro 2860 debug", () => {
	it("debug empty assistant via newSession", async () => {
		const tempDir = join(tmpdir(), `pi-2860dbg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const log = "/tmp/2860-trace3.log";
		writeFileSync(log, "");
		const out = (s: string) => {
			writeFileSync(log, `${s}\n`, { flag: "a" });
		};
		let _replacementSession: any;
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		faux.setResponses(["hello reply"].map((r) => fauxAssistantMessage(r)));
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }: any) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((m) => ({
									id: m.id,
									name: m.name,
									api: m.api,
									reasoning: m.reasoning,
									input: m.input,
									cost: m.cost,
									contextWindow: m.contextWindow,
									maxTokens: m.maxTokens,
								})),
							});
							pi.registerCommand("repro", {
								description: "repro",
								handler: async (_args: string, ctx: ExtensionCommandContext) => {
									out(
										`repro handler start, callCount=${faux.state.callCount}, pending=${faux.getPendingResponseCount()}`,
									);
									await ctx.newSession({
										parentSession: ctx.sessionManager.getSessionFile(),
										withSession: async (replacedCtx: ExtensionCommandContext) => {
											out(
												`withSession start, callCount=${faux.state.callCount}, pending=${faux.getPendingResponseCount()}`,
											);
											await (replacedCtx as any).sendUserMessage("Hello from the new session!");
											_replacementSession =
												(replacedCtx as any).sessionManager?.getSession?.() ??
												(replacedCtx as any)._session;
											out(
												`withSession after sendUserMessage, callCount=${faux.state.callCount}, pending=${faux.getPendingResponseCount()}`,
											);
											out(`replacedCtx keys: ${Object.keys(replacedCtx).join(",")}`);
										},
									});
									out(`repro handler end, callCount=${faux.state.callCount}`);
								},
							});
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime as any, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		const session = runtime.session;
		const rebind = async () => {
			await session.bindExtensions({
				commandContextActions: {
					waitForIdle: () => session.agent.waitForIdle(),
					newSession: async (o: any) => runtime.newSession(o),
					fork: async (e: any, o: any) => ({ cancelled: (await runtime.fork(e, o)).cancelled }),
					navigateTree: async () => ({ cancelled: false }),
					switchSession: async (sp: any, o: any) => runtime.switchSession(sp, o),
					reload: async () => {
						await session.reload();
					},
				},
			});
		};
		await rebind();
		runtime.setRebindSession(rebind);
		await session.prompt("/repro");
		out(`after /repro prompt, callCount=${faux.state.callCount}`);
		out(
			`runtime.session messages: ${JSON.stringify(runtime.session.messages.map((m: any) => `${m.role}:${getText(m)}`))}`,
		);
		out(
			`runtime.session msgobjs: ${JSON.stringify(runtime.session.messages.map((m: any) => ({ role: m.role, stop: m.stopReason, err: m.errorMessage, ncontent: m.content?.length })))}`,
		);
		await runtime.dispose();
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		expect(true).toBe(true);
	}, 30000);
});
