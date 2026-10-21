import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BridgeCoordinator, ReservationJournal } from '../src/lib/bridge-coordinator.js';
import { PROTOCOL } from '../src/lib/bridge-protocol.js';

const flush = () => new Promise(r => setImmediate(r));

test('failed page navigation never journals a file hold and preserves the native diagnostic', async t => {
  const c = setup(t), a = worker(c);
  const job = c.dispatch('cmd', { cmd: { op: 'page', action: 'select', id: 'heavy' } });
  const rejected = assert.rejects(job, { kind: 'page-navigation', outcome: 'failed' });
  await flush();
  assert.equal(c.journal.fileHolds.size, 0, 'Navigation must not leave a hold even if the daemon crashes');
  const navigation = { phase: 'switch', requestedPageId: 'heavy', currentPageId: 'old',
    elapsedMs: 10451, artworkChanged: false, cause: 'Native page switch timed out' };
  finish(a, { error: navigation.cause, kind: 'page-navigation', outcome: 'failed', details: { navigation } });
  await rejected;
  assert.equal(c.quarantined('fileA'), false); assert.equal(c.recoveryRequired, false);
  assert.equal(c.snapshot().recent[0].pageId, 'heavy');
  assert.deepEqual(c.snapshot().recent[0].navigation, navigation);
  const read = c.dispatch('cmd', { cmd: { op: 'page', action: 'list' } });
  await flush(); finish(a); await read;
});

test('navigation-only batches leave no hold; batches containing artwork mutations still do', async t => {
  for (const mutation of [false, true]) {
    const c = setup(t), a = worker(c);
    const cmds = [{ op: 'page', action: 'select', id: 'heavy' }];
    if (mutation) cmds.unshift({ op: 'update', id: 'existing', name: 'Changed' });
    const job = c.dispatch('cmd-batch', { cmds }); await flush();
    assert.equal(c.journal.fileHolds.size, mutation ? 1 : 0);
    const wire = a.ws.sent.find(m => m.action === 'cmd-batch');
    a.ws.receive({ type: 'batch-result', id: wire.id, outcome: 'partial',
      results: cmds.map(cmd => cmd.op === 'update' ? { success: true, result: {} }
        : { success: false, error: 'Page unavailable', kind: 'page-navigation', outcome: 'failed' }) });
    await job; assert.equal(c.quarantined('fileA'), mutation);
  }
});

test('a page-switch failure before a skipped writer releases only that batch hold', async t => {
  const c = setup(t), a = worker(c);
  const job = c.dispatch('cmd-batch', { cmds: [
    { op: 'page', action: 'select', id: 'heavy' }, { op: 'update', id: 'existing' },
  ] });
  await flush(); assert.equal(c.journal.fileHolds.size, 1);
  const wire = a.ws.sent.find(m => m.action === 'cmd-batch');
  a.ws.receive({ type: 'batch-result', id: wire.id, outcome: 'partial', results: [
    { success: false, error: 'Native rejection', outcome: 'failed', kind: 'page-navigation' },
    { success: false, error: 'Skipped after earlier failure', outcome: 'not-started', kind: 'skipped' },
  ] });
  await job; assert.equal(c.quarantined('fileA'), false);
});

test('page creation, rename and update failures still preserve file holds', async t => {
  for (const action of ['create', 'rename', 'update']) {
    const c = setup(t), a = worker(c);
    const job = c.dispatch('cmd', { cmd: { op: 'page', action, id: 'p', name: 'Changed' } });
    const rejected = assert.rejects(job, { outcome: 'partial' }); await flush();
    finish(a, { error: 'Native failure after change', outcome: 'partial' }); await rejected;
    assert.equal(c.quarantined('fileA'), true);
  }
});

