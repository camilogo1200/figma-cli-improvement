import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { BridgeCoordinator } from '../src/lib/bridge-coordinator.js';
import { Highways } from '../src/lib/bridge-highways.js';
import { PROTOCOL } from '../src/lib/bridge-protocol.js';
import { HighwayClient } from '../bridge/fig.mjs';

const flush = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await predicate())) { if (Date.now() > end) throw Error('Timed out waiting'); await sleep(5); }
}
// The paired control socket of one plugin window (in-memory, as in the coordinator tests).
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(wire, callback) { this.sent.push(JSON.parse(wire)); callback?.(); }
  ping() {}
  close(code, reason) { if (this.readyState === 3) return; this.readyState = 3; this.code = code; this.reason = reason; this.emit('close'); }
  receive(msg) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
}
function setup(t, options = {}) {
  const c = new BridgeCoordinator({ expectedBuild: 'test' }); clearInterval(c.timer);
  const highways = new Highways(c, { expectedBuild: 'test', resumeMs: 400, agentWaitMs: 2000, ...options });
  const control = new Socket(); c.attach(control);
  control.receive({ type: 'hello', build: 'test', protocol: PROTOCOL, busy: false, fileKey: 'fileA', instanceId: 'instance-A', file: 'File A', page: 'Page', pageId: '1:1', pairingCode: c.pair().pairingCode });
  t.after(() => { highways.closeAll('test over'); c.close(); });
  return { c, highways, control };
}
// The plugin end of one highway: it answers the jobs it receives under test control.
function plugin(port, ticket, { instanceId = 'instance-A', busy = false, fileKey = 'fileA' } = {}) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/plugin'), jobs = [];
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'plugin', ticket, protocol: PROTOCOL, build: 'test', busy, fileKey, instanceId })));
  ws.on('message', data => { const m = JSON.parse(data.toString()); if (m.action) jobs.push(m); });
  const send = msg => ws.send(JSON.stringify(msg));
  return { ws, jobs, send,
    start(job) { send({ type: 'busy', id: job.id, busy: true, op: job.cmd?.op || 'batch' }); },
    finish(job, fields = { result: { created: [{ id: 'node-' + job.id }] } }) { send({ type: job.action === 'cmd-batch' ? 'batch-result' : 'result', id: job.id, ...fields }); send({ type: 'busy', id: job.id, busy: false }); },
    closed: new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))) };
}
async function open(t, s, agentId = 'agent-1') {
  const lobby = await s.highways.open({ fileKey: 'fileA', agentId, label: agentId });
  const p = plugin(lobby.port, lobby.ticket);
  const client = new HighwayClient(lobby, { WebSocketImpl: WebSocket });
  await client.ready; await until(() => s.c.highways.get(lobby.highwayId).bridge.connected());
  t.after(() => { try { client.fail('test over'); client.ws.close(); } catch {} try { p.ws.close(); } catch {} });
  return { lobby, p, client, h: s.c.highways.get(lobby.highwayId) };
}

test('the lobby opens a private loopback port announced only to the paired plugin; tickets are enforced', async t => {
  const s = setup(t);
  const lobby = await s.highways.open({ fileKey: 'fileA', agentId: 'builder' });
  assert.ok(lobby.port > 0 && lobby.port !== 3456); assert.match(lobby.ticket, /^[a-f0-9]{64}$/);
  const announced = s.control.sent.find(m => m.type === 'open-highway');
  assert.deepEqual([announced.highwayId, announced.port, announced.ticket, announced.sessionEpoch], [lobby.highwayId, lobby.port, lobby.ticket, lobby.highwayId]);
  const intruder = plugin(lobby.port, 'f'.repeat(64));
  assert.equal((await intruder.closed).code, 4401);
  const otherFile = plugin(lobby.port, lobby.ticket, { fileKey: 'fileB' });
  assert.equal((await otherFile.closed).code, 1008);
  await assert.rejects(s.highways.open({ fileKey: 'missing-file' }), { kind: 'plugin-offline' });
  assert.ok(!JSON.stringify(s.c.snapshot()).includes(lobby.ticket), 'tickets never appear in telemetry');
});

