import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { documentLifecycle, fileKeyFromUrl, selectDocumentTarget, validateLifecycleTarget, connectDocument } from '../src/lib/bridge-lifecycle.js';

const cmd = { op: 'reload', expectedFileKey: 'copyKey', sourceFileKey: 'sourceKey', expectedFileName: '__Ultimate disposable test' };
function fixture() {
  const state = { fileKey: 'copyKey', instanceId: 'old', file: cmd.expectedFileName, capabilities: { undo: 'owned-remove-restore', redo: false } };
  const bridge = { session: { identity: state }, connected: () => true,
    diagnostics: () => ({ connected: true, busy: false, pending: 0, queued: 0 }),
    dispatch: async (action, payload) => { assert.equal(action, 'cmd'); assert.deepEqual(payload.cmd, { op: 'verifyFile', expectedFileKey: 'copyKey' }); return { ...state }; } };
  const host = { targetId: 'target', calls: 0, closed: false,
    frame: async () => ({ url: 'https://www.figma.com/design/copyKey/Copy', loaderId: host.calls ? 'new-loader' : 'old-loader' }),
    reload: async () => { host.calls++; state.instanceId = 'new'; }, close: () => { host.closed = true; } };
  return { bridge, host, state, dependencies: { connect: async () => host, pause: async () => {} } };
}
test('exact URL key matching refuses spoofed hosts, duplicates and source file', () => {
  assert.equal(fileKeyFromUrl('https://www.figma.com/design/copyKey/Test'), 'copyKey');
  assert.equal(fileKeyFromUrl('https://www.figma.com.evil/design/copyKey/Test'), null);
  const target = { type: 'page', url: 'https://www.figma.com/design/copyKey/Test', id: 'copy' };
  assert.equal(selectDocumentTarget([target, { ...target, url: 'https://www.figma.com/design/sourceKey/Test' }], 'copyKey').id, 'copy');
  assert.throws(() => selectDocumentTarget([target, target], 'copyKey'), { kind: 'target-ambiguous' });
  assert.throws(() => validateLifecycleTarget({ ...cmd, sourceFileKey: 'copyKey' }, fixture().state), { kind: 'invalid-request' });
});
test('reload requires a new loader and a freshly verified plugin instance', async () => {
  const f = fixture(), response = await documentLifecycle(f.bridge, cmd, f.dependencies);
  assert.equal(response.verified, true); assert.equal(response.pluginReconnected, true);
  assert.equal(response.beforeInstanceId, 'old'); assert.equal(response.afterInstanceId, 'new');
  assert.equal(f.host.calls, 1); assert.equal(f.host.closed, true); assert.equal(f.bridge.lifecycleBusy, false);
});
test('inspect reports native redo/relaunch unavailable without dispatching reload', async () => {
  const f = fixture(), response = await documentLifecycle(f.bridge, { ...cmd, op: 'inspect' }, f.dependencies);
  assert.equal(response.documentReload, true); assert.equal(response.fullStudyReady, false);
  assert.equal(response.redo, false); assert.equal(response.automaticPluginRelaunch, false); assert.equal(f.host.calls, 0);
});
test('wrong file, busy state and absent host refuse before any reload', async () => {
  const f = fixture(); f.state.fileKey = 'sourceKey';
  await assert.rejects(documentLifecycle(f.bridge, cmd, f.dependencies), { kind: 'wrong-file' });
  f.state.fileKey = 'copyKey'; f.bridge.diagnostics = () => ({ connected: true, pending: 1 });
  await assert.rejects(documentLifecycle(f.bridge, cmd, f.dependencies), { kind: 'worker-busy' });
  f.bridge.diagnostics = () => ({ connected: true, pending: 0 });
  await assert.rejects(documentLifecycle(f.bridge, cmd, { connect: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal(f.host.calls, 0); assert.equal(f.bridge.lifecycleBusy, false); assert.equal(f.bridge.recoveryRequired, undefined);
});
test('target navigation fails closed and releases the CDP connection', async () => {
  const f = fixture(); f.host.frame = async () => ({ url: 'https://www.figma.com/design/sourceKey/Source' });
  await assert.rejects(documentLifecycle(f.bridge, cmd, f.dependencies), { kind: 'wrong-file', outcome: 'not-started' });
  assert.equal(f.host.calls, 0); assert.equal(f.host.closed, true);
});
test('lost reload reply is uncertain, quarantines the bridge and is never replayed', async () => {
  const f = fixture(); f.host.reload = async () => { f.host.calls++; throw new Error('lost reply'); };
  await assert.rejects(documentLifecycle(f.bridge, cmd, f.dependencies), { outcome: 'uncertain' });
  assert.equal(f.host.calls, 1); assert.equal(f.bridge.recoveryRequired, true); assert.equal(f.bridge.lifecycleBusy, false); assert.equal(f.host.closed, true);
});
test('abort after reload with an unchanged plugin cannot be reported as success', async () => {
  const f = fixture(), controller = new AbortController();
  f.host.reload = async () => { f.host.calls++; controller.abort(); };
  await assert.rejects(documentLifecycle(f.bridge, cmd, { ...f.dependencies, signal: controller.signal }), { outcome: 'uncertain' });
  assert.equal(f.bridge.recoveryRequired, true); assert.equal(f.host.calls, 1);
});
test('lifecycle implementation contains no desktop input, tab activation or process launch', () => {
  const source = readFileSync(new URL('../src/lib/bridge-lifecycle.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Input\.dispatch|Target\.activateTarget|Page\.bringToFront|Runtime\.evaluate|child_process|activate_window|press_key/);
});

test('CDP transport uses an isolated HTTP/WebSocket host and sends only page lifecycle commands', async t => {
  let port, reloads = 0; const calls = [];
  const server = createServer((req, res) => {
    assert.equal(req.url, '/json/list'); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ id: 'copy', type: 'page', url: 'https://www.figma.com/design/copyKey/Test',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/copy` }]));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', socket => socket.on('message', bytes => {
    const msg = JSON.parse(bytes); calls.push(msg.method);
    if (msg.method === 'Page.reload') reloads++;
    socket.send(JSON.stringify({ id: msg.id, result: msg.method === 'Page.getFrameTree'
      ? { frameTree: { frame: { url: 'https://www.figma.com/design/copyKey/Test', loaderId: 'loader' + reloads } } } : {} }));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections(); server.close(); });
  const host = await connectDocument('copyKey', port); t.after(() => host.close());
  assert.equal((await host.frame()).loaderId, 'loader0'); await host.reload();
  assert.equal((await host.frame()).loaderId, 'loader1');
  assert.deepEqual(calls, ['Page.getFrameTree', 'Page.reload', 'Page.getFrameTree']);
});
