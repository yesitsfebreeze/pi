/**
 * dev-hot-reload: startHotReload watches dirs and fires a debounced onChange.
 * Proves the real implementation (not the stub it replaced): watches a dir,
 * debounces a burst of changes into one callback, and stop() closes watchers.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHotReload } from "../src/core/dev-hot-reload.ts";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "hot-reload-"));
}

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll until `condition` holds. `fs.watch` delivery latency is unbounded — on a
 * loaded macOS box the first event can land well after a fixed sleep would have
 * expired, which made this suite flake. Waiting on the condition instead of on
 * the clock keeps the assertion honest without racing the watcher.
 */
async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) return;
		await wait(10);
	}
}

describe("startHotReload", () => {
	it("fires onChange (debounced) when a watched file changes", async () => {
		const dir = tmpDir();
		const sub = join(dir, "extensions");
		mkdirSync(sub);
		let calls = 0;
		const h = startHotReload({
			watchDirs: [sub],
			debounceMs: 60,
			onChange: () => {
				calls++;
			},
		});
		try {
			// Burst of writes — should collapse to a single debounced call.
			for (let i = 0; i < 5; i++) writeFileSync(join(sub, `f${i}.ts`), "x");
			// fs.watch delivery is unbounded under full-suite load, and a dropped
			// event is invisible to the poll. Nudge with a fresh write every 200ms
			// until something arrives — the watcher always has an event to see.
			const arrivalDeadline = Date.now() + 5000;
			while (Date.now() < arrivalDeadline && calls < 1) {
				writeFileSync(join(sub, "nudge.ts"), `${Date.now()}`);
				await wait(200);
			}
			await waitUntil(() => calls >= 1);
			expect(calls).toBeGreaterThanOrEqual(1);
			// Debounce: 5 rapid writes → at most 2 callbacks (one burst + maybe a late one).
			// Poll until the count has been stable for 2 full debounce windows, so a
			// slow fs.watch delivery under load doesn't trip the upper bound mid-burst.
			let lastSeen = calls;
			let stableSince = Date.now();
			const settleDeadline = Date.now() + 5000;
			while (Date.now() < settleDeadline) {
				if (calls !== lastSeen) {
					lastSeen = calls;
					stableSince = Date.now();
				} else if (Date.now() - stableSince >= 150) {
					break;
				}
				await wait(20);
			}
			expect(calls).toBeLessThanOrEqual(2);
		} finally {
			h.stop();
		}
	});

	it("stop() prevents further callbacks and is idempotent", async () => {
		const dir = tmpDir();
		const sub = join(dir, "skills");
		mkdirSync(sub);
		let calls = 0;
		const h = startHotReload({
			watchDirs: [sub],
			debounceMs: 30,
			onChange: () => {
				calls++;
			},
		});
		h.stop();
		h.stop(); // idempotent
		writeFileSync(join(sub, "a.md"), "x");
		await wait(80);
		expect(calls).toBe(0);
	});

	it("skips non-existent watch dirs without throwing", () => {
		let calls = 0;
		const h = startHotReload({
			watchDirs: ["/nonexistent/dir/that/does/not/exist"],
			debounceMs: 10,
			onChange: () => {
				calls++;
			},
		});
		h.stop();
		expect(calls).toBe(0);
	});
});
