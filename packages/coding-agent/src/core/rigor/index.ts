// rigor — automated post-pass verification for the repo the session runs in.
//
// One scan discovers every check the repo already carries (package scripts,
// per-dir test files, Makefile/justfile targets, cargo/go/pytest markers,
// probe.sh scripts) and freezes them into `.pi/rigor/checks.json` plus three
// generated plans:
//
//   .pi/rigor/plan-full.md          everything, the whole program
//   .pi/rigor/plan-integration.md   repo-wide wiring checks only
//   .pi/rigor/plan-fast.md          per-section checks, one section at a time
//
// Tiers test gradually downwards: full ⊃ integration ⊃ fast <section>.
// Past mistakes land in `.pi/rigor/mistakes.md` via `/rigor mistake <text>`;
// they are folded into every plan and injected into the system prompt, so
// the next pass plans around them instead of repeating them.
//
// /rigor scan                  discover checks, write plans
// /rigor full                  run everything
// /rigor integration           run repo-wide checks
// /rigor fast <section>        run one section's checks
// /rigor mistake <text>        record a pitfall, regenerate plans
// /rigor status                last run, check counts, auto state

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { createVolatileChannel } from "../context-injection.ts";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.ts";

const STATUS_KEY = "rigor";
const TAIL_MAX = 30;
const CHECK_TIMEOUT_MS = 300_000;
const PITFALLS_SHOWN = 5;

type Kind = "test" | "lint" | "typecheck" | "build" | "probe" | "custom";
type Tier = "full" | "integration" | "fast";

interface Check {
	name: string;
	cmd: string;
	cwd: string;
	scope: string;
	kind: Kind;
}

interface Result {
	name: string;
	ok: boolean;
	status: "passed" | "failed" | "timed_out" | "spawn_error";
	code: number | null;
	signal?: string | null;
	ms: number;
	tail: string[];
	error?: string;
}

interface Run {
	tier: Tier;
	section?: string;
	at: string;
	results: Result[];
}

let root = process.cwd();
// Auto post-edit check is off by default: rigor is manual — activate with
// `/rigor auto on` (persisted) or run `/rigor full|integration|fast` once.
let auto = false;
let running = false;
let touched = new Set<string>();
let lastFailSig = "";
let setStatus: ((key: string, text: string | undefined) => void) | undefined;

// ─── state files ────────────────────────────────────────────────────────────
const rigorDir = () => path.join(root, ".pi", "rigor");
const checksPath = () => path.join(rigorDir(), "checks.json");
const mistakesPath = () => path.join(rigorDir(), "mistakes.md");
const lastPath = () => path.join(rigorDir(), "last.json");
const configPath = () => path.join(rigorDir(), "config.json");

function loadConfig(): { auto_fast_check: boolean } {
	try {
		const d = JSON.parse(fs.readFileSync(configPath(), "utf8"));
		return { auto_fast_check: d.auto_fast_check === true };
	} catch {
		return { auto_fast_check: false };
	}
}

function saveConfig(cfg: { auto_fast_check: boolean }): void {
	fs.mkdirSync(rigorDir(), { recursive: true });
	fs.writeFileSync(configPath(), JSON.stringify(cfg));
}

function loadChecks(): { discovered: Check[]; custom: Check[] } {
	try {
		const d = JSON.parse(fs.readFileSync(checksPath(), "utf8"));
		return { discovered: d.discovered ?? [], custom: d.custom ?? [] };
	} catch {
		return { discovered: [], custom: [] };
	}
}

function allChecks(): Check[] {
	const { discovered, custom } = loadChecks();
	return [...discovered, ...custom];
}

function loadMistakes(): string[] {
	try {
		return fs
			.readFileSync(mistakesPath(), "utf8")
			.split("\n")
			.filter((l: string) => l.startsWith("- "));
	} catch {
		return [];
	}
}

// ─── discovery ──────────────────────────────────────────────────────────────
const SCRIPT_KINDS: [string, Kind][] = [
	["test", "test"],
	["lint", "lint"],
	["typecheck", "typecheck"],
	["check", "lint"],
	["build", "build"],
];