test('two highways into one file never queue behind each other at the daemon', async t => {
  const s = setup(t), one = await open(t, s, 'slow-builder'), two = await open(t, s, 'quick-reader');
  const slow = one.client.cmd({ op: 'create', parent: '1:1', spec: { name: 'big' } });
  await until(() => one.p.jobs.length === 1); one.p.start(one.p.jobs[0]);
  const quick = two.client.cmd({ op: 'find', name: 'x' });
  await until(() => two.p.jobs.length === 1);
  assert.equal(one.p.jobs.length, 1, 'the slow job is still running');
  two.p.start(two.p.jobs[0]); two.p.finish(two.p.jobs[0], { result: [{ id: '1' }] });
  assert.deepEqual(await quick, [{ id: '1' }]);
  one.p.finish(one.p.jobs[0]);
  assert.equal((await slow).created[0].id, 'node-' + one.p.jobs[0].id);
  const receipts = s.c.snapshot().recent.filter(r => r.highwayId).map(r => [r.op, r.highwayId]);
  assert.deepEqual(receipts, [['create', one.lobby.highwayId], ['find', two.lobby.highwayId]]);
});

test('an uncertain outcome holds only its own highway; the file and other highways keep writing', async t => {
  const s = setup(t), one = await open(t, s, 'unlucky'), two = await open(t, s, 'unaffected');
  const lost = one.client.cmd({ op: 'update', id: 'x', spec: {} });
  await until(() => one.p.jobs.length === 1); one.p.start(one.p.jobs[0]);
  one.p.finish(one.p.jobs[0], { error: 'Native failure after change', outcome: 'uncertain' });
  await assert.rejects(lost, { outcome: 'uncertain' });
  await assert.rejects(one.client.cmd({ op: 'update', id: 'y', spec: {} }), { kind: 'worker-uncertain' });
  assert.equal(s.c.quarantined(one.h), true); assert.equal(s.c.quarantined('fileA'), false);
  const fine = two.client.cmd({ op: 'update', id: 'z', spec: {} });
  await until(() => two.p.jobs.length === 1); two.p.start(two.p.jobs[0]); two.p.finish(two.p.jobs[0], { result: { id: 'z' } });
  assert.deepEqual(await fine, { id: 'z' });
  const main = s.c.dispatch('cmd', { cmd: { op: 'update', id: 'w', spec: {} } });
  await flush(); const wire = s.control.sent.filter(m => m.action === 'cmd').at(-1);
  s.control.receive({ type: 'result', id: wire.id, result: { id: 'w' } });
  assert.deepEqual(await main, { id: 'w' }, 'the file’s own channel is not held either');
  const held = s.c.snapshot().highways.find(h => h.id === one.lobby.highwayId);
  assert.equal(held.quarantine, true);
  // The operator can release it after looking at the canvas.
  const route = { workerId: s.control.sent.find(m => m.type === 'ready').workerId, sessionEpoch: s.control.sent.find(m => m.type === 'ready').sessionEpoch, fileKey: 'fileA' };
  s.c.release(s.c.journal.fileHolds.get('highway:' + one.lobby.highwayId).requestId, route);
  assert.equal(s.c.quarantined(one.h), false);
});

test('an agent that drops keeps its results; reconnecting to the same port delivers them', async t => {
  const s = setup(t), one = await open(t, s, 'flaky-agent');
  const pending = one.client.cmd({ op: 'create', parent: '1:1', spec: {} });
  await until(() => one.p.jobs.length === 1); one.p.start(one.p.jobs[0]);
  one.h.agentWs.terminate();
  await until(() => one.h.agentState === 'away');
  one.p.finish(one.p.jobs[0]);
  await until(() => one.h.outbox.length === 1 || one.h.agentState === 'connected');
  const result = await pending;
  assert.equal(result.created[0].id, 'node-' + one.p.jobs[0].id, 'the client reconnected by itself and received the result');
  assert.ok(s.c.lobby.some(e => e.event === 'agent-away') && s.c.lobby.some(e => e.event === 'agent-resumed'));
  assert.equal(s.c.journal.fileHolds.size, 0);
});

