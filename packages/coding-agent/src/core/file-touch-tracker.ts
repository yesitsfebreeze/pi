/**
 * Tracks file modification times for edit-awareness.
 *
 * The read tool stamps mtimes of every file it successfully reads.
 * On before_agent_start, we compare current mtimes against the stamped
 * ones to detect files changed externally since the agent last read them.
 */
import { statSync } from "node:fs";

export interface FileStamp {
	path: string;
	mtimeMs: number;
}

export class FileTouchTracker {
	private _stamps = new Map<string, number>();

	/** Record that the agent touched (read) a file at its current mtime. */
	stamp(absolutePath: string): void {
		try {
			const stat = statSync(absolutePath);
			this._stamps.set(absolutePath, stat.mtimeMs);
		} catch {
			// File vanished — still record that we attempted to read it
			this._stamps.set(absolutePath, -1);
		}
	}

	/**
	 * Return paths of touched files whose mtime on disk now differs
	 * from the last stamp. These files were changed externally since
	 * the agent last read them.
	 */
	getChangedFiles(): string[] {
		const changed: string[] = [];
		for (const [path, stampedMs] of this._stamps) {
			try {
				const currentMs = statSync(path).mtimeMs;
				if (currentMs !== stampedMs) {
					changed.push(path);
					// Update stamp so we only report once per change
					this._stamps.set(path, currentMs);
				}
			} catch {
				// File deleted since we read it — report as changed
				if (stampedMs >= 0) {
					changed.push(path);
					this._stamps.set(path, -1);
				}
			}
		}
		return changed;
	}

	/** Number of tracked files. */
	get size(): number {
		return this._stamps.size;
	}
}
