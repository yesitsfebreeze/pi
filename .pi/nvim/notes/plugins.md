# Plugin capability map (lazy.nvim, ~/.local/share/nvim/lazy/)

How the agent can/can't use each installed plugin.

## Directly used by pi tools
- **conform.nvim** — `nvim_format` tool: `conform.format({bufnr, lsp_format="fallback", async=false, quiet=true}, cb)`; with async=false the callback fires synchronously. `list_formatters_to_run(bufnr)` → (formatters, has_lsp). LSP fallback runs when no CLI formatter matches and lsp_format != "never".
- **vim-table-mode** — `nvim_table_realign` tool: calls `vim.fn["tablemode#table#Realign"](line)` (autoload; works without plugin being explicitly loaded since lazy puts it on rtp). Realigns table at a 1-based line via getline/setline — no cursor move needed. No-op when line not in a table. Guard: markdown/markdown.mdx filetypes only.
- **nvim-lspconfig / mason** — LSP client is nvim builtin (`vim.lsp.*`), tools: lsp_diagnostics, lsp_references, lsp_definition, lsp_hover, lsp_rename, lsp_code_action, ts_query.

## Usable via escape hatches (nvim_exec / nvim_lua / nvim_keys)
- **telescope.nvim** — interactive pickers only, NO headless API. `<leader>ff` files, `<leader>fg` live_grep, `<leader>fb` buffers; <Tab>/<S-Tab> multiselect → quickfix. Drive with nvim_keys; nvim_search/nvim_find_files are the headless vimgrep/globpath equivalents.
- **oil.nvim** — file explorer, `<leader>e`. No headless API; nvim_find_files covers file discovery; rename/move via oil = interactive.
- **gitsigns.nvim** — hunks in signcolumn. No tool; bash git covers hunk/stage/blame. Buffer-level hunks could be surfaced via `require("gitsigns").get_hunks()` if ever needed.
- **blink.cmp / friendly-snippets** — completion engine; not drivable headlessly (insert-mode UI). Agent edits via tools; completion is for the human.
- **lualine / tinted-nvim / smear-cursor / nvim-web-devicons / which-key** — pure UI; n/a to agent (nvim_config "plugins" lists them).
- **nvim-autopairs** — insert-mode pairing; n/a (agent writes whole buffers).
- **nvim-treesitter** — ts_query tool uses it; also powers indent/folds. For structural queries beyond ts_query, write Lua via nvim_lua.
- **plenary / telescope-fzf-native** — deps of telescope.

## Key nvim internals learned
- `vim.lsp.buf_request_sync` returns a MAP keyed by client id `{[2]={result=...}}`, NOT a list. Iterate `vim.tbl_keys(results)` sorted. `ipairs` silently returns nothing for a single non-contiguous id (e.g. one LSP client) — this broke references/definition/hover for single-client buffers; fixed all call sites.
- nvim 0.12 `vim.lsp.util.apply_text_edits(edits, bufnr, position_encoding)` — 3rd arg REQUIRED (else "position_encoding: expected string, got nil").
- codeAction context.diagnostics must be LSP-shaped: `{range={start={line,character(utf-16)},["end"]={...}}, severity, code, source, message, tags}`. vim.diagnostic.get returns byte lnum/col; sending those raw makes ts_ls error "Cannot destructure property 'start' of 'diagnostic.range'".
- Position params for non-current buffers need manual offset-encoding handling: `vim.lsp.util.make_position_params()` is hard-wired to current window/buffer. Get encoding via `vim.lsp.get_clients({bufnr})[1].offset_encoding`, convert byte→utf-16 with `vim.str_utfindex(text, byte_col)` — CLAMP byte_col to `#text` first (str_utfindex throws "index out of range" past EOL).
- lsp_* tools' line/col/path params were previously ignored (always current cursor) — fixed to actually target the given buffer/position.
- nvim_get_keymap(mode) has NO buffer arg in 0.12 — buffer-local maps use `vim.api.nvim_buf_get_keymap(bufnr, mode)`.
- Lazy plugins don't define their :Commands until first use — `exists(":Cmd")` is a false negative for lazy-loaded plugins; use `package.searchpath(mod, rtp.."/lua/?")` for load-free runnability checks.

## Gaps left (candidate future tools)
- LSP document/workspace symbols, implementation, type definition, codelens, inlay hints — all available via vim.lsp.*; not yet surfaced as tools.
- gitsigns hunk staging via nvim.
- telescope headless (by design, not possible without a picker API).

---

## Plugins (audited)

Runnable = probe succeeded in the live instance (pcall require / :cmd exists).

## Capability probes
- ✅ `quickfix` — quickfix list
- ✅ `telescope_fzf` — fzf-native sorting for telescope
- ✅ `tinted` — base16 colorscheme + live tinty switching
- ✅ `smear_cursor` — cursor smear (cosmetic)
- ✅ `which_key` — keymap hints
- ✅ `native_lsp` — built-in LSP client
- ✅ `conform` — formatter runner (nvim_format tool, <leader>cf, format-on-save)
- ✅ `lualine` — statusline
- ✅ `blink` — completion engine (insert mode)
- ✅ `oil` — file explorer (<leader>e)
- ✅ `table_mode` — markdown table alignment (nvim_table_realign tool)
- ✅ `gitsigns` — git hunks in the signcolumn
- ✅ `lazy` — plugin manager
- ✅ `treesitter` — syntax trees (ts_query tool, indent, folds)
- ✅ `autopairs` — auto-pairing (insert mode)
- ✅ `telescope` — fuzzy finder (ff/fg/fb/fh pickers; multiselect → quickfix)

## Plugins (lazy)
- loaded `blink.cmp`
- lazy `conform.nvim`
- lazy `friendly-snippets`
- lazy `gitsigns.nvim`
- lazy `lazy.nvim`
- lazy `lualine.nvim`
- lazy `mason-lspconfig.nvim`
- lazy `mason.nvim`
- loaded `nvim-autopairs`
- lazy `nvim-lspconfig`
- loaded `nvim-treesitter`
- loaded `nvim-web-devicons`
- lazy `oil.nvim`
- lazy `plenary.nvim`
- lazy `smear-cursor.nvim`
- lazy `telescope-fzf-native.nvim`
- lazy `telescope.nvim`
- loaded `tinted-nvim`
- lazy `vim-table-mode`
- lazy `which-key.nvim`

## conform formatters_by_ft
- `rust`: rustfmt
- `markdown.mdx`: prettier
- `markdown`: prettier
- `python`: black
- `lua`: stylua

## treesitter parsers: bash, c, css, json, just, lua, luadoc, markdown, markdown_inline, nu, php, python, query, rust, toml, vim, vimdoc, yaml
