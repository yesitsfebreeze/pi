/**
 * Discovery map — fan-out codebase survey for subagent context.
 *
 * Architecture (ported from Agent-Context):
 *   .pi/context/
 *     map.json                 (~1-3 KB — node index with git watermarks)
 *     memory/<node>.md         (~10-20 lines each — non-obvious facts per region)
 *
 * The map is pulled on-demand by subagents, never loaded at startup.
 * Subsequent surveys are incremental: only regions whose git watermark
 * changed since the last survey are re-discovered.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
export interface MapNode {
	/** Stable id — e.g. "packages/agent" */
	id: string;
	/** Human label — e.g. "Agent package" */
	label: string;
	/** File globs that define this region */
	globs: string[];
	/** HEAD commit hash when this node was last surveyed */
	gitWatermark: string;
	/** Path relative to map.json dir — e.g. "memory/packages-agent.md" */
	notePath: string;
	/** ISO-8601 date of last survey */
	lastDiscovered: string;
}

export interface DiscoveryMap {
	version: 1;
	nodes: MapNode[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_NODES = 60;
const MAX_INDEX_BYTES = 16384;
const MAP_PATH = ".pi/context/map.json";

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------
function gitHead(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd,
			encoding: "utf8",
			timeout: 5000,
		}).trim();
	} catch {
		return "unknown";
	}
}

function filesChangedSince(cwd: string, since: string): number {
	try {
		const out = execFileSync(
			"git",
			["diff", "--name-only", `${since}..HEAD`],
			{ cwd, encoding: "utf8", timeout: 5000 },
		);
		return out.trim().split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

function globsChanged(cwd: string, globs: string[], since: string): boolean {
	try {
		// Fast path: if any file changed since the watermark, check globs
		if (filesChangedSince(cwd, since) === 0) return false;
		// Check changed files against each glob
		const changed = execFileSync(
			"git",
			["diff", "--name-only", `${since}..HEAD`],
			{ cwd, encoding: "utf8", timeout: 5000 },
		);
		const paths = changed.trim().split("\n").filter(Boolean);
		return paths.some((p) => globs.some((g) => p.startsWith(g.replace(/\/$/, ""))));
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Map read/write
// ---------------------------------------------------------------------------
export function readMap(cwd: string): DiscoveryMap | null {
	const p = join(cwd, MAP_PATH);
	if (!existsSync(p)) return null;
	try {
		const raw = JSON.parse(readFileSync(p, "utf8"));
		if (raw?.version === 1 && Array.isArray(raw?.nodes)) {
			return raw as DiscoveryMap;
		}
	} catch {
		// corrupted map — treat as absent
	}
	return null;
}

export function writeMap(cwd: string, map: DiscoveryMap): void {
	const p = join(cwd, MAP_PATH);
	const json = JSON.stringify(map, null, 2);
	if (Buffer.byteLength(json, "utf8") > MAX_INDEX_BYTES) {
		throw new Error(
			`map.json exceeds ${MAX_INDEX_BYTES} byte budget (${Buffer.byteLength(json, "utf8")}). ` +
				"Increase MAX_INDEX_BYTES or reduce node count.",
		);
	}
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, json, "utf8");
}

// ---------------------------------------------------------------------------
// Node manifest — deterministic inventory before fan-out
// ---------------------------------------------------------------------------
export interface NodeTemplate {
	id: string;
	label: string;
	globs: string[];
}

/**
 * Generate a deterministic node manifest from the repo structure.
 * Treats each top-level dir that contains a src/ directory as a region.
 */
export function generateManifest(cwd: string): NodeTemplate[] {
	const nodes: NodeTemplate[] = [];
	try {
		const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
		const topLevel = readdirSync(cwd);
		for (const name of topLevel) {
			if (name.startsWith(".") || name === "node_modules") continue;
			const full = join(cwd, name);
			if (!statSync(full).isDirectory()) continue;
			if (!existsSync(join(full, "src"))) continue;
			const id = name;
			const label = name.charAt(0).toUpperCase() + name.slice(1);
			nodes.push({
				id,
				label,
				globs: [`${name}/`],
			});
		}
	} catch {
		return [];
	}
	return nodes;
}

// ---------------------------------------------------------------------------
// Discovery budget
// ---------------------------------------------------------------------------
export function checkBudget(cwd: string): string | null {
	const map = readMap(cwd);
	if (map && map.nodes.length > MAX_NODES) {
		return `map.json has ${map.nodes.length} nodes (limit: ${MAX_NODES}). ` +
			"Prune stale nodes or increase MAX_NODES.";
	}
	try {
		const manifest = generateManifest(cwd);
		if (manifest.length > MAX_NODES) {
			return `${manifest.length} candidate regions (limit: ${MAX_NODES}). ` +
				"Narrow the manifest or increase MAX_NODES.";
		}
	} catch {
		// can't check — allow
	}
	return null;
}

// ---------------------------------------------------------------------------
// Incremental plan
// ---------------------------------------------------------------------------
export interface DiscoveryTask {
	node: NodeTemplate;
	needsDiscovery: boolean;
	reason: string;
	existingWatermark?: string;
}

/**
 * Compute which nodes need re-discovery.
 * A node needs re-discovery if:
 * 1. It's new (not in the existing map)
 * 2. Files matching its globs changed since its git watermark
 */
export function planDiscovery(cwd: string): DiscoveryTask[] {
	const head = gitHead(cwd);
	const existing = readMap(cwd);
	const manifest = generateManifest(cwd);
	const existingById = new Map(
		(existing?.nodes ?? []).map((n) => [n.id, n]),
	);

	return manifest.map((node): DiscoveryTask => {
		const prev = existingById.get(node.id);
		if (!prev) {
			return { node, needsDiscovery: true, reason: "new region" };
		}
		if (prev.gitWatermark === head) {
			return {
				node,
				needsDiscovery: false,
				reason: `unchanged since ${head}`,
				existingWatermark: prev.gitWatermark,
			};
		}
		if (globsChanged(cwd, node.globs, prev.gitWatermark)) {
			return {
				node,
				needsDiscovery: true,
				reason: `files changed since ${prev.gitWatermark}`,
				existingWatermark: prev.gitWatermark,
			};
		}
		// Glob files haven't changed — bump watermark without re-survey
		return {
			node,
			needsDiscovery: false,
			reason: `files unchanged, watermark bumped to ${head}`,
			existingWatermark: prev.gitWatermark,
		};
	});
}

// ---------------------------------------------------------------------------
// Map update after a single-node survey
// ---------------------------------------------------------------------------
export function updateNode(
	cwd: string,
	nodeId: string,
	notePath: string,
): DiscoveryMap | null {
	const map = readMap(cwd) ?? { version: 1, nodes: [] };
	const head = gitHead(cwd);
	const idx = map.nodes.findIndex((n) => n.id === nodeId);
	const updated: MapNode = {
		id: nodeId,
		label: map.nodes[idx]?.label ?? nodeId,
		globs: map.nodes[idx]?.globs ?? [`${nodeId}/`],
		gitWatermark: head,
		notePath: notePath.startsWith(".pi/context/")
			? relative(join(cwd, ".pi", "context"), resolve(cwd, notePath))
			: notePath,
		lastDiscovered: new Date().toISOString().split("T")[0],
	};

	if (idx >= 0) {
		map.nodes[idx] = updated;
	} else {
		map.nodes.push(updated);
	}

	const budget = checkBudget(cwd);
	if (budget) {
		throw new Error(`Budget exceeded after update: ${budget}`);
	}

	writeMap(cwd, map);
	return map;
}