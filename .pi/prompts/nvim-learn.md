---
description: Learn/refresh the nvim setup — diff config, read changes, update learned notes, record
argument-hint: "[focus]"
---

Learn the nvim setup and persist it. Follow these steps:

1. Run `nvim_learn diff` to see which config files changed since the last
   session (content-hash based against `.pi/nvim/manifest.json`).
2. Read any new/changed files under `~/.config/nvim/` (plus `init.lua`) with the
   `read` tool to see the actual content. If nvim is connected, `nvim_read_buf`
   also works.
3. Update the learned notes via `nvim_learn note_write` with names:
   `keymaps`, `plugins`, `lsp`, `options`, `gotchas`. Keep each note accurate
   and current — replace stale facts, don't append duplicates.
4. Finish with `nvim_learn record` to mark the current config as seen, so the
   next `diff` is meaningful.

If `$@` is given, focus only on that area (e.g. `keymaps`, `lsp`, `plugins`) and
skip the rest.

Notes on this machine's nvim:
- Shell is nushell, not bash — use `;` not `&&`, `try`/`or` not `||`,
  `out+err>` not `2>&1` when running shell commands.
- Config root: `~/.config/nvim/` (init.lua + lua/config/*.lua + lua/plugins/*.lua).
- Leader is `<space>`; see the keymaps note for the full map.
