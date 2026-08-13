// PRD engine (ported from gantt's idle roam, re-homed onto gantt):
// a closed or missing board + .pi/gantt/prd.md → dispatch a charting pass
// over the UNCOVERED PRD scope — fog comes from the PRD delta, never
// from invention. No PRD → nothing to plan from, stop; an idle board
// with no requirements is not a license to make work up.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chartPrompt } from "./chart.ts";
import type { Board } from "./store.ts";

export function boardClosed(board: Board | null): boolean {
	if (!board) return true;
	return [...board.tickets.values()].every((t) => t.state === "done" || t.state === "out-of-scope");
}

export type PrdPass = { kind: "chart"; prompt: string } | { kind: "no-prd" };

export function prdPass(root: string, dir: string): PrdPass {
	const prd = join(root, ".pi", "gantt", "prd.md");
	if (!existsSync(prd)) return { kind: "no-prd" };
	const prompt = [
		`The gantt board at ${dir}/ is closed (or absent) but ${prd} exists.`,
		"Plan the next routine from the PRD delta:",
		"",
		`1. Read ${prd} end to end.`,
		`2. Diff its scope against what the board already covers — closed`,
		"   tickets, the map's Destination and Out of scope. Covered scope is",
		"   done; do not re-chart it.",
		"3. The uncovered remainder is the new fog. If there is none, report",
		"   the PRD fully covered and STOP — do not invent scope the PRD does",
		"   not name.",
		"4. Chart that fog with the protocol below (its escape hatch still",
		"   applies: one obvious ticket → no map, just say so).",
		"",
		chartPrompt(dir),
	].join("\n");
	return { kind: "chart", prompt };
}
