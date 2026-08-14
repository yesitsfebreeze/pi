# Recipes — how to do things in this nvim (audited)

## Search
- Find file: `<leader>ff` (user) · `nvim_find_files` (agent)
- Grep project: `<leader>fg` (user) · `nvim_search` (agent)
- Buffers: `<leader>fb` (user) · `buffers` (agent)
- Multiselect → quickfix: `<Tab>` marks + `<CR>` (user)

## LSP
- Rename symbol: `lsp_rename` (agent) · `grn`/`<leader>rn` (user)
- Code actions: `lsp_code_action` (agent) · `gra`/`<leader>ca` (user)
- Diagnostics: `lsp_diagnostics` (agent); jump `]d`/`[d` (user)
- Definition/refs/hover: `lsp_definition`/`lsp_references`/`lsp_hover` (agent)

## Formatting
- Format buffer: `nvim_format` (agent) · `<leader>cf` (user) — conform (rust, markdown.mdx, markdown, python, lua)

## Markdown tables
- Realign table: `nvim_table_realign` (agent) · `:TableModeRealign` (user)

## Files & buffers
- Explorer: `<leader>e` (oil)
- Delete buffer: `<leader>bd`; previous/next buffer `<S-h>`/`<S-l>`

## Editor
- Move line: `<A-j>`/`<A-k>`; shift+arrow to select (editor-style)
- Save: `<leader>w`; quit: `<leader>q`; clear search: `<Esc>`

## Treesitter
- Query the AST: `ts_query` (agent) — parsers: bash, c, css, json, just, lua, luadoc, markdown, markdown_inline, nu, php, python, query, rust, toml, vim, vimdoc, yaml