test('each arriving batch gets a transient lane; batches stay ordered within each file', async t => {
  const c=setup(t),a=worker(c),b=worker(c,'fileB');
  const commands=[{op:'update',id:'existing'},{op:'exportImage',id:'existing'}];
  const first=c.dispatch('cmd-batch',{cmds:commands},{coordination:a.route});
  const second=c.dispatch('cmd-batch',{cmds:commands},{coordination:a.route});
  const other=c.dispatch('cmd-batch',{cmds:commands},{coordination:b.route});
  await flush();
  const lanes=c.snapshot().lanes;
  assert.equal(new Set(lanes.map(l=>l.laneId)).size,3);
  assert.ok(lanes.every(l=>l.automatic&&l.laneId.startsWith('batch-')));
  assert.deepEqual(lanes.map(l=>l.label),['Batch 1 · 2 commands','Batch 2 · 2 commands','Batch 3 · 2 commands']);
  assert.equal(c.snapshot().workers.filter(w=>w.current).length,2);
  assert.equal(a.ws.sent.filter(m=>m.action==='cmd-batch').length,1);
  const complete=w=>{
    const wire=w.ws.sent.filter(m=>m.action==='cmd-batch').at(-1);
    assert.deepEqual(wire.cmds.map(({expectedFileKey,...cmd})=>cmd),commands);
    w.ws.receive({type:'busy',id:wire.id,busy:true,op:'batch'});
    w.ws.receive({type:'batch-result',id:wire.id,results:[{success:true,result:'updated'},{success:false,error:'export failed',outcome:'not-started'}],outcome:'partial'});
    w.ws.receive({type:'busy',id:wire.id,busy:false});
  };
  // This is a read/write batch: keep its existing partial-outcome hold and result ordering.
  complete(a);complete(b);const results=await first;await other;
  assert.equal(results[0].result,'updated');assert.equal(results[1].success,false);
  // A partial writer holds its file, so the waiting batch must not run.
  await assert.rejects(second,{kind:'worker-uncertain'});
  await flush();assert.equal(c.snapshot().lanes.length,0);assert.equal(c.lastLane.size,0);
  assert.equal(c.snapshot().recent.some(r=>r.label==='Batch 1 · 2 commands'),true);
});

test('successful batch completion advances the next automatic lane and queued cancellation does not dispatch', async t => {
  const c=setup(t),a=worker(c),commands=[{op:'find',name:'Card'},{op:'tree',id:'node'}];
  const one=c.dispatch('cmd-batch',{cmds:commands}),two=c.dispatch('cmd-batch',{cmds:commands}),three=c.dispatch('cmd-batch',{cmds:commands});
  const cancelled=assert.rejects(three,{kind:'cancelled',outcome:'not-started'});await flush();
  const last=c.snapshot().lanes[2];c.cancel(last.requestId,a.ready.workerId);await cancelled;
  const complete=()=>{const wire=a.ws.sent.filter(m=>m.action==='cmd-batch').at(-1);a.ws.receive({type:'batch-result',id:wire.id,results:commands.map(()=>({success:true,result:[]}))});};
  complete();await one;await flush();
  assert.equal(c.snapshot().workers[0].current.label,'Batch 2 · 2 commands');
  assert.equal(a.ws.sent.filter(m=>m.action==='cmd-batch').length,2);
  complete();await two;await flush();assert.equal(c.snapshot().lanes.length,0);
});

test('automatic jobs plan fresh space, queue within a file, and execute across files', async t => {
  const c = setup(t), a = worker(c, 'fileA', {pageId:'page1'}), b = worker(c, 'fileB', {pageId:'page2'});
  const auto = w => c.dispatch('cmd', {cmd:{op:'create',spec:{name:'Auto card',w:100,h:100}}}, {coordination:w.route});
  const one=auto(a), two=auto(a), other=auto(b); await flush();
  assert.equal(c.snapshot().workers.filter(w=>w.current).length,2);
  assert.equal(c.snapshot().workers[0].pageId,'page1');
  assert.equal(a.ws.sent.filter(m=>m.action==='cmd').length,1);
  assert.equal(a.ws.sent.filter(m=>m.action==='cmd').at(-1).cmd.op,'layoutInfo');
  finish(a,{result:{fileKey:'fileA',pageId:'page1',bounds:[{x:0,y:0,width:200,height:300}]}});
  finish(b,{result:{fileKey:'fileB',pageId:'page2',bounds:[]}}); await flush();
  const first=a.ws.sent.filter(m=>m.action==='cmd').at(-1);
  assert.equal(first.cmd.op,'create'); assert.equal(first.lease.rect.y,348); assert.equal(first.cmd.specs[0].y,350);
  assert.match(first.lease.laneId,/^auto-/); assert.equal(first.cmd.select,false);
  finish(a); finish(b); await one; await other; await flush();
  assert.equal(a.ws.sent.filter(m=>m.action==='cmd').at(-1).cmd.op,'layoutInfo');
  // Even if a scene snapshot omits prior nodes, the durable reservation protects them.
  finish(a,{result:{fileKey:'fileA',pageId:'page1',bounds:[{x:0,y:0,width:200,height:300}]}}); await flush();
  const next=a.ws.sent.filter(m=>m.action==='cmd').at(-1);
  assert.ok(next.lease.rect.y>=first.lease.rect.y+first.lease.rect.height+48);
  assert.notEqual(next.lease.laneId,first.lease.laneId); finish(a);await two;
  assert.equal(c.snapshot().reservations.length,3);
});

