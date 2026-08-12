export type HotReloadEvent = { type: "reload"; path: string };

export function startHotReload(onReload: (event: HotReloadEvent) => void, watchDir?: string): { stop(): void } {
	// Stub: hot reload not implemented in this build
	return { stop() {} };
}
