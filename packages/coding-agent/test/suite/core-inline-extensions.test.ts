/**
 * Wiring integration — verifies the core inline extensions (file-awareness,
 * persona, rigor, forest, launch, until, issue-reporter, crew, nvim-surface)
 * are loaded by the DefaultResourceLoader and register their tools/commands.
 * This is the single chokepoint that makes the ported features live in every
 * session.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

let dir: string;
let agentDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-wire-"));
	agentDir = mkdtempSync(join(tmpdir(), "pi-wire-agent-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

async function loader(): Promise<DefaultResourceLoader> {
	const settings = SettingsManager.create(dir, agentDir);
	const l = new DefaultResourceLoader({
		cwd: dir,
		agentDir,
		settingsManager: settings,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await l.reload();
	return l;
}

describe("core inline extensions wiring", () => {
	it("loads all nine core inline extensions", async () => {
		const l = await loader();
		const names = new Set(l.getExtensions().extensions.map((e) => e.path));
		// Inline extensions show up as <inline:name>
		for (const n of [
			"file-awareness",
			"persona",
			"rigor",
			"forest",
			"launch",
			"until",
			"issue-reporter",
			"crew",
			"nvim-surface",
		]) {
			expect(names.has(`<inline:${n}>`), `missing inline extension ${n}`).toBe(true);
		}
	});

	it("registers every core tool", async () => {
		const l = await loader();
		const toolNames = new Set<string>();
		for (const ext of l.getExtensions().extensions) {
			for (const name of ext.tools.keys()) toolNames.add(name);
		}
		for (const t of ["rigor", "forest_dispatch", "forest_cleanup", "launch", "until", "record_stall", "crew"]) {
			expect(toolNames.has(t), `missing tool ${t}`).toBe(true);
		}
	});

	it("registers the slash commands", async () => {
		const l = await loader();
		const cmds = new Set<string>();
		for (const ext of l.getExtensions().extensions) {
			for (const name of ext.commands.keys()) cmds.add(name);
		}
		for (const c of ["launch", "until", "pace", "issue", "persona", "rigor", "crew"]) {
			expect(cmds.has(c), `missing command /${c}`).toBe(true);
		}
	});

	it("merges user-provided inline factories after the core ones", async () => {
		const settings = SettingsManager.create(dir, agentDir);
		const user: { name: string; factory: (pi: any) => void } = {
			name: "user-extra",
			factory(pi: any) {
				pi.registerTool({
					name: "user_extra",
					label: "X",
					description: "x",
					parameters: { type: "object" } as any,
					async execute() {
						return { content: [], details: {} };
					},
				});
			},
		};
		const l = new DefaultResourceLoader({
			cwd: dir,
			agentDir,
			settingsManager: settings,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [user],
		});
		await l.reload();
		const paths = l.getExtensions().extensions.map((e) => e.path);
		const coreIdx = paths.indexOf("<inline:crew>");
		const userIdx = paths.indexOf("<inline:user-extra>");
		expect(coreIdx).toBeGreaterThan(-1);
		expect(userIdx).toBeGreaterThan(-1);
		expect(userIdx).toBeGreaterThan(coreIdx);
	});

	it("loads even with noExtensions set", async () => {
		const settings = SettingsManager.create(dir, agentDir);
		const l = new DefaultResourceLoader({
			cwd: dir,
			agentDir,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await l.reload();
		const names = new Set(l.getExtensions().extensions.map((e) => e.path));
		// Inline factories load regardless of noExtensions (it only suppresses
		// path-based extension discovery).
		expect(names.has("<inline:launch>")).toBe(true);
		expect(names.has("<inline:crew>")).toBe(true);
	});
});
