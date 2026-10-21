import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StructuredBridge } from '../src/lib/structured-bridge.js';
import { PROTOCOL } from '../src/lib/bridge-protocol.js';
import { BodyBudget, ResponseSlots, readJsonBody, withDeadline } from '../src/lib/bridge-http.js';

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(wire, callback) { this.sent.push(JSON.parse(wire)); callback?.(); }
  close(code, reason) { this.closeCode = code; this.closeReason = reason; this.readyState = 3; this.emit('close'); }
  ping() {}
  message(msg) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
}
function fixture(t, options = {}) {
  const bridge = new StructuredBridge({ expectedBuild: 'test', ...options });
  t.after(() => bridge.close());
  const ws = new Socket(); bridge.attach(ws);
  ws.message({ type: 'hello', protocol: PROTOCOL, build: 'test', busy: false, file: 'Test', page: 'Page', pageId: '1:2', ...options.identity });
  return { bridge, ws };
}
function submit(bridge, options) { return bridge.dispatch('cmd', { cmd: { op: 'create', spec: {} } }, options); }

test('page navigation survives ten seconds and the normal sixty-second command budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { bridge, ws } = fixture(t);
  const job = bridge.dispatch('cmd', { cmd: { op: 'page', action: 'select', id: 'heavy' } });
  const id = ws.sent[0].id;
  ws.message({ type: 'busy', id, busy: true });
  for (let i = 0; i < 7; i++) { t.mock.timers.tick(10000); ws.emit('pong'); }
  assert.equal(bridge.pending.size, 1);
  ws.message({ type: 'result', id, result: { current: true } }); await job;
  assert.equal(ws.sent.some(m => m.action === 'cancel'), false);
});

test('navigation expiry fences the file until acknowledgement without persisting artwork uncertainty', async t => {
  const { bridge, ws } = fixture(t);
  const job = bridge.dispatch('cmd', { cmd: { op: 'page', action: 'select', id: 'heavy' } });
  const rejected = assert.rejects(job, { outcome: 'uncertain' });
  const pending = [...bridge.pending.values()][0];
  bridge.expire(pending, 'daemon-timeout', 'expired'); await rejected;
  await assert.rejects(submit(bridge), { kind: 'worker-uncertain' });
  ws.message({ type: 'result', id: pending.id, error: 'Navigation cancelled', outcome: 'uncertain' });
  assert.equal(bridge.recoveryRequired, false); assert.equal(bridge.diagnostics().uncertain, 0);
  const next = submit(bridge); ws.message({ type: 'result', id: ws.sent.at(-1).id, result: 'ok' }); await next;
});

test('disconnected navigation can reconnect without daemon recovery; mixed batches retain recovery', async t => {
  for (const mutation of [false, true]) {
    const { bridge, ws } = fixture(t);
    const cmds = [{ op: 'page', action: 'select', id: 'heavy' }];
    if (mutation) cmds.unshift({ op: 'update', id: 'existing' });
    const job = bridge.dispatch('cmd-batch', { cmds });
    const rejected = assert.rejects(job, { outcome: 'uncertain' });
    const pending = [...bridge.pending.values()][0];
    bridge.expire(pending, 'client-gone', 'lost caller'); await rejected; ws.close();
    assert.equal(bridge.recoveryRequired, mutation);
    if (!mutation) {
      const replacement = new Socket(); bridge.attach(replacement);
      replacement.message({ type: 'hello', protocol: PROTOCOL, build: 'test', busy: false });
      const next = submit(bridge);
      replacement.message({ type: 'result', id: replacement.sent.at(-1).id, result: 'ok' }); await next;
    }
  }
});

test('explicit navigation deadlines still expire and never report an in-flight switch as not-started', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { bridge, ws } = fixture(t);
  const job = bridge.dispatch('cmd', { cmd: { op: 'page', action: 'select', id: 'heavy' } }, { timeoutMs: 20 });
  const rejected = assert.rejects(job, { kind: 'daemon-timeout', outcome: 'uncertain' });
  const id = ws.sent[0].id; ws.message({ type: 'busy', id, busy: true });
  t.mock.timers.tick(21); await rejected; assert.equal(bridge.diagnostics().uncertain, 1);
  t.mock.timers.tick(5000); assert.equal(bridge.connected(), false); assert.equal(bridge.recoveryRequired, false);
});

