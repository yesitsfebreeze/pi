/**
 * Shared edit-tracking for tool_call events — one containment policy for rigor
 * (touched sections) and simplify (changed files). The containment check goes
 * through `getCwdRelativePath`, which handles the Windows-separator case a bare
 * `rel.startsWith("..")` misses.
 */
import { getCwdRelativePath } from "../utils/paths.ts";

/** Tools whose tool_call input carries a file path we track for edit-scope features. */
export const EDIT_TOOLS = new Set(["edit", "write", "str_replace_editor", "create"]);

/**
 * Relative (to cwd) path of the file a tool_call event edited, or null when the
 * call is not an edit or the path escapes the cwd.
 */
export function editedRelPath(event: { input?: { path?: unknown; file_path?: unknown } }, cwd: string): string | null {
	const p = event?.input?.path ?? event?.input?.file_path;
	if (typeof p !== "string") return null;
	return getCwdRelativePath(p, cwd) ?? null;
}
