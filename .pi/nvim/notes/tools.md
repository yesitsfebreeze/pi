# How to use the nvim tooling (pi ↔ nvim)

The rule: when nvim is connected, **file work happens in nvim**. The standard
tools (read/edit/write/grep/find/ls) already forward through nvim's buffers, so
the user sees every change live. The nvim-native tools below go further — they
drive nvim's own search, LSP, and quickfix machinery.

## Tool map — what to reach for

| Job | Tool | Notes |
|---|---|---|
| See the whole session | `nvim_state` | brief = cheap every-turn snapshot; full = every window, folds, marks, diagnostics |
| Read a file / buffer | `nvim_read_buf` | any buffer, line ranges, line numbers. (or `read` — forwarded through nvim) |
| Single unique replace | `nvim_find_replace` | one exact string in one buffer; rejects multi-match — add context to make it unique |
| **Multi-file replace** | `nvim_find_replace_all` | vimgrep → quickfix → `:cdo s///g`. **Always dry-run first** (`apply=false`), then `apply=true`. Results land in the quickfix list |
| Project search (grep) | `nvim_search` | vimgrep into quickfix; `literal=true` for plain text; `glob` filters (e.g. `src/**/*.ts`) |
| Find files | `nvim_find_files` | globpath — respects the user's wildignore |
| Open buffers | `buffers` | bufnr, filetype, modified status |
| Keystrokes / drive UI | `nvim_keys` | `<CR>`, `<Esc>` auto-prepended; triggers mappings |
| **Show work in nvim** | `nvim_reveal` | switch window to a file, jump cursor to line/col, center (`zz`), optional split. **Edits auto-reveal the changed line** (edit op + nvim_find_replace) |
| LSP rename | `lsp_rename` | LSP textDocument/rename across files; writes touched buffers |
| LSP code actions | `lsp_code_action` | list (no `action`) or apply by index/title; quickfixes need diagnostics context |
| Format | `nvim_format` | conform first (formatters_by_ft), LSP fallback |
| Markdown tables | `nvim_table_realign` | vim-table-mode autoload; no-op if line not in a table |
| Ex commands | `nvim_exec` | `split`, `vsplit`, `copen`, `bd`, tabs… |
| Raw Lua | `nvim_lua` | read state, run snippets; JSON-encode results yourself |
| Terminal buffer | `nvim_terminal_send` | drive a shell/sibling agent running in a nvim terminal |
| LSP | `lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover` | positions are 0-indexed line/col; defaults to cursor |
| Treesitter | `ts_query` | `(function_declaration) @fn` style queries |
| Inspect config | `nvim_config` | keymaps, options, lsp, plugins, search_tools |
| Persist knowledge | `nvim_learn` | `audit` sifts config + probes runnability + regenerates notes; `diff` config changes; `note_read`/`note_write` |

## The quickfix flow (the unification)

`nvim_search` and `nvim_find_replace_all` put every match in nvim's **quickfix
list** — the same list the user's telescope multiselect (`<leader>fg` →
`<Tab>` marks → `<CR>` sends to quickfix) feeds. Open it with
`nvim_exec { command: "copen" }` (or tell the user `:copen`). From there:
`nvim_keys` can jump match-to-match (`:cn`/`:cp` or `<leader>` maps), and
`nvim_find_replace_all apply=true` edits exactly the listed lines via `:cdo`.

## Search semantics (updated 2026-08-14)

- Default is **vim regex** (groups `\(...\)`, replacement `\1`, `&` = whole
  match). For plain text pass `literal=true` — the tool switches to very-nomagic
  (`\V`) so metachars are inert.
- The `path` param takes a **directory or a single file** — a file path is
  searched directly (no `/**` appended, which would match nothing).
- A `glob` is folded into the vimgrep target (`path/**/<glob>`, or
  `path/<glob>` when it spans dirs), so vimgrep skips non-matching files and
  binaries itself instead of grepping everything and filtering in Lua.
- vimgrep respects `wildignore` and doesn't follow symlinks; the user's config
  may not exclude `dist/`/`node_modules/` — use the `glob` param when searching
  a built tree.
- Interactive pickers (telescope `<leader>fg`/`<leader>ff`/`<leader>fb`,
  multiselect → quickfix) are for the **user**. Drive them with `nvim_keys` when
  the user asks; don't expect to capture their output programmatically — use
  `nvim_search`/`nvim_find_files` for that.

## User's setup (from nvim_learn notes)

- Leader `<space>`; telescope: `<leader>ff` files, `<leader>fg` live grep,
  `<leader>fb` buffers; `<leader>e` oil explorer; `<leader>bd` delete buffer.
- LSP maps on attach: `gd` definition, `gI` implementation, `<leader>rn` rename,
  `<leader>ca` code action.
- Shell in the `bash` tool is **nushell**, not bash (see gotchas.md).
