# Command reference

`figma-ultimate` (alias `figma-cli-ultimate`). File commands print JSON on stdout; errors go to
stderr with exit code 1.

## Choosing the file

With one file connected, commands go to it. With several, every file command needs
`--file "<unique part of the file name>"` or `--file <fileKey>` (or `FIGMA_ULTIMATE_FILE` in the
environment). An unclear choice fails with `ambiguous-file` and lists the connected files; nothing
is guessed.

## Reading

| Command | Output |
|---|---|
| `figma-ultimate files` | `[{file, fileKey, page, pageId, busy, needsReview}]` |
| `figma-ultimate info` | file, current page, child count, selection, queue |
| `figma-ultimate pages` | `[{id, name, current}]` |
| `figma-ultimate children [prefix]` | `{count, duplicates, children}`: roots of the visible page, optionally only names starting with `prefix` |
| `figma-ultimate find <name>` | up to 100 nodes on the visible page whose name contains `<name>` |
| `figma-ultimate tree <nodeId>` | the node and 4 levels below: `id, name, type, x, y, w, h` |
| `figma-ultimate export <nodeId> [out.png]` | writes a PNG at 2× and prints `{saved, id, name}` |

`find`, `children` and the CLI's `tree` look at the page the user has open. For another page, send
`{"op":"children","id":"<page id>"}` (it loads that page without switching to it).

`export` is limited to 32 megapixels (width × height × 4 at 2×). For a large frame, export a child
or a smaller section.

## Writing

| Command | Input file |
|---|---|
| `figma-ultimate layout layout.json` | `{"specs":[…], "pageId":"…", "label":"…"}`. New top-level frames, each with `w` and `h`, 1 to 64 roots. Placed in free space on `pageId` (default: the visible page) and reserved while they are built |
| `figma-ultimate send commands.json` | one command object, or an array of up to 128 commands run in order as one batch |
| `figma-ultimate cancel [requestId]` | stops one request, or everything running and queued for that file |

`layout` roots: give all of them `x`/`y` (kept as offsets inside the reserved area) or none, keep
them at least 24 px apart, and put overlapping pieces inside one frame. `SECTION` and `INSTANCE`
nodes are not allowed in a layout.

## Status and inspection

| Command | Output |
|---|---|
| `figma-ultimate doctor` | every check, with the fix for each problem (exit 1 when something blocks work) |
| `figma-ultimate status [--json]` | port, files, open highways, held work |
| `figma-ultimate highways` | open highways: agent, file, port, queue |
| `figma-ultimate lanes`, `workers`, `diagnostics` | coordinator detail (large JSON) |

Setup and lifecycle (`setup`, `start`, `stop`, `restart`, `autostart`, `register`, `approve`, `pair`,
`uninstall`) belong to the **figma-ultimate-setup** skill. Ask the user before any of them except
`doctor` and `status`.

## Node scripts

Use a script instead of the CLI when the work is long (many requests, minutes of building), runs
next to other agents, or needs results from one step to build the next. Each `forFile` client opens
its own **highway**: a private port, queue and hold scope for one agent in one file.

```js
import { forFile } from 'figma-cli-ultimate';

const FILE = 'FILE_KEY';                       // from: figma-ultimate files
const fig = forFile(FILE, undefined, { agentId: 'checkout-builder', label: 'Checkout' });
try {
  const pages = await fig.cmd({ op: 'page', action: 'list' });
  const pageId = pages.find(p => p.name === 'Checkout').id;

  // New screens: free space is found and reserved for you.
  const { created } = await fig.createLayout(
    [{ name: 'Checkout / Cart', w: 390, h: 844, fill: '#FFFFFF' }],
    { pageId, label: 'Checkout' });

  // Children and wiring: explicit parent, no selection or zoom changes.
  const card = await fig.cmd({ op: 'create', parent: created[0].id, select: false, zoom: false,
    spec: { name: 'Card', layout: 'COL', p: 16, gap: 8, wSize: 'FILL' } }, 120000);
  await fig.cmdBatch([
    { op: 'update', id: card.created[0].id, spec: { fill: '#F4F4F5', radius: 12 } },
  ], 120000);
} finally {
  await fig.close();                           // waits for this client's own requests
}
```

- `cmd(command, timeoutMs?, options?)`, `cmdBatch(commands, timeoutMs?, options?)`,
  `createLayout(specs, { pageId, label, timeoutMs })`, `worker()`, `coordinate(command)`, `close()`.
- Default deadlines: 60 s for one command, 120 s for a batch, 30 s waiting in the queue; at most
  600 s. `options.onProgress(p)` reports `p.done` / `p.total` nodes; `options.signal` cancels.
- One client per agent and file. Reuse it for the whole job; do not open a new one to get around a
  hold.
- Errors are `BridgeError` with `kind`, `outcome` and, for batches, `results`
  ([recovery.md](recovery.md)).
- More than one file connected: `forFile` is already bound to its file key and never switches.
- Low-level client: `import { cmd, cmdBatch, coordinate, openHighway } from 'figma-cli-ultimate/client'`.

**Importing the package.** In a project: `npm install github:camilogo1200/figma-cli-improvement`,
then `import { forFile } from 'figma-cli-ultimate'`. With only the global install, import it by
file URL (a bare `C:/…` path fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`):

```js
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
const { forFile } = await import(pathToFileURL(join(root, 'figma-cli-ultimate', 'file-client.mjs')).href);
```

Save scripts as `.mjs` (the package is ES modules) and run them with `node script.mjs`.
