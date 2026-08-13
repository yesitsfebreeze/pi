import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("regression #3592: no-builtin-tools keeps extension tools enabled", () => {
	let tempDir: string;
	let agentDir: string;
	// Every session built here binds all core inline extensions, whose
	// session_start handlers write into tempDir (memory seeds an ontology
	// digest) and arm timers (memory's 30s poll, crew's heartbeat). Deleting
	// tempDir without disposing them races those writes and fails cleanup with
	// ENOTEMPTY — intermittently, which is worse than always.
	const sessions: Array<{ dispose: () => void }> = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-no-builtin-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(options?: { noTools?: "all" | "builtin"; tools?: string[] }) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			noTools: options?.noTools,
			tools: options?.tools,
		});
		await session.bindExtensions({});
		sessions.push(session);
		return session;
	}

	it("keeps the tools meta-tool active on the default SDK surface", async () => {
		const session = await createSession({});

		const active = session.getActiveToolNames();
		for (const name of ["read", "bash", "edit", "write"]) expect(active).toContain(name);
		// The deferred-tools prompt section tells the model to "make a real tool
		// call to `tools`" whenever anything is deferred, so the meta-tool must be
		// active on the default surface — regression for "Tool tools not found".
		expect(active).toContain("tools");
		session.dispose();
	});

	it("keeps extension tools active when built-in defaults are disabled", async () => {
		const session = await createSession({ noTools: "builtin" });

		const allToolNames = session
			.getAllTools()
			.map((tool) => tool.name)
			.sort();
		const active = session.getActiveToolNames();
		const builtins = ["bash", "edit", "find", "grep", "ls", "read", "write"];
		// The meta-tool stays hot even when the built-in defaults are off: the
		// deferred-tools prompt section advertises it, so it must be reachable.
		expect(active).toContain("tools");
		// Built-in tools stay in the available catalog…
		for (const name of builtins) expect(allToolNames).toContain(name);
		// …but none of them are active.
		for (const name of builtins) expect(active).not.toContain(name);
		// Extension tools stay registered and reachable. The tool band defers their
		// schemas (see core/tools/band.ts), so they are listed for restore rather
		// than active — disabling the built-ins does not change that either way.
		expect(session.getAllTools().map((tool) => tool.name)).toContain("dynamic_tool");
		expect(session.getDeferredToolNames()).toContain("dynamic_tool");
		expect(session.systemPrompt).toContain("- dynamic_tool — Run dynamic test behavior");
		expect(session.systemPrompt).not.toContain("- read:");
		expect(session.systemPrompt).not.toContain("- bash:");
		session.dispose();
	});

	it("respects an explicit allowlist — no implicit tools meta-tool", async () => {
		const session = await createSession({ tools: ["read", "bash"] });

		// An explicit allowlist is the user's exact surface: nothing is registered
		// beyond it (so nothing deferred is advertised, and no meta-tool is needed).
		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "read"]);
		expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
		session.dispose();
	});

	it("still disables all tools when noTools is all", async () => {
		const session = await createSession({ noTools: "all" });

		expect(session.getAllTools()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.systemPrompt).toContain("Available tools:\n(none)");
		session.dispose();
	});

	it("propagates noTools through service-based session creation", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			noTools: "builtin",
		});

		const active = session.getActiveToolNames();
		const builtins = ["bash", "edit", "find", "grep", "ls", "read", "write"];
		// Built-in defaults are disabled…
		for (const name of builtins) expect(active).not.toContain(name);
		// …but the core inline extension tools stay active.
		expect(active.length).toBeGreaterThan(0);
		expect(session.systemPrompt).not.toContain("- read:");
		session.dispose();
	});
});
