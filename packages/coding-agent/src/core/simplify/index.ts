// simplify — post-change follow-up that runs exactly once per change.
//
// The tool dispatches the follow-up — check, test, persona review — to three
// sub-agents in order, each running exactly once.  Any failing step sends the
// agent back to its original change; a clean run closes the loop.
//
//   0. code the feature (the main agent)
//   1. simplify → dispatch follow-up sub-agents once, in order:
//        check (code-reviewer): requirement match + dead code + duplication + …
//        test (test-engineer): run the test/build loop
//        persona review (code-reviewer): would the persona be satisfied?
//   2. any step fails → back to 0 (fix the original change), then run simplify
//      once more.  Never re-run simplify just to "check" — one run per change.
//
// Three sub-agents per change is too much for ordinary work, so the AUTOMATIC
// half — the system-prompt injection and the post-turn reminder — is scoped to
// the gantt work loop, where a ticket close is the natural gate and the cost
// buys something.  `globalThis.__gantt.role === "work"` (set by core/gantt when
// a session enters `/gantt work` or `work-here`) is the switch.  Everywhere
// else the tool and `/simplify` stay registered and do nothing until asked.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { loadProfiles } from "../crew/profiles.ts";
import { runSingleSync } from "../crew/sync.ts";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "../extensions/types.ts";

// ─── state ──────────────────────────────────────────────────────────────────
let root = process.cwd();
let setStatus: ((key: string, text: string | undefined) => void) | undefined;
let changedFiles: string[] = [];
let simplifyReminderCount = 0;
// One reminder per change — simplify runs once; it does not need nagging.
const MAX_SIMPLIFY_REMINDERS = 1;

// ─── principles injected into the system prompt (gantt work loop only) ──────
export const SIMPLIFY_PRINCIPLES = `# Simplify principles
You are in a gantt work loop. Before you close a ticket, run the simplify tool
ONCE (/simplify or the simplify tool). It dispatches the follow-up — check,
test, persona review — to three sub-agents in order, each running exactly once,
and returns a verdict:

- [SIMPLIFY: CLEAN] — every follow-up step passed; close the ticket.
- [SIMPLIFY: FIXES NEEDED] — a step failed; the tool returns the findings.
  Go back to the ticket's change, fix it, then run simplify once more.

Never run simplify repeatedly to "check your work". One run per ticket.`;

/**
 * True while this session is inside a gantt work loop — `/gantt work` or
 * `work-here`, both of which wear the `work` role. The automatic half of
 * simplify (prompt injection + post-turn reminder) is gated on this; the tool
 * and the command stay available everywhere for manual use.
 */
function inGanttWork(): boolean {
	const g = (globalThis as Record<string, unknown>).__gantt as { role?: unknown } | undefined;
	return g?.role === "work";
}

// ─── follow-up chain ────────────────────────────────────────────────────────
const VERDICT_RE = /VERDICT:\s*(CLEAN|PASS|SATISFIED|BLOCKS|FAIL|NOT\s*SATISFIED)/i;

interface FollowUpStep {
	agent: string;
	label: string;
	/** Verdicts (normalized, upper-case) that count as passing this step. */
	good: string[];
	task: (files: string) => string;
}

const FOLLOW_UP: FollowUpStep[] = [
	{
		agent: "code-reviewer",
		label: "check",
		good: ["CLEAN"],
		task: (files) => `## Requirement check + code review

The main session just changed these files. Establish what changed first: run
\`git diff\` and \`git status\`, then read the named files.

${files}

Review, do not fix. Check, in order:
1. Requirement match — is the change coherent and minimal for one clear goal? Any drift or unrelated additions?
2. Dead code — anything without a caller, unused imports, unreachable branches?
3. Duplication — the same logic expressed twice?
4. Over-abstraction — one-impl interfaces, factory-for-new, single-use config flags, one-subclass bases?
5. Minimal diff — lines that don't justify themselves?
6. Consistency — does it match the surrounding patterns?

Every finding is file:line, what breaks, and the smallest fix. End with exactly one line:
VERDICT: CLEAN
or
VERDICT: BLOCKS`,
	},
	{
		agent: "test-engineer",
		label: "test",
		good: ["PASS"],
		task: (files) => `## Test the change

The main session changed these files:

${files}

Prove the behavior and hunt regressions. Do NOT edit source — report only.
- Find the package's test command (package.json scripts; fall back to the repo's own test loop) and run it. Report the actual pass/fail counts and output.
- A failing test: file:line + the failure mode.
- Flag coverage gaps by unguarded behavior, not percentages.

End with exactly one line:
VERDICT: PASS
or
VERDICT: FAIL`,
	},
	{
		agent: "code-reviewer",
		label: "persona review",
		good: ["SATISFIED"],
		task: (files) => `## Persona review

The main session changed these files:

${files}

Review whether the active persona would be satisfied. Read \`.pi/persona.md\`
if present; otherwise apply the substrate standard:
- correctness before cleverness
- smallest change that ships
- numbers over adjectives — verify, don't assert
- no speculative scaffolding, no dead code kept "for later"

Review the diff against those standards. End with exactly one line:
VERDICT: SATISFIED
or
VERDICT: NOT SATISFIED`,
	},
];

