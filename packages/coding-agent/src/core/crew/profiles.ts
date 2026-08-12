import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CrewProfile } from "./types.ts";

const FRONT = /^---\n([\s\S]*?)\n---\n?/;

function csv(v: string): string[] | undefined {
	if (!v) return undefined;
	const list = v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length ? list : undefined;
}

export function parseProfile(name: string, text: string, source: string): CrewProfile {
	const m = FRONT.exec(text);
	const head: Record<string, string> = {};
	for (const line of (m?.[1] ?? "").split("\n")) {
		const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim());
		if (kv) head[kv[1]] = kv[2].trim();
	}
	const timeout = Number(head.timeout);
	return {
		name,
		description: head.description || `the ${name} agent`,
		persona: head.persona || undefined,
		model: head.model || undefined,
		thinking: head.thinking || undefined,
		tools: csv(head.tools),
		exclude: csv(head.exclude),
		timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
		scope: csv(head.scope),
		prompt: text.slice(m?.[0].length ?? 0).trim(),
		source,
	};
}

function readDir(dir: string, into: Map<string, CrewProfile>): void {
	if (!existsSync(dir)) return;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".md")) continue;
		const name = basename(f, ".md");
		try {
			into.set(name, parseProfile(name, readFileSync(join(dir, f), "utf8"), join(dir, f)));
		} catch {
			/* unreadable profile — the others still load */
		}
	}
}

export function shippedProfilesDir(): string {
	return join(import.meta.dirname, "profiles");
}

export function loadProfiles(repo: string): Map<string, CrewProfile> {
	const out = new Map<string, CrewProfile>();
	readDir(shippedProfilesDir(), out);
	readDir(join(repo, ".pi", "agents"), out);
	return out;
}

export function getProfile(repo: string, name: string): CrewProfile | undefined {
	return loadProfiles(repo).get(name);
}

export function renderProfileList(repo: string): string {
	const all = [...loadProfiles(repo).values()];
	if (!all.length) return "no agent profiles found";
	const w = Math.max(...all.map((p) => p.name.length));
	return all.map((p) => `${p.name.padEnd(w)}  ${p.description}`).join("\n");
}
