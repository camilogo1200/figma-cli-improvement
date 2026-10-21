# Security Policy

## Reporting a vulnerability

Report privately, not through the public issue tracker: use
[GitHub private vulnerability reporting](https://github.com/camilogo1200/figma-cli-improvement/security/advisories/new).
If that link is not available, open an issue that asks for a private contact, without details.

Useful in a report: what you did, what happened, the version (`figma-ultimate version`), your OS and
your Figma Desktop version. Please allow time for a fix before publishing. Credit in the release
notes if you want it.

## Supported versions

Fixes go into the latest release on the default branch. Older versions are not backported.

## What figma-cli-ultimate does on your machine

This is the section to point at when someone asks before approving the tool.

### The daemon

- `src/daemon.js` listens on **127.0.0.1:3049** only (the lobby) and on one OS-assigned loopback port
  per open highway. Nothing listens on other interfaces.
- Every HTTP request needs the daemon token from `~/.figma-cli-ultimate/.daemon-token` (created with
  mode 600) and the exact build fingerprint. A highway port accepts only its own 32-byte ticket.
- It **never evaluates code**. It accepts structured JSON commands (`create`, `update`, `find`, …)
  that the plugin interprets against the Figma Plugin API. `eval` and `render` requests are refused.
- It exits after an hour without activity unless the companion restarts it.

### The plugin

- Runs only after you start it from **Plugins → Development** in a file. It cannot start itself.
- Connects only to the local daemon. Its manifest declares network access because highway ports are
  assigned at runtime; the window dials `127.0.0.1` only.
- A plugin window becomes a worker only after this computer is **paired**: you approve a six-digit
  number in the terminal or in a Windows dialog, or paste a two-minute code. The daemon stores only a
  hash of the pairing credential. **Connection settings → Forget this computer** revokes it.
- It reads the private plugin API's file key to make sure each command reaches the file it names.
- Rollback removes only nodes the job itself created, never pre-existing ones.

### Setup

- `figma-ultimate setup` writes `~/.figma-cli-ultimate`, starts the daemon, and on Windows adds one
  shortcut to your Startup folder (**Figma CLI Ultimate**) that runs `bridge/start-companion.ps1`
  hidden at sign-in. `figma-ultimate autostart off` removes it.
- With `--register-figma` (or `register --figma-settings`) it edits Figma Desktop's `settings.json`
  to register the plugin, only while Figma is closed, after saving a timestamped backup next to it.
  Without that flag it never writes Figma's files.
- When upgrading an earlier installation of this bridge from the same folder, it turns off that
  installation's automatic start, asks its idle daemon to stop and copies its pairings and journal.
  It never kills a process by PID.

### Data

- No telemetry, analytics or outbound requests. Nothing leaves the machine.
- No Figma API key or account token is involved.
- The console shows where work happens and how much came back, never the contents of query results
  or images.

## Scope

In scope: the daemon, the plugin, the CLI and the companion in this repository. Out of scope: Figma
Desktop itself, and the original figma-cli (report those to their maintainers).
