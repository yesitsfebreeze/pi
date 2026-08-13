// vitals — the memory watchdog for a long-lived session, ported from hub's
// vitals module (the one salvageable piece of the otherwise-replaced hub).
//
// Three signals, because absolute RSS alone is a bad alarm on a machine whose
// baseline varies:
//
//   level  — RSS against a hard ceiling, or growth against this session's own
//            baseline. Escalates ok → warn → crit, notifies on each escalation
//            and re-nags at crit.
//   trend  — least-squares slope over the recent window, in MB/min, with the
//            projected time to the crit line. A slow monotonic climb trips
//            this long before it trips a threshold.
//   procs  — live child processes counted from the event loop's active
//            handles. The oilrig counted detached/unref'd children via /proc;
//            core counts what the event loop holds (a launch/mem child is
//            visible; a detached one is not — documented limitation).
//
// Env knobs: PI_MEM_WARN_MB / PI_MEM_CRIT_MB / PI_MEM_GROW_WARN_MB /
// PI_MEM_GROW_CRIT_MB / PI_MEM_TREND_MB_PER_MIN / PI_MEM_PROC_WARN.

import type { ExtensionAPI, ExtensionContext, InlineExtension } from "../extensions/types.ts";

export type Level = "ok" | "warn" | "crit";

export interface VitalSample {
	t: number;
	rss: number; // MB
	heap: number; // MB
	procs: number;
}

const SAMPLE_MS = 30_000;
const WINDOW = 20; // samples kept — 10 minutes at the default cadence
const RENAG_MS = 15 * 60_000;
const MIN_SPAN_MS = 1000; // below this wall-clock span there is no trend to report

const envMb = (k: string, d: number): number => {
	const v = Number(process.env[k]);
	return Number.isFinite(v) && v > 0 ? v : d;
};
const WARN_MB = () => envMb("PI_MEM_WARN_MB", 2000);
const CRIT_MB = () => envMb("PI_MEM_CRIT_MB", 3000);
const GROW_WARN_MB = () => envMb("PI_MEM_GROW_WARN_MB", 800);
const GROW_CRIT_MB = () => envMb("PI_MEM_GROW_CRIT_MB", 1600);
const TREND_WARN = () => envMb("PI_MEM_TREND_MB_PER_MIN", 25);
const PROC_WARN = () => envMb("PI_MEM_PROC_WARN", 8);

export const samples: VitalSample[] = [];
let baseline = 0;
let level: Level = "ok";
let lastNag = 0;
let onChange: ((level: Level, text: string) => void) | undefined;

const mb = (bytes: number) => Math.round(bytes / 1048576);

export function fmt(m: number): string {
	return m >= 1024 ? `${(m / 1024).toFixed(1)}G` : `${m}M`;
}

/** Live child processes from the event loop's active handles. */
export function liveProcs(): number {
	try {
		const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
		return handles.filter((h) =>
			/ChildProcess|Process/i.test((h as { constructor?: { name?: string } }).constructor?.name ?? ""),
		).length;
	} catch {
		return 0;
	}
}

function sample(): VitalSample {
	const u = process.memoryUsage();
	return { t: Date.now(), rss: mb(u.rss), heap: mb(u.heapUsed), procs: liveProcs() };
}

// The lower bound over the window, so one legitimate burst of parallel children
// reads as zero and only a queue that never drains reads as a storm.
export function procFloor(): number {
	if (samples.length < 3) return 0;
	return Math.min(...samples.slice(-3).map((s) => s.procs));
}

/**
 * MB per minute over the retained window; least squares, so one GC dip does
 * not read as a downward trend. A slope needs a baseline in time as well as
 * points: samples crowded into a few milliseconds divide by a near-zero span
 * and report millions of MB/min from ordinary jitter, so below a one-second
 * span there is no trend to report.
 */
