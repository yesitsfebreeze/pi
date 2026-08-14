# Core Inline Extensions

Pi ships a set of features that are built as extensions but are not installed
from disk. They are *inline extensions*: factory functions compiled into the
binary that the resource loader instantiates on every session, before any
user-provided extension runs.

They use the same `ExtensionAPI` as a user extension — same events, same
`pi.registerTool()` / `pi.registerCommand()` / `pi.registerHealthCheck()`. The
only difference is where they come from. Anything in this document is
something you could have written yourself as a `.pi/extensions/*.ts` file.

## How they load

`getCoreInlineExtensions()` in `src/core/core-inline-extensions.ts` returns the
list. `DefaultResourceLoader` prepends it to any inline factories the embedder
passed in:

```typescript
this.extensionFactories = options.noCoreInlineExtensions
  ? (options.extensionFactories ?? [])
  : [...getCoreInlineExtensions(), ...(options.extensionFactories ?? [])];
```

Consequences:

- **Always on.** There is no settings flag to disable an individual core
  inline extension. `noCoreInlineExtensions` exists for loader tests that need
  to assert exact factory counts, not as a user-facing switch.
- **They load first.** Core inline extensions are instantiated before
  disk-discovered extensions, so a user extension can observe or override what
  they registered.
- **They load before project trust.** Inline factories do not come from the
  project directory, so they are not gated on `.pi/` trust the way
  `.pi/extensions/*.ts` are.

An inline extension is either a bare factory or a named record:

```typescript
export type InlineExtension =
  | ExtensionFactory
  | {
      /** Display name shown as `<inline:name>` in the startup Extensions list. */
      name: string;
      factory: ExtensionFactory;
      /** Omit this extension from the startup Extensions list. */
      hidden?: boolean;
    };
```

`hidden: true` keeps an extension out of the startup Extensions list. It does
not change behavior — hidden extensions are loaded and live like any other.
It is used for the ones with no user-facing surface (`file-awareness`,
`issue-reporter`, `nvim-surface`).

## The list

In load order. "Hidden" means it does not appear in the startup Extensions
list.