test('named lanes persist, bind work to their page, and cannot be removed while busy', async t => {
  const dir=mkdtempSync(join(tmpdir(),'ultimate-lanes-'));
  t.after(()=>{if(dirname(resolve(dir))!==resolve(tmpdir())||realpathSync(dir)!==resolve(dir))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true});});
  const journalPath=join(dir,'journal.json'), c=setup(t,{journalPath}), a=worker(c,'fileA',{pageId:'visible'}), b=worker(c,'fileB');
  a.ws.receive({type:'lane-control',id:'create-ui',op:'create-lane',label:'Checkout',pageId:'other-page'});
  const lane=a.ws.sent.find(m=>m.id==='create-ui').result;
  assert.equal(c.snapshot(true).taskLanes[0].state,'waiting');
  assert.equal(new ReservationJournal(journalPath).taskLanes.get(lane.laneId).label,'Checkout');
  assert.throws(()=>c.removeLane(lane.laneId,b.route),{kind:'invalid-request'});
  const job=c.dispatch('cmd',{cmd:{op:'create',spec:{w:100,h:100}}},{coordination:{...a.route,laneId:lane.laneId}});
  assert.throws(()=>c.removeLane(lane.laneId,a.route),{kind:'worker-busy'});await flush();
  assert.equal(a.ws.sent.filter(m=>m.action==='cmd').at(-1).cmd.pageId,'other-page');
  finish(a,{result:{fileKey:'fileA',pageId:'other-page',bounds:[]}});await flush();finish(a);await job;
  c.removeLane(lane.laneId,a.route);
  assert.equal(c.journal.taskLanes.size,0); assert.equal(c.journal.records.size,1);
});

