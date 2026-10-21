# figma-cli-ultimate

Multi-agent bridge for Figma Desktop: a daemon (lobby on `127.0.0.1:3049`), one private highway port
per agent and file, a Figma plugin that executes structured JSON commands, and the `figma-ultimate`
CLI. README.md is the full documentation; this file is the short version for agents working here.

## Using the bridge (when the user asks for Figma work)

| User says | Do |
|---|---|
| "set it up" / "connect to Figma" | `figma-ultimate setup` (or `node bin/figma-ultimate.mjs setup` from this repo) |
| "is it working?" / something fails | `figma-ultimate doctor`, then follow its arrows |
| "which files are open?" | `figma-ultimate files` |
| "what's on the page" | `figma-ultimate info`, `pages`, `children`, `find <name>`, `tree <id>` |
| "build these screens" | `figma-ultimate layout layout.json` (auto-placed, reserved zone) |
| "run these commands" | `figma-ultimate send commands.json` (array = one batch, ≤128) |
| "screenshot this" | `figma-ultimate export <nodeId> out.png` |
| several files open | add `--file "<name part>"` or `--file <fileKey>` |
| "use it from Claude Code / Codex" | `figma-ultimate skills install` (`--project` for this folder) |

Rules:

1. **There is no `eval` and no `render`.** The original figma-cli's commands are not part of this
   project. Use structured ops: `create`, `update`, `find`, `children`, `tree`, `remove`, `select`,
   `page`, `audit`, `fonts`, `reactions`, `flowStart`, `image`, `exportImage`.
2. Scripts that run long or alongside other agents use a highway: `forFile(fileKey)` from
   `file-client.mjs` (the package's main export) or `openHighway()` from `bridge/fig.mjs`.
3. Create with an explicit `parent` page id, `select: false`, `zoom: false`. Await parents before
   children and created ids before wiring reactions.
4. **Retry only what was reported `not-started`.** Never clean up by name and never replay a section
   after a failure. `uncertain` / held work is for the human: point them at the console's attention
   panel (reconcile or release after review).
5. Never delete existing nodes the user did not ask you to delete.
6. Never restart the daemon, reload the plugin, or edit `~/.figma-cli-ultimate` without the user's
   approval. A restart refuses while work is active; do not force around it.

## Working on this repository

- `npm test` stamps the build and runs every suite (real plugin/UI/daemon sources against mocks; it
  never touches a working daemon, Figma's settings or a document). Keep it green.
- After changing `plugin/ui.html` or a diagram: `npm run docs`, commit PNGs with their sources.
- After changing runtime sources (`src/`, `bridge/`, `plugin/`): `figma-ultimate build`. A running
  daemon refuses clients from a different build (`build-mismatch`) until `figma-ultimate restart`.
- **Never write the token `import (` anywhere in `plugin/code.js`, comments included.** Figma rejects
  the whole plugin source and the window closes.
- Wire limits live in `src/lib/bridge-protocol.js` and are mirrored in `plugin/code.js`; the port is
  `DEFAULT_PORT` there and `DAEMON_PORT` in `plugin/ui.html`. Change both sides together.
- Layout: `bin/` + `cli/` (the CLI), `bridge/` (client, launcher, companion), `src/` (daemon and
  coordinator), `plugin/` (Figma plugin), `docs/` (diagram sources, images, renderer), `tests/`.
- `skills/` holds the agent skills that `figma-ultimate skills install` copies (one folder per skill,
  short SKILL.md, detail in `references/`). When an op, spec field, CLI command or outcome changes,
  update them too; `tests/bridge-setup.test.js` checks their frontmatter and links.
- `cli/previous-version.mjs` and `PREVIOUS_STATE_DIR` in `src/lib/bridge-state.js` are the only places
  that name the pre-3.0 installation; they exist to upgrade it.
