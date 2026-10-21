#!/usr/bin/env node
// Shared file-bound client. Kept outside fingerprinted runtime directories so
// client-only changes do not require restarting the daemon.
import * as bridge from './bridge/fig.mjs';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fail = (kind, message) => { throw new bridge.BridgeError(kind, message, { outcome: 'not-started' }); };
// By default each client gets its own highway (private port, queue and holds), so
// it never waits behind or inherits another agent's failure. Set
// FIGMA_ULTIMATE_TRANSPORT=shared, or pass { mode: 'shared' }, for the shared lobby path.
export function forFile(fileKey, transport = bridge, { mode = process.env.FIGMA_ULTIMATE_TRANSPORT || 'highway', agentId = 'file-client', label } = {}) {
  if (typeof fileKey !== 'string' || !/^[\w:.-]{1,128}$/.test(fileKey)) fail('invalid-request', 'An explicit Figma file key is required.');
  let opening = null;
  function road() {
    if (mode !== 'highway' || typeof transport.openHighway !== 'function') return null;
    opening ??= transport.openHighway(fileKey, { agentId, label }).then(h => h, e => { opening = null; throw e; });
    return opening.then(h => { if (!h.closed) return h; opening = null; return road(); });
  }
  const viaHighway = options => ({ queueTimeoutMs: options?.queueTimeoutMs, coordination: options?.coordination, signal: options?.signal, onProgress: options?.onProgress });
  function checkCommand(command) {
    if (command?.expectedFileKey && command.expectedFileKey !== fileKey) fail('wrong-file', 'Command targets a different file than this client.');
    if (command?.op === 'pages' || (command?.op === 'page' && !command.action && ['name', 'create', 'rename', 'index', 'bg'].some(k => k in command))) {
      fail('unsupported', 'Legacy Smart Builder page command: use op:"page" with action:"list", "create", "select" or "rename". The old board builder must be migrated before running it with figma-cli-ultimate.');
    }
  }
  async function worker() {
    const status = await transport.coordinate({ op: 'status' });
    const matches = status.workers.filter(w => w.connected && w.fileKey === fileKey);
    if (matches.length !== 1) fail('plugin-offline', 'Open figma-cli-ultimate in file ' + fileKey + '. This client will not switch to another open file.');
    return matches[0];
  }
  async function optionsFor(options = {}) {
    if (options.signal?.aborted) fail('client-gone', 'Request aborted before dispatch.');
    const w = await worker();
    const identity = { workerId: w.workerId, sessionEpoch: w.sessionEpoch, fileKey };
    for (const [key, value] of Object.entries(identity)) {
      if (options.coordination?.[key] !== undefined && options.coordination[key] !== value) fail('stale-session', 'Explicit routing does not match the bound file and its current session.');
    }
    return { ...options, coordination: { ...options.coordination, ...identity } };
  }
  return Object.freeze({
    fileKey,
    worker,
    async cmd(command, timeoutMs, options) {
      checkCommand(command);
      const highway = await road();
      return highway ? highway.cmd(command, timeoutMs, viaHighway(options)) : transport.cmd(command, timeoutMs, await optionsFor(options));
    },
    async cmdBatch(commands, timeoutMs, options) {
      if (!Array.isArray(commands) || !commands.length) fail('invalid-request', 'A nonempty command array is required.');
      commands.forEach(checkCommand);
      const highway = await road();
      return highway ? highway.cmdBatch(commands, timeoutMs, viaHighway(options)) : transport.cmdBatch(commands, timeoutMs, await optionsFor(options));
    },
    async createLayout(specs, options = {}) {
      if (options.fileKey !== undefined && options.fileKey !== fileKey) fail('wrong-file', 'Layout targets a different file than this client.');
      const highway = await road();
      if (!highway || options.laneId) return transport.createLayout(specs, { ...options, fileKey });
      const pageId = options.pageId || (await worker()).pageId;
      if (!pageId) fail('invalid-request', 'Choose a page for this layout');
      const timeoutMs = options.timeoutMs || 120000;
      return highway.cmd({ op: 'create', parent: pageId, specs: Array.isArray(specs) ? specs : [specs], placement: 'auto', select: false, zoom: false }, timeoutMs,
        { signal: options.signal, queueTimeoutMs: timeoutMs, coordination: { pageId, label: options.label, agentId: options.agentId || agentId, placement: 'auto' } });
    },
    async coordinate(command, options) {
      return transport.coordinate(command, await optionsFor(options));
    },
    // Releases this client's highway (after its own requests settle).
    async close() { const highway = opening && await opening.catch(() => null); opening = null; await highway?.close(); },
  });
}

export async function main(args = process.argv.slice(2)) {
  const rest = [...args], flag = rest.indexOf('--file-key');
  const fileKey = flag < 0 ? process.env.FIGMA_ULTIMATE_FILE_KEY : rest.splice(flag, 2)[1];
  const [sub = 'info', arg] = rest, client = forFile(fileKey);
  let result;
  try {
    if (sub === 'ping' || sub === 'info') result = await client.cmd({ op: sub });
    else if (sub === 'pages') result = await client.cmd({ op: 'page', action: 'list' });
    else if (sub === 'worker') result = await client.worker();
    else if (sub === 'find') result = await client.cmd({ op: 'find', name: arg || '' });
    else if (sub === 'send') {
      if (!arg) fail('invalid-request', 'send requires a JSON command or batch file.');
      const input = JSON.parse(readFileSync(arg, 'utf8'));
      result = Array.isArray(input) ? await client.cmdBatch(input) : await client.cmd(input);
    } else fail('invalid-request', 'Use info | ping | pages | worker | find | send, with --file-key KEY.');
  } finally { await client.close(); }
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error(`${e.message}${e.kind ? ' [' + e.kind + ']' : ''}`); process.exitCode = 1; });
}
