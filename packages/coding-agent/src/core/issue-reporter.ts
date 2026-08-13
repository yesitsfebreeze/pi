// issue-reporter — structured GitHub issue reporting.
// Loaded as the hidden `issue-reporter` core inline extension (see
// core-inline-extensions.ts), which owns the `record_stall` tool, the /issue
// command, and auto-reporting of errors from non-builtin tools.

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ToolDefinition } from "../core/extensions/types.ts";

const execFileAsync = promisify(execFile);
const GH_BIN = "gh";
const AUTO_COOLDOWN_MS = 5 * 60_000;
const AUTO_CAP = 5;

const KIND_LABELS: Record<string, string[]> = {
	stall: ["stall"],
	bug: ["bug"],
	issue: [],
	feature: ["enhancement"],
	decision: ["decision"],
	task: [],
};

export const KIND_OPTIONS = ["stall", "bug", "issue", "feature", "decision", "task"];

function ghOnPath(): boolean {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		try {
			if (statSync(join(dir, GH_BIN)).isFile()) return true;
		} catch {
			/* continue */
		}
	}
	return false;
}

async function ghAvailable(): Promise<boolean> {
	try {
		await execFileAsync(GH_BIN, ["--version"]);
		return true;
	} catch {
		return false;
	}
}

async function detectRepo(): Promise<string | null> {
	const explicit = process.env.PI_GH_REPO;
	if (explicit) return explicit;
	try {
		const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"]);
		const url = stdout.trim();
		const m = url.match(/github\.com[:/](.+)\.git$/);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

async function captureContext(): Promise<string> {
	const parts: string[] = [];
	parts.push(`**Timestamp:** ${new Date().toISOString()}`);
	try {
		const { stdout } = await execFileAsync("git", ["branch", "--show-current"]);
		const branch = stdout.trim();
		if (branch) parts.push(`**Branch:** \`${branch}\``);
	} catch {
		/* no git */
	}
	try {
		const { stdout } = await execFileAsync("git", ["log", "--oneline", "-5"]);
		const log = stdout.trim();
		if (log) parts.push(`**Recent commits:**\n\`\`\`\n${log}\n\`\`\``);
	} catch {
		/* no git */
	}
	try {
		const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"]);
		const url = stdout.trim();
		if (url) parts.push(`**Repo:** ${url}`);
	} catch {
		/* no git */
	}
	return parts.join("\n\n");
}

export class IssueReporter {
	private _autoLastReport = 0;
	private _autoCount = 0;

	ghOnPath(): boolean {
		return ghOnPath();
	}

	async fileIssue(params: {
		kind?: string;
		title: string;
		description?: string;
		labels?: string[];
		repo?: string | null;
	}): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean; details: Record<string, never> }> {
		const kind = params.kind || "stall";
		const resolution = params.description || "(no description provided)";
		const context = await captureContext();
		const body = [
			`## ${kind.charAt(0).toUpperCase() + kind.slice(1)} Report`,
			"",
			resolution,
			"",
			"---",
			"### Context",
			"",
			context,
		].join("\n");
		const labels = params.labels?.length ? params.labels : (KIND_LABELS[kind] ?? []);

		if (!(await ghAvailable())) {
			return {
				content: [
					{
						type: "text",
						text: [
							`[report] ${kind}: ${params.title}`,
							"",
							"gh not available — issue body printed below. Install gh: https://cli.github.com/",
							"",
							body,
						].join("\n"),
					},
				],
				details: {},
			};
		}

		const repo = params.repo ?? (await detectRepo());
		const result = await this._createIssue(params.title, body, labels, repo);
		if (result.ok) {
			return { content: [{ type: "text", text: result.msg }], details: {} };
		}
		return { isError: true, content: [{ type: "text", text: result.msg }], details: {} };
	}

	private async _createIssue(
		title: string,
		body: string,
		labels: string[],
		repo: string | null,
	): Promise<{ ok: boolean; url?: string; msg: string }> {
		const repoFlag = repo ? ["-R", repo] : [];
		const args = ["issue", "create", "--title", title, "--body", body, ...repoFlag];
		for (const l of labels) args.push("--label", l);

		try {
			const { stdout } = await execFileAsync(GH_BIN, args, { maxBuffer: 16 * 1024 * 1024 });
			return { ok: true, url: stdout.trim(), msg: `Issue created: ${stdout.trim()}` };
		} catch (err) {
			const e = err as { stderr?: string; message?: string };
			const stderr = e.stderr ?? e.message ?? String(err);
			if (labels.length && /not found/i.test(stderr)) {
				for (const l of labels) {
					try {
						await execFileAsync(GH_BIN, ["label", "create", l, ...repoFlag, "--color", "fbca04"], {
							maxBuffer: 16 * 1024 * 1024,
						});
					} catch {
						/* best-effort */
					}
				}
				try {
					const { stdout } = await execFileAsync(GH_BIN, args, { maxBuffer: 16 * 1024 * 1024 });
					return { ok: true, url: stdout.trim(), msg: `Issue created: ${stdout.trim()}` };
				} catch (err2) {
					const e = err2 as { stderr?: string; message?: string };
					return {
						ok: false,
						msg: `Failed to create issue: ${(e.stderr ?? e.message ?? "").trim()}`,
					};
				}
			}
			return { ok: false, msg: `Failed to create issue: ${stderr.trim()}` };
		}
	}

	async autoReportError(toolName: string, errText: string, pluginNames?: Set<string>): Promise<void> {
		if (!pluginNames || !pluginNames.has(toolName)) return;
		if (toolName === "record_stall") return;

		const now = Date.now();
		if (now - this._autoLastReport < AUTO_COOLDOWN_MS) return;
		if (this._autoCount >= AUTO_CAP) return;
		if (!(await ghAvailable())) return;

		const ctx = await captureContext();
		const title = `[auto] ${toolName} errored`;
		const body = [
			"## Auto-reported plugin tool error",
			"",
			`**Tool:** \`${toolName}\``,
			"",
			"### Error output",
			"",
			"```",
			errText || "(no error text captured)",
			"```",
			"",
			"---",
			"### Context",
			"",
			ctx,
			"",
			"_Filed automatically by pi's built-in error reporter._",
		].join("\n");

		const repo = await detectRepo();
		const result = await this._createIssue(title, body, ["bug"], repo);
		this._autoLastReport = now;
		this._autoCount++;
		if (result.ok) {
			try {
				(globalThis as any).__piTrackingLastUrl = result.url;
			} catch {
				/* best-effort */
			}
		}
	}
}

// ─── tool definition ──────────────────────────────────────────────────

export function createRecordStallToolDefinition(reporter: IssueReporter): ToolDefinition {
	return {
		name: "record_stall",
		label: "Record Stall / Issue",
		description:
			"Record a stall, bug, issue, or decision as a GitHub issue on the current repo. " +
			"Auto-captures context (branch, recent commits, repo, timestamp) and returns the issue URL.",
		promptSnippet: "Record a stall/issue on the current repo",
		promptGuidelines: [
			"Use record_stall when the agent hits a blocker, needs to track a bug, or the user asks to file an issue",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Issue title — concise, describes what's blocked or what needs doing" }),
			kind: Type.Optional(
				Type.Enum(Object.fromEntries(KIND_OPTIONS.map((k) => [k, k])) as any, {
					description: "Kind: stall (blocked), bug (broken), issue (task), feature, decision, task",
				}) as any,
			),
			description: Type.Optional(
				Type.String({ description: "Detailed description of what's happening, what's blocked, next steps" }),
			),
			labels: Type.Optional(Type.Array(Type.String(), { description: "Additional labels beyond the kind default" })),
		}),
		async execute(_id, params) {
			return reporter.fileIssue(params as any);
		},
	};
}