test('cancellation during placement never dispatches creation; invalid targets fail closed', async t => {
  const c=setup(t),a=worker(c,'fileA',{pageId:'p'});
  const job=c.dispatch('cmd',{cmd:{op:'create',spec:{w:100,h:100}}});
  const rejected=assert.rejects(job,{kind:'cancelled',outcome:'not-started'});await flush();
  const id=[...c.jobs.keys()][0];c.cancel(id,a.ready.workerId);
  finish(a,{result:{fileKey:'fileA',pageId:'p',bounds:[]}});await rejected;
  assert.equal(a.ws.sent.some(m=>m.cmd?.op==='create'),false);assert.equal(c.journal.records.size,0);
  const wrong=c.dispatch('cmd',{cmd:{op:'create',spec:{w:100,h:100}}});const denied=assert.rejects(wrong,{kind:'wrong-file'});await flush();
  finish(a,{result:{fileKey:'another-file',pageId:'p',bounds:[]}});await denied;
  assert.equal(c.journal.records.size,0);
});
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(wire, callback) { this.sent.push(JSON.parse(wire)); callback?.(); }
  ping() {}
  close(code, reason) { if (this.readyState === 3) return; this.readyState = 3; this.code = code; this.reason = reason; this.emit('close'); }
  receive(msg) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
}
function setup(t, opts = {}) { const c = new BridgeCoordinator({ expectedBuild: 'test', ...opts }); t.after(() => c.close()); return c; }
function worker(c, fileKey = 'fileA', extra = {}) {
  const ws = new Socket(); c.attach(ws);
  ws.receive({ type: 'hello', build: 'test', protocol: PROTOCOL, busy: false, fileKey, instanceId: 'instance-' + fileKey,
    file: 'File ' + fileKey, page: 'Visible page', pairingCode: c.pair().pairingCode, ...extra });
  const ready = ws.sent.find(m => m.type === 'ready');
  return { ws, ready, route: ready && { workerId: ready.workerId, sessionEpoch: ready.sessionEpoch, fileKey } };
}
function submit(c, w, id, lane = 'laneA', extra = {}, options = {}) {
  return c.dispatch('cmd', { cmd: { op: 'create', parent: extra.pageId || 'page1', select: false, zoom: false,
    spec: { x: 0, y: 0, w: 50, h: 50, text: 'PRIVATE SPEC' } } }, { ...options, coordination: { ...w.route, requestId: id,
    agentId: 'agent1', laneId: lane, pageId: 'page1', rect: { x: Number(id.replace(/\D/g, '')) * 200, y: 0, width: 100, height: 100 }, gutter: 24, ...extra } });
}
function finish(w, extra = {}) {
  const job = w.ws.sent.filter(m => m.action === 'cmd').at(-1);
  w.ws.receive({ type: 'busy', id: job.id, busy: true, op: job.cmd.op });
  w.ws.receive({ type: 'result', id: job.id, result: { created: [{ id: 'node-' + job.id }] }, ...extra });
  w.ws.receive({ type: 'busy', id: job.id, busy: false });
  return job;
}
test('pairing is one-use, identity-bound, origin checked, and rejects same-file writers', t => {
  const c = setup(t), a = worker(c);
  assert.ok(a.ready.credential); assert.equal(worker(c).ws.code, 1008);
  const unpaired = new Socket(); c.attach(unpaired); unpaired.receive({ type: 'hello', build: 'test', protocol: PROTOCOL, busy: false, instanceId: 'x', fileKey: 'B' });
  assert.equal(unpaired.code, 4401);
  const origin = new Socket(); c.attach(origin, 'https://evil.example'); assert.equal(origin.code, 1008);
  a.ws.close();
  const resumed = worker(c, 'fileA', { credential: a.ready.credential });
  assert.equal(resumed.ready.workerId, a.ready.workerId); assert.notEqual(resumed.ready.sessionEpoch, a.ready.sessionEpoch);
  const stolen = worker(c, 'fileB', { credential: a.ready.credential }); assert.equal(stolen.ws.code, 1008);
  const wire = JSON.stringify(c.snapshot()); assert.ok(!wire.includes(a.ready.credential)); assert.ok(!wire.includes('pairingCode'));
});
test('same-page rectangles and gutters conflict, different pages and files are independent', async t => {
  const c = setup(t), a = worker(c), b = worker(c, 'fileB');
  const first = submit(c, a, 'r1');
  await assert.rejects(submit(c, a, 'r2', 'laneB', { rect: { x: 310, y: 0, width: 100, height: 100 } }), { kind: 'zone-conflict' });
  const second = submit(c, a, 'r3', 'laneC', { pageId: 'page2', rect: { x: 200, y: 0, width: 100, height: 100 } });
  const third = submit(c, b, 'r4'); await flush();
  assert.equal(c.jobs.size, 3); assert.equal([...c.workers.values()].filter(w => w.active).length, 2);
  finish(a); finish(b); await first; await third; await flush(); finish(a); await second;
  assert.equal(c.jobs.size, 0); assert.equal(c.snapshot().reservations.length, 3);
  await assert.rejects(submit(c, a, 'r5', 'laneB', { rect: { x: 200, y: 0, width: 100, height: 100 } }), { kind: 'zone-conflict' });
});
test('three sustained lanes rotate fairly while retaining FIFO within each lane', async t => {
  const c = setup(t), a = worker(c), order = [];
  const promises = ['A','A','B','B','C','C'].map((lane, i) => submit(c, a, 'r' + (i + 1), lane));
  for (let i = 0; i < 6; i++) { await flush(); order.push(finish(a).lease.requestId); }
  await Promise.all(promises); assert.deepEqual(order, ['r1','r3','r5','r2','r4','r6']);
});

