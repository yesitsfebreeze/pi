/**
 * Persona loader + manager — discovery, sorting, injection, repo override.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPersonas, parsePersonaMeta, sortPersonas } from "../../src/core/personas/persona-loader.ts";
import { PersonaManager } from "../../src/core/personas/persona-manager.ts";

function personaDir(id: string, meta: { name: string; profession: string; description: string }, body: string) {
	const dir = join(tmpdir(), `pi-persona-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(dir, id), { recursive: true });
	writeFileSync(
		join(dir, id, "PERSONA.md"),
		`---\nname: ${meta.name}\nprofession: ${meta.profession}\ndescription: ${meta.description}\n---\n${body}`,
	);
	return dir;
}

describe("persona-loader", () => {
	it("parses frontmatter", () => {
		const m = parsePersonaMeta("---\nname: Alice\nprofession: engineer\ndescription: x\n---\nbody");
		expect(m).toEqual({ name: "Alice", profession: "engineer", description: "x" });
	});

	it("loads personas from a directory", () => {
		const dir = personaDir("substrate", { name: "Substrate", profession: "agent", description: "default" }, "body");
		try {
			const personas = loadPersonas([dir]);
			expect(personas.length).toBe(1);
			expect(personas[0].id).toBe("substrate");
			expect(personas[0].name).toBe("Substrate");
			expect(personas[0].body).toContain("body");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sorts substrate first, then base ids, then alphabetical", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-sort-"));
		try {
			for (const id of ["zeta", "skeptic", "substrate", "mentor", "alpha"]) {
				mkdirSync(join(root, id), { recursive: true });
				writeFileSync(join(root, id, "PERSONA.md"), `---\nname: ${id}\n---\nbody`);
			}
			const sorted = sortPersonas(loadPersonas([root]));
			const ids = sorted.map((p) => p.id);
			expect(ids[0]).toBe("substrate");
			// base ids (mentor, skeptic) before non-base (alpha, zeta)
			const mentorIdx = ids.indexOf("mentor");
			const skepticIdx = ids.indexOf("skeptic");
			const alphaIdx = ids.indexOf("alpha");
			expect(mentorIdx).toBeLessThan(alphaIdx);
			expect(skepticIdx).toBeLessThan(alphaIdx);
			expect(ids[ids.length - 1]).toBe("zeta");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("PersonaManager", () => {
	it("builds an injected block from the active persona", () => {
		const dir = personaDir("substrate", { name: "Sub", profession: "agent", description: "d" }, "Be terse.");
		try {
			const mgr = new PersonaManager(dir, [dir]);
			const block = mgr.buildInjectedBlock();
			expect(block).toContain("auto-injected-context");
			expect(block).toContain("Be terse.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("appends a repo override from .pi/persona.md", () => {
		const dir = personaDir("substrate", { name: "Sub", profession: "agent", description: "d" }, "Base persona.");
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(join(dir, ".pi", "persona.md"), "Repo override: always cite the ticket.");
			const mgr = new PersonaManager(dir, [dir]);
			const text = mgr.getInjectText();
			expect(text).toContain("Base persona.");
			expect(text).toContain("Repo override: always cite the ticket.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("switches to a known persona and resets to default", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-switch-"));
		try {
			for (const id of ["substrate", "skeptic"]) {
				mkdirSync(join(root, id), { recursive: true });
				writeFileSync(join(root, id, "PERSONA.md"), `---\nname: ${id}\n---\nbody ${id}`);
			}
			const mgr = new PersonaManager(root, [root]);
			expect(mgr.selectedId).toBe("substrate");
			expect(mgr.switchTo("skeptic")).toBe(true);
			expect(mgr.selectedId).toBe("skeptic");
			expect(mgr.switchTo("nope")).toBe(false);
			mgr.reset();
			expect(mgr.selectedId).toBe("substrate");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("loads the built-in personas shipped with pi", () => {
		const mgr = new PersonaManager(tmpdir());
		const ids = mgr.personas.map((p) => p.id);
		expect(ids).toContain("substrate");
		expect(ids).toContain("designer");
		expect(ids).toContain("mentor");
		expect(ids).toContain("skeptic");
		expect(mgr.active?.name).toBe("Substrate");
	});
});