| # | Name | Tools | Commands | What it does |
|---|------|-------|----------|--------------|
| 1 | `file-awareness` *(hidden)* | — | — | Stamps the mtime of every file the `read` tool reads; on `before_agent_start`, injects a warning listing files that changed on disk since the agent last read them. |
| 2 | `persona` | — | `/persona` | Loads a persona (agent identity) and injects it into the system prompt each turn. Sets the `persona` status key. |
| 3 | `model-ledger` | — | `/model-ledger` | Records per-model cost/latency observations and classifies models by role against the model registry. |
| 4 | `rigor` | `rigor` | `/rigor` | Discovers the checks the repo already carries (package scripts, Makefile/justfile targets, cargo/go/pytest markers, `probe.sh`) into `.pi/rigor/checks.json` and runs them as a post-pass. |
| 5 | `simplify` | `simplify` | `/simplify` | Post-change follow-up: dispatches check, test, and persona-review steps to crew sub-agents, each exactly once. Failing steps send the agent back to its change. |
| 6 | `forest` | `forest_dispatch`, `forest_cleanup` | — | Isolated git worktrees under `.pi/trees/`. Auto-sweeps trees whose branch is merged. Latches a write scope at `session_start` and blocks writes outside it. |
| 7 | `layers` | `layer_new`, `layer_write`, `layer_edit`, `layer_read`, `layer_rm`, `layer_diff`, `layer_log`, `layer_list`, `layer_test`, `layer_merge`, `layer_discard` | `/layers` | Develop-on-refs: a layer is a branch under `refs/layers/<name>` forked from HEAD, written without a worktree, with provenance trailers on every commit. `layer_test` materializes one ephemeral worktree to validate before merge. |
| 8 | `launch` | `launch` | `/launch` | Background job manager — dev servers, watchers, daemons in their own process groups, with a ring buffer and log file per job. Killed with the session. Registers the `launch:jobs` health check and the `launch` status key. |
| 9 | `until` | `until` | `/until`, `/pace` | Loop surface: goal loops (armed by a trigger word in your message, with a confirm prompt), scheduled `every <interval>` loops, and timeboxed pace loops. Sets the `until`, `loop`, and `pace` status keys. |
| 10 | `issue-reporter` *(hidden)* | `record_stall` | `/issue` | Files GitHub issues. Also auto-reports errors from non-builtin tools. |
| 11 | `memory` | `kern_ingest`, `kern_query`, `kern_link`, `kern_forget`, `kern_health` | `/ontology` | Knowledge graph over the `kern` CLI, plus an ontology digest at `.pi/ontology/digest.md`. Fail-open: with no `kern` on PATH the tools return clear errors rather than breaking the session. |
| 12 | `crew` | `crew`, `crew_send`, `crew_recv`, `crew_scope`, `crew_list` | `/crew`, `/discover` | Sub-agent dispatch against role profiles (`src/core/crew/profiles/*.md`), plus the walkie-talkie channel — a maildir outside the repo that lets dispatched agents steer and be steered. Picks models per role via `model-ledger`. |
| 13 | `pi-backup` | — | — | Snapshots session state around tool execution so a bad edit can be recovered. |
| 14 | `init` | — | `/init` | Generates a project context file for the current repo. |
| 15 | `gantt` | `gantt` | `/gantt` | File-per-ticket board at `.pi/gantt/`; the gantt/cursor/decisions views are computed at read time and never written. `/gantt work` fans research tickets out to crew sub-agents. Inert when `.pi/gantt/` is absent. |
| 16 | `crawl` | `crawl`, `crawl_score`, `crawl_rescore`, `crawl_export`, `crawl_research`, `crawl_list`, `crawl_topics`, `crawl_status` | — | Web research and topic scoring into a local store at `.pi/crawl/`. No external CLI. |
| 17 | `recipes` | `recipes` | — | Executable knowledge base — searchable, runnable recorded procedures. |
| 18 | `interact` | `questionnaire`, `ask` | — | Lets the model ask you structured questions mid-turn through the TUI. |
| 19 | `nvim-surface` *(hidden)* | — | — | When nvim is connected, injects a live snapshot of the editor surface (buffers, windows, cursor, diagnostics) at turn start, raced against a short timeout so a stuck nvim never blocks the turn. |

### nvim tools are registered separately

The `nvim-surface` inline extension only injects context. The nvim tools
themselves — `nvim_state`, `nvim_read_buf`, `buffers`, `nvim_search`,
`nvim_find_files`, `nvim_find_replace`, `nvim_find_replace_all`, `nvim_keys`, `nvim_terminal_send`,
`nvim_highlight`, `nvim_virtual_text`, `nvim_config`, and the LSP tools
`lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_diagnostics`,
`ts_query` — are registered by `createNvimToolDefinitions()` from `main.ts`
and `interactive-mode.ts`, and only when an nvim socket client actually
connects. No connection, no tools.

## Features wired outside the inline list

Three core features predate or sidestep the inline-extension list.

| Feature | Wired in | Surface |
|---------|----------|---------|
| `doctor` | `sdk.ts` (`createDoctorProbeToolDefinition`) + `interactive-mode.ts` for the command | `doctor_probe` tool, `/doctor` command |
| `tools` meta-tool | `agent-session.ts` | `tools` tool (list/enable); restores anything the band deferred |
| Tool band | `tools/band.ts`, `extensions/loader.ts` | No tools — every extension-registered tool is stamped `rare` at registration |
| Search guard | `search-guard.ts` | No tools — a `tool_call` veto on unbounded `find`/`grep -r` |
| Compaction / history-slim | `agent-session.ts`, `sdk.ts` | No tools — lifecycle only |

### The tool band (cold by default)