test('new automatic lanes cannot jump ahead of already waiting lanes', async t => {
  const c=setup(t),a=worker(c,'fileA',{pageId:'page1'});
  const a1=submit(c,a,'r1','A'), a2=submit(c,a,'r2','A'), b1=submit(c,a,'r3','B');
  await flush();finish(a);await a1;await flush();
  const automatic=c.dispatch('cmd',{cmd:{op:'create',spec:{w:100,h:100}}});
  finish(a);await b1;await flush();
  const next=a.ws.sent.filter(m=>m.action==='cmd').at(-1);
  assert.equal(next.lease.requestId,'r2');finish(a);await a2;await flush();
  finish(a,{result:{fileKey:'fileA',pageId:'page1',bounds:[]}});await flush();finish(a);await automatic;
  assert.equal(c.lastLane.size,0);
});
test('queued cancellation never reaches the sandbox and dependencies fail without dispatch', async t => {
  const c = setup(t), a = worker(c), b = worker(c, 'fileB');
  const p = submit(c, a, 'r1'); await flush();
  const queued = submit(c, a, 'r2'); const qError = assert.rejects(queued, { kind: 'cancelled', outcome: 'not-started' });
  const dependent = submit(c, b, 'r3', 'B', { dependencies: ['r2'] }); const dError = assert.rejects(dependent, { kind: 'dependency-failed' });
  await flush(); assert.match(c.snapshot().lanes.find(j => j.requestId === 'r3').blockedReason, /waiting-dependency/);
  assert.equal(c.cancel('r2', b.ready.workerId), false); assert.equal(c.cancel('r2', a.ready.workerId), true);
  await qError; await dError; assert.equal(b.ws.sent.filter(m => m.action).length, 0);
  finish(a); await p; assert.equal(c.journal.records.get('r2').state, 'released');
});
test('queue expiry releases only never-dispatched reservations; stale epochs cannot submit', async t => {
  const c = setup(t), a = worker(c); const p = submit(c, a, 'r1'); await flush();
  await assert.rejects(submit(c, a, 'r2', 'B', {}, { queueTimeoutMs: 10 }), { kind: 'queue-timeout', outcome: 'not-started' });
  assert.equal(c.journal.records.get('r2').state, 'released');
  await assert.rejects(submit(c, a, 'r3', 'C', { sessionEpoch: 'stale' }), { kind: 'stale-session' });
  finish(a); await p;
});
test('uncertain work holds geometry across restart, deduplicates, and quarantines its file', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ultimate-coordinator-'));
  t.after(() => { if (dirname(resolve(dir)) !== resolve(tmpdir()) || realpathSync(dir) !== resolve(dir)) throw Error('Unsafe cleanup'); rmSync(dir, { recursive: true }); });
  const journalPath = join(dir, 'receipts.json'), c = setup(t, { journalPath }), a = worker(c);
  const p = submit(c, a, 'r1'); const rejected = assert.rejects(p, { outcome: 'uncertain' }); await flush();
  const before = new ReservationJournal(journalPath); assert.equal(before.records.get('r1').state, 'held');
  finish(a, { error: 'lost ownership', kind: 'cleanup', outcome: 'uncertain' }); await rejected;
  assert.equal(c.journal.records.get('r1').state, 'held');
  const restart = setup(t, { journalPath }), b = worker(restart);
  await assert.rejects(submit(restart, b, 'r2'), { kind: 'worker-uncertain' });
  assert.equal(restart.snapshot().held, 1); assert.equal(b.ws.sent.filter(m => m.action).length, 0);
  assert.ok(!readFileSync(journalPath, 'utf8').includes('PRIVATE SPEC'));
});
test('writers without a zone are not refused by zones; overlapping zones still are; snapshots are bounded metadata', async t => {
  const c = setup(t, { resources: () => ({ memory: { rss: 123 } }) }), a = worker(c);
  const p = submit(c, a, 'r1'); await flush();
  // Admitted while the zone is running: it cannot know the zone's node ids, and the
  // zone job validates its own area and rolls back on interference.
  const update = c.dispatch('cmd', { cmd: { op: 'update', id: 'old' } });
  finish(a); await p; await flush(); finish(a, { result: { id: 'old' } }); await update;
  await assert.rejects(submit(c, a, 'r2', 'B', { rect: { x: 250, y: 0, width: 100, height: 100 } }), { kind: 'zone-conflict' });
  await assert.rejects(submit(c, a, 'r1'), { kind: 'duplicate-request' });
  const full = c.snapshot(); assert.equal(full.resources.memory.rss, 123); assert.equal(full.latency.count, 2);
  assert.ok(!JSON.stringify(full).includes('PRIVATE SPEC')); assert.equal(c.snapshot(true).reservations, undefined);
  a.ws.receive({ type: 'subscribe', visible: false }); const count = a.ws.sent.length; c.publish(); assert.equal(a.ws.sent.length, count);
});

test('completion telemetry includes only bounded finite geometry and yield measurements', async t => {
  const c = setup(t), a = worker(c), p = submit(c, a, 'r1'); await flush();
  finish(a, { result: { created: [{ id: 'created' }], performance: { spatialChecks: 51, spatialNodes: 50000,
    spatialMs: 200, spatialMaxMs: -1, yieldCount: '24', yieldMs: 30, privatePayload: 'PRIVATE' } } });
  await p;
  assert.deepEqual(c.snapshot().recent[0].performance, { spatialChecks: 51, spatialNodes: 50000, spatialMs: 200, yieldMs: 30 });
  assert.ok(!JSON.stringify(c.snapshot()).includes('PRIVATE'));
});

