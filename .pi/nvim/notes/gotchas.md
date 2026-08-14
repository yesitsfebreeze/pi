# Gotchas

## Shell is nushell, not bash
The `bash` tool runs nushell. Use `;` not `&&` · `try`/`or` not `||` · `out+err>` not `2>&1`. `ls` has no `-R` (use `glob`); `find` is nushell's built-in (no GNU `-maxdepth`/`-type` flags — use `glob` or `fd`).

## tinted-nvim + custom schemes
tinted-nvim only resolves builtin palettes or schemes passed in `schemes`. `colorscheme.lua` loads every yaml under `~/.local/share/tinted-theming/tinty/custom-schemes/{base16,base24}` and registers each as `<system>-<name>`; otherwise picking a non-builtin scheme aborts with "scheme not defined". Theme switches are driven by `tinty apply`, which writes `~/.local/share/tinted-theming/tinty/current_scheme` (watched live).

## lualine + base16
lualine's "auto" theme collapses base16-* colorschemes to its bundled "base16" theme (requires nvim-base16 → errors). `statusline.lua` instead builds the theme from tinted-nvim's active palette and rebuilds on ColorScheme, with `gruvbox_dark` fallback.

## shift-select state machine
`shift_select` flag in `keymaps.lua` gates editor-style selection. Reset on ModeChanged leaving visual. Uses `nvim_feedkeys` round-trip (`feed()`); don't break that.

## nvim_learn storage
Config hashes live in `.pi/nvim/manifest.json` (sha256 + mtimeMs + size per file). `nvim_learn diff` compares against it; `record` updates it. Learned notes (keymaps, plugins, lsp, options, gotchas) live under `.pi/nvim/`.