# Changelog

## Unreleased

### Changed
- Page select attempts a native `loadAsync()` rejection again, up to 3 attempts. No attempt starts
  45 s or more after the request began. A cold heavy page can outlast one native load (the
  2026-10-20 failures took about ten seconds). Cancellations, bridge failures and the switch itself
  are never retried. A retried load's receipt carries `loadAttempts` and `loadErrors`.
- The daemon connects one file per CPU core, minus one (31 on a 32-core machine). It used to stop at
  4 files on every machine. `FIGMA_ULTIMATE_MAX_FILES` sets the number by hand; a machine with four
  cores or fewer connects fewer files than before unless it is set. The limits on simultaneous
  handshakes and saved reconnect credentials grow with the file limit. A refused window reads
  "File limit reached: N files at once on this computer. Close the plugin in another file, then
  retry." in place of "Worker capacity exceeded".

### Fixed
- The plugin window's attention panel lists only its own file's held items, under the file's name,
  and names the other files that hold the rest. It used to offer **Release after review** for every
  file's items, and the daemon refused each one that belonged to another file.

## 3.0.0 — 2026-10-20

First release packaged on its own as **figma-cli-ultimate**.

### Added
- `figma-ultimate` CLI: `setup` (build, start, automatic start, plugin registration, pairing),
  `doctor`, `status`, `start`/`stop`/`restart`, `autostart`, `register`, `approve`, `pair`,
  `uninstall`, and file commands (`files`, `info`, `pages`, `find`, `children`, `tree`, `export`,
  `send`, `layout`, `cancel`) with `--file NAME|KEY`.
- Agent skills for Claude Code and Codex in `skills/`: **figma-ultimate** (files, reading, building
  with `layout` and `send`, verifying, the failure contract, highways) and **figma-ultimate-setup**
  (`doctor`, first-time setup, pairing, what needs the user's OK).
- `figma-ultimate skills install [--claude] [--codex] [--user|--project] [--force]` copies them into
  `~/.claude/skills` and `~/.agents/skills` (default) or the current folder's `.claude/skills` and
  `.agents/skills`. Running it again updates untouched copies and leaves edited ones alone unless
  `--force`.
- CLI errors end with the outcome and request id (`[kind] · outcome: … · request: …`), so a caller
  knows whether it may retry.
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
- `setup` and `doctor` name the folder an earlier version still runs from and say how to upgrade it
  there. `setup` from a clone without the `figma-ultimate` command says how to add it
  (`npm install -g .`), and `bin/` is checked out with LF so that command leaves the clone unmodified.
- The README explains why pairing exists, the first-time **Show details → Connect this computer**
  click, and what happens on later days (automatic start, reopening the plugin per file).

### Removed
- The original figma-cli commands and modes (`render`, `eval`, tokens, blocks, shadcn, extract,
  motion, Yolo and Browser modes, voice plugin) with their docs and tests.

### Upgrading from an earlier version of this bridge
Install, then run `figma-ultimate setup`. It turns off the earlier automatic start, stops the earlier
daemon when idle, and moves pairings and reservations. Reopen the plugin in each file and pair once.
