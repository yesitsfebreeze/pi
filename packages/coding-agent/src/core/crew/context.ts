/**
 * Layered project context for crew subagents.
 *
 * Architecture (ported from Agent-Context):
 *
 *   AGENTS.md                              (~35 lines — identity, quick rules)
 *   .pi/context/
 *     layer0-agent-workflow.md             (~25 lines — skill lookup, memory routing)
 *     layer1-bootstrap.md                  (~15 lines — tech stack, project identity)
 *     layer2-project-core.md               (~20 lines — dev principles, conventions)
 *     layer3-guidebook.md                  (~30 lines — task → file routing table)
 *     base-principles.md                   (~20 lines — shared dev rules)
 *     agent-delegation.md                  (on-demand — how to inject context)
 *     memory/                              (stubs, ~10 lines each, loaded on-demand)
 *     skills/                              (full reference, loaded on-demand)
 *
 * Shared files live at ~/.pi/context/ (global, apply to all projects).
 * Project-owned files live at <project>/.pi/context/.
 *
 * Total baseline injected into subagent: ~120-150 lines.
 * Memory and skills are referenced but not injected — the subagent reads them
 * on demand when its task matches a routing trigger.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safeJson(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
function readDirNames(dir: string) {
	return readdirSync(dir).filter((e) => {
		try {
			return statSync(join(dir, e)).isDirectory();
		} catch {
			return false;
		}
	});
}
function extractSections(text: string, headings: string[]) {
	const sections = [];
	for (const h of headings) {
		const escaped = h.replace(/[.*+?^${}()|[\]\\\\]/g, "\\\\$&");
		const re = new RegExp(`##\\\\s+${escaped}\\\\b[^#]*`, "i");
		const m = text.match(re);
		if (m) {
			const start = m.index! + m[0].length;
			const nextHead = text.indexOf("\\n#", start);
			const end = nextHead >= 0 ? nextHead : text.length;
			const body = text.slice(start, end).trim();
			if (body) sections.push(`## ${h}\n${body}`);
		}
	}
	return sections;
}

// ---------------------------------------------------------------------------
// Shared files (~/.pi/context/)
// ---------------------------------------------------------------------------
function sharedDir() {
	return join(homedir(), ".pi", "context");
}
function readShared(filename: string) {
	const p = join(sharedDir(), filename);
	if (existsSync(p)) return readFileSync(p, "utf8").trim();
	return "";
}
// ---------------------------------------------------------------------------
// Project files (<project>/.pi/context/)
// ---------------------------------------------------------------------------
function projectDir(cwd: string) {
	return join(cwd, ".pi", "context");
}
function readProject(cwd: string, filename: string) {
	const p = join(projectDir(cwd), filename);
	if (existsSync(p)) return readFileSync(p, "utf8").trim();
	return "";
}
// ---------------------------------------------------------------------------
// Auto-detect layers 1-3 when project files don't exist
// ---------------------------------------------------------------------------
function detectIdentity(cwd: string) {
	// AGENTS.md first 10 lines — project identity
	const agentsPath = join(cwd, "AGENTS.md");
	if (existsSync(agentsPath)) {
		const lines = readFileSync(agentsPath, "utf8").split("\n").slice(0, 15);
		return lines.join("\n").trim();
	}
	return `Project: ${basename(cwd)}`;
}
function detectBootstrap(cwd: string) {
	const lines = [];
	const pkgPath = join(cwd, "package.json");
	if (existsSync(pkgPath)) {
		const raw = safeJson(pkgPath) as Record<string, unknown> | null;
		if (raw) {
			const eng = raw.engines as Record<string, string> | undefined;
			lines.push(`- Runtime: ${eng?.node ?? "node"}`);
			if (raw.workspaces) lines.push("- Monorepo: npm workspaces");
		}
		const deps = {
			...((raw?.dependencies as Record<string, unknown>) ?? {}),
			...((raw?.devDependencies as Record<string, unknown>) ?? {}),
		};
		if (Object.keys(deps).length > 0) {
			if ("typescript" in deps) lines.push("- Language: TypeScript");
			if ("vitest" in deps) lines.push("- Test: vitest");
			if ("react" in deps) lines.push("- UI: React");
		}
	}
	if (existsSync(join(cwd, "tsconfig.json")) && !lines.some((l) => l.includes("TypeScript")))
		lines.push("- Language: TypeScript");
	if (existsSync(join(cwd, "Cargo.toml"))) lines.push("- Language: Rust");
	if (existsSync(join(cwd, "go.mod"))) lines.push("- Language: Go");
	if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) lines.push("- Language: Python");
	return lines.length ? lines.join("\n") : "(scan the repo for tech stack)";
}
function detectCore(cwd: string) {
	// Extract ## sections from AGENTS.md that contain conventions
	const agentsPath = join(cwd, "AGENTS.md");
	if (!existsSync(agentsPath)) return "(no AGENTS.md — follow existing codebase patterns)";
	const text = readFileSync(agentsPath, "utf8");
	const headings = [
		"Code Quality",
		"Development Rules",
		"Conventions",
		"Style",
		"Testing",
		"Commands",
		"Git",
		"Security",
	];
	const sections = extractSections(text, headings);
	return sections.join("\n\n").slice(0, 1200) || "(scan AGENTS.md for conventions)";
}
function detectGuidebook(cwd: string) {
	const lines = ["| Working on... | Primary files |", "|---|---|"];
	// Top-level dirs that look like packages
	let entries: string[];
	try {
		entries = readDirNames(cwd);
	} catch {
		return lines.join("\n");
	}
	for (const e of entries) {
		if (e.startsWith(".") || e === "node_modules") continue;
		const pkg = join(cwd, e, "src");
		if (existsSync(pkg)) lines.push(`| \`${e}/\` changes | \`${e}/src/\` |`);
	}
	return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function snapshot(cwd: string) {
	return {
		identity: readProject(cwd, "AGENTS.md") || detectIdentity(cwd),
		bootstrap: readProject(cwd, "layer1-bootstrap.md") || detectBootstrap(cwd),
		core: readProject(cwd, "layer2-project-core.md") || detectCore(cwd),
		guidebook: readProject(cwd, "layer3-guidebook.md") || detectGuidebook(cwd),
		workflow: readShared("layer0-agent-workflow.md"),
		principles: readShared("base-principles.md"),
	};
}
/** The condensed block injected into a subagent briefing (~120-150 lines). */
export function briefingBlock(cwd: string) {
	const s = snapshot(cwd);
	const parts = ["## Project context", "", "### Identity", s.identity];
	if (s.bootstrap) {
		parts.push("", "### Stack", s.bootstrap);
	}
	if (s.core) {
		parts.push("", "### Conventions", s.core);
	}
	if (s.guidebook) {
		parts.push("", "### Task routing", s.guidebook);
	}
	if (s.principles) {
		parts.push("", "### Principles", s.principles);
	}
	if (s.workflow) {
		parts.push("", "### Workflow", s.workflow);
	}
	parts.push(
		"",
		"### On-demand context",
		"More detail is available on demand. Read these when your task triggers them:",
		"- `.pi/context/layer3-guidebook.md` — task → file routing table",
		"- `.pi/context/memory/` — domain facts, lessons, preferences",
		"- `.pi/context/skills/` — heavy reference material",
		"- `.pi/context/decisions.json` — architecture decisions",
		"- `.pi/context/knowledge-map.md` — external knowledge pointers",
	);
	return parts.join("\n");
}
