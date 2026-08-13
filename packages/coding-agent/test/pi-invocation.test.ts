import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPiInvocation } from "../src/core/pi-invocation.ts";

describe("getPiInvocation", () => {
	const originalArgv = process.argv;
	const originalPiBin = process.env.PI_BIN;
	let tmpDir: string;
	let fakeScript: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-invocation-"));
		fakeScript = join(tmpDir, "cli.ts");
		writeFileSync(fakeScript, "");
	});

	afterEach(() => {
		process.argv = originalArgv;
		if (originalPiBin === undefined) delete process.env.PI_BIN;
		else process.env.PI_BIN = originalPiBin;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("inherits --no-* resource flags from the parent argv", () => {
		process.argv = [process.execPath, fakeScript, "-ne", "-ns", "--no-themes", "-nc", "--session", "x"];
		const r = getPiInvocation(["--mode", "json", "-p"]);
		expect(r.args).toEqual([fakeScript, "-ne", "-ns", "--no-themes", "-nc", "--mode", "json", "-p"]);
	});

	it("does not inherit unrelated flags", () => {
		process.argv = [process.execPath, fakeScript, "--session", "abc", "-p", "--verbose"];
		const r = getPiInvocation(["--mode", "json"]);
		expect(r.args).toEqual([fakeScript, "--mode", "json"]);
	});

	it("applies inherited flags when PI_BIN is set", () => {
		process.env.PI_BIN = "/tmp/fake-pi";
		process.argv = [process.execPath, fakeScript, "-ne"];
		const r = getPiInvocation(["update", "--all"]);
		expect(r).toEqual({ command: "/tmp/fake-pi", args: ["-ne", "update", "--all"] });
	});
});
