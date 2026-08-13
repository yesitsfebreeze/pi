/**
 * vitals — session memory watchdog: level escalation, least-squares trend,
 * proc-storm floor, and the /doctor health check. The sampler functions are
 * exported; tests feed the samples array directly (tick() would need a real
 * process.memoryUsage and a timer).
 */
import { describe, expect, it } from "vitest";
import {
	advice,
	classify,
	createVitalsInlineExtension,
	etaMinutes,
	evaluateVitals,
	fmt,
	growth,
	liveProcs,
	procFloor,
	resetVitals,
	samples,
	setOnVitalsChange,
	trend,
} from "../../src/core/vitals/index.ts";

function push(rss: number, t = Date.now(), procs = 0): void {
	samples.push({ t, rss, heap: rss / 2, procs });
}

describe("vitals signals", () => {
	it("trend is flat below four samples or a one-second span", () => {
		resetVitals();
		expect(trend()).toBe(0);
		push(100, 0);
		push(100, 10);
		push(100, 20);
		expect(trend()).toBe(0); // < 4 samples
		push(100, 25);
		expect(trend()).toBe(0); // span < 1s → no trend
	});

	it("trend measures MB/min by least squares over the window", () => {
		resetVitals();
		const t0 = Date.now();
		// +1000MB over 10 minutes = +100 MB/min
		for (let i = 0; i <= 10; i++) push(500 + i * 100, t0 + i * 60_000);
		expect(trend()).toBeCloseTo(100, 0);
	});

	it("a flat line reads as zero trend", () => {
		resetVitals();
		const t0 = Date.now();
		for (let i = 0; i <= 10; i++) push(700, t0 + i * 60_000);
		expect(trend()).toBeLessThan(1);
	});

	it("growth is growth from the session baseline, floored at zero", () => {
		resetVitals();
		samples.push({ t: 0, rss: 500, heap: 250, procs: 0 });
		push(500, 1);
		expect(growth()).toBe(0);
		push(700, 2);
		expect(growth()).toBe(200);
		resetVitals();
		samples.push({ t: 0, rss: 500, heap: 250, procs: 0 });
		push(400, 1);
		expect(growth()).toBe(0);
	});

	it("procFloor is the min of the last three samples, zero below three", () => {
		resetVitals();
		expect(procFloor()).toBe(0);
		push(100, 1, 10);
		expect(procFloor()).toBe(0);
		push(100, 2, 12);
		expect(procFloor()).toBe(0);
		push(100, 3, 6);
		expect(procFloor()).toBe(6);
	});

	it("etaMinutes projects time to the crit ceiling", () => {
		resetVitals();
		const t0 = Date.now();
		for (let i = 0; i <= 10; i++) push(1500 + i * 100, t0 + i * 60_000); // +100MB/min, crit 3000
		const eta = etaMinutes();
		expect(eta).not.toBeUndefined();
		expect(eta).toBeLessThanOrEqual(20);
	});

	it("etaMinutes is undefined on a flat trend", () => {
		resetVitals();
		const t0 = Date.now();
		for (let i = 0; i <= 10; i++) push(700, t0 + i * 60_000);
		expect(etaMinutes()).toBeUndefined();
	});

	it("fmt renders MB and GB", () => {
		expect(fmt(512)).toBe("512M");
		expect(fmt(2048)).toBe("2.0G");
	});
});

describe("vitals classify + evaluate", () => {
	it("escalates ok → warn → crit on RSS ceilings", () => {
		process.env.PI_MEM_WARN_MB = "2000";
		process.env.PI_MEM_CRIT_MB = "3000";
		resetVitals();
		push(1500, Date.now());
		expect(classify()).toBe("ok");
		push(2500, Date.now() + 30_000);
		expect(classify()).toBe("warn");
		push(3500, Date.now() + 60_000);
		expect(classify()).toBe("crit");
		delete process.env.PI_MEM_WARN_MB;
		delete process.env.PI_MEM_CRIT_MB;
	});

	it("growth-from-baseline trips warn/crit before the absolute ceiling", () => {
		process.env.PI_MEM_GROW_WARN_MB = "800";
		process.env.PI_MEM_GROW_CRIT_MB = "1600";
		resetVitals();
		samples.push({ t: 0, rss: 500, heap: 250, procs: 0 });
		push(1200, 1); // +700 growth
		expect(classify()).toBe("ok");
		push(1400, 2); // +900 growth
		expect(classify()).toBe("warn");
		push(2200, 3); // +1700 growth
		expect(classify()).toBe("crit");
		delete process.env.PI_MEM_GROW_WARN_MB;
		delete process.env.PI_MEM_GROW_CRIT_MB;
	});

	it("notifies once on escalation and re-nags at crit after the cooldown", () => {
		resetVitals();
		const seen: Array<{ level: string; text: string }> = [];
		setOnVitalsChange((lvl, text) => seen.push({ level: lvl, text }));
		process.env.PI_MEM_WARN_MB = "2000";
		process.env.PI_MEM_CRIT_MB = "3000";
		const t0 = Date.now();
		push(1500, t0);
		evaluateVitals();
		push(2500, t0 + 30_000); // warn escalation → notify
		evaluateVitals();
		push(3500, t0 + 60_000); // crit escalation → notify
		evaluateVitals();
		expect(seen.filter((s) => s.text).map((s) => s.level)).toEqual(["warn", "crit"]);
		expect(seen.filter((s) => s.text)[0].text).toContain("vitals:");
		expect(seen.filter((s) => s.text)[1].text).toContain("restart");
		// same-level re-nag is gated by the cooldown (15 min) — a quick re-eval stays quiet
		const before = seen.filter((s) => s.text).length;
		push(3600, t0 + 61_000);
		evaluateVitals();
		expect(seen.filter((s) => s.text).length).toBe(before);
		delete process.env.PI_MEM_WARN_MB;
		delete process.env.PI_MEM_CRIT_MB;
	});

	it("advice flags a child-process storm", () => {
		resetVitals();
		process.env.PI_MEM_PROC_WARN = "8";
		const t0 = Date.now();
		push(1000, t0, 9);
		push(1000, t0 + 30_000, 10);
		push(1000, t0 + 60_000, 11);
		expect(procFloor()).toBe(9);
		expect(advice()).toMatch(/child processes live/);
		delete process.env.PI_MEM_PROC_WARN;
	});
});

describe("vitals extension", () => {
	it("registers a health check", () => {
		const checks: string[] = [];
		const api: any = {
			on() {},
			registerTool() {},
			registerCommand() {},
			registerHealthCheck(c: any) {
				checks.push(c.name);
			},
			sendUserMessage() {},
		};
		(createVitalsInlineExtension() as { factory: (pi: any) => void }).factory(api);
		expect(checks).toContain("vitals:memory");
	});

	it("liveProcs counts child-process handles without crashing", () => {
		expect(liveProcs()).toBeGreaterThanOrEqual(0);
	});
});