test('file-key fencing and lifecycle exclusion run before sending work', async t => {
  const { bridge, ws } = fixture(t, { identity: { fileKey: 'copyKey', instanceId: 'instance' } });
  ws.message({ type: 'status', file: 'Copy', fileKey: 'copyKey', instanceId: 'instance', page: 'Page', pageId: '1:2' });
  assert.equal(bridge.diagnostics().identity.fileKey, 'copyKey');
  await assert.rejects(bridge.dispatch('cmd', { cmd: { op: 'create', expectedFileKey: 'sourceKey', spec: {} } }), { kind: 'wrong-file' });
  assert.equal(ws.sent.length, 0); bridge.lifecycleBusy = true;
  await assert.rejects(submit(bridge), { kind: 'worker-busy' });
  const p = bridge.dispatch('cmd', { cmd: { op: 'verifyFile', expectedFileKey: 'copyKey' } });
  ws.message({ type: 'result', id: ws.sent.at(-1).id, result: { fileKey: 'copyKey' } });
  assert.equal((await p).fileKey, 'copyKey'); bridge.lifecycleBusy = false;
});

test('a status cannot silently replace the attested file or plugin instance', async t => {
  const { bridge, ws } = fixture(t, { identity: { fileKey: 'fileA', instanceId: 'instanceA' } });
  const pending = submit(bridge); const rejected = assert.rejects(pending, { outcome: 'uncertain' });
  ws.message({ type: 'status', file: 'Wrong', fileKey: 'fileB', instanceId: 'instanceB' });
  await rejected; assert.equal(bridge.connected(), false); assert.equal(bridge.recoveryRequired, true);
});

test('native action uncertainty quarantines future mutations even when a terminal reply arrives', async t => {
  const { bridge, ws } = fixture(t);
  const promise = submit(bridge);
  const rejected = assert.rejects(promise, { outcome: 'uncertain' });
  ws.message({ type: 'result', id: ws.sent[0].id, error: 'Undo restoration failed', kind: 'history-verification', outcome: 'uncertain' });
  await rejected;
  assert.equal(bridge.recoveryRequired, true); assert.equal(bridge.pendingBytes, 0);
  await assert.rejects(submit(bridge), { kind: 'worker-uncertain', outcome: 'not-started' });
});

test('uncertain batch items and late uncertain acknowledgements remain quarantined', async t => {
  const { bridge, ws } = fixture(t);
  const batch = bridge.dispatch('cmd-batch', { cmds: [{ op: 'create', spec: {} }] });
  ws.message({ type: 'batch-result', id: ws.sent[0].id, outcome: 'partial', results: [{ success: false, outcome: 'uncertain' }] });
  await batch; assert.equal(bridge.recoveryRequired, true);
  const second = fixture(t); const promise = submit(second.bridge);
  const rejected = assert.rejects(promise, { outcome: 'uncertain' });
  const pending = [...second.bridge.pending.values()][0]; second.bridge.expire(pending, 'daemon-timeout', 'expired'); await rejected;
  second.ws.message({ type: 'result', id: pending.id, error: 'cleanup failed', outcome: 'uncertain' });
  assert.equal(second.bridge.recoveryRequired, true); assert.equal(second.bridge.diagnostics().uncertain, 0);
  await assert.rejects(submit(second.bridge), { kind: 'worker-uncertain' });
});

test('second socket cannot replace a worker or complete its requests', async t => {
  const { bridge, ws } = fixture(t); const promise = submit(bridge); const id = ws.sent[0].id;
  const intruder = new Socket(); assert.equal(bridge.attach(intruder), false); assert.equal(intruder.closeCode, 1008);
  intruder.message({ type: 'result', id, result: 'wrong' }); assert.equal(bridge.pending.size, 1);
  ws.message({ type: 'result', id, result: 'right' }); assert.equal(await promise, 'right');
  assert.equal(bridge.pendingBytes, 0);
});

test('protocol/build mismatch and a busy reconnect fail closed', t => {
  for (const hello of [{ protocol: 2, build: 'test', busy: false }, { protocol: 4, build: 'old', busy: false }, { protocol: 4, build: 'test', busy: true }]) {
    const bridge = new StructuredBridge({ expectedBuild: 'test' }); t.after(() => bridge.close());
    const ws = new Socket(); bridge.attach(ws); ws.message({ type: 'hello', ...hello });
    assert.equal(ws.closeCode, 1008); assert.equal(bridge.connected(), false);
  }
});

