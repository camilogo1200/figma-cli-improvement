# Failures, outcomes and holds

The bridge never replays work by itself and never guesses. Your job after a failure is the same:
read the outcome, do only what that outcome allows, and hand anything unclear to the user.

## Reading an error

- **CLI:** exit code 1 and one line on stderr:
  `✗ <message> [<kind>] · outcome: <outcome> · request: <requestId>`.
  A failed batch (`batch-failed`, outcome `partial`) is followed by a JSON array with one entry per
  command: `index`, `success`, `created`, `error`, `kind`, `outcome`, `details`.
- An error without `outcome` (invalid JSON, a missing file) happened before anything was sent: fix it
  and run again.
- **Node scripts:** a `BridgeError` with `kind`, `outcome`, `requestId`, `details` and, for batches,
  `results`.

## Outcomes

| Outcome | Meaning | You may |
|---|---|---|
| `not-started` | Nothing reached the canvas. Typical kinds: `invalid-request`, `plugin-offline`, `ambiguous-file`, `daemon-down`, `build-mismatch`, `queue-full`, `zone-conflict`, `layout-size-required`, `unsupported-scope`, `cancelled`; `skipped` for batch items after a failure | Fix the cause and send the same request again |
| `rolled-back` | A `create` failed or was cancelled, and the plugin removed every node it had created. Nothing that existed before was touched | Fix and send again |
| `partial` | A batch stopped: items with `success: true` happened, the failed item has its own outcome, later items were skipped. A single write to an existing node (`update`, `remove`, `reactions`, `page`, …) that threw is also `partial` | Stop and report (see below) |
| `failed` | A command failed after it started | Stop and report |
| `uncertain` | Nobody can tell whether it happened: client timeout, lost connection, cancellation without an answer | Stop and report |

**Retry only `not-started` and `rolled-back`.** Never retry, rebuild or "fix up" after the others.

## Holds

A write that ends `partial`, `failed` or `uncertain` **holds** the channel it came from, and its area
stays protected:

- The CLI uses the file's own channel. While it is held, every request from the CLI to that file
  except `info` and `ping` fails with `worker-uncertain` ("This file has held work requiring
  reconciliation"), reads included. `figma-ultimate files` shows `needsReview: true`.
- A script on a highway holds only that highway ("This highway has held work requiring review;
  other highways are unaffected"). Other agents keep working.
- No timeout, restart or reconnection clears a hold.

## What to do when work is held

1. Stop writing to that file. Do not open a new highway, restart the bridge, reopen the plugin or
   edit `~/.figma-cli-ultimate` to get past the hold.
2. Do not delete or rebuild anything, and never look for your nodes by name to remove them: names
   are not unique, and other people and agents work in the same file.
3. Tell the user:
   - what you sent (the file and the commands, briefly) and the error line or batch results;
   - which ids were created (`created` in the batch results), so they can check them;
   - that the plugin window holds it for review: **Show details**, the attention panel, then
     **Release after review** once they have checked the canvas. Releasing is their decision.
4. After they release it, read the canvas again (`children`, `tree`) before deciding what is still
   missing. Send only that, as a new request.

Zone jobs (`layout`, automatic placement) can sometimes be settled by proof instead of review:
`coordinate({ op: 'reconcile', requestId })` in a Node script asks the plugin to check the receipt.
It only reads; a hold without proof stays held. Offer it to the user rather than running it unasked.

## Avoiding holds

- Confirm ids with `tree <id>` before `update`, `reactions`, `flowStart` or `remove`; a write to a
  missing node holds the file.
- Prefer `create` for new work: a failed `create` rolls back cleanly.
- Keep batches small and related. One batch stops at its first failure, and a partial batch holds.
- Use `layout` for new top-level frames so the bridge checks free space before anything is built.
- Give long jobs enough time (Node: `cmd(command, timeoutMs)`, up to 600000 ms) instead of letting a
  client timeout make them `uncertain`.
