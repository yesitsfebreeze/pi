// search-guard — bound the shell searches that cost the most tokens and time.
//
// The tool layer already truncates output at 2000 lines / 50KB, but truncation
// is a ceiling, not a brake: a `grep -r pattern .` still reads `.git/` and
// `node_modules/` before any downstream `| grep -v` or `| head` sees a path, and
// a `find /` without `-maxdepth` walks the whole disk. Both burn wall-clock
// first and context second, and neither is something a prompt guideline can
// enforce — the model is writing shell grammar, not choosing a tool.
//
// `tool_call` fires before execution and can veto with `{ block, reason }`.
// The reason goes back to the model, so the next attempt is bounded instead of
// blind. This is the only point where the command string is visible before the
// shell sees it: the bash tool sources no rc file, so a shell alias is not an
// option.
//
// Override: `PI_SEARCH_GUARD=off` in the environment, or a leading
// `# guard-off` line on the command for a one-off. Every block is appended to
// `<state>/pi/search-guard.log` so the record survives a disarmed session.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InlineExtension } from "./extensions/types.ts";

// Honour XDG_STATE_HOME like every other pi state path — the test suites set it
// precisely to keep writes out of the real ~/.local/state.
function logPath(): string {
	return (
		process.env.PI_SEARCH_GUARD_LOG ??
		join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi", "search-guard.log")
	);
}

function enabled(): boolean {
	return process.env.PI_SEARCH_GUARD !== "off";
}

/** A leading `# guard-off` line disarms the guard for one command. */
function overrideMarker(command: string): boolean {
	return /^\s*#\s*guard-off\b/i.test(command);
}

function toks(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

/** Root paths of a `find` invocation: the path tokens before the first predicate. */
function findRoots(command: string): string[] {
	const t = toks(command);
	const roots: string[] = [];
	for (let i = 1; i < t.length; i++) {
		const token = t[i];
		if (token === "-") continue;
		if (token.startsWith("-")) break; // predicates begin → no more roots
		if (token.includes("=") || token.includes("(") || token.includes("!")) break;
		roots.push(token.replace(/^~(?=$|\/)/, homedir()));
	}
	return roots;
}

// `find /` without `-maxdepth` walks the whole disk. Pruning `/proc` does not
// bound the `$HOME` walk (`~/.cargo`, `~/Library`), which is the part that
// actually stalls — so the accepted bounds are `-maxdepth` or a root set that
// is not bare `/`.
function checkFind(command: string): string | null {
	const t = toks(command);
	if (t[0] !== "find") return null;
	const roots = findRoots(command);
	if (!roots.some((r) => r === "/" || r === "")) return null;
	if (/-maxdepth\s+\d+/.test(command)) return null;
	return (
		"find rooted at / without -maxdepth walks the whole disk (~/Library, ~/.cargo, every mounted volume) — " +
		"a /proc prune does not bound the $HOME walk. Add -maxdepth N, scope the roots " +
		"(`find ~/.config ~/.local -name X`), or prefix the command with `# guard-off` for a one-off unbounded search."
	);
}

// A recursive grep rooted at the repo reads `.git/`, `node_modules/` and build
// output before any downstream filter sees a path — `| grep -v` and `| head`
// cannot undo reads already done, and sparse matches mean SIGPIPE arrives late.
// A grep scoped to a named subdirectory is left alone.
function checkGrep(command: string): string | null {
	const t = toks(command);
	if (t[0] !== "grep") return null;
	const recursive = t.some((x) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(x));
	if (!recursive) return null;

	const excluded = (command.match(/--exclude-dir[=\s]\S+/g) ?? []).map((m) =>
		m.replace(/^--exclude-dir[=\s]/, "").replace(/^['"]|['"]$/g, ""),
	);
	const hasGit = excluded.some((e) => /\.git|^git$/.test(e));
	const hasVendor = excluded.some((e) => /node_modules|target|dist|build|vendor/.test(e));

	// Roots are the non-flag tokens after the pattern (the first non-flag arg).
	let patternSeen = false;
	const roots: string[] = [];
	for (let i = 1; i < t.length; i++) {
		const token = t[i];
		if (token.startsWith("-")) continue;
		if (!patternSeen) {
			patternSeen = true;
			continue;
		}
		roots.push(token);
	}
	const wholeRepo = roots.length === 0 || roots.some((r) => r === "." || r === "./" || r === "/");
	if (!wholeRepo) return null;
	if (hasGit && hasVendor) return null;
	return (
		"grep -r over the whole tree without --exclude-dir for .git and node_modules/target/dist — " +
		"those are read before any `| grep -v` or `| head` sees a path, so the pipe cannot undo the cost. " +
		"Use the `grep` tool (respects ignore rules), add `--exclude-dir=.git --exclude-dir=node_modules`, " +
		"scope to a subdirectory, or prefix the command with `# guard-off`."
	);
}

/** Operators that begin a fresh command, as [token, width]. Longest-first. */
const SEPARATORS: ReadonlyArray<readonly [string, number]> = [
	["&&", 2],
	["||", 2],
	[";", 1],
	["|", 1],
	["\n", 1],
];

// Split a command on the operators that start a fresh command, keeping quoted
// regions intact. Without this a `find /` buried after a `;` or piped into
// `head` sails past the checks — which is the common shape, not the exception.
export function segments(command: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote = "";
	let i = 0;
	while (i < command.length) {
		const c = command[i];
		if (quote) {
			current += c;
			if (c === quote && command[i - 1] !== "\\") quote = "";
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			current += c;
			i++;
			continue;
		}
		// Separators, longest-first so `&&` wins over a bare `&` (which is not a
		// separator here and falls through to the accumulator) and `||` over `|`.
		const op = SEPARATORS.find(([token]) => command.startsWith(token, i));
		if (op) {
			out.push(current);
			current = "";
			i += op[1];
			continue;
		}
		current += c;
		i++;
	}
	if (current.trim()) out.push(current);
	return out;
}

/** The reason a command is blocked, or null when it is bounded. Exported for tests. */
export function checkCommand(command: string): string | null {
	if (!enabled()) return null;
	if (overrideMarker(command)) return null;
	for (const segment of segments(command)) {
		const reason = checkFind(segment) ?? checkGrep(segment);
		if (reason) return reason;
	}
	return null;
}

function logBlock(command: string, reason: string): void {
	try {
		const log = logPath();
		mkdirSync(dirname(log), { recursive: true });
		appendFileSync(log, `[${new Date().toISOString()}] BLOCKED: ${reason}\n  cmd: ${command.replace(/\n/g, " ")}\n`);
	} catch {
		// logging is best-effort; never let it mask the block
	}
}

export function createSearchGuardExtension(): InlineExtension {
	return {
		name: "search-guard",
		hidden: true,
		factory(pi) {
			pi.on("tool_call", (event) => {
				if (event.toolName !== "bash") return;
				const command = (event.input as { command?: unknown }).command;
				if (typeof command !== "string" || !command) return;
				const reason = checkCommand(command);
				if (!reason) return;
				logBlock(command, reason);
				return { block: true, reason };
			});
		},
	};
}
