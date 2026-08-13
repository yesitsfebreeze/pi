import { existsSync } from "node:fs";
import { basename } from "node:path";

/** Flags that suppress disk-loaded resources. A sub-agent re-invoked from this
 * process inherits these so it runs in the same environment as its parent — a
 * `-ne` session must not let its sub-agents load conflicting disk extensions. */
const INHERITED_NO_RESOURCE_FLAGS = new Set([
	"--no-extensions",
	"-ne",
	"--no-skills",
	"-ns",
	"--no-prompt-templates",
	"-np",
	"--no-themes",
	"--no-context-files",
	"-nc",
]);

function inheritedNoResourceFlags(): string[] {
	return process.argv.filter((arg) => INHERITED_NO_RESOURCE_FLAGS.has(arg));
}

/** Resolve how to invoke the `pi` CLI from this process. A source checkout
 * re-runs `process.argv[1]`; a compiled binary re-invokes `process.execPath`;
 * otherwise fall back to `pi` on PATH. `PI_BIN` overrides for tests and dev. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const inherited = inheritedNoResourceFlags();
	const fullArgs = [...inherited, ...args];
	if (process.env.PI_BIN) return { command: process.env.PI_BIN, args: fullArgs };
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...fullArgs] };
	}
	if (!/^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase())) {
		return { command: process.execPath, args: fullArgs };
	}
	return { command: "pi", args: fullArgs };
}
