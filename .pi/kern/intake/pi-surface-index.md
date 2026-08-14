# pi surface index (auto-maintained; replaced whole on change)

Tool ask: Ask the user a question inline, below the chat. Unlike `questionnaire`, the user navigates options with arrow keys OR types their own answer directly in the editor with full autocomplete, history and 
Tool bash: Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a tem
Tool crew: Dispatch work to a subagent and carry on. action=start spawns a headless pi in its own process group and returns a handle immediately — it does NOT wait, and you must not wait for it either: pick up t
Tool doctor_probe: Run living integration status probe: checks all pi packages, git state, bus health. Returns a table sorted by status.
Tool find: Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).
Tool gantt: Work the gantt board without the /gantt slash command, so a headless or looping session can drive it. action "work" (default): claim the next ready ticket and RETURN its orchestration brief as the res
Tool grep: Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are tr
Tool hub: Manage the extension hub: register pi packages or skills (local dir, workspace dir, or git url), list them, git-pull sync with hot reload, force reload, enable/disable, and read session memory vitals 
Tool launch: Run and manage long-lived background jobs owned by this session (tests, dev servers, watchers, tailers). action=start takes a concrete command — resolve the request into one first, writing a script if
Tool ls: List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).
Tool mcp: MCP gateway — server status, tool search/describe, auth, and single MCP tool calls. When one request needs several MCP calls with logic between them, use mcpScript. Non-MCP Pi tools should be called d
Tool mcpScript: Run trusted JavaScript that makes multiple MCP tool calls in one request — loop, filter, chain, or fan out between calls. For a single MCP call, search, describe, status check, or auth action, use the
Tool questionnaire: Ask the user one or more questions in a TUI overlay. Brief each question first — `problem` (what is being decided and why it came up), `explanation` (what separates the options) and `recommendation` (
Tool read: Read a file's contents. Text passes through hypa compression, so large files and markdown cost a fraction of the raw bytes. Images return as image blocks. offset is the 1-based line to start at, limit
Tool record_stall: Record a stall, bug, issue, or decision as a GitHub issue. Auto-captures context (branch, recent commits, repo, timestamp) and returns the issue URL. Defaults to the current repo; pass target=oilrig f
Tool rigor: Post-pass verification for this repo. scan discovers checks; run executes full, integration, or fast section tiers. compare validates each revision's committed trusted profile, runs it in an isolated 
Tool run_command: Invoke a slash command from the agent, or list every available command. Markdown-backed commands — prompt templates (e.g. /simplify) and skill commands (/skill:<name>) — are resolved to their expanded
Tool session_ledger: List recent pi sessions from the terminal-session ledger: tty, terminal, session file, age, end reason. Shows which terminal ran which session last.
Tool skill: Load a registered skill: markdown doctrine or a CLI playbook, kept off the tool surface until asked for. Call with no arguments to list what is registered, `name` to load one, `section` for one part o
Tool tools: Activate deferred tools, or rate the tool this session was asked to evaluate. To activate a deferred tool (whose schema is off the surface but listed in the reflex block), call with action="on" and na
Tool forest_cleanup: Clean up git worktrees under .pi/trees: prune stale metadata, list remaining trees, remove specific or all to reclaim disk. Never touches worktrees outside .pi/trees.
Tool forest_dispatch: Create an isolated git worktree under .pi/trees with write-scope, for spawning a sub-agent. Returns the worktree path.
Tool until: The one loop surface — hand it a workload and it works until done, re-dispatching each settled turn until the agent emits [UNTIL: DONE] or hits max iterations. Three ways to say what to loop, all armi
Tool watch: Arm a file watcher over everything this session touched: when any of those files changes on disk, the given prompt is re-dispatched into this session. The agent's own writes are filtered out. Subcomma
Tool crew_list: Who else is working in this directory right now, which scopes each of them is in, and the line each one published about what it is doing. Read it before starting anything that touches shared ground.
Tool crew_recv: Pull anything waiting on the channel for this session right now, instead of waiting for the next settle.
Tool crew_scope: Organise yourself on the channel. A scope is a group address: every session that joins `auth-rewrite` receives mail sent to `auth-rewrite`. Join one per area of work you take on — the package, the fea
Tool crew_send: Say something to a specific peer session, or to a scope you know is working on this. `to` is a session id prefix (first 8 chars) for one session, or a scope name for that group (crew_scope lists them). 