function readPkg(p: string): any {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return undefined;
	}
}

function scriptChecks(add: (c: Check) => void, sub: string, scope: string): boolean {
	const pkg = readPkg(path.join(root, sub, "package.json"));
	if (!pkg) return false;
	let hasTest = false;
	for (const [script, kind] of SCRIPT_KINDS) {
		if (!pkg.scripts?.[script]) continue;
		add({ name: `${scope}:${script}`, cmd: `npm run ${script}`, cwd: sub, scope, kind });
		if (script === "test") hasTest = true;
	}
	return hasTest;
}

function discover(): Check[] {
	const checks: Check[] = [];
	const seen = new Set<string>();
	const add = (c: Check) => {
		if (seen.has(c.name)) return;
		seen.add(c.name);
		checks.push(c);
	};

	scriptChecks(add, ".", "repo");

	for (const [file, runner] of [
		["Makefile", "make"],
		["justfile", "just"],
	]) {
		const p = path.join(root, file);
		if (!fs.existsSync(p)) continue;
		const lines = fs.readFileSync(p, "utf8").split("\n");
		for (const t of ["test", "check", "lint"])
			if (lines.some((l: string) => l.startsWith(`${t}:`) || l.startsWith(`${t} :`)))
				add({
					name: `repo:${runner}-${t}`,
					cmd: `${runner} ${t}`,
					cwd: ".",
					scope: "repo",
					kind: t === "lint" ? "lint" : "test",
				});
	}

	if (fs.existsSync(path.join(root, "Cargo.toml"))) {
		add({ name: "repo:cargo-check", cmd: "cargo check", cwd: ".", scope: "repo", kind: "typecheck" });
		add({ name: "repo:cargo-test", cmd: "cargo test", cwd: ".", scope: "repo", kind: "test" });
	}
	if (fs.existsSync(path.join(root, "go.mod"))) {
		add({ name: "repo:go-vet", cmd: "go vet ./...", cwd: ".", scope: "repo", kind: "lint" });
		add({ name: "repo:go-test", cmd: "go test ./...", cwd: ".", scope: "repo", kind: "test" });
	}
	if (
		["pyproject.toml", "pytest.ini", "setup.cfg"].some((f) => fs.existsSync(path.join(root, f))) &&
		fs.existsSync(path.join(root, "tests"))
	)
		add({ name: "repo:pytest", cmd: "pytest", cwd: ".", scope: "repo", kind: "test" });

	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {}
	for (const e of entries) {
		if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
		const scope = e.name;
		const hasTest = scriptChecks(add, scope, scope);
		if (!hasTest) {
			const tdir = path.join(root, scope, "tests");
			if (fs.existsSync(tdir))
				for (const f of fs.readdirSync(tdir).sort())
					if (/\.test\.(mjs|js)$/.test(f))
						add({
							name: `${scope}:${f}`,
							cmd: `node --experimental-strip-types tests/${f}`,
							cwd: scope,
							scope,
							kind: "test",
						});
		}
		if (fs.existsSync(path.join(root, scope, "probe.sh")))
			add({ name: `${scope}:probe`, cmd: "bash probe.sh", cwd: scope, scope, kind: "probe" });
		let subs: fs.Dirent[] = [];
		try {
			subs = fs.readdirSync(path.join(root, scope), { withFileTypes: true });
		} catch {}
		for (const s of subs)
			if (s.isDirectory() && fs.existsSync(path.join(root, scope, s.name, "probe.sh")))
				add({
					name: `${scope}/${s.name}:probe`,
					cmd: "bash probe.sh",
					cwd: path.join(scope, s.name),
					scope,
					kind: "probe",
				});
	}
	return checks;
}

// ─── plans ──────────────────────────────────────────────────────────────────
function pitfallBlock(): string {
	const m = loadMistakes();
	if (!m.length) return "(none recorded — `/rigor mistake <text>` when one bites)";
	return m.join("\n");
}

function checkLines(checks: Check[]): string {
	return checks.map((c) => `- \`${c.cmd}\` in \`${c.cwd}\` — ${c.name} [${c.kind}]`).join("\n");
}

