/**
 * Persona loader — discovers and loads persona definitions from directories
 * containing PERSONA.md files with YAML frontmatter.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PERSONA_FILE = "PERSONA.md";
const DEFAULT_ID = "substrate";
const BASE_IDS = new Set(["substrate", "designer", "mentor", "skeptic"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface PersonaMeta {
  name: string;
  profession: string;
  description: string;
}

export interface Persona {
  id: string;
  name: string;
  profession: string;
  description: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------
export function parsePersonaMeta(text: string): PersonaMeta {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: "", profession: "", description: "" };
  const body = m[1];
  const get = (key: string): string => {
    const line = body.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return line ? line[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  return {
    name: get("name"),
    profession: get("profession"),
    description: get("description"),
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Load a single persona from a directory that contains PERSONA.md. */
export function loadPersonaFromDir(dir: string): Persona | null {
  const file = join(dir, PERSONA_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const meta = parsePersonaMeta(raw);
  const id = basename(dir);
  return {
    id,
    name: meta.name || id,
    profession: meta.profession,
    description: meta.description,
    body: raw,
  };
}

/**
 * Load all personas from one or more search directories. Later directories
 * override earlier ones for same-id personas.
 */
export function loadPersonas(dirs: string[]): Persona[] {
  const map = new Map<string, Persona>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: { isDirectory: () => boolean; name: string }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as { isDirectory: () => boolean; name: string }[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const persona = loadPersonaFromDir(join(dir, entry.name as unknown as string));
      if (persona) map.set(persona.id, persona);
    }
  }
  return sortPersonas([...map.values()]);
}

/**
 * Sort personas: substrate first (default), then base identities, then
 * rest alphabetically.
 */
export function sortPersonas(personas: Persona[]): Persona[] {
  return [...personas].sort((a, b) => {
    if (a.id === DEFAULT_ID) return -1;
    if (b.id === DEFAULT_ID) return 1;
    const aBase = BASE_IDS.has(a.id) ? 0 : 1;
    const bBase = BASE_IDS.has(b.id) ? 0 : 1;
    return aBase !== bBase ? aBase - bBase : a.id.localeCompare(b.id);
  });
}

/** Load the default persona (substrate) from the given directories. */
export function loadDefaultPersona(dirs: string[]): Persona | null {
  return loadPersonas(dirs).find((p) => p.id === DEFAULT_ID) ?? null;
}