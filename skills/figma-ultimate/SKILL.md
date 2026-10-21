---
name: figma-ultimate
description: Read, build, change and screenshot designs in an open Figma Desktop file through the figma-ultimate CLI (the figma-cli-ultimate bridge). Use when the user asks for Figma work such as listing pages or nodes, creating frames, screens or components from structured JSON specs, updating existing nodes, wiring prototype links or exporting a PNG, or mentions figma-ultimate or figma-cli-ultimate. Not the original figma-cli; this bridge has no render or eval.
---

# figma-ultimate

`figma-ultimate` drives Figma Desktop through a local bridge: a daemon on `127.0.0.1:3049` and a
plugin window that stays open in each file. File commands print JSON. The plugin runs **structured
commands only** (`{"op":"create", …}`), never JavaScript.

If a command reports `daemon-down`, `plugin-offline`, `build-mismatch` or that the command is missing,
switch to the **figma-ultimate-setup** skill (start with `figma-ultimate doctor`).

## Never

- Never use the original figma-cli: no `figma-cli render`, `render-batch`, `eval`, `npx figma-use`.
  Their rules (and any AGENTS.md written by figma-cli) do not apply here.
- Never delete or "clean up" nodes the user did not ask you to delete, and never find nodes to remove
  by name.
- Never restart the bridge, reload or close the plugin, or edit `~/.figma-cli-ultimate` without the
  user's OK.

## Workflow

1. **Pick the file.** `figma-ultimate files` lists connected files (`file`, `fileKey`, `page`,
   `pageId`, `busy`, `needsReview`). With more than one, add `--file "<unique part of the name>"` or
   `--file <fileKey>` to every command. `needsReview: true` means writes are blocked: tell the user.
2. **Read before writing.** `info` (current page, selection), `pages` (page ids), `children [prefix]`
   (roots of the visible page, duplicate names), `find <name>` (visible page only, first 100),
   `tree <nodeId>` (4 levels, with sizes). Confirm an id exists before you change it.
3. **Write a JSON file, then run it** (`send` and `layout` take a path, not inline JSON; keep the file
   in a temp folder).
   - New top-level frames or screens: `figma-ultimate layout layout.json` with
     `{"specs":[…], "pageId":"…", "label":"…"}`. Every root needs `w` and `h`; the bridge finds free
     canvas space and reserves it, so nothing lands on existing work.
   - Everything else (children inside an existing frame, updates, pages, prototype links):
     `figma-ultimate send commands.json`, one command object or an array (one batch, at most 128,
     stops at the first failure).
   - Always give an explicit `"parent"` (a page id from `pages`, or a frame id), plus
     `"select": false` and `"zoom": false`, so the user's view and selection stay put.
   - Create parents before children and read the created ids from the result before using them
     (for example in `reactions`).
4. **Verify.** `figma-ultimate export <nodeId> out.png` and look at the image; check sizes with
   `tree <nodeId>`. If `fontFallbacks` appears in a result, the font was missing and Inter was used:
   check names with `{"op":"fonts","query":"…"}`.
5. **Report** the ids and names you created or changed.

Spec fields for `create` and `update`, and every other op: [references/spec.md](references/spec.md).
All CLI commands and Node scripts: [references/commands.md](references/commands.md).

## When something fails

The error line ends with `[kind] · outcome: <outcome>`; a failed batch also prints one result per
item. The outcome decides what you may do:

| Outcome | Do |
|---|---|
| `not-started` | Nothing happened. Fix the cause and send the same request again |
| `rolled-back` | The plugin removed everything it had created. Fix and send again |
| `partial`, `failed`, `uncertain`, `disconnected` | **Stop.** Do not retry, rebuild or delete anything. Tell the user what you sent and what came back |

A write that ends `partial`, `failed` or `uncertain` holds its channel: later writes fail with
`worker-uncertain` until the user reviews it in the plugin (**Show details**, the attention panel,
**Release after review**). Releasing is the user's decision, never yours, and never something to get
around by opening another highway or restarting. Details: [references/recovery.md](references/recovery.md).

## Long or parallel work

The CLI uses the file's shared channel. A script that runs long, or alongside other agents, uses its
own **highway**: `forFile(fileKey, undefined, { agentId })` from the `figma-cli-ultimate` package
(see [references/commands.md](references/commands.md#node-scripts)). Each client gets a private queue
and its own holds, so it neither waits behind nor inherits another agent's failure. Call `close()`
when done.