test('queue timeout cancels its owning socket, quarantines work, and clears after terminal acknowledgement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { bridge, ws } = fixture(t);
  const promise = submit(bridge, { queueTimeoutMs: 30, timeoutMs: 200 });
  const rejection = assert.rejects(promise, e => e.kind === 'queue-timeout' && e.outcome === 'uncertain');
  const id = ws.sent[0].id; t.mock.timers.tick(31); await rejection;
  assert.equal(ws.sent.at(-1).action, 'cancel'); assert.equal(ws.sent.at(-1).id, id);
  assert.equal(bridge.pendingBytes, 0);
  await assert.rejects(submit(bridge), { kind: 'worker-uncertain' });
  const ping = bridge.dispatch('cmd', { cmd: { op: 'ping' } }); const pingId = ws.sent.at(-1).id;
  ws.message({ type: 'result', id: pingId, result: { ok: true } }); await ping;
  ws.message({ type: 'result', id, error: 'cancelled', outcome: 'rolled-back' });
  assert.equal(bridge.diagnostics().uncertain, 0);
  const next = submit(bridge); ws.message({ type: 'result', id: ws.sent.at(-1).id, result: 'ok' }); await next;
});

test('busy acknowledgement starts a separate execution clock; successful requests clear timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { bridge, ws } = fixture(t);
  const promise = submit(bridge, { queueTimeoutMs: 30, timeoutMs: 100 }); const id = ws.sent[0].id;
  t.mock.timers.tick(25); ws.message({ type: 'busy', busy: true, id }); t.mock.timers.tick(75);
  assert.equal(bridge.pending.size, 1);
  ws.message({ type: 'result', id, result: 'ok' }); await promise;
  t.mock.timers.tick(500); assert.equal(ws.sent.length, 1); assert.equal(bridge.pendingBytes, 0);
});

test('execution deadline and unacknowledged cancellation close the session instead of reusing it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { bridge, ws } = fixture(t, { cancelGraceMs: 50 });
  const promise = submit(bridge, { timeoutMs: 20 });
  const reject = assert.rejects(promise, { kind: 'daemon-timeout', outcome: 'uncertain' });
  ws.message({ type: 'busy', busy: true, id: ws.sent[0].id }); t.mock.timers.tick(21); await reject;
  t.mock.timers.tick(51); assert.equal(bridge.connected(), false); assert.equal(ws.closeCode, 1008);
  assert.equal(bridge.pending.size, 0); assert.equal(bridge.pendingBytes, 0);
});

test('client abort settles once, clears its listener, and does not contaminate a new socket', async t => {
  const { bridge, ws } = fixture(t); const signal = new AbortController();
  const promise = submit(bridge, { signal: signal.signal }); const rejection = assert.rejects(promise, { kind: 'client-gone' });
  const id = ws.sent[0].id; signal.abort(); await rejection;
  ws.close(); const next = new Socket(); bridge.attach(next); next.message({ type: 'hello', protocol: 4, build: 'test', busy: false });
  ws.message({ type: 'result', id, result: 'late' }); ws.emit('error', new Error('old socket'));
  assert.equal(bridge.session.ws, next); assert.equal(bridge.counts.uncertain, 1); assert.equal(bridge.pendingBytes, 0);
  assert.equal(bridge.diagnostics().recoveryRequired, true);
  await assert.rejects(submit(bridge), { kind: 'worker-uncertain', outcome: 'not-started' });
});

test('job/byte/backpressure limits reject before send and reserve control capacity', async t => {
  const { bridge, ws } = fixture(t, { limits: { queueJobs: 1, queueBytes: 500, messageBytes: 300 } });
  const first = submit(bridge); const firstId = ws.sent[0].id;
  await assert.rejects(submit(bridge), { kind: 'queue-full', outcome: 'not-started' });
  const ping = bridge.dispatch('cmd', { cmd: { op: 'ping' } });
  ws.message({ type: 'result', id: ws.sent.at(-1).id, result: true }); await ping;
  ws.message({ type: 'result', id: firstId, result: true }); await first;
  await assert.rejects(bridge.dispatch('cmd', { cmd: { op: 'create', text: 'x'.repeat(400) } }), { kind: 'queue-full' });
  ws.bufferedAmount = 301; await assert.rejects(submit(bridge), { kind: 'queue-full' });
  assert.equal(bridge.pendingBytes, 0);
});