const POSTPASS = `## Postpass — leave it cleaner than found
- [ ] every check above green
- [ ] dead code deleted: nothing kept "for later", nothing without a caller
- [ ] no duplicate logic — one authoritative representation
- [ ] diff minimal: no unrequested abstractions, no scaffolding
- [ ] docs updated where behavior changed`;

function genPlans(checks: Check[]): void {
	const dir = rigorDir();
	fs.mkdirSync(dir, { recursive: true });
	const stamp = `Generated ${new Date().toISOString().slice(0, 10)} by rigor scan. Rescan after tooling changes.`;
	const pitfalls = `## Known pitfalls — plan around these\n${pitfallBlock()}`;

	const repo = checks.filter((c) => c.scope === "repo");
	const sections = [...new Set(checks.filter((c) => c.scope !== "repo").map((c) => c.scope))].sort();

	fs.writeFileSync(
		path.join(dir, "plan-full.md"),
		`# Rigor plan — full sweep\n${stamp}\n\nRun: \`/rigor full\` — the whole program, every check discovered.\n\n${pitfalls}\n\n## Checks (${checks.length})\n${checkLines(checks)}\n\n${POSTPASS}\n`,
	);
	fs.writeFileSync(
		path.join(dir, "plan-integration.md"),
		`# Rigor plan — integration\n${stamp}\n\nRun: \`/rigor integration\` — repo-wide checks only: is everything wired and building together.\n\n${pitfalls}\n\n## Checks (${repo.length})\n${checkLines(repo)}\n`,
	);
	fs.writeFileSync(
		path.join(dir, "plan-fast.md"),
		`# Rigor plan — fast section check\n${stamp}\n\nRun: \`/rigor fast <section>\` — only that section's checks; the post-edit auto check uses this tier.\n\n${pitfalls}\n\n## Sections\n${sections
			.map((s) => {
				const own = checks.filter((c) => c.scope === s);
				return `### ${s} (${own.length})\n${checkLines(own)}`;
			})
			.join("\n\n")}\n`,
	);
}

// ─── running ────────────────────────────────────────────────────────────────
function pick(tier: Tier, section?: string): Check[] {
	const checks = allChecks();
	if (tier === "fast") return checks.filter((c) => c.scope === (section ?? ""));
	if (tier === "integration") return checks.filter((c) => c.scope === "repo");
	return checks;
}

function cleanTail(text: string): string[] {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.split("\n")
		.map((line) => line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""))
		.filter(Boolean)
		.slice(-TAIL_MAX);
}

function runOne(check: Check, timeout = CHECK_TIMEOUT_MS): Promise<Result> {
	return new Promise((resolve) => {
		const started = Date.now();
		let tail: string[] = [];
		let timedOut = false;
		const child = spawn(check.cmd, {
			shell: true,
			cwd: path.resolve(root, check.cwd),
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1", TERM: "dumb" },
		});
		const push = (b: Buffer) => {
			tail = [...tail, ...cleanTail(b.toString())].slice(-TAIL_MAX);
		};
		child.stdout?.on("data", push);
		child.stderr?.on("data", push);
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-(child.pid as number), "SIGKILL");
			} catch {}
		}, timeout);
		timer.unref?.();
		child.on("error", (e: Error) => {
			clearTimeout(timer);
			resolve({
				name: check.name,
				ok: false,
				status: "spawn_error",
				code: null,
				ms: Date.now() - started,
				tail: [`spawn failed: ${e.message}`],
				error: e.message,
			});
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({
				name: check.name,
				ok: !timedOut && code === 0,
				status: timedOut ? "timed_out" : code === 0 ? "passed" : "failed",
				code,
				signal,
				ms: Date.now() - started,
				tail,
			});
		});
	});
}

async function runTier(tier: Tier, section?: string): Promise<Run | string> {
	const checks = pick(tier, section);
	if (!checks.length)
		return tier === "fast"
			? `rigor: no checks for section "${section ?? ""}" — /rigor scan first, or check the section name`
			: "rigor: no checks discovered — /rigor scan first";

	running = true;
	const results: Result[] = [];
	try {
		for (const [i, c] of checks.entries()) {
			setStatus?.(STATUS_KEY, `rigor: ${tier} ${i + 1}/${checks.length} · ${c.name}`);
			results.push(await runOne(c));
		}
	} finally {
		running = false;
	}

	const run: Run = { tier, section, at: new Date().toISOString(), results };
	fs.mkdirSync(rigorDir(), { recursive: true });
	fs.writeFileSync(lastPath(), JSON.stringify(run, null, 2));
	return run;
}

function summarize(run: Run): string {
	const bad = run.results.filter((r) => !r.ok);
	const secs = (run.results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1);
	const head = `rigor ${run.tier}${run.section ? ` ${run.section}` : ""}: ${run.results.length - bad.length}/${run.results.length} passed (${secs}s)`;
	if (!bad.length) return head;
	return [
		head,
		...bad.map((r) => `✗ ${r.name} (exit ${r.code ?? "?"}, ${(r.ms / 1000).toFixed(1)}s)\n   ${r.tail.at(-1) ?? ""}`),
	].join("\n");
}

// ─── mistakes ───────────────────────────────────────────────────────────────
function addMistake(text: string): string {
	if (!text.trim()) return "rigor: mistake needs text";
	fs.mkdirSync(rigorDir(), { recursive: true });
	const line = `- ${new Date().toISOString().slice(0, 10)} ${text.trim()}\n`;
	fs.appendFileSync(mistakesPath(), line);
	const checks = allChecks();
	if (checks.length) genPlans(checks);
	return `rigor: recorded — ${loadMistakes().length} pitfall(s) on file, plans updated`;
}

// ─── actions ────────────────────────────────────────────────────────────────
function doScan(): string {
	const discovered = discover();
	const { custom } = loadChecks();
	fs.mkdirSync(rigorDir(), { recursive: true });
	fs.writeFileSync(checksPath(), JSON.stringify({ discovered, custom }, null, 2));
	genPlans([...discovered, ...custom]);
	const sections = new Set(discovered.filter((c) => c.scope !== "repo").map((c) => c.scope));
	return `rigor: ${discovered.length} check(s) across ${sections.size} section(s)${custom.length ? ` + ${custom.length} custom` : ""} — plans in .pi/rigor/ (custom checks: edit .pi/rigor/checks.json "custom")`;
}

function doStatus(): string {
	const checks = allChecks();
	const lines = [
		`checks: ${checks.length} (${checks.filter((c) => c.scope === "repo").length} repo-wide) · auto fast check: ${auto ? "on" : "off"} · pitfalls: ${loadMistakes().length}`,
	];
	try {
		const run: Run = JSON.parse(fs.readFileSync(lastPath(), "utf8"));
		lines.push(`last run ${run.at}:`, summarize(run));
	} catch {
		lines.push("no runs yet");
	}
	return lines.join("\n");
}

async function doRun(tier: Tier, section?: string): Promise<string> {
	const r = await runTier(tier, section);
	return typeof r === "string" ? r : summarize(r);
}

// ─── post-pass ──────────────────────────────────────────────────────────────
async function postpass(pi: ExtensionAPI): Promise<void> {
	const sections = [...touched];
	touched = new Set();
	const known = new Set(allChecks().map((c) => c.scope));
	const targets = sections.filter((s) => known.has(s));
	if (!targets.length || running) return;
	const failures: string[] = [];
	for (const s of targets) {
		const r = await runTier("fast", s);
		if (typeof r === "string") continue;
		for (const res of r.results)
			if (!res.ok) failures.push(`✗ ${res.name} (exit ${res.code ?? "?"}) — ${res.tail.at(-1) ?? ""}`);
	}
	const sig = failures.join("|");
	if (failures.length && sig !== lastFailSig)
		pi.sendUserMessage(
			`rigor post-pass: fast check failed after your edits.\n${failures.join("\n")}\nFix these before moving on; /rigor status for details.`,
		);
	lastFailSig = sig;
}

// ─── wiring ─────────────────────────────────────────────────────────────────
const EDIT_TOOLS = new Set(["edit", "write", "str_replace_editor", "create"]);

export function createRigorExtension(): (pi: ExtensionAPI) => void {
	const pitfalls = createVolatileChannel("rigor-pitfalls");
	return (pi: ExtensionAPI) => {
		pi.on("session_start", (_event: any, ctx: any) => {
			root = ctx?.cwd ?? root;
			auto = loadConfig().auto_fast_check;
			setStatus = ctx?.ui?.setStatus?.bind(ctx.ui);
			pitfalls.reset();
		});

		pi.on("session_shutdown", () => {
			setStatus = undefined;
		});

		// Pitfalls grow as the session records them, so this rides a custom message
		// rather than the system prompt — a growing system prompt rewrites the
		// whole cached prefix every time a pitfall lands. The channel is change-
		// gated, so an unchanged pitfall list is not re-sent.
		pi.on("before_agent_start", () => {
			const m = loadMistakes();
			if (!m.length) return;
			return pitfalls.emit(
				`RIGOR pitfalls (recorded in this repo — do not repeat):\n${m.slice(-PITFALLS_SHOWN).join("\n")}`,
			);
		});

		pi.on("tool_call", (event: any) => {
			if (!EDIT_TOOLS.has(event?.toolName)) return;
			const p = event?.input?.path ?? event?.input?.file_path;
			if (typeof p !== "string") return;
			const rel = path.relative(root, path.resolve(root, p));
			if (rel.startsWith("..")) return;
			const section = rel.split(path.sep)[0];
			if (section && !section.includes(".")) touched.add(section);
		});

		pi.on("agent_settled", () => {
			if (!auto || touched.size === 0 || !fs.existsSync(checksPath())) {
				touched = new Set();
				return;
			}
			void postpass(pi);
		});

		pi.registerCommand("rigor", {
			description:
				"Post-pass verification: scan | full | integration | fast <section> | mistake <text> | status | auto on|off",
			async handler(args: string, ctx: any) {
				root = ctx?.cwd ?? root;
				setStatus = ctx?.ui?.setStatus?.bind(ctx.ui);
				const tokens = args.trim().split(/\s+/).filter(Boolean);
				const head = tokens[0] ?? "status";
				let msg: string;
				if (head === "scan") msg = doScan();
				else if (head === "full" || head === "integration") msg = await doRun(head);
				else if (head === "fast") msg = await doRun("fast", tokens[1]);
				else if (head === "mistake") msg = addMistake(tokens.slice(1).join(" "));
				else if (head === "auto") {
					auto = tokens[1] !== "off";
					saveConfig({ auto_fast_check: auto });
					msg = `rigor: auto fast check ${auto ? "on" : "off"}`;
				} else msg = doStatus();
				ctx.ui.notify(msg, msg.includes("✗") || msg.startsWith("rigor: no") ? "warning" : "info");
			},
		});

		pi.registerTool({
			name: "rigor",
			label: "Rigor",
			description:
				"Post-pass verification for this repo. scan discovers checks; run executes full, integration, or fast section tiers. mistake records a pitfall folded into plans and prompts.",
			promptSnippet: "Verification tiers: rigor scan once, then run fast/integration/full",
			parameters: Type.Object({
				action: Type.String({
					enum: ["scan", "run", "mistake", "status"],
					description: "scan discovers checks; run executes a tier; mistake records a planning pitfall.",
				}),
				tier: Type.Optional(
					Type.String({
						enum: ["full", "integration", "fast"],
						description: "run only — which tier to execute (default fast)",
					}),
				),
				section: Type.Optional(Type.String({ description: "fast tier only — top-level directory to check" })),
				text: Type.Optional(Type.String({ description: "mistake only — the pitfall to record" })),
			}),
			async execute(_id, params: any, _signal, _onUpdate, ctx: ExtensionContext) {
				root = ctx?.cwd ?? root;
				setStatus = ctx?.ui?.setStatus?.bind(ctx.ui);
				const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
				if (params.action === "scan") return out(doScan());
				if (params.action === "run") return out(await doRun(params.tier ?? "fast", params.section));
				if (params.action === "mistake") return out(addMistake(params.text ?? ""));
				return out(doStatus());
			},
		});
	};
}
