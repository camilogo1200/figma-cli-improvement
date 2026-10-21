# Changelog

## 3.0.0 — 2026-10-20

First release packaged on its own as **figma-cli-ultimate**.

### Added
- `figma-ultimate` CLI: `setup` (build, start, automatic start, plugin registration, pairing),
  `doctor`, `status`, `start`/`stop`/`restart`, `autostart`, `register`, `approve`, `pair`,
  `uninstall`, and file commands (`files`, `info`, `pages`, `find`, `children`, `tree`, `export`,
  `send`, `layout`, `cancel`) with `--file NAME|KEY`.
- Pairing approval in the terminal (the Windows dialog remains when no terminal is waiting).
- Optional automatic plugin registration in Figma Desktop's settings (`--register-figma`).
- Package exports: `figma-cli-ultimate` (file-bound client) and `figma-cli-ultimate/client`.
- Install from GitHub: `npm install -g github:camilogo1200/figma-cli-improvement`.
- Highways: one private loopback port per agent and file, turn-taking inside the plugin, holds
  scoped per channel, resume on either end, release after review.
- Worker console: banner start mode, resizable window, close confirmation, Highways tab, canvas map
  with live zones and page sketches, per-highway timeline, reads and snapshots in Activity.

### Changed
- The lobby moved from port 3456 to **3049**, so it no longer clashes with the original figma-cli.
- Settings moved to `~/.figma-cli-ultimate`; environment variables are `FIGMA_ULTIMATE_*`.
- The plugin id is now `figma-cli-ultimate` (register it again and pair once).
- Clients accept a daemon of the same build from any install folder.
- Requires Node.js 20 or newer.
- `update` changes only the fields its spec names. It no longer turns fixed auto-layout axes into hug
  when `w`/`h` are left out, and a text update keeps the node's font, colour and wrapping unless they
  are sent; text fields such as `color` or `size` also apply without `text`.

### Removed
- The original figma-cli commands and modes (`render`, `eval`, tokens, blocks, shadcn, extract,
  motion, Yolo and Browser modes, voice plugin) with their docs and tests.

### Upgrading from an earlier version of this bridge
Install, then run `figma-ultimate setup`. It turns off the earlier automatic start, stops the earlier
daemon when idle, and moves pairings and reservations. Reopen the plugin in each file and pair once.