test('late acknowledgement reconciles only its original zone; uncertain unscoped writes persist a file hold', async t => {
  const c = setup(t), a = worker(c), controller = new AbortController();
  const p = submit(c, a, 'r1', 'A', {}, { signal: controller.signal }); const rejected = assert.rejects(p, { outcome: 'uncertain' });
  await flush(); controller.abort(); await rejected; assert.equal(c.journal.records.get('r1').state, 'held');
  finish(a, { error: 'cancelled', outcome: 'rolled-back' }); assert.equal(c.journal.records.get('r1').state, 'released');
  const legacy = c.dispatch('cmd', { cmd: { op: 'update', id: 'node' } }); const lost = assert.rejects(legacy, { outcome: 'uncertain' });
  await flush(); a.ws.close(); await lost; assert.equal(c.journal.fileHolds.get('fileA').state, 'held');
  const reconnected = worker(c); await assert.rejects(submit(c, reconnected, 'r2'), { kind: 'worker-uncertain' });
});

test('held reservations unlock only after matching read-only plugin proof', async t => {
  const c = setup(t), a = worker(c); const p = submit(c, a, 'r1'); const rejected = assert.rejects(p, { outcome: 'uncertain' });
  await flush(); finish(a, { error: 'unknown', outcome: 'uncertain' }); await rejected; await flush();
  const proof = c.reconcile('r1', a.route);
  const command = a.ws.sent.filter(m => m.action === 'cmd').at(-1), r = c.journal.records.get('r1');
  assert.equal(command.cmd.op, 'inspectReservation');
  a.ws.receive({ type: 'result', id: command.id, result: { requestId: 'r1', token: r.token, fileKey: 'fileA', state: 'rolled-back', nodeIds: [] } });
  assert.equal((await proof).state, 'released'); assert.equal(c.recoveryRequired, false);
  const receipt = c.snapshot().recent[0];
  assert.equal(receipt.op, 'inspectReservation'); assert.equal(receipt.category, 'query'); assert.equal(receipt.target.pageId, 'page1');
});

test('the map keeps live and recently finished zones, counts older ones, and still protects their area', async t => {
  const c = setup(t), a = worker(c); clearInterval(c.timer);
  const job = submit(c, a, 'r1'); await flush();
  const wire = a.ws.sent.filter(m => m.action === 'cmd').at(-1);
  a.ws.receive({ type: 'busy', id: wire.id, busy: true, op: 'create' });
  a.ws.receive({ type: 'status', queued: 0, current: { id: wire.id, op: 'create', target: { pageId: 'page1', page: 'Checkout', parentId: 'page1', kind: 'write', bounds: null } } });
  a.ws.receive({ type: 'page-sketch', pageId: 'page1', page: 'Checkout', roots: 2, cols: 4, rows: 2, extent: { x: 0, y: 0, width: 400, height: 200 }, cells: 'f0', measuredAt: 5 });
  a.ws.receive({ type: 'page-sketch', pageId: 'injected', page: 'X', cols: 4, rows: 2, cells: '<b>' });
  a.ws.receive({ type: 'page-sketch', pageId: 'huge', page: 'X', cols: 100, rows: 100, cells: '' });
  let s = c.snapshot();
  assert.deepEqual(s.workers[0].current.target, { pageId: 'page1', page: 'Checkout', nodeId: 'page1', kind: 'write', bounds: null });
  assert.equal(s.workers[0].current.category, 'change'); assert.equal(s.workers[0].current.agentId, 'agent1');
  assert.deepEqual(s.sketches.map(x => [x.fileKey, x.pageId, x.cells]), [['fileA', 'page1', 'f0']], 'invalid sketches are dropped');
  assert.equal(s.reservations[0].state, 'running');
  a.ws.receive({ type: 'result', id: wire.id, result: { created: [{ id: 'n1' }] } }); await job;
  assert.equal(c.snapshot().reservations[0].state, 'committed', 'a just-finished zone stays on the map');
  c.journal.records.get('r1').completedAt = Date.now() - 121000;
  s = c.snapshot();
  assert.equal(s.reservations.length, 0); assert.deepEqual(s.earlierCommitted, [{ fileKey: 'fileA', count: 1 }]);
  await assert.rejects(submit(c, a, 'r2', 'B', { rect: { x: 250, y: 0, width: 100, height: 100 } }), { kind: 'zone-conflict' }, 'off the map, its area is still protected');
});

