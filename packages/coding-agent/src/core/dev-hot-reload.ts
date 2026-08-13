/**
 * dev-hot-reload — watches pi resource directories (extensions, skills,
 * prompts, themes) for changes and fires a debounced reload callback.
 *
 * Designed for development: edit an extension file, pi reloads extensions,
 * skills, prompts, themes, and context files without restarting the session.
 *
 * The watcher is intentionally conservative:
 *   - one `fs.watch` per existing directory (skips dirs that do not exist);
 *   - events are debounced so a burst of saves triggers a single reload;
 *   - the caller decides whether to act (it should skip while streaming or
 *     compacting and re-arm on the next idle tick);
 *   - `stop()` closes every watcher. Safe to call twice.
 *
 * Not a generic file watcher: it only reports "something in a watched dir
 * changed", not which file. The caller runs a full resource reload anyway.
 */
import type { FSWatcher } from "node:fs";
import { closeWatcher, watchWithErrorHandler } from "../utils/fs-watch.ts";

export interface HotReloadEvent {
	/** Always "reload". Kept as a discriminated tag for future event types. */
	type: "reload";
	/** Best-effort path from the watcher event that triggered the reload (may be undefined). */
	path?: string;
}

export interface StartHotReloadOptions {
	/** Directories to watch for changes. Non-existent dirs are skipped silently. */
	watchDirs: string[];
	/** Called (debounced) after a burst of file changes. */
	onChange: (event: HotReloadEvent) => void;
	/** Debounce window in ms. Default 300. */
	debounceMs?: number;
}

interface Watch {
	dir: string;
	watcher: FSWatcher | null;
}

export function startHotReload(opts: StartHotReloadOptions): { stop(): void } {
	const debounceMs = opts.debounceMs ?? 300;
	const watches: Watch[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const fire = (path?: string) => {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			if (!stopped) opts.onChange({ type: "reload", path });
		}, debounceMs);
	};

	for (const dir of opts.watchDirs) {
		// Returns null when the dir does not exist or is not watchable, and
		// swallows later watcher errors (e.g. dir deleted mid-session) — the
		// caller can restart the session to re-arm.
		const watcher = watchWithErrorHandler(
			dir,
			(_event, filename) => fire(filename ? `${dir}/${filename}` : dir),
			() => {},
		);
		watches.push({ dir, watcher });
	}

	const stop = () => {
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		for (const w of watches) closeWatcher(w.watcher);
		watches.length = 0;
	};

	return { stop };
}