const FULL_CAP = 4000;

async function dispatchFollowUp(
	files: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: AgentToolUpdateCallback,
): Promise<{ clean: boolean; report: string; findings: string }> {
	const profiles = loadProfiles(cwd);
	const rows: string[] = [];
	const findings: string[] = [];
	let clean = true;
	for (let i = 0; i < FOLLOW_UP.length; i++) {
		const step = FOLLOW_UP[i];
		const profile = profiles.get(step.agent);
		if (!profile) {
			rows.push(`${i + 1}. ${step.label} — skipped (no "${step.agent}" profile)`);
			continue;
		}
		setStatus?.("simplify", `${i + 1}/${FOLLOW_UP.length} ${step.label} (${step.agent})`);
		onUpdate?.({ content: [], details: { status: `${i + 1}/${FOLLOW_UP.length} ${step.label} (${step.agent})` } });
		const out = await runSingleSync(profile, step.task(files), { cwd }, signal);
		const m = VERDICT_RE.exec(out);
		const verdict = m ? m[1].replace(/\s+/g, " ").toUpperCase() : undefined;
		const ok = verdict ? step.good.includes(verdict) : false;
		if (!ok) {
			clean = false;
			findings.push(
				`### ${i + 1}. ${step.label} (${step.agent}) — ${verdict ?? "no verdict"}\n\n${out.slice(0, FULL_CAP)}`,
			);
		}
		rows.push(`${i + 1}. ${step.label} (${step.agent}) → ${verdict ?? "no verdict"}${ok ? "" : " ✗"}`);
	}
	setStatus?.("simplify", undefined);
	return { clean, report: rows.join("\n"), findings: findings.join("\n\n---\n\n") };
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function gitDiffFiles(): string[] {
	// No `.git` pre-checks: in a linked worktree `.git` is a *file*, so testing
	// for `<root>/.git/HEAD` fails and this returned [] for every worktree —
	// including the ones `forest` creates under `.pi/trees/`. The catch below
	// already covers a non-repo.
	try {
		// Best-effort: list modified + untracked files
		// stdio must be explicit: execSync's default pipes the child's stderr to
		// ours, so outside a repo (or in one with no commits) git's usage text
		// would print straight onto the TUI. This is what the removed
		// `.git`/`.git/HEAD` existsSync guards were incidentally suppressing.
		const quiet = {
			cwd: root,
			encoding: "utf8" as const,
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[],
		};
		// Separate try blocks: an empty repo throws on `diff HEAD`, and the old
		// shared try meant untracked files were never listed in that case.
		let out = "";
		try {
			out = execSync("git diff --name-only HEAD", quiet);
		} catch {
			/* no HEAD yet — untracked files below still count */
		}
		const untracked = execSync("git ls-files --others --exclude-standard", quiet);
		return [...out.trim().split("\n").filter(Boolean), ...untracked.trim().split("\n").filter(Boolean)];
	} catch {
		return [];
	}
}

// ─── actions ────────────────────────────────────────────────────────────────
async function simplifyAction(
	target: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: AgentToolUpdateCallback,
): Promise<string> {
	const t = target.trim();
	// A real path → review that file. Free text (a feature name) → review the
	// diff, focused. Without this, a feature name would be handed to the
	// sub-agent as a literal (non-existent) file path and it would find
	// nothing to review.
	const named = t && fs.existsSync(path.resolve(root, t));
	const focus = named ? undefined : t || undefined;
	let files: string[];
	if (named) {
		files = [t];
	} else {
		const diff = gitDiffFiles();
		files = diff.length > 0 ? diff : [...changedFiles];
	}
	if (files.length === 0) {
		return "[SIMPLIFY: CLEAN] — no changes to review.";
	}

	const filesBlock = files.map((f) => `- ${f}`).join("\n");
	const scope = focus ? `Focus: ${focus}\n\n${filesBlock}` : filesBlock;
	const { clean, report, findings } = await dispatchFollowUp(scope, cwd, signal, onUpdate);
	return [
		"## Simplify — follow-up via sub-agents (once, in order)",
		"",
		...(focus ? [`Focus: ${focus}`] : []),
		`Files reviewed:\n${filesBlock}`,
		"",
		report,
		...(findings ? ["", findings] : []),
		"",
		clean
			? "[SIMPLIFY: CLEAN] — all follow-up steps passed."
			: "[SIMPLIFY: FIXES NEEDED] — a follow-up step failed above. Return to your original change, fix it, then run simplify once more. Do not loop.",
	].join("\n");
}

// ─── wiring ─────────────────────────────────────────────────────────────────
const EDIT_TOOLS = new Set(["edit", "write", "str_replace_editor", "create"]);

export function createSimplifyExtension(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.on("session_start", (_event: any, ctx: any) => {
			root = ctx?.cwd ?? root;
			setStatus = ctx?.ui?.setStatus?.bind(ctx.ui);
		});

		pi.on("session_shutdown", () => {
			setStatus = undefined;
		});

		// Inject simplify principles — only inside a gantt work loop. Ordinary
		// turns pay nothing: no prompt tokens, no pull toward the tool.
		pi.on("before_agent_start", (event: any) => {
			if (!inGanttWork()) return;
			const base = event?.systemPrompt ?? "";
			return {
				systemPrompt: `${base}\n\n${SIMPLIFY_PRINCIPLES}`,
			};
		});

		// Track edited files for the review prompt.
		pi.on("tool_call", (event: any) => {
			if (!EDIT_TOOLS.has(event?.toolName)) return;
			const p = event?.input?.path ?? event?.input?.file_path;
			if (typeof p !== "string") return;
			const rel = path.relative(root, path.resolve(root, p));
			if (rel.startsWith("..")) return;
			if (!changedFiles.includes(rel)) changedFiles.push(rel);
		});

		// Remind the agent to run simplify after a change — once per change, and
		// only in a gantt work loop. Outside one, a change is just a change.
		pi.on("agent_settled", () => {
			if (!inGanttWork()) return;
			if (changedFiles.length === 0) return;
			if (simplifyReminderCount >= MAX_SIMPLIFY_REMINDERS) return;
			simplifyReminderCount++;
			pi.sendUserMessage(
				`simplify: changes made this turn — before closing the ticket, run the simplify tool (/simplify or the simplify tool) once to dispatch the follow-up (check, test, persona review). (${simplifyReminderCount}/${MAX_SIMPLIFY_REMINDERS})`,
				{ deliverAs: "followUp" },
			);
		});

		// Command: /simplify [target]
		pi.registerCommand("simplify", {
			description:
				"Post-change follow-up: dispatch check/test/persona review sub-agents once, in order. /simplify [target]",
			async handler(args: string, ctx: any) {
				root = ctx?.cwd ?? root;
				setStatus = ctx?.ui?.setStatus?.bind(ctx.ui);
				const msg = await simplifyAction(args, root, undefined);
				changedFiles = []; // clear — the follow-up covered this change
				simplifyReminderCount = 0;
				ctx.ui.notify(msg.includes("[SIMPLIFY: CLEAN]") ? "simplify: clean" : "simplify: fixes needed", "info");
				pi.sendUserMessage(msg, { deliverAs: "followUp" });
			},
		});

		// Tool: simplify
		pi.registerTool({
			name: "simplify",
			label: "Simplify",
			description:
				"Post-change follow-up: dispatch check/test/persona review to three sub-agents in order, each once, and return a verdict. Run once per change; a failing step means return to the change and fix it.",
			promptSnippet: "Post-change follow-up via sub-agents: check, test, persona review — once, in order.",
			parameters: Type.Object({
				target: Type.Optional(
					Type.String({
						description:
							"Optional: what to focus the review on (a file, a feature name, or leave empty for whole diff).",
					}),
				),
			}),
			async execute(_id, params: any, signal: AbortSignal | undefined, onUpdate, ctx: ExtensionContext) {
				root = ctx?.cwd ?? root;
				setStatus = ctx?.ui?.setStatus?.bind(ctx.ui);
				const msg = await simplifyAction(params?.target ?? "", root, signal, onUpdate);
				changedFiles = []; // clear — the follow-up covered this change
				simplifyReminderCount = 0;
				return {
					content: [{ type: "text" as const, text: msg }],
					details: {},
				};
			},
		});
	};
}