Every registered tool costs its schema on **every** request. The core inline
extensions register ~35 tools; most are idle in any given session, and an
installed extension (an MCP adapter especially) can add a server's entire tool
list on top. So `createExtensionApi`'s `registerTool` — the one choke point
every extension goes through, at load time and from lifecycle handlers alike —
stamps `rare: true` on everything except the hot set in `tools/band.ts`
(`bash`, `read`, `write`, `edit`, `grep`, `find`, `tools`, `ask`, `crew`).

A deferred tool is not disabled. Its schema is withheld from the request, and
`buildSystemPrompt` lists it under **Deferred tools** as `name — one-liner`
(~15 tokens against a few hundred for a schema). The model restores it with a
real tool call:

```
tools({ action: "on", names: ["gantt"] })
```

after which the tool is directly callable for the rest of the session. Measured
on the current surface: ~17KB of schema withheld, ~2.5KB of listing kept —
about 4,800 tokens off every request.

A deferred tool is listed by its `promptSnippet`, never its description: a tool
that omits the snippet has opted out of the Available-tools section, and the
band lists it by name alone rather than smuggling its description into the
prompt. Give every tool a snippet — that one line is what makes deferral safe.

Opting a tool back onto the hot surface is `rare: false` in its definition —
the escape hatch for a tool an SDK embedder needs callable without a restore.
Naming a tool in an explicit allowlist (`pi.query({ tools: [...] })`) also
counts as a restore.
`PI_BAND_OFF=1` disables the band process-wide (A/B measurement, or a session
that wants everything up front).

### Where per-turn context goes

`cache_control` marks the system prompt, so anything appended to it in
`before_agent_start` moves the cache breakpoint and rewrites the whole cached
prefix — system prompt, every tool schema, the entire conversation — at write
price instead of reading it at ~10%.

Extensions with per-turn context (file-awareness, until, rigor, memory) use
`createVolatileChannel()` from `context-injection.ts` instead. It returns a
`{ message }` result — a custom message that lands *after* the breakpoint and
leaves the cached prefix byte-identical — and it is change-gated, so an
unchanged block is not re-sent. Only session-stable context (the persona block)
still goes in the system prompt.

`doctor` is the one that reaches across everything else: it runs its own
probes (git state, walkie-talkie bus health, log rotation, MCP cache schema,
package test status) *and* iterates every installed extension, running any
health check registered via `pi.registerHealthCheck()`. `launch:jobs` is the
core inline extension that registers one:

```typescript
pi.registerHealthCheck({
  name: "launch:jobs",
  description: "Background job health — flags failed launch jobs",
  run() {
    const all = [...mgr.jobs.values()];
    if (all.length === 0) return { status: "SKIP", detail: "no background jobs" };
    const failed = all.filter((j) => j.status === "failed");
    if (failed.length > 0) {
      return { status: "DIRTY", detail: `${failed.length} failed job(s): ...` };
    }
    return { status: "PASS", detail: `${all.length} job(s), none failed` };
  },
});
```

Any extension — inline or yours — can register one the same way, and it shows
up in the `/doctor` table.

## Cross-feature dependencies

Most of these are standalone. The ones that are not:

```
simplify  ──► crew ──► model-ledger (role → model), walkie-talkie channel
gantt     ──► crew (fan out research tickets), walkie-talkie (doing/leave scope)
forest    ──► crew (write-scope enforcement for dispatched agents)
doctor    ──► every extension (registerHealthCheck)
persona, launch, until ──► TUI status line (ui.setStatus)
crew      ──► TUI session tree
```

Everything else — `file-awareness`, `model-ledger`, `rigor`, `layers`,
`issue-reporter`, `memory`, `pi-backup`, `init`, `crawl`, `recipes`,
`interact`, `nvim-surface` — has no dependency on another core inline
extension.

## Writing your own

Nothing here is privileged. To build the same kind of thing as a normal
extension, see [extensions.md](extensions.md) — the events, the
`ExtensionAPI` methods, and the tool/command registration are identical. The
core inline extensions in `src/core/` are the largest worked examples
available.
