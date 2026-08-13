// ontology tests — digest read/write at .pi/ontology/digest.md

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	countEntities,
	ensureDigest,
	parseDigest,
	readDigest,
	setOntologyRoot,
	writeDigest,
} from "../../src/core/memory/ontology.ts";

function tmpRoot(): string {
	const dir = join(tmpdir(), `pi-ontology-test-${process.pid}`);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

describe("ontology", () => {
	let root: string;

	beforeAll(() => {
		root = tmpRoot();
		setOntologyRoot(root);
		const d = `${root}/.pi/ontology`;
		if (existsSync(d)) rmSync(d, { recursive: true, force: true });
	});

	afterAll(() => {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {}
	});

	it("ensureDigest creates digest from template", () => {
		ensureDigest();
		const digest = readDigest();
		expect(digest).toBeTruthy();
		expect(digest!.includes(`Ontology digest — ${root}`)).toBe(true);
		expect(digest!.includes("## Entities")).toBe(true);
		expect(digest!.includes("(none yet)")).toBe(true);
	});

	it("ensureDigest is idempotent", () => {
		const before = readDigest();
		ensureDigest(); // second call
		const after = readDigest();
		expect(after).toBe(before);
	});

	it("writeDigest overwrites", () => {
		const newBody = [
			"# Test digest",
			"",
			"## Entities",
			"- EntityA kern:abc123 — hook text",
			"- EntityB kern:def456 — more detail",
		].join("\n");
		writeDigest(newBody);
		const digest = readDigest();
		expect(digest).toBe(newBody);
	});

	it("parseDigest extracts entities", () => {
		const digest = [
			"# Test digest",
			"",
			"## Entities",
			"- EntityA kern:abc123 — hook text | rel: depends_on -> EntityB",
			"- EntityB kern:def456 — more detail | see: src/foo.ts",
			"(not an entity — no kern id)",
		].join("\n");
		writeDigest(digest);
		const entries = parseDigest(digest);
		expect(entries.length).toBe(2);
		expect(entries[0].term).toBe("EntityA");
		expect(entries[0].kernId).toBe("abc123");
		expect(entries[0].summary.includes("hook text")).toBe(true);
		expect(entries[1].term).toBe("EntityB");
		expect(entries[1].kernId).toBe("def456");
	});

	it("parseDigest handles middot separators", () => {
		const digest = "## Entities\n- Foo kern:xyz — a · b · c\n";
		writeDigest(digest);
		const entries = parseDigest(digest);
		expect(entries.length).toBe(1);
		expect(entries[0].term).toBe("Foo");
	});

	it("countEntities returns entity count", () => {
		const digest = ["## Entities", "- A kern:1 — x", "- B kern:2 — y", "- C kern:3 — z"].join("\n");
		expect(countEntities(digest)).toBe(3);
	});

	it("countEntities returns 0 for no entities", () => {
		expect(countEntities("## Entities\n(none yet)\n")).toBe(0);
	});
});
