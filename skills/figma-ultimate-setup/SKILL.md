---
name: figma-ultimate-setup
description: Install, connect, check and troubleshoot the figma-cli-ultimate bridge between AI agents and Figma Desktop (the figma-ultimate command, its daemon on port 3049 and its Figma plugin). Use when figma-ultimate is not installed or not set up, when the user asks to connect Figma, pair, register the plugin, update or check the bridge, or when a figma-ultimate command fails with daemon-down, plugin-offline, build-mismatch, ambiguous-file or worker-uncertain.
---

# figma-ultimate setup and troubleshooting

## Start with doctor

```bash
figma-ultimate doctor
```

It checks Node.js, the plugin build, an earlier installation, the bridge, automatic start (Windows),
the plugin's registration in Figma and the connected files. Every problem line is followed by
`→ <fix>`. Work through the fixes from the top, run `doctor` again, and stop when it exits 0.
`figma-ultimate status` is the one-line version. `doctor`, `status` and `files` are always safe.

## Ask the user first

The bridge is shared by every agent and file on this computer. Get the user's OK before
`restart`, `stop`, `uninstall`, `autostart on|off`, `register --figma-settings`, installing or
updating the package, closing or reopening the plugin, and any change inside
`~/.figma-cli-ultimate`. Never kill Figma or node processes, and never work around a refused restart
(it refuses while work is running or held). `figma-ultimate start` only starts a bridge that is not
running, so it is fine when `doctor` asks for it.

## First-time setup

1. **Install** (if `figma-ultimate` is not found; needs Node.js 20+ and Git). Ask, then run:
   `npm install -g github:camilogo1200/figma-cli-improvement`. In a clone of this repository, run
   `npm ci` and `npm install -g .` there instead: that links the command to the clone (without it,
   use `node bin/figma-ultimate.mjs <command>` from the clone). An earlier version of the bridge
   (port 3456) is upgraded the same way in its own clone, after `git pull`.
2. **Set up:** `figma-ultimate setup`. It builds, starts the bridge on `127.0.0.1:3049`, turns on
   automatic start at sign-in (Windows; `--no-autostart` skips it) and checks the plugin's
   registration. From a shell the user cannot type into, add `--no-wait`; the pairing approval below
   then happens in the user's own terminal.
3. **Register the plugin** (once per computer; you cannot click in Figma, so give the user the steps):
   Figma Desktop → **Plugins → Development → Import plugin from manifest…** → the `manifest.json`
   path that setup printed (also copied to the clipboard). Alternative, only with Figma closed and
   the user's OK: `figma-ultimate register --figma-settings` (edits Figma's own settings file and
   keeps a backup).
4. **Open the plugin:** in a design file, **Plugins → Development → figma-cli-ultimate**. It opens as
   a small banner in the bottom-left corner. It must stay open; minimize it rather than closing it.
5. **Pair once:** the banner says *Connect this computer*; the user clicks **Show details**, then
   **Connect this computer**, and the plugin shows a six-digit number. The user approves it where the
   same number is shown: in the terminal running `figma-ultimate setup` or `figma-ultimate approve`
   (press Y), or in the Windows dialog. The user compares the numbers, so never answer that prompt
   yourself. Manual fallback: `figma-ultimate pair` prints a two-minute code to paste under **Show
   details → Advanced pairing & setup**. If the user asks why: the plugin runs in Figma's sandbox and
   cannot read the bridge's key file, so it gets its own key once; without it, any program on the
   computer could pose as a Figma file.
   After pairing, the bridge starts at sign-in (Windows) and the plugin connects by itself when the
   user opens it in a file; Figma cannot open it for them.
6. **Check:** `figma-ultimate doctor`, then `figma-ultimate files`.

## When a command fails

| Error or doctor line | Next step |
|---|---|
| `figma-ultimate` not found | install (step 1), with the user's OK |
| `daemon-down`, "Bridge: not running" | `figma-ultimate start` |
| `build-mismatch`, "running an older build" | ask, then `figma-ultimate restart`; then the user reopens the plugin in each open file |
| "port 3049 is used by another program" | tell the user; do not stop that program |
| `plugin-offline`, "Connected files: none" | the user opens the plugin in the file (step 4) |
| "Plugin in Figma: not registered" or "registered from another folder" | import the manifest again (step 3) |
| "Previous version" | `figma-ultimate setup` moves pairings and turns off the old automatic start. When the line names another folder, that folder is upgraded instead (ask first): `git pull`, `npm ci`, `npm install -g .`, `figma-ultimate setup` there |
| "Automatic start: off" | optional: ask, then `figma-ultimate autostart on` |
| `ambiguous-file` | add `--file "<name part>"` or `--file <fileKey>` (see `figma-ultimate files`) |
| `worker-uncertain`, `needsReview: true` | work is held for review. Not a setup problem: restarting does not clear it. The user reviews it in the plugin (**Show details**, attention panel, **Release after review**) |

## Update

The user runs the install command again (in a clone: `git pull`, then `npm ci`), then
`figma-ultimate setup`. A new build restarts the bridge; then reopen the plugin in each open file
(it reports a build mismatch until then). Refresh the agent skills with `figma-ultimate skills install`.

## Other systems

Automatic start is Windows-only. On macOS (untested) or Linux, run `figma-ultimate start` after
signing in. The browser version of Figma cannot reach the bridge; Figma Desktop is required.
