import { WebSocket } from 'ws';
import { bridgeError } from './bridge-protocol.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (kind, message, outcome = 'not-started') => bridgeError(kind, message, { outcome });
export function fileKeyFromUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'www.figma.com'
    ? url.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9]+)(?:\/|$)/)?.[1] || null : null; } catch { return null; }
}
export function selectDocumentTarget(targets, key) {
  const matches = targets.filter(target => target.type === 'page' && fileKeyFromUrl(target.url) === key);
  if (matches.length !== 1) throw fail('target-ambiguous', 'Require exactly one CDP document target for the exact disposable file key');
  return matches[0];
}
function requireIdle(bridge) {
  const d = bridge.diagnostics();
  if (!d.connected) throw fail('plugin-offline', 'The matching plugin must be connected');
  if (d.busy || d.pending || d.queued || d.uncertain || d.recoveryRequired) throw fail('worker-busy', 'Work must settle before document lifecycle actions');
}
export function validateLifecycleTarget(cmd, identity) {
  if (!/^[A-Za-z0-9]{1,128}$/.test(cmd.expectedFileKey || '') || !/^[A-Za-z0-9]{1,128}$/.test(cmd.sourceFileKey || '') ||
      cmd.expectedFileKey === cmd.sourceFileKey) throw fail('invalid-request', 'Distinct exact disposable/source file keys are required');
  if (typeof cmd.expectedFileName !== 'string' || !cmd.expectedFileName.startsWith('__Insula disposable ') || cmd.expectedFileName.length > 200) {
    throw fail('invalid-request', 'An explicit disposable file name is required');
  }
  if (identity?.fileKey !== cmd.expectedFileKey || !identity.instanceId ||
      identity.file !== cmd.expectedFileName || !identity.file.startsWith('__Insula disposable ')) {
    throw fail('wrong-file', 'Connected worker identity does not match the disposable copy');
  }
}

// This client issues only CDP Page commands. It never activates a tab, injects
// input, opens a URL, executes arbitrary JS, or starts/restarts Figma.
export async function connectDocument(key, port = 9222) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('invalid-request', 'Invalid CDP port');
  let targets;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    let bytes = 0, chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('CDP target list exceeds 1 MiB');
      chunks.push(chunk);
    }
    targets = JSON.parse(Buffer.concat(chunks).toString());
    if (!Array.isArray(targets)) throw new Error('Invalid target list');
  } catch (error) { throw fail('host-unavailable', 'No script-accessible Figma CDP host: ' + (error.cause?.code || error.message)); }
  const target = selectDocumentTarget(targets, key);
  const address = new URL(target.webSocketDebuggerUrl);
  if (address.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(address.hostname) || Number(address.port) !== port || address.username || address.password) {
    throw fail('invalid-host', 'CDP target socket must remain on the requested loopback port');
  }
  const ws = new WebSocket(address, { maxPayload: 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 2000 });
  let serial = 0; const pending = new Map();
  const rejectPending = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  ws.on('error', error => rejectPending(error));
  ws.on('close', () => rejectPending(new Error('CDP socket closed')));
  ws.on('message', bytes => {
    try {
      const message = JSON.parse(bytes.toString()), p = pending.get(message.id);
      if (!p) return; pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result);
    } catch (error) { rejectPending(error); ws.terminate(); }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  function send(method, params = {}) {
    if (!['Page.getFrameTree', 'Page.reload'].includes(method)) return Promise.reject(new Error('Unsupported lifecycle method'));
    return new Promise((resolve, reject) => {
      const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP command timed out')); ws.terminate(); }, 5000);
      pending.set(id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ id, method, params })); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  return { targetId: target.id, frame: async () => (await send('Page.getFrameTree')).frameTree.frame,
    reload: () => send('Page.reload', { ignoreCache: false }),
    close() { rejectPending(new Error('Lifecycle connection closed')); ws.terminate(); } };
}

export async function documentLifecycle(bridge, cmd, { port = 9222, connect = connectDocument, pause = sleep, signal } = {}) {
  if (!['inspect', 'reload'].includes(cmd?.op)) throw fail('invalid-request', 'Expected lifecycle inspect or reload');
  if (bridge.lifecycleBusy) throw fail('worker-busy', 'Another lifecycle action is active');
  requireIdle(bridge); validateLifecycleTarget(cmd, bridge.session.identity);
  bridge.lifecycleBusy = true;
  let host, dispatched = false;
  const stopped = () => { if (signal?.aborted) throw fail('client-gone', 'Lifecycle caller disconnected', dispatched ? 'uncertain' : 'not-started'); };
  try {
    stopped();
    const before = await bridge.dispatch('cmd', { cmd: { op: 'verifyFile', expectedFileKey: cmd.expectedFileKey } }, { timeoutMs: 3000 });
    validateLifecycleTarget(cmd, before);
    host = await connect(cmd.expectedFileKey, port);
    const frame = await host.frame();
    if (fileKeyFromUrl(frame.url) !== cmd.expectedFileKey) throw fail('wrong-file', 'CDP target navigated before reload');
    if (cmd.op === 'inspect') return { fileKey: before.fileKey, instanceId: before.instanceId, targetId: host.targetId,
      documentReload: true, undo: before.capabilities?.undo || false, redo: false, automaticPluginRelaunch: false,
      fullStudyReady: false, reason: 'Native redo and automatic plugin relaunch are not exposed by the Figma Plugin API' };
    stopped(); requireIdle(bridge);
    if (bridge.session.identity.instanceId !== before.instanceId) throw fail('session-changed', 'Plugin changed before reload');
    // Mark dispatch before send; a transport error can mean the reload ran.
    dispatched = true; const reloadSentAt = new Date().toISOString(); await host.reload();
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      stopped(); await pause(250);
      const afterFrame = await host.frame();
      if (fileKeyFromUrl(afterFrame.url) !== cmd.expectedFileKey) throw fail('wrong-file', 'Reload target changed files', 'uncertain');
      if (afterFrame.loaderId === frame.loaderId || !bridge.connected()) continue;
      const identity = bridge.session.identity;
      validateLifecycleTarget(cmd, identity);
      if (identity.instanceId === before.instanceId) continue;
      requireIdle(bridge);
      const after = await bridge.dispatch('cmd', { cmd: { op: 'verifyFile', expectedFileKey: cmd.expectedFileKey } }, { timeoutMs: 3000 });
      validateLifecycleTarget(cmd, after);
      if (after.instanceId === before.instanceId) continue;
      return { verified: true, fileKey: after.fileKey, targetId: host.targetId, reloadSentAt,
        beforeInstanceId: before.instanceId, afterInstanceId: after.instanceId, pluginReconnected: true,
        beforeLoaderId: frame.loaderId, afterLoaderId: afterFrame.loaderId };
    }
    throw fail('reconnect-unavailable', 'Document reload was sent but a new matching plugin did not reconnect; no UI fallback or replay', 'uncertain');
  } catch (error) {
    if (dispatched) { bridge.recoveryRequired = true; error.outcome = 'uncertain'; }
    throw error;
  } finally { host?.close(); bridge.lifecycleBusy = false; }
}
