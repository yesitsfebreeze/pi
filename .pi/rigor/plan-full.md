# Rigor plan — full sweep
Generated 2026-08-14 by rigor scan. Rescan after tooling changes.

Run: `/rigor full` — the whole program, every check discovered.

## Known pitfalls — plan around these
- 2026-08-12 When porting a closure-based bus object (e.g. walkie-talkie's createWalkieTalkie), passing a mutable array as a constructor arg and later reassigning it in the caller's closure does NOT propagate to the object's getter — the object captured the original reference. Pass a getter (() => value) instead of a snapshot, so live mutations (join/leave scope) reflect through the bus. This bit wt.scopes() returning [] forever after a join.
- 2026-08-12 When porting an extension that reads its repo root from a module-level singleton (gantt's store.ts `setGanttRoot`/`dir()`), the inline-extension factory must call `setGanttRoot(root)` on `session_start` (after latching `ctx.cwd`) AND again at the top of every tool `execute` / command `handler` before calling any store function — a tool invoked after a `session_start` on a different cwd would otherwise read the wrong board. The `session_start` latch alone is not enough if the session ever switches cwd; re-asserting in the call path is the safe pattern.
- 2026-08-12 When porting an extension whose storage is a thin shell over an external CLI (crawl over `kern`), shedding the dependency means implementing local file-based storage at a repo-root-relative path (`.pi/crawl/pages/<base64url(url)>.json`) with a module singleton latched on session_start AND re-asserted at the top of every tool execute() — same pitfall as gantt's setGanttRoot. Don't keep a global `~/.local/state` default; pi's convention is repo-local `.pi/<feature>/` (gantt's `.pi/gantt/`, forest's `.pi/trees/`). Derived views (query/score/rescore) must be computed at read time and never written, so recency decay tracks real elapsed time (derive recencyMs from ingestedAt at query time, don't store it).

## Checks (5)
- `npm run test` in `.` — repo:test [test]
- `npm run check` in `.` — repo:check [lint]
- `npm run build` in `.` — repo:build [build]
- `just test` in `.` — repo:just-test [test]
- `just check` in `.` — repo:just-check [test]

## Postpass — leave it cleaner than found
- [ ] every check above green
- [ ] dead code deleted: nothing kept "for later", nothing without a caller
- [ ] no duplicate logic — one authoritative representation
- [ ] diff minimal: no unrequested abstractions, no scaffolding
- [ ] docs updated where behavior changed
