/**
 * Wiring integration — verifies every core inline extension is loaded by the
 * DefaultResourceLoader and registers its tools/commands. This is the single
 * chokepoint that makes the ported features live in every session. The
 * authoritative list lives in the test body, where its length is asserted
 * against getCoreInlineExtensions() so the two cannot drift.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCoreInlineExtensions } from "../../src/core/core-inline-extensions.ts";
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
	it("loads every core inline extension", async () => {
		const l = await loader();
		const names = new Set(l.getExtensions().extensions.map((e) => e.path));
		// Inline extensions show up as <inline:name>. This list is exhaustive and
		// the count is asserted below: a presence-only check let `search-guard`
		// and `pi-backup` ship uncovered, and would not catch one silently
		// dropped from getCoreInlineExtensions().
		const expectedInline = [
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
		];
		for (const n of expectedInline) {
			expect(names.has(`<inline:${n}>`), `missing inline extension ${n}`).toBe(true);
		}
		expect(getCoreInlineExtensions().length, "getCoreInlineExtensions() drifted from the expected list").toBe(
			expectedInline.length,
		);
	});

	it("registers every core tool", async () => {
		const l = await loader();
		const toolNames = new Set<string>();
		for (const ext of l.getExtensions().extensions) {
			for (const name of ext.tools.keys()) toolNames.add(name);
		}
		for (const t of [
			"rigor",
			"forest_dispatch",
			"forest_cleanup",
			"layer_new",
			"layer_write",
			"layer_edit",
			"layer_read",
			"layer_rm",
			"layer_diff",
			"layer_log",
			"layer_list",
			"layer_test",
			"layer_merge",
			"layer_discard",
			"launch",
			"until",
			"record_stall",
			"crew",
			"gantt",
			"btw",
			"crawl",
			"crawl_score",
			"crawl_rescore",
			"crawl_export",
			"crawl_research",
			"crawl_list",
			"crawl_topics",
			"crawl_status",
			"simplify",
			"reflex",
			"kern_ingest",
			"kern_query",
			"kern_link",
			"kern_forget",
			"kern_health",
			"mem_maps",
			"mem_read",
			"mem_write",
			"mem_search",
			"mem_attach",
			"mem_registers",
			"mem_detach",
			"mem_run",
			"mem_children",
			"mem_valgrind_run",
			"mem_valgrind_status",
		]) {
			expect(toolNames.has(t), `missing tool ${t}`).toBe(true);
		}
	});

	it("registers the slash commands", async () => {
		const l = await loader();
		const cmds = new Set<string>();
		for (const ext of l.getExtensions().extensions) {
			for (const name of ext.commands.keys()) cmds.add(name);
		}
		for (const c of [
			"launch",
			"until",
			"pace",
			"issue",
			"persona",
			"rigor",
			"crew",
			"init",
			"gantt",
			"simplify",
			"layers",
			"ontology",
			"discover",
			"model-ledger",
		]) {
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
