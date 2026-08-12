/**
 * Extract a human-readable message from a thrown value.
 *
 * Caught values are `unknown` under `strict` mode; this mirrors the inline
 * `error instanceof Error ? error.message : String(error)` pattern used across
 * the agent runtime so callers don't repeat it.
 */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