test('disconnect releases every request, and diagnostics retain only 50 metadata records', async t => {
  const { bridge, ws } = fixture(t);
  for (let i = 0; i < 70; i++) {
    const p = submit(bridge); ws.message({ type: 'result', id: ws.sent.at(-1).id, result: { secretPayload: 'must not be retained' } }); await p;
  }
  const a = submit(bridge), b = submit(bridge);
  const rejects = [assert.rejects(a, { kind: 'plugin-offline' }), assert.rejects(b, { kind: 'plugin-offline' })];
  ws.close(); await Promise.all(rejects);
  const d = bridge.diagnostics(); assert.equal(d.pending, 0); assert.equal(d.pendingBytes, 0); assert.equal(d.recent.length, 50);
  assert.doesNotMatch(JSON.stringify(d), /secretPayload/);
});

test('malformed envelopes/deadlines fail synchronously without allocating pending state', t => {
  const { bridge } = fixture(t);
  for (const timeoutMs of [0, -1, '30', null, Infinity, 600001]) assert.throws(() => submit(bridge, { timeoutMs }), { kind: 'invalid-request' });
  assert.throws(() => bridge.dispatch('cmd-batch', { cmds: [] }), { kind: 'invalid-request' });
  assert.throws(() => bridge.dispatch('cmd', { cmd: [] }), { kind: 'invalid-request' });
  assert.equal(bridge.pending.size, 0);
});

function stream(headers = {}) { const req = new PassThrough(); req.headers = headers; return req; }
test('body reader handles split UTF-8 and removes data listeners', async () => {
  const req = stream(), promise = readJsonBody(req); const b = Buffer.from('{"text":"café ☕"}');
  req.write(b.subarray(0, 13)); req.end(b.subarray(13));
  assert.equal((await promise).value.text, 'café ☕'); assert.equal(req.listenerCount('data'), 0);
});
test('body reader rejects malformed, oversized, interrupted and stalled uploads with cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const raw of ['', 'null', '[]', '{']) {
    const req = stream(), p = readJsonBody(req); req.end(raw); await assert.rejects(p, { kind: 'invalid-request' }); assert.equal(req.listenerCount('data'), 0);
  }
  const huge = stream(); const hugeP = readJsonBody(huge, { maxBytes: 4 }); huge.write(Buffer.alloc(5));
  await assert.rejects(hugeP, { kind: 'payload-too-large' });
  const declared = stream({ 'content-length': '500' }); await assert.rejects(readJsonBody(declared, { maxBytes: 4 }), { kind: 'payload-too-large' });
  const broken = stream(), brokenP = readJsonBody(broken); broken.emit('aborted'); broken.emit('error', new Error('late error'));
  await assert.rejects(brokenP, { kind: 'client-gone' });
  const stalled = stream(), stalledP = readJsonBody(stalled, { timeoutMs: 20 });
  const rejection = assert.rejects(stalledP, { kind: 'request-timeout' }); t.mock.timers.tick(21); await rejection;
  assert.equal(stalled.listenerCount('data'), 0);
});
test('deadline helper clears its timer on both success and failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(await withDeadline(async () => 42, 10), 42);
  await assert.rejects(withDeadline(async () => { throw new Error('failed'); }, 10), /failed/);
  t.mock.timers.tick(100);
  const p = withDeadline(() => new Promise(() => {}), 10); const rejected = assert.rejects(p, { kind: 'daemon-timeout', outcome: 'uncertain' });
  t.mock.timers.tick(11); await rejected;
});

test('concurrent HTTP uploads share a finite slot and byte budget, released on every exit', async () => {
  const budget = new BodyBudget({ maxActive: 2, maxBytes: 8 });
  const a = stream(), b = stream(), pa = readJsonBody(a, { budget }), pb = readJsonBody(b, { budget });
  await assert.rejects(readJsonBody(stream(), { budget }), { kind: 'queue-full' });
  a.write(Buffer.from('{"a":')); b.write(Buffer.from('1234'));
  await assert.rejects(pb, { kind: 'queue-full' }); assert.equal(budget.active, 1); assert.equal(budget.bytes, 5);
  a.end('1}'); assert.equal((await pa).value.a, 1); assert.equal(budget.active, 0); assert.equal(budget.bytes, 0);
});

test('slow HTTP readers retain a bounded slot until flush or disconnect, released exactly once', () => {
  const slots = new ResponseSlots(1), a = new EventEmitter(), b = new EventEmitter();
  assert.equal(slots.acquire(a), true); assert.equal(slots.acquire(b), false);
  a.emit('finish'); a.emit('close'); assert.equal(slots.active, 0);
  assert.equal(a.listenerCount('finish') + a.listenerCount('close'), 0);
  assert.equal(slots.acquire(b), true); b.emit('close'); b.emit('finish'); assert.equal(slots.active, 0);
  b.destroyed = true; assert.equal(slots.acquire(b), false);
});