test('a dropped plugin socket neither cancels nor clouds the work; the same instance resumes and delivers', async t => {
  const s = setup(t), one = await open(t, s, 'steady');
  const pending = one.client.cmd({ op: 'create', parent: '1:1', spec: {} });
  await until(() => one.p.jobs.length === 1); const job = one.p.jobs[0]; one.p.start(job);
  one.p.ws.terminate();
  await until(() => one.h.bridge.detached());
  assert.equal(one.p.jobs.filter(j => j.action === 'cancel').length, 0, 'nothing was cancelled');
  const back = plugin(one.lobby.port, one.lobby.ticket, { busy: true });
  await until(() => one.h.bridge.connected());
  back.finish(job);
  assert.equal((await pending).created[0].id, 'node-' + job.id);
  assert.equal(s.c.quarantined(one.h), false); assert.equal(s.c.journal.fileHolds.size, 0);
  assert.ok(s.c.lobby.some(e => e.event === 'plugin-resumed'));
  back.ws.close();
});

test('a plugin that does not come back in time leaves an uncertain result held on that highway only', async t => {
  const s = setup(t, { resumeMs: 80 }), one = await open(t, s, 'abandoned'), two = await open(t, s, 'other');
  const pending = one.client.cmd({ op: 'update', id: 'x', spec: {} });
  await until(() => one.p.jobs.length === 1); one.p.start(one.p.jobs[0]);
  one.p.ws.terminate();
  await assert.rejects(pending, { outcome: 'uncertain' });
  assert.equal(s.c.quarantined(one.h), true); assert.equal(s.c.quarantined(two.h), false); assert.equal(s.c.quarantined('fileA'), false);
  // A reopened plugin is a new instance: it starts a fresh session instead of inheriting.
  const reopened = plugin(one.lobby.port, one.lobby.ticket, { instanceId: 'instance-new' });
  await until(() => one.h.bridge.connected());
  assert.equal(one.h.bridge.session.identity.instanceId, 'instance-new');
  reopened.ws.close();
});

test('closing returns queued work as not-started and lets the running job finish first', async t => {
  const s = setup(t), one = await open(t, s, 'closer');
  const running = one.client.cmd({ op: 'create', parent: '1:1', spec: {} });
  await until(() => one.p.jobs.length === 1); one.p.start(one.p.jobs[0]);
  const queued = one.client.cmd({ op: 'update', id: 'later', spec: {} });
  await until(() => s.c.snapshot().highways[0].queued === 1);
  const closing = s.highways.close(one.lobby.highwayId, 'Done for today');
  await assert.rejects(queued, { kind: 'highway-closed', outcome: 'not-started' });
  assert.equal(s.c.highways.has(one.lobby.highwayId), true, 'still open while its job runs');
  one.p.finish(one.p.jobs[0]);
  assert.equal((await running).created.length, 1);
  assert.equal(await closing, true);
  assert.equal(s.c.highways.has(one.lobby.highwayId), false);
  assert.ok(s.control.sent.some(m => m.type === 'close-highway' && m.highwayId === one.lobby.highwayId));
  assert.ok(['closed', 'closing'].includes(s.c.lobby[0].event));
});

test('a highway whose agent never connects closes by itself', async t => {
  const s = setup(t, { agentWaitMs: 50 });
  const lobby = await s.highways.open({ fileKey: 'fileA', agentId: 'ghost' });
  await until(() => !s.c.highways.has(lobby.highwayId));
  assert.ok(s.c.lobby.some(e => e.event === 'closed' && /never connected/.test(e.reason)));
});