test('reads and placement scans leave receipts with target, size and count but never contents', async t => {
  const c = setup(t), a = worker(c, 'fileA', { pageId: 'p' }); clearInterval(c.timer);
  const read = c.dispatch('cmd', { cmd: { op: 'find', name: 'Card' } }); await flush();
  const wire = a.ws.sent.filter(m => m.action === 'cmd').at(-1);
  a.ws.receive({ type: 'busy', id: wire.id, busy: true, op: 'find' });
  a.ws.receive({ type: 'progress', id: wire.id, done: 0, total: 0, state: { current: { id: wire.id, op: 'find', target: { pageId: 'p', page: 'Visible page', parentId: 'p', kind: 'read' } } } });
  a.ws.receive({ type: 'result', id: wire.id, result: [{ id: '1', name: 'PRIVATE NAME' }, { id: '2', name: 'PRIVATE NAME' }] });
  await read;
  const receipt = c.snapshot().recent[0];
  assert.equal(receipt.category, 'query'); assert.equal(receipt.items, 2); assert.ok(receipt.responseBytes > 40);
  assert.deepEqual(receipt.target, { pageId: 'p', page: 'Visible page', nodeId: 'p', kind: 'read' });
  assert.equal(c.snapshot().timeline[0].op, 'find');
  const info = c.dispatch('cmd', { cmd: { op: 'info' } }); await flush(); finish(a, { result: { file: 'PRIVATE FILE' } }); await info;
  assert.equal(c.snapshot().recent[0].op, 'info'); assert.ok(c.snapshot().recent[0].responseBytes > 0);
  const layout = c.dispatch('cmd', { cmd: { op: 'create', spec: { w: 100, h: 100 } } }); await flush();
  finish(a, { result: { fileKey: 'fileA', pageId: 'p', bounds: [{ x: 0, y: 0, width: 10, height: 10 }] } }); await flush();
  finish(a); await layout;
  const [created, scan] = c.snapshot().recent;
  assert.deepEqual([created.op, scan.op], ['create', 'layoutInfo']);
  assert.match(scan.label, /^Placement scan/); assert.equal(scan.items, 1); assert.equal(scan.target.pageId, 'p'); assert.equal(scan.category, 'query');
  assert.doesNotMatch(JSON.stringify(c.snapshot()), /PRIVATE/);
});

test('oversized telemetry trims history and sketches before it would drop a live snapshot', async t => {
  const c = setup(t), a = worker(c); clearInterval(c.timer);
  for (let i = 0; i < 200; i++) c.record({ id: 'r' + i, workerId: a.ready.workerId, laneId: 'lane-' + i, label: 'x'.repeat(500), op: 'find', category: 'query', outcome: 'succeeded', completedAt: Date.now(), executionMs: 1 });
  for (let i = 0; i < 12; i++) a.ws.receive({ type: 'page-sketch', pageId: 'p' + i, page: 'Page ' + i, roots: 1, cols: 64, rows: 64, extent: { x: 0, y: 0, width: 10, height: 10 }, cells: 'f'.repeat(1024) });
  assert.ok(JSON.stringify(c.snapshot()).length > 131072, 'fixture exceeds the wire budget');
  const wire = c.telemetryWire(false);
  assert.ok(wire && Buffer.byteLength(wire) <= 131072);
  const sent = JSON.parse(wire); assert.equal(sent.workers.length, 1); assert.ok(sent.timeline.length < 200);
});


test('remembered pairing survives daemon restart and new plugin instances without exposing its token', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ultimate-pairing-'));
  t.after(() => { if (dirname(resolve(dir)) !== resolve(tmpdir()) || realpathSync(dir) !== resolve(dir)) throw Error('Unsafe cleanup'); rmSync(dir, { recursive: true }); });
  const pairingPath = join(dir, 'pairing.json'), c = setup(t, { pairingPath });
  const first = worker(c, 'A', { remember: true });
  const token = first.ready.deviceCredential;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.ok(!readFileSync(pairingPath, 'utf8').includes(token));
  assert.ok(!JSON.stringify(c.diagnostics()).includes(token));
  first.ws.close(); c.close();
  const restarted = setup(t, { pairingPath });
  const second = worker(restarted, 'A', { pairingCode: '', instanceId: 'new-instance', deviceCredential: token });
  assert.ok(second.ready); assert.notEqual(first.ready.workerId, second.ready.workerId);
  assert.notEqual(first.ready.sessionEpoch, second.ready.sessionEpoch);
  const differentFile = worker(restarted, 'B', { pairingCode: '', instanceId: 'another-instance', deviceCredential: token });
  assert.ok(differentFile.ready);
  assert.equal(worker(restarted, 'A', { pairingCode: '', deviceCredential: token }).ws.code, 1008);
  differentFile.ws.receive({ type: 'forget-computer' });
  assert.equal(second.ws.code, 4401); assert.equal(differentFile.ws.code, 4401);
  const revoked = setup(t, { pairingPath });
  assert.equal(worker(revoked, 'A', { pairingCode: '', deviceCredential: token }).ws.code, 4401);
  assert.equal(worker(restarted, 'A', { pairingCode: '', credential: second.ready.credential }).ws.code, 4401);
});