export function trend(): number {
	if (samples.length < 4) return 0;
	const t0 = samples[0].t;
	if ((samples.at(-1)?.t ?? t0) - t0 < MIN_SPAN_MS) return 0;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	for (const s of samples) {
		const x = (s.t - t0) / 60_000;
		sx += x;
		sy += s.rss;
		sxx += x * x;
		sxy += x * s.rss;
	}
	const n = samples.length;
	const denom = n * sxx - sx * sx;
	return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

export function current(): VitalSample {
	return samples.at(-1) ?? sample();
}

export function growth(): number {
	// The session baseline is latched by tick(); direct-sample callers (tests)
	// fall back to the first sample so growth is still honest.
	const base = baseline || samples[0]?.rss || 0;
	return Math.max(0, current().rss - base);
}

export function classify(): Level {
	const rss = current().rss;
	const g = growth();
	if (rss >= CRIT_MB() || g >= GROW_CRIT_MB()) return "crit";
	if (rss >= WARN_MB() || g >= GROW_WARN_MB()) return "warn";
	return "ok";
}

/** Minutes until the projected RSS reaches the crit ceiling, or undefined when flat/past. */
export function etaMinutes(): number | undefined {
	const slope = trend();
	if (slope <= 1) return undefined;
	const room = CRIT_MB() - current().rss;
	if (room <= 0) return 0;
	return Math.round(room / slope);
}

export function advice(): string {
	const eta = etaMinutes();
	const c = current();
	const storm = procFloor() >= PROC_WARN();
	if (storm) {
		return `vitals: ${procFloor()} child processes live across the last 3 samples — something is shelling out per item and the session will stall until it drains.`;
	}
	const lines = [
		`vitals: session memory ${fmt(c.rss)} rss (heap ${fmt(c.heap)}), +${fmt(growth())} since session start, ${trend() >= 0 ? "+" : ""}${trend().toFixed(0)}MB/min`,
	];
	if (eta !== undefined && eta <= 120) lines.push(`at this rate it hits ${fmt(CRIT_MB())} in ~${eta} min`);
	lines.push(
		level === "crit"
			? "restart the session or continue it elsewhere — a reload will not give this back"
			: "wrap up long-running work soon",
	);
	return lines.join(" · ");
}

export function resetVitals(): void {
	samples.length = 0;
	baseline = 0;
	level = "ok";
	lastNag = 0;
}

export function setOnVitalsChange(fn: (level: Level, text: string) => void): void {
	onChange = fn;
}

export function vitalsLevel(): Level {
	return level;
}

/** One evaluation pass — exported for the timer and the test seam. */
export function evaluateVitals(): void {
	const next = classify();
	const storm = procFloor() >= PROC_WARN();
	const leaking = next === "ok" && (trend() >= TREND_WARN() || storm);
	if (next !== level) {
		const rising = next === "crit" || (next === "warn" && level === "ok");
		level = next;
		if (rising) {
			lastNag = Date.now();
			onChange?.(next, advice());
			return;
		}
	} else if (level === "crit" && Date.now() - lastNag >= RENAG_MS) {
		lastNag = Date.now();
		onChange?.(level, advice());
		return;
	} else if (leaking && Date.now() - lastNag >= RENAG_MS) {
		lastNag = Date.now();
		onChange?.("warn", advice());
		return;
	}
	onChange?.(level, "");
}

/** One sample cycle — exported for the timer and the test seam. */
export function tick(): void {
	samples.push(sample());
	if (samples.length > WINDOW) samples.shift();
	if (!baseline) baseline = samples[0].rss;
	evaluateVitals();
}

export function createVitalsInlineExtension(): InlineExtension {
	return {
		name: "vitals",
		factory(pi: ExtensionAPI) {
			let timer: ReturnType<typeof setInterval> | undefined;
			let ui: ExtensionContext["ui"] | undefined;
			const STATUS_KEY = "vitals";

			const paint = (lvl: Level, text: string) => {
				const badge = lvl === "crit" ? "!!" : lvl === "warn" ? "!" : "";
				ui?.setStatus?.(
					STATUS_KEY,
					text
						? `vitals ${badge} ${fmt(current().rss)} · ${text.split(" · ").slice(1).join(" · ")}`
						: `vitals ${fmt(current().rss)}`,
				);
			};

			setOnVitalsChange((lvl, text) => {
				if (text) {
					ui?.notify?.(text, lvl === "crit" ? "error" : "warning");
					paint(lvl, text);
				} else {
					paint(lvl, "");
				}
			});

			pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
				ui = ctx?.ui;
				resetVitals();
				tick(); // baseline
				timer = setInterval(tick, SAMPLE_MS);
				timer.unref?.();
			});

			pi.on("session_shutdown", () => {
				if (timer) clearInterval(timer);
				timer = undefined;
				ui?.setStatus?.(STATUS_KEY, undefined);
				ui = undefined;
			});

			// Health surfaced to /doctor: PASS/ok, DIRTY/warn, FAIL/crit.
			pi.registerHealthCheck({
				name: "vitals:memory",
				description: "Session memory watchdog — RSS ceiling, growth, trend, child-process storm",
				run() {
					const lvl = vitalsLevel();
					if (lvl === "crit") return { status: "FAIL", detail: advice() };
					if (lvl === "warn") return { status: "DIRTY", detail: advice() };
					return { status: "PASS", detail: `session at ${fmt(current().rss)} rss` };
				},
			});
		},
	};
}
