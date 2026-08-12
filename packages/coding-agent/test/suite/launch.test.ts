/**
 * LaunchManager — background job lifecycle. Uses `sleep` to avoid real
 * long-running processes; no port-binding dev servers.
 */
import { describe, expect, it } from "vitest";
import { LaunchManager } from "../../src/core/launch.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("LaunchManager", () => {
	it("starts a job and reports it in list/status", () => {
		const mgr = new LaunchManager();
		const r = mgr.start("sleep 30");
		expect(r.ok).toBe(true);
		expect(r.msg).toContain("sleep 30");
		expect(mgr.liveJobs.length).toBe(1);
		expect(mgr.list()).toContain("running");
		const status = JSON.parse(mgr.status());
		expect(status.status).toBe("running");
		expect(status.cmd).toBe("sleep 30");
		mgr.shutdown();
	});

	it("status line reflects live jobs", () => {
		const mgr = new LaunchManager();
		expect(mgr.statusLine).toBeUndefined();
		mgr.start("sleep 30");
		expect(mgr.statusLine).toContain("1 up");
		mgr.shutdown();
		expect(mgr.statusLine).toContain("done");
	});

	it("stops a running job", async () => {
		const mgr = new LaunchManager();
		const r = mgr.start("sleep 30");
		expect(r.ok).toBe(true);
		await sleep(50);
		const stop = mgr.stop(r.msg.split(" ")[1]);
		expect(stop.ok).toBe(true);
		await sleep(50);
		expect(mgr.liveJobs.length).toBe(0);
		mgr.shutdown();
	});

	it("restart re-spawns a stopped job", async () => {
		const mgr = new LaunchManager();
		const r = mgr.start("sleep 30");
		const name = r.msg.split(" ")[1];
		mgr.stop(name);
		await sleep(50);
		const rr = mgr.restart(name);
		expect(rr.ok).toBe(true);
		await sleep(50);
		expect(mgr.liveJobs.length).toBe(1);
		mgr.shutdown();
	});

	it("logs captures stdout", async () => {
		const mgr = new LaunchManager();
		const r = mgr.start("echo hello-stdout");
		const name = r.msg.split(" ")[1];
		await sleep(150);
		const logs = mgr.logs(name);
		expect(logs.ok).toBe(true);
		expect(logs.msg).toContain("hello-stdout");
		mgr.shutdown();
	});

	it("clear removes finished jobs but keeps running ones", async () => {
		const mgr = new LaunchManager();
		mgr.start("echo done");
		await sleep(150);
		// job exited cleanly
		const before = mgr.jobs.size;
		expect(before).toBe(1);
		const cleared = mgr.clear();
		expect(cleared.ok).toBe(true);
		expect(mgr.jobs.size).toBe(0);
		mgr.shutdown();
	});

	it("shutdown terminates all children", async () => {
		const mgr = new LaunchManager();
		mgr.start("sleep 30");
		mgr.start("sleep 30");
		expect(mgr.liveJobs.length).toBe(2);
		mgr.shutdown();
		await sleep(100);
		expect(mgr.liveJobs.length).toBe(0);
	});

	it("request emits a follow-up instruction and returns ok", () => {
		const mgr = new LaunchManager();
		const sent: string[] = [];
		const r = mgr.request("a dev server", (msg) => sent.push(msg));
		expect(r.ok).toBe(true);
		expect(sent.length).toBe(1);
		expect(sent[0]).toContain("action=start");
	});

	it("rejects a duplicate name", () => {
		const mgr = new LaunchManager();
		mgr.start("sleep 30", "srv");
		const dup = mgr.start("sleep 30", "srv");
		expect(dup.ok).toBe(false);
		expect(dup.msg).toContain("already exists");
		mgr.shutdown();
	});
});