test('UI pairing waits for explicit approval; rejected, stale and disconnected requests never enroll', async t => {
  let resolveApproval, signal, calls = 0;
  const c = setup(t, { approvePairing: request => { calls++; signal = request.signal; return new Promise(r => { resolveApproval = r; }); } });
  function pending(extra = {}) {
    const ws = new Socket(); c.attach(ws, 'null');
    ws.receive({ type: 'pair-request', protocol: PROTOCOL, build: 'test', busy: false, instanceId: 'new', fileKey: 'A', file: 'Example', ...extra });
    return ws;
  }
  const stale = pending({ build: 'old' }); assert.equal(stale.code, 1008); assert.equal(calls, 0);
  const first = pending(); assert.match(first.sent[0].challenge, /^\d{6}$/);
  assert.equal(c.connected(), false); resolveApproval(false); await flush();
  assert.equal(first.code, 4403); assert.equal(c.computers.records.size, 0);
  const gone = pending(); gone.close(); assert.equal(signal.aborted, true); resolveApproval(true); await flush();
  assert.equal(c.computers.records.size, 0);
  const accepted = pending(); resolveApproval(true); await flush();
  const ready = accepted.sent.find(m => m.type === 'ready'); assert.ok(ready.deviceCredential);
  assert.equal(c.connected(), true); assert.equal(c.snapshot().workers[0].file, 'Example');
  assert.equal(c.handshakes.size, 0);
});

test('quick queries and screenshots both produce bounded action receipts without response contents',async t=>{
  const c=setup(t),a=worker(c);clearInterval(c.timer);
  for(const op of ['info','verifyFile','exportImage']) {
    const result=c.dispatch('cmd',{cmd:{op,id:'target'}});await flush();
    finish(a,{result:{base64:'PRIVATE_IMAGE',nodes:['PRIVATE_QUERY_RESULT']}});await result;await flush();
    const receipt=c.snapshot().recent[0];assert.equal(receipt.op,op);assert.equal(receipt.outcome,'succeeded');
    assert.equal(receipt.category,op==='exportImage'?'screenshot':'query');
  }
  await new Promise(r=>setTimeout(r,130));
  const snapshot=a.ws.sent.filter(m=>m.type==='telemetry').at(-1);
  assert.deepEqual(snapshot.recent.map(r=>r.op),['exportImage','verifyFile','info']);
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_IMAGE|PRIVATE_QUERY_RESULT/);
});

test('job transitions publish promptly and progress bursts send one small delta to visible subscribers',async t=>{
  const c=setup(t),a=worker(c),b=worker(c,'fileB');clearInterval(c.timer);
  b.ws.receive({type:'subscribe',visible:false});
  const job=c.dispatch('cmd',{cmd:{op:'find',name:'Example'}},{coordination:a.route});await flush();
  const wire=a.ws.sent.filter(m=>m.action==='cmd').at(-1);
  await new Promise(r=>setTimeout(r,130));
  const started=a.ws.sent.filter(m=>m.type==='telemetry').at(-1);assert.equal(started.workers[0].current.wireId,wire.id);
  const fullCount=a.ws.sent.filter(m=>m.type==='telemetry').length,beforeHidden=b.ws.sent.length;
  for(let done=1;done<=100;done++)a.ws.receive({type:'progress',id:wire.id,done,total:200});
  await new Promise(r=>setTimeout(r,130));
  const deltas=a.ws.sent.filter(m=>m.type==='worker-progress');assert.equal(deltas.length,1);assert.equal(deltas[0].progress.done,100);
  assert.equal(deltas[0].requestId,started.workers[0].current.requestId);assert.equal(deltas[0].wireId,wire.id);
  assert.equal(a.ws.sent.filter(m=>m.type==='telemetry').length,fullCount,'progress does not resend the full dashboard');assert.equal(b.ws.sent.length,beforeHidden);
  finish(a,{result:[]});await job;await flush();await new Promise(r=>setTimeout(r,130));
  const ended=a.ws.sent.filter(m=>m.type==='telemetry').at(-1);assert.equal(ended.workers[0].current,null);assert.equal(ended.lanes.length,0);assert.equal(ended.recent[0].op,'find');
  assert.ok(ended.sequence>deltas[0].sequence);
});
