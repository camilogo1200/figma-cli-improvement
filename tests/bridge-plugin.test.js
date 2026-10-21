import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { LIMITS } from '../src/lib/bridge-protocol.js';
import { geometricFixture } from './live/navigation-stress.mjs';

const source = readFileSync(process.env.INSULA_PLUGIN_TEST_SOURCE || new URL('../plugin/code.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await flush(); }
  throw new Error('Plugin did not reach expected state');
}
function harness({ autoYield = true, onYield, loadFontAsync = async () => {}, clientStorage, extend, html = '' } = {}) {
  const messages = [], nodes = new Map(), renderReads = new Map(); let seq = 0, serial = 0, made = 0;
  function node(type = 'FRAME') {
    const n = { id: String(++seq), type, children: [], selection: [], x: 0, y: 0, width: 100, height: 100,
      fills: [], layoutMode: 'NONE', removed: false, parent: null, pluginData: {}, flowStartingPoints: [], backgrounds: [], dashPattern: [], strokeCap: 'NONE',
      setPluginData(key, value) { this.pluginData[key] = value; }, getPluginData(key) { return this.pluginData[key] || ''; },
      appendChild(child) { if (child.parent) child.parent.children = child.parent.children.filter(x => x !== child); child.parent = this; this.children.push(child); },
      remove() { if (this.failRemove) throw new Error('remove failed'); for (const child of [...this.children]) child.remove(); if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.removed = true; nodes.delete(this.id); },
      resize(w, h) { this.width = w; this.height = h; },
      resizeWithoutConstraints(w, h) { this.width = w; this.height = h; },
      insertChild(index, child) { this.appendChild(child); this.children.splice(this.children.indexOf(child), 1); this.children.splice(index, 0, child); },
      createInstance() {
        const instance = node('INSTANCE'); instance.mainComponent = this;
        instance.width = this.width; instance.height = this.height;
        const copy = (source, parent) => { const c = node(source.type); parent.appendChild(c); c.remove = () => { throw Error('Instance descendants are immutable'); }; for (const ch of source.children) copy(ch, c); };
        for (const ch of this.children) copy(ch, instance);
        instance.remove = function () { for (const c of this.children) { c.removed = true; nodes.delete(c.id); } this.parent.children = this.parent.children.filter(x => x !== this); this.removed = true; nodes.delete(this.id); };
        page.appendChild(instance); return instance;
      },
      rescale(f) { this.width *= f; this.height *= f; },
      async exportAsync() { return new Uint8Array([1, 2]); },
    };
    Object.defineProperty(n, 'absoluteBoundingBox', { get() { let x = this.x, y = this.y, parent = this.parent; while (parent && parent.type !== 'PAGE' && parent.type !== 'DOCUMENT') { x += parent.x; y += parent.y; parent = parent.parent; } return { x, y, width: this.width, height: this.height }; } });
    Object.defineProperty(n, 'absoluteRenderBounds', { get() { renderReads.set(this.id, (renderReads.get(this.id) || 0) + 1); const b = this.absoluteBoundingBox, margin = this.effectMargin || 0; return { x: b.x - margin, y: b.y - margin, width: b.width + 2 * margin, height: b.height + 2 * margin }; } });
    let name = type;
    Object.defineProperty(n, 'name', { get: () => name, set: value => { if (value === 'FAIL') throw new Error('property failed'); name = value; } });
    nodes.set(n.id, n); return n;
  }
  const page = node('PAGE'), root = node('DOCUMENT'); root.appendChild(page); root.name = 'Test file';
  const make = type => { const n = node(type); made++; figma.currentPage.appendChild(n); return n; };
  const figma = { currentPage: page, root, editorType: 'figma', clientStorage,
    showUI(html, options) { this.shown = options; }, notify() {}, commitUndo() {},
    viewport: { scrollAndZoomIntoView() {} }, loadFontAsync,
    createFrame: () => make('FRAME'), createText: () => make('TEXT'), createRectangle: () => make('RECTANGLE'), createSection: () => make('SECTION'),
    createPage: () => { const p = node('PAGE'); root.appendChild(p); return p; },
    createEllipse: () => make('ELLIPSE'), createLine: () => make('LINE'), createComponent: () => make('COMPONENT'), createNodeFromSvg: () => make('FRAME'),
    getNodeByIdAsync: async id => nodes.get(id), setCurrentPageAsync: async p => { figma.currentPage = p; },
    base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    ui: { resize(width, height) { this.size = [width, height]; }, postMessage(msg) {
      messages.push(JSON.parse(JSON.stringify(msg)));
      if (msg.type === 'yield') queueMicrotask(() => {
        onYield?.(msg, h);
        if (autoYield) figma.ui.onmessage({ type: 'yielded', k: msg.k });
      });
    } },
  };
  extend?.(figma);
  const context = vm.createContext({ figma, __html__: html, console, Date });
  vm.runInContext(source, context);
  const h = { figma, context, messages, page, nodes, node, renderReads, get made() { return made; },
    send(cmd, options = {}) { const id = options.id || 'r' + (++serial); figma.ui.onmessage({ type: 'cmd', id, session: 1, cmd, ...options }); return id; },
    cancel(id = '*') { return figma.ui.onmessage({ type: 'cancel', id }); },
    result(id) { return messages.find(m => m.id === id && ['result', 'batch-result'].includes(m.type)); },
    async done(id) { await until(() => h.result(id)); await until(() => !context.current); return h.result(id); },
  };
  return h;
}
const many = count => ({ name: 'new-root', children: Array.from({ length: count }, (_, i) => ({ name: 'child-' + i })) });

test('page navigation preloads a heavy page and has no ten-second yield deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const h = harness({ autoYield: false }), target = h.node('PAGE');
  h.figma.root.appendChild(target);
  let loaded, switched, calls = 0;
  target.loadAsync = () => new Promise(resolve => { loaded = resolve; });
  h.figma.setCurrentPageAsync = () => { calls++; return new Promise(resolve => {
    switched = () => { h.figma.currentPage = target; resolve(); };
  }); };
  const id = h.send({ op: 'page', action: 'select', id: target.id });
  await until(() => loaded || calls);
  assert.equal(calls, 0, 'Load the page before calling the native switch');
  t.mock.timers.tick(12000); loaded(); await until(() => switched);
  t.mock.timers.tick(12000);
  await h.figma.ui.onmessage({ type: 'yield-timeout', k: 999 });
  assert.equal(h.result(id), undefined);
  assert.equal(h.messages.filter(m => m.type === 'yield').length, 0);
  assert.equal(Object.keys(h.context.yieldWaiters).length, 0);
  switched();
  const result = await h.done(id);
  assert.equal(result.result.current, true); assert.equal(calls, 1);
  assert.equal(result.result.navigation.elapsedMs, 24000); assert.equal(h.made, 0);
});

test('native page-switch rejection retains its phase and error even for immutable Figma errors', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const h = harness(), target = h.node('PAGE'); h.figma.root.appendChild(target);
  let rejectSwitch;
  h.figma.setCurrentPageAsync = () => new Promise((_, reject) => { rejectSwitch = reject; });
  const id = h.send({ op: 'page', action: 'select', id: target.id });
  await until(() => rejectSwitch); t.mock.timers.tick(10451);
  rejectSwitch(Object.freeze(new Error('Native page switch timed out')));
  const result = await h.done(id);
  assert.equal(result.kind, 'page-navigation'); assert.equal(result.outcome, 'failed');
  assert.match(result.error, /Native page switch timed out/);
  assert.deepEqual(result.details.navigation, {
    phase: 'switch', requestedPageId: target.id, previousPageId: h.page.id, currentPageId: h.page.id,
    elapsedMs: 10451, artworkChanged: false, cause: 'Native page switch timed out',
  });
  assert.equal(h.messages.some(m => m.type === 'yield'), false);
  assert.equal((await h.done(h.send({ op: 'page', action: 'list' }))).result.length, 2);
});

test('page loading failures are not-started and a completed switch can reconcile a native rejection', async () => {
  const h = harness(), target = h.node('PAGE'); h.figma.root.appendChild(target);
  let calls = 0;
  target.loadAsync = async () => { throw Error('Could not load page'); };
  h.figma.setCurrentPageAsync = async () => { calls++; h.figma.currentPage = target; throw Error('Late native rejection'); };
  let result = await h.done(h.send({ op: 'page', action: 'select', id: target.id }));
  assert.equal(result.outcome, 'not-started'); assert.equal(result.details.navigation.phase, 'load');
  assert.equal(calls, 0);
  target.loadAsync = async () => {};
  result = await h.done(h.send({ op: 'page', action: 'select', id: target.id }));
  assert.equal(result.error, undefined); assert.equal(result.result.current, true);
  assert.equal(result.result.navigation.reconciled, true);
  await h.done(h.send({ op: 'page', action: 'select', id: target.id }));
  assert.equal(calls, 1, 'Selecting the current page does not switch again');
});

test('cancelling page navigation waits for the native call before advancing the file queue', async () => {
  const h = harness(), target = h.node('PAGE'); h.figma.root.appendChild(target);
  let finishSwitch;
  h.figma.setCurrentPageAsync = () => new Promise(resolve => {
    finishSwitch = () => { h.figma.currentPage = target; resolve(); };
  });
  const id = h.send({ op: 'page', action: 'select', id: target.id });
  await until(() => finishSwitch);
  const next = h.send({ op: 'page', action: 'list' });
  await h.cancel(id); await flush();
  assert.equal(h.result(id), undefined); assert.equal(h.result(next), undefined);
  finishSwitch();
  const result = await h.done(id); await h.done(next);
  assert.equal(result.kind, 'cancelled'); assert.equal(result.details.navigation.currentPageId, target.id);
  assert.equal(h.made, 0);
});

test('an old batch yield watchdog cannot cancel a native page switch or its successor', async () => {
  const h = harness(), target = h.node('PAGE'); h.figma.root.appendChild(target);
  let finishSwitch;
  h.figma.setCurrentPageAsync = () => new Promise(resolve => {
    finishSwitch = () => { h.figma.currentPage = target; resolve(); };
  });
  h.figma.ui.onmessage({ type: 'cmd-batch', id: 'navigate-batch', session: 1,
    cmds: [{ op: 'info' }, { op: 'page', action: 'select', id: target.id }] });
  await until(() => finishSwitch);
  const oldYield = h.messages.find(m => m.type === 'yield');
  assert.equal(Object.keys(h.context.yieldWaiters).length, 0);
  const next = h.send({ op: 'page', action: 'list' });
  await h.figma.ui.onmessage({ type: 'yield-timeout', k: oldYield.k });
  assert.equal(h.context.current.cancelReason, undefined);
  finishSwitch();
  assert.equal((await h.done('navigate-batch')).results.every(r => r.success), true);
  assert.equal((await h.done(next)).error, undefined);
});

test('a batch beginning with immediate reads yields and executes every later command', async () => {
  for (const first of ['ping', 'info']) {
    const h = harness();
    h.figma.ui.onmessage({ type: 'cmd-batch', id: first + '-batch', session: 1, cmds: [
      { op: first }, { op: 'page', action: 'list' },
      { op: 'create', parent: h.page.id, select: false, zoom: false, spec: { name: 'after-read', w: 100, h: 100 } },
      { op: 'info' },
    ] });
    const result = await h.done(first + '-batch');
    assert.deepEqual(result.results.map(r => r.success), [true, true, true, true]);
    assert.equal(h.made, 1);
    assert.equal(result.results[2].result.created[0].name, 'after-read');
    assert.equal(h.messages.filter(m => m.type === 'yield').length, 3);
    assert.equal(Object.keys(h.context.yieldWaiters).length, 0);
  }
});

test('a read-only batch initializes yield counters and cancellation still stops later commands', async () => {
  const h = harness({ autoYield: false });
  h.figma.ui.onmessage({ type: 'cmd-batch', id: 'read-batch', session: 1, cmds: [{ op: 'info' }, { op: 'page', action: 'list' }] });
  await until(() => h.messages.some(m => m.type === 'yield') || h.result('read-batch'));
  assert.equal(h.result('read-batch'), undefined, 'The batch should await its yield acknowledgement');
  assert.equal(h.context.current.performance.yieldCount, 1);
  await h.cancel('read-batch');
  const result = await h.done('read-batch');
  assert.equal(result.results[0].success, true);
  assert.equal(result.results[1].success, false);
  assert.equal(result.results[1].kind, 'cancelled');
  assert.equal(h.made, 0);
  assert.equal(Object.keys(h.context.yieldWaiters).length, 0);
});

function zone(h, page = h.page, patch = {}) {
  h.figma.fileKey = 'fileA';
  h.figma.ui.onmessage({ type: 'coordinator-ready', sessionEpoch: 'session', coordinatorEpoch: 'coordinator' });
  return { leaseId: 'lease1', requestId: 'request1', token: 1, fileKey: 'fileA', pageId: page.id, sessionEpoch: 'session', coordinatorEpoch: 'coordinator', rect: { x: 200, y: 200, width: 400, height: 400 }, gutter: 24, ...patch };
}
const zoneCmd = (page, spec = { x: 240, y: 240, w: 100, h: 100 }) => ({ op: 'create', parent: page.id, select: false, zoom: false, spec });

test('layout planning reads actual descendant and effect bounds without changing page or nodes', async () => {
  const h=harness(),other=h.node('PAGE'),frame=h.node(),child=h.node();h.figma.root.appendChild(other);other.appendChild(frame);frame.appendChild(child);
  h.figma.fileKey='fileA';frame.x=200;child.x=300;child.effectMargin=20;let loaded=false;
  other.loadAsync=async()=>{loaded=true;};
  const result=await h.done(h.send({op:'layoutInfo',pageId:other.id,expectedFileKey:'fileA'}));
  assert.equal(result.result.bounds.length,1);assert.equal(result.result.bounds[0].width,420);
  assert.equal(result.result.fileKey,'fileA');assert.equal(loaded,true);assert.equal(h.made,0);assert.equal(h.figma.currentPage,h.page);
  const bad=await h.done(h.send({op:'layoutInfo',pageId:frame.id,expectedFileKey:'fileA'}));assert.equal(bad.kind,'wrong-page');
});

test('zone creation loads an inactive page and leaves visible page, selection and viewport untouched', async () => {
  const h = harness(), other = h.node('PAGE'); h.figma.root.appendChild(other); let loaded = false;
  other.loadAsync = async () => { loaded = true; };
  h.figma.viewport.scrollAndZoomIntoView = () => { throw Error('Camera must not move'); };
  const result = await h.done(h.send(zoneCmd(other), { lease: zone(h, other) }));
  assert.equal(result.result.created.length, 1); assert.equal(loaded, true); assert.equal(other.children.length, 1);
  assert.equal(h.page.children.length, 0); assert.equal(h.figma.currentPage, h.page); assert.equal(other.children[0].visible, true);
});
test('existing artwork, effect extents, and overflowing descendants prevent zone commit', async () => {
  const h = harness(), existing = h.node(); h.page.appendChild(existing); existing.x = 190; existing.y = 240; existing.width = 10;
  let result = await h.done(h.send(zoneCmd(h.page), { lease: zone(h) }));
  assert.equal(result.kind, 'zone-conflict'); assert.equal(h.made, 0); assert.equal(existing.removed, false);
  existing.x = -1000;
  result = await h.done(h.send(zoneCmd(h.page, { x: 240, y: 240, w: 500, h: 100 }), { lease: zone(h, h.page, { leaseId: 'overflow' }) }));
  assert.equal(result.kind, 'zone-overflow'); assert.equal(result.outcome, 'rolled-back'); assert.deepEqual(h.page.children, [existing]);
  result = await h.done(h.send(zoneCmd(h.page, { x: 240, y: 240, w: 100, h: 100, children: [{ x: 500, w: 100, h: 100 }] }), { lease: zone(h, h.page, { leaseId: 'child-overflow' }) }));
  assert.equal(result.kind, 'zone-overflow'); assert.deepEqual(h.page.children, [existing]);
});
test('external edits during a yield roll back only owned creations', async () => {
  let intruder;
  const h = harness({ onYield: (_, h) => { if (!intruder) { intruder = h.node(); intruder.x = 300; intruder.y = 300; h.page.appendChild(intruder); } } });
  const result = await h.done(h.send(zoneCmd(h.page), { lease: zone(h) }));
  assert.equal(result.kind, 'zone-conflict'); assert.equal(result.outcome, 'rolled-back'); assert.deepEqual(h.page.children, [intruder]);
});

test('geometric layouts stay on their target page while UI changes the current page at every yield', async () => {
  let changes = 0;
  const h = harness({ onYield: (_, h) => {
    h.figma.currentPage = h.figma.currentPage === h.page ? other : h.page; changes++;
  } });
  const target = h.node('PAGE'), other = h.node('PAGE');
  h.figma.root.appendChild(target); h.figma.root.appendChild(other);
  const lease = zone(h, target, { rect: { x: 0, y: 0, width: 2000, height: 1000 } });
  const result = await h.done(h.send({ op: 'create', parent: target.id, select: false, zoom: false,
    specs: geometricFixture('parallel geometry', 1, 4) }, { lease }));
  assert.equal(result.error, undefined); assert.ok(changes >= 2);
  assert.equal(result.result.created.length, 4);
  assert.equal(target.children.length, 4); assert.equal(h.page.children.length, 0); assert.equal(other.children.length, 0);
  assert.ok(target.children.every(n => n.parent === target && n.width === 180 && n.height === 240));
});

test('effect bounds and moved owned roots are rejected; durable receipts prove rollback or commit', async () => {
  let effect = true;
  const h = harness({ onYield: (_, h) => { if (effect) h.page.children[0].effectMargin = 1000; } });
  const lease = zone(h);
  const failed = await h.done(h.send(zoneCmd(h.page), { lease }));
  assert.equal(failed.kind, 'zone-overflow');
  const inspect = { op: 'inspectReservation', expectedFileKey: 'fileA', pageId: h.page.id, leaseId: lease.leaseId, token: lease.token, requestId: lease.requestId };
  assert.equal((await h.done(h.send(inspect))).result.state, 'rolled-back');
  effect = false;
  await h.done(h.send(zoneCmd(h.page), { lease: { ...lease, leaseId: 'second' } }));
  assert.equal((await h.done(h.send({ ...inspect, leaseId: 'second' }))).result.state, 'committed');
  assert.equal((await h.done(h.send({ ...inspect, token: 999 }))).kind, 'unverifiable');
  const moved = harness({ onYield: (_, h) => { const other = h.node('PAGE'); h.figma.root.appendChild(other); other.appendChild(h.page.children[0]); } });
  const result = await moved.done(moved.send(zoneCmd(moved.page), { lease: zone(moved) }));
  assert.equal(result.kind, 'external-edit'); assert.equal(result.outcome, 'rolled-back');
});

test('rollback never deletes a foreign node reparented under an owned root', async () => {
  let existing;
  const h = harness({ onYield: (_, h) => { const root = h.page.children.find(n => n !== existing); root.appendChild(existing); } });
  existing = h.node(); existing.x = -1000; h.page.appendChild(existing);
  const result = await h.done(h.send(zoneCmd(h.page), { lease: zone(h) }));
  assert.equal(result.outcome, 'uncertain'); assert.equal(existing.removed, false); assert.ok(result.details.cleanupFailedIds.length);
});
test('stale session, lease replay, moved roots and font-await file switches fail closed', async () => {
  const h = harness(), lease = zone(h);
  let result = await h.done(h.send(zoneCmd(h.page), { lease: { ...lease, sessionEpoch: 'old' } })); assert.equal(result.kind, 'stale-lease'); assert.equal(h.made, 0);
  await h.done(h.send(zoneCmd(h.page), { lease }));
  result = await h.done(h.send(zoneCmd(h.page), { lease })); assert.equal(result.kind, 'invalid-lease');
  let resume; const f = harness({ loadFontAsync: () => new Promise(r => { resume = r; }) });
  const id = f.send(zoneCmd(f.page, { type: 'TEXT', x: 240, y: 240, text: 'a' }), { lease: zone(f) });
  await until(() => resume); f.figma.fileKey = 'wrong'; resume();
  result = await f.done(id); assert.equal(result.kind, 'wrong-file'); assert.equal(f.made, 0);
});

test('geometry reads stay linear in created nodes while every checkpoint rechecks existing artwork', async () => {
  const h = harness(), existing = h.node(); existing.x = -1000; h.page.appendChild(existing);
  const specs = Array.from({ length: 24 }, (_, i) => ({ x: i * 150, y: 0, w: 100, h: 100,
    children: Array.from({ length: 10 }, () => ({ x: 0, y: 0, w: 10, h: 10 })) }));
  const result = await h.done(h.send({ op: 'create', parent: h.page.id, select: false, zoom: false, specs },
    { lease: zone(h, h.page, { rect: { x: 0, y: 0, width: 4000, height: 300 } }) }));
  assert.equal(result.outcome, undefined); assert.equal(result.result.created.length, 24);
  const metrics = result.result.performance;
  // Initial + each post-font checkpoint + each yield + two final passes.
  assert.equal(metrics.spatialChecks, 1 + 24 + metrics.yieldCount + 2);
  assert.equal(h.renderReads.get(existing.id), metrics.spatialChecks);
  const ownedReads = [...h.renderReads].filter(([id]) => id !== existing.id).reduce((sum, [, reads]) => sum + reads, 0);
  assert.equal(ownedReads, 2 * 24 * 11, 'Pairwise comparisons and response assembly must not rescan native subtrees');
  assert.equal(metrics.spatialNodes, ownedReads + metrics.spatialChecks);
  assert.equal(result.result.reservation.roots.length, 24);
});

test('a clipped foreign descendant moving at a later yield still rejects and preserves the existing subtree', async () => {
  let existing, child, yields = 0;
  const h = harness({ onYield: () => { if (++yields === 2) { child.x = 1300; child.y = 300; child.visible = false; } } });
  existing = h.node(); existing.x = -1000; existing.clipsContent = true; h.page.appendChild(existing);
  child = h.node(); existing.appendChild(child);
  const result = await h.done(h.send({ ...zoneCmd(h.page), spec: undefined,
    specs: [{ x: 240, y: 240, w: 80, h: 80 }, { x: 380, y: 240, w: 80, h: 80 }] }, { lease: zone(h) }));
  assert.equal(result.kind, 'zone-conflict'); assert.equal(result.outcome, 'rolled-back');
  assert.deepEqual(h.page.children, [existing]); assert.equal(child.removed, false);
});

test('geometry node budget is shared across separate existing roots', async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) {
    const root = h.node(); root.x = -1000; h.page.appendChild(root);
    for (let j = 0; j < 5000; j++) root.appendChild(h.node());
  }
  const result = await h.done(h.send(zoneCmd(h.page), { lease: zone(h) }));
  assert.equal(result.kind, 'spatial-budget'); assert.equal(h.made, 0); assert.equal(h.page.children.length, 2);
});

test('cancel at an inner-tree yield stops creation and removes only owned nodes', async () => {
  const h = harness({ onYield: (_, h) => h.cancel() });
  const existing = h.node(); existing.name = 'user-node'; h.page.appendChild(existing);
  const result = await h.done(h.send({ op: 'create', spec: many(300), select: false }));
  assert.equal(result.kind, 'cancelled'); assert.equal(result.outcome, 'rolled-back');
  assert.equal(h.made, 100); assert.deepEqual(h.page.children, [existing]);
  assert.equal(h.context.current, null); assert.equal(Object.keys(h.context.yieldWaiters).length, 0);
});

test('a lost yield acknowledgement is released by cancellation; waiting payloads are removed immediately', async () => {
  const h = harness({ autoYield: false });
  const active = h.send({ op: 'create', spec: many(300), select: false });
  await until(() => Object.keys(h.context.yieldWaiters).length === 1);
  const queued = h.send({ op: 'create', spec: { name: 'never' }, select: false });
  assert.ok(h.context.queuedBytes > 0);
  await h.cancel();
  assert.equal(h.context.waiting.length, 0); assert.equal(h.context.queuedBytes, 0);
  assert.equal(h.result(queued).outcome, 'not-started');
  assert.equal((await h.done(active)).outcome, 'rolled-back');
  const next = await h.done(h.send({ op: 'create', spec: { name: 'next' }, select: false }));
  assert.equal(next.result.created.length, 1);
});

test('UI watchdog cancels a stalled yield without sandbox timers', async () => {
  const h = harness({ autoYield: false }); const id = h.send({ op: 'create', spec: many(200), select: false });
  await until(() => h.messages.some(m => m.type === 'yield'));
  await h.figma.ui.onmessage({ type: 'yield-timeout', k: h.messages.find(m => m.type === 'yield').k });
  assert.equal((await h.done(id)).kind, 'yield-timeout'); assert.equal(h.page.children.length, 0);
});

test('property failure cleans up parent and unparented descendants and leaves the queue usable', async () => {
  const h = harness(); const id = h.send({ op: 'create', spec: { name: 'root', children: [{ name: 'ok' }, { name: 'FAIL' }] }, select: false });
  assert.equal((await h.done(id)).outcome, 'rolled-back'); assert.equal(h.page.children.length, 0);
  assert.equal((await h.done(h.send({ op: 'create', spec: { name: 'ok' }, select: false }))).result.created[0].name, 'ok');
});

test('cleanup failure reports remaining IDs and releases retained node references', async () => {
  const h = harness({ onYield: (_, h) => { h.page.children[0].failRemove = true; h.cancel(); } });
  const res = await h.done(h.send({ op: 'create', spec: many(200), select: false }));
  assert.equal(res.outcome, 'uncertain'); assert.equal(res.details.cleanupFailedIds.length, 1); assert.equal(h.context.current, null);
});

test('cancellation during a native font await creates nothing after that await resolves', async () => {
  let resume; const h = harness({ loadFontAsync: () => new Promise(r => { resume = r; }) });
  const id = h.send({ op: 'create', spec: { type: 'TEXT', text: 'hello' }, select: false });
  await until(() => resume); await h.cancel(); resume();
  assert.equal((await h.done(id)).outcome, 'rolled-back'); assert.equal(h.made, 0);
});

test('malformed, over-depth, oversized batches and inherited ops reply without wedging FIFO', async () => {
  const h = harness();
  let deep = {}; for (let i = 0; i < 65; i++) deep = { children: [deep] };
  for (const cmd of [{ op: 'toString' }, { op: 'create', specs: {} }, { op: 'create', spec: { children: {} } }, { op: 'create', spec: deep }]) {
    assert.equal((await h.done(h.send(cmd))).outcome, 'not-started');
  }
  const id = h.send(null, { type: 'cmd-batch', cmds: Array(129).fill({ op: 'ping' }) });
  assert.equal((await h.done(id)).outcome, 'not-started'); assert.equal(h.made, 0);
  assert.equal((await h.done(h.send({ op: 'ping' }))).result.ok, true);
});

test('plugin capacity limits are enforced and ping/cancel bypass the waiting queue', async () => {
  const h = harness({ autoYield: false }); const id = h.send({ op: 'create', spec: many(200), select: false });
  await until(() => Object.keys(h.context.yieldWaiters).length);
  for (let i = 0; i < 7; i++) h.send({ op: 'create', spec: {}, select: false });
  const refused = h.send({ op: 'create', spec: {}, select: false });
  assert.equal(h.result(refused).kind, 'queue-full');
  const ping = h.send({ op: 'ping' }); await until(() => h.result(ping));
  assert.equal(h.result(ping).result.queued, 7);
  await h.cancel(); await h.done(id); assert.equal(h.context.queuedBytes, 0);
});

test('batch stops after the first error and preserves explicit per-item outcomes', async () => {
  const h = harness(); const id = h.send(null, { type: 'cmd-batch', cmds: [
    { op: 'create', spec: { name: 'kept' }, select: false },
    { op: 'create', spec: { name: 'FAIL' }, select: false },
    { op: 'create', spec: { name: 'never' }, select: false },
  ] });
  const res = await h.done(id);
  assert.equal(res.type, 'batch-result'); assert.equal(res.results[0].success, true);
  assert.equal(res.results[1].outcome, 'rolled-back'); assert.equal(res.results[2].kind, 'skipped');
  assert.deepEqual(h.page.children.map(n => n.name), ['kept']);
});

test('repeated cancellation returns every bridge-owned collection to baseline', async () => {
  const h = harness({ onYield: (_, h) => h.cancel() });
  for (let i = 0; i < 40; i++) {
    await h.done(h.send({ op: 'create', spec: many(110), select: false }));
    assert.equal(h.context.waiting.length, 0); assert.equal(h.context.queuedBytes, 0);
    assert.equal(Object.keys(h.context.yieldWaiters).length, 0); assert.equal(Object.keys(h.context.fontCache).length, 0);
    assert.equal(h.nodes.size, 2);
  }
});

test('export pixel budget is enforced before export, and wire limits stay in sync', async () => {
  const h = harness(); const n = h.node(); n.width = 10000; n.height = 10000; let called = false;
  n.exportAsync = async () => { called = true; return []; };
  assert.equal((await h.done(h.send({ op: 'exportImage', id: n.id }))).kind, 'limit-exceeded'); assert.equal(called, false);
  for (const key of Object.keys(h.context.LIMITS)) assert.equal(h.context.LIMITS[key], LIMITS[key], key);
});

test('file-key verification refuses missing/wrong keys and guards execution after queueing', async () => {
  const h = harness({ autoYield: false });
  assert.equal((await h.done(h.send({ op: 'verifyFile', expectedFileKey: 'copyKey' }))).kind, 'file-key-unavailable');
  h.figma.fileKey = 'copyKey';
  const identity = (await h.done(h.send({ op: 'verifyFile', expectedFileKey: 'copyKey' }))).result;
  assert.equal(identity.fileKey, 'copyKey'); assert.ok(identity.instanceId); assert.equal(identity.capabilities.redo, false);
  assert.equal((await h.done(h.send({ op: 'create', expectedFileKey: 'sourceKey', spec: {} }))).kind, 'wrong-file');
  const first = h.send({ op: 'create', spec: many(200) });
  await until(() => Object.keys(h.context.yieldWaiters).length);
  const second = h.send({ op: 'create', expectedFileKey: 'copyKey', spec: {} });
  h.figma.fileKey = 'changedKey';
  await h.cancel(first); await h.done(first);
  assert.equal((await h.done(second)).kind, 'wrong-file'); assert.equal(h.page.children.length, 0);
});

test('native undo probe consumes one owned receipt without retaining nodes or replay payloads', async () => {
  const h = harness(); h.figma.fileKey = 'copyKey'; h.page.name = '__Insula memory disposable test';
  const result = (await h.done(h.send({ op: 'create', expectedFileKey: 'copyKey', trackHistory: true,
    parent: h.page.id, spec: { name: '__history_1' }, select: false }))).result;
  const root = h.nodes.get(result.created[0].id); let undoCalls = 0, commits = 0;
  h.figma.commitUndo = () => { commits++; };
  h.figma.triggerUndo = () => { undoCalls++; root.removed = false; h.nodes.set(root.id, root); h.page.appendChild(root); };
  assert.equal(Object.values(h.context.historyCandidate).some(v => typeof v === 'object'), false);
  const command = { op: 'undo', expectedFileKey: 'copyKey', expectedPageId: h.page.id, id: root.id, receipt: result.historyReceipt };
  assert.equal((await h.done(h.send({ ...command, id: 'foreign' }))).kind, 'history-guard');
  const undo = await h.done(h.send(command));
  assert.equal(undo.result.verified, true); assert.equal(undoCalls, 1); assert.equal(commits, 1);
  assert.equal(h.context.historyCandidate, null);
  assert.equal((await h.done(h.send(command))).kind, 'history-guard'); assert.equal(undoCalls, 1);
  assert.deepEqual(h.page.children.map(n => n.id), [root.id]);
});

test('native undo failures report uncertainty and redo/reload never simulate native actions', async () => {
  const h = harness(); h.figma.fileKey = 'copyKey'; h.page.name = '__Insula memory disposable test';
  const result = (await h.done(h.send({ op: 'create', expectedFileKey: 'copyKey', trackHistory: true,
    parent: h.page.id, spec: { name: '__history_2' }, select: false }))).result;
  h.figma.triggerUndo = () => { throw new Error('native failure'); };
  const failed = await h.done(h.send({ op: 'undo', expectedFileKey: 'copyKey', expectedPageId: h.page.id,
    id: result.created[0].id, receipt: result.historyReceipt }));
  assert.equal(failed.outcome, 'uncertain'); assert.equal(h.context.historyCandidate, null);
  for (const op of ['redo', 'reload']) {
    const res = await h.done(h.send({ op, expectedFileKey: 'copyKey' }));
    assert.equal(res.kind, 'unsupported'); assert.equal(res.outcome, 'not-started');
  }
});

test('history tracking refuses normal pages and mixed batches before mutation', async () => {
  const h = harness(); h.figma.fileKey = 'copyKey';
  const create = { op: 'create', expectedFileKey: 'copyKey', trackHistory: true, parent: h.page.id, spec: { name: '__history_1' } };
  assert.equal((await h.done(h.send(create))).kind, 'history-guard'); assert.equal(h.made, 0);
  h.page.name = '__Insula memory disposable test';
  assert.equal((await h.done(h.send(null, { type: 'cmd-batch', cmds: [create] }))).kind, 'invalid-request');
  assert.equal(h.made, 0);
});

test('the window always opens as the corner banner and presets grow it upward from there', async () => {
  const moves = [], html = '<body data-mode="standard" data-theme="ios">';
  let position = { x: 10, y: 700 };
  const h = harness({ html, clientStorage: { async getAsync() { return 'console'; }, async setAsync() {} }, extend(figma) {
    figma.viewport.bounds = { x: 0, y: 0, width: 1600, height: 900 }; figma.viewport.zoom = 0.5;
    figma.ui.getPosition = () => ({ windowSpace: { x: 0, y: 0 }, canvasSpace: { ...position } });
    figma.ui.reposition = (x, y) => { moves.push([x, y]); position = { x, y }; };
    figma.closePlugin = () => { figma.closed = true; };
    figma.showUI = function (markup, options) { this.shown = options; this.markup = markup; };
  } });
  await flush();
  // A saved console size is ignored: every session starts as the stealth banner.
  assert.deepEqual(JSON.parse(JSON.stringify(h.figma.shown)), { width: 300, height: 40, themeColors: true, position: { x: 24, y: 716 } });
  assert.equal(h.figma.markup, '<body data-mode="stealth" data-theme="ios">');
  await h.figma.ui.onmessage({ type: 'identify' });
  assert.equal(h.messages.find(m => m.type === 'identity').uiMode, 'stealth');
  await h.figma.ui.onmessage({ type: 'ui-resize', width: 900, height: 900, dx: -50 });
  assert.equal(h.figma.ui.size, undefined, 'the banner is not drag-resizable');
  await h.figma.ui.onmessage({ type: 'ui-mode', mode: 'compact' });
  assert.deepEqual(h.figma.ui.size, [360, 300]);
  assert.deepEqual(moves.at(-1), [10, 700 - 260 / 0.5], 'a low window keeps its bottom edge');
  position = { x: 10, y: 100 };
  await h.figma.ui.onmessage({ type: 'ui-mode', mode: 'console' });
  assert.deepEqual(h.figma.ui.size, [1060, 904]); assert.equal(moves.length, 1, 'a high window keeps its top edge');
  await h.figma.ui.onmessage({ type: 'ui-mode', mode: 'constructor' });
  assert.deepEqual(h.figma.ui.size, [1060, 904]);
  await h.figma.ui.onmessage({ type: 'close-plugin' }); assert.equal(h.figma.closed, true);
});

test('edge drags resize within bounds and move the window for left and top edges', async () => {
  const moves = [];
  const h = harness({ clientStorage: { async getAsync() {} }, extend(figma) {
    figma.viewport.zoom = 2;
    figma.ui.getPosition = () => ({ windowSpace: { x: 0, y: 0 }, canvasSpace: { x: 100, y: 100 } });
    figma.ui.reposition = (x, y) => moves.push([x, y]);
  } });
  await flush();
  await h.figma.ui.onmessage({ type: 'ui-mode', mode: 'compact' }); moves.length = 0;
  await h.figma.ui.onmessage({ type: 'ui-resize', width: 500.4, height: 420, dx: -140, dy: 0, mode: 'compact' });
  assert.deepEqual(h.figma.ui.size, [500, 420]); assert.deepEqual(moves, [[30, 100]]);
  await h.figma.ui.onmessage({ type: 'ui-resize', width: 10, height: 99999, mode: 'standard' });
  assert.deepEqual(h.figma.ui.size, [300, 1800]); assert.equal(moves.length, 1, 'no shift without dx/dy');
  await h.figma.ui.onmessage({ type: 'ui-resize', width: 'wide', height: 400 });
  assert.deepEqual(h.figma.ui.size, [300, 1800]);
  await h.figma.ui.onmessage({ type: 'identify' });
  assert.equal(h.messages.filter(m => m.type === 'identity').at(-1).uiMode, 'standard');
});

test('jobs report where they read or write; pages are sketched between jobs, never inside one', async () => {
  const h = harness();
  const other = h.node('PAGE'); other.name = 'Checkout'; h.figma.root.appendChild(other);
  const frame = h.node('FRAME'); other.appendChild(frame); Object.assign(frame, { x: 100, y: 50, width: 400, height: 300 });
  const id = h.send({ op: 'create', parent: frame.id, spec: { name: 'card' }, select: false });
  await h.done(id);
  const target = h.messages.filter(m => m.type === 'status' && m.current?.target).at(-1).current.target;
  assert.deepEqual(target, { pageId: other.id, page: 'Checkout', parentId: frame.id, kind: 'write', bounds: { x: 100, y: 50, width: 400, height: 300 } });
  const sketchAt = h.messages.findIndex(m => m.type === 'page-sketch' && m.pageId === other.id);
  assert.ok(sketchAt > h.messages.findIndex(m => m.type === 'busy' && m.id === id && m.busy === false), 'sketched after the job finished');
  const sketch = h.messages[sketchAt];
  assert.equal(sketch.roots, 1); assert.deepEqual(sketch.extent, { x: 100, y: 50, width: 400, height: 300 });
  assert.equal(sketch.cells.length, 48 * 30 / 4); assert.match(sketch.cells, /^f+$/, 'one frame fills its own extent');
  const kinds = [];
  for (const cmd of [{ op: 'update', id: frame.id, spec: { name: 'renamed' } }, { op: 'find', name: 'card' }, { op: 'exportImage', id: frame.id }, { op: 'find', name: 'x' }]) {
    const job = h.send(cmd); await h.done(job);
    kinds.push(h.messages.filter(m => m.type === 'status' && m.current?.id === job && m.current.target).at(-1).current.target.kind);
  }
  assert.deepEqual(kinds, ['write', 'read', 'snapshot', 'read']);
  assert.equal(h.messages.filter(m => m.type === 'page-sketch' && m.pageId === h.page.id).length, 1, 'a page only read is sketched once for context');
  assert.equal(h.context.pageSketch({ id: 'u', name: 'Unloaded', type: 'PAGE', get children() { throw Error('not loaded'); } }), null);
  const crowded = h.context.pageSketch({ id: 'c', name: 'Crowded', type: 'PAGE', children: { length: 6000 } });
  assert.equal(crowded.cells, null); assert.equal(crowded.roots, 6000);
});

test('storage failure still opens the banner', async () => {
  const h = harness({ clientStorage: { async getAsync() { throw new Error('unavailable'); } } });
  await flush(); assert.equal(h.figma.shown.width, 300); assert.equal(h.figma.shown.themeColors, true);
});

test('theme restores independently of size and rejects unsupported stored values', async () => {
  for (const [saved, expected] of [['ios', 'ios'], ['signal', 'signal'], ['ios-color', 'ios'], ['ios-uber', 'ios'], ['graphite', 'signal'], ['constructor', 'ios']]) {
    const h = harness({ clientStorage: { async getAsync(key) { if (key === 'ui-mode') throw Error('size unavailable'); return saved; } } });
    await flush();
    await h.figma.ui.onmessage({ type: 'identify' });
    const identity = h.messages.find(m => m.type === 'identity');
    assert.equal(identity.uiTheme, expected); assert.equal(identity.uiMode, 'stealth');
    assert.equal(h.figma.shown.width, 300);
  }
});

test('rapid theme saves serialize with size, recover from storage failure, and never mutate the document', async () => {
  const writes = []; let release;
  const h = harness({ clientStorage: {
    async getAsync() { return undefined; },
    async setAsync(key, value) { writes.push([key, value]); if (writes.length === 1) { await new Promise(resolve => { release = resolve; }); throw Error('storage unavailable'); } },
  } });
  await flush();
  await h.figma.ui.onmessage({ type: 'ui-theme', theme: 'ios' });
  assert.equal(h.figma.ui.size, undefined);
  await h.figma.ui.onmessage({ type: 'ui-mode', mode: 'compact' });
  await h.figma.ui.onmessage({ type: 'ui-theme', theme: 'signal' });
  await h.figma.ui.onmessage({ type: 'ui-theme', theme: '<invalid>' });
  await flush(); assert.deepEqual(writes, [['ui-theme', 'ios']]);
  release(); await flush();
  // Sessions always start as the banner, so the window size is no longer saved.
  assert.deepEqual(writes, [['ui-theme', 'ios'], ['ui-theme', 'signal']]);
  await h.figma.ui.onmessage({ type: 'identify' });
  assert.equal(h.messages.find(m => m.type === 'identity').uiTheme, 'signal');
  assert.deepEqual(h.figma.ui.size, [360, 300]); assert.equal(h.made, 0);
});

test('progress contains bounded queue metadata and the resolved creation page without specs', async () => {
  const h = harness({ autoYield: false });
  const other = h.node('PAGE'); other.name = 'Target page'; h.figma.root.appendChild(other);
  const id = h.send({ op: 'create', parent: other.id, spec: many(200), select: false });
  await until(() => h.messages.some(m => m.type === 'progress'));
  h.send({ op: 'create', parent: h.page.id, spec: { name: 'DO_NOT_LEAK_SPEC' }, select: false });
  const state = h.context.queueStatus();
  assert.equal(state.current.target.pageId, other.id);
  assert.equal(state.queue.length, 1); assert.equal(state.queue[0].parentId, h.page.id);
  assert.ok(state.queue[0].waitMs >= 0);
  assert.doesNotMatch(JSON.stringify(state), /DO_NOT_LEAK_SPEC/);
  const progress = h.messages.find(m => m.type === 'progress');
  assert.equal(progress.state.current.target.page, 'Target page');
  assert.equal(progress.state.current.done, 100);
  await h.cancel(); await h.done(id);
});


test('computer pairing restores and serializes saves without leaking into document or status', async () => {
  const storage = new Map([['insula-computer-pairing-v1', 'a'.repeat(64)]]);
  const h = harness({ clientStorage: { async getAsync(key) { return storage.get(key); }, async setAsync(key, value) { storage.set(key, value); } } });
  await flush(); await h.figma.ui.onmessage({ type: 'identify' });
  assert.equal(h.messages.find(m => m.type === 'identity').deviceCredential, 'a'.repeat(64));
  assert.ok(h.messages.filter(m => m.type === 'status').every(m => !JSON.stringify(m).includes('a'.repeat(64))));
  await h.figma.ui.onmessage({ type: 'remember-computer', deviceCredential: 'b'.repeat(64) });
  await h.figma.ui.onmessage({ type: 'forget-computer' }); await flush();
  assert.equal(storage.get('insula-computer-pairing-v1'), ''); assert.equal(h.made, 0);
  await h.figma.ui.onmessage({ type: 'remember-computer', deviceCredential: 'invalid' }); await flush();
  assert.equal(storage.get('insula-computer-pairing-v1'), '');
});


test('board sections, instances and line styling keep native types and coordinates', async () => {
  const h = harness();
  const comp = h.node('COMPONENT'); h.page.appendChild(comp); comp.width = 320; comp.height = 200;
  const child = h.node('TEXT'); comp.appendChild(child);
  const result = await h.done(h.send({op:'create', parent:h.page.id, select:false, zoom:false, spec:{type:'SECTION',name:'board',x:40,y:80,w:900,h:700,children:[{type:'INSTANCE',of:comp.id,x:20,y:30},{type:'LINE',x:4,y:6,w:80,strokeCap:'ARROW_LINES',dash:[6,4]}]}}));
  assert.equal(result.error, undefined);
  const section = h.nodes.get(result.result.created[0].id);
  assert.equal(section.type,'SECTION'); assert.equal(section.width,900); assert.equal(section.height,700);
  assert.equal(section.children[0].type,'INSTANCE'); assert.equal(section.children[0].mainComponent,comp);
  assert.equal(section.children[0].x,20); assert.equal(section.children[0].y,30); assert.equal(section.children[0].width,320);
  assert.equal(section.children[1].strokeCap,'ARROW_LINES'); assert.deepEqual(Array.from(section.children[1].dashPattern),[6,4]);
  assert.equal(comp.removed,false);
});

test('failed instance creation rolls back copies without touching source components', async () => {
  const h = harness(), comp = h.node('COMPONENT'); h.page.appendChild(comp); comp.appendChild(h.node('TEXT'));
  const result = await h.done(h.send({op:'create',parent:h.page.id,select:false,zoom:false,specs:[{type:'INSTANCE',of:comp.id},{name:'FAIL'}]}));
  assert.equal(result.outcome,'rolled-back'); assert.deepEqual(h.page.children,[comp]); assert.equal(comp.removed,false);
  const wrong = await h.done(h.send({op:'create',parent:h.page.id,spec:{type:'INSTANCE',of:h.page.id}}));
  assert.equal(wrong.kind,'invalid-request'); assert.deepEqual(h.page.children,[comp]);
});

test('page updates and flow starts target IDs without changing the visible page', async () => {
  const h = harness(), other = h.node('PAGE'), target = h.node(); h.figma.root.appendChild(other); other.appendChild(target);
  const update = await h.done(h.send({op:'page',action:'update',id:other.id,index:0,bg:'#112233'}));
  assert.equal(update.error,undefined); assert.equal(h.figma.root.children[0],other); assert.equal(h.figma.currentPage,h.page);
  assert.equal(other.backgrounds[0].color.r,17/255);
  const bad = await h.done(h.send({op:'page',action:'update',id:other.id,index:99,bg:'#000000'}));
  assert.equal(bad.outcome,'not-started'); assert.equal(other.backgrounds[0].color.r,17/255);
  other.flowStartingPoints=[{nodeId:'old',name:'old'}];
  const flow = await h.done(h.send({op:'flowStart',pageId:other.id,id:target.id,name:'board',reset:true}));
  assert.equal(flow.error,undefined); assert.equal(other.flowStartingPoints.length,1); assert.equal(other.flowStartingPoints[0].nodeId,target.id);
  assert.equal(h.figma.currentPage,h.page); assert.equal(h.page.flowStartingPoints.length,0);
  const wrong = await h.done(h.send({op:'flowStart',pageId:h.page.id,id:target.id})); assert.equal(wrong.kind,'wrong-page');
});

test('instances reject oversized sources and automatic-placement leases before allocation', async () => {
  const h = harness(), comp=h.node('COMPONENT'); h.page.appendChild(comp); comp.x=-1000;
  comp.children=Array.from({length:LIMITS.specNodes},()=>({children:[]}));
  const result=await h.done(h.send({op:'create',parent:h.page.id,spec:{type:'INSTANCE',of:comp.id}}));
  assert.equal(result.kind,'limit-exceeded'); assert.deepEqual(h.page.children,[comp]);
  comp.children=[];
  const refused=await h.done(h.send(zoneCmd(h.page,{type:'INSTANCE',of:comp.id,x:240,y:240}),{lease:zone(h)}));
  assert.equal(refused.kind,'unsupported-scope'); assert.deepEqual(h.page.children,[comp]);
});

// Highways: several channels share the one plugin thread and take turns at pause points.
const road = (h, id = 'hw-a') => h.figma.ui.onmessage({ type: 'highway-session', highwayId: id, sessionEpoch: id });
const sendOn = (h, highway, cmd, options = {}) => { const id = options.id || 'h' + Math.random().toString(36).slice(2); h.figma.ui.onmessage({ type: 'cmd', id, session: 1, cmd, highway, ...options }); return id; };
const resultIndex = (h, id) => h.messages.findIndex(m => m.id === id && ['result', 'batch-result'].includes(m.type));

test('a short highway job finishes while a long job on another channel is still running', async () => {
  let short;
  // The short job arrives during the long job's first yield, as a second agent would.
  const h = harness({ onYield: (_, h) => { short ??= sendOn(h, 'hw-a', { op: 'find', name: 'child-1' }); } }); road(h);
  const long = h.send({ op: 'create', parent: h.page.id, spec: many(500), select: false });
  await until(() => resultIndex(h, long) >= 0);
  assert.ok(resultIndex(h, short) >= 0 && resultIndex(h, short) < resultIndex(h, long), 'the short job finished first');
  const progressAfterShort = h.messages.slice(resultIndex(h, short)).filter(m => m.type === 'progress' && m.id === long);
  assert.ok(progressAfterShort.length >= 2, 'the long job was still running when the short one finished');
  assert.equal(h.messages[resultIndex(h, short)].highway, 'hw-a', 'the reply carries its highway');
  assert.ok(h.messages.some(m => m.type === 'busy' && m.id === short && m.highway === 'hw-a'));
  await h.done(long);
  assert.equal(h.result(long).result.created.length, 1); assert.equal(h.result(long).highway, undefined);
  assert.equal(h.context.activeJobs.length, 0); assert.equal(h.context.turnQueue.length, 0); assert.equal(h.context.turnHolder, null);
});

test('two long jobs on different channels alternate slices and both complete', async () => {
  const h = harness(); road(h);
  const a = h.send({ op: 'create', parent: h.page.id, spec: many(400), select: false });
  const b = sendOn(h, 'hw-a', { op: 'create', parent: h.page.id, spec: many(400), select: false });
  await until(() => h.result(a) && h.result(b));
  const order = h.messages.filter(m => m.type === 'progress').map(m => m.id === a ? 'a' : 'b');
  assert.ok(order.join('').includes('ab') && order.join('').includes('ba'), 'progress interleaves: ' + order.join(''));
  assert.equal(h.result(a).result.created.length, 1); assert.equal(h.result(b).result.created.length, 1);
  assert.equal(h.page.children.length, 2);
});

test('a dropped control socket cancels only its own channel; highway work continues', async () => {
  let dropped = false;
  const h = harness({ onYield: (_, h) => { if (!dropped) { dropped = true; h.figma.ui.onmessage({ type: 'cancel', id: '*', reason: 'socket closed', channel: 'main' }); } } }); road(h);
  const main = h.send({ op: 'create', parent: h.page.id, spec: many(400), select: false });
  const hw = sendOn(h, 'hw-a', { op: 'create', parent: h.page.id, spec: many(400), select: false });
  await until(() => h.result(main) && h.result(hw));
  assert.equal(h.result(main).outcome, 'rolled-back'); assert.equal(h.result(hw).result.created.length, 1);
});

test('highway work is fenced: unknown highways and foreign leases are refused before allocation', async () => {
  const h = harness();
  const unknown = sendOn(h, 'hw-unknown', { op: 'find', name: 'x' });
  await until(() => resultIndex(h, unknown) >= 0);
  assert.equal(h.messages[resultIndex(h, unknown)].kind, 'stale-session');
  road(h);
  const mainLease = zone(h);
  const wrongFence = sendOn(h, 'hw-a', zoneCmd(h.page), { lease: mainLease });
  await until(() => resultIndex(h, wrongFence) >= 0);
  assert.equal(h.messages[resultIndex(h, wrongFence)].kind, 'stale-lease'); assert.equal(h.made, 0);
  const own = sendOn(h, 'hw-a', zoneCmd(h.page), { lease: { ...mainLease, leaseId: 'hw-lease', sessionEpoch: 'hw-a' } });
  await until(() => resultIndex(h, own) >= 0);
  assert.equal(h.messages[resultIndex(h, own)].result.created.length, 1);
});

test('interleaved zone jobs on one page ignore each other’s hidden scaffolding and both commit', async () => {
  const h = harness(); road(h);
  const left = zone(h, h.page, { leaseId: 'left', requestId: 'left', rect: { x: 0, y: 0, width: 600, height: 600 } });
  const right = { ...left, leaseId: 'right', requestId: 'right', sessionEpoch: 'hw-a', rect: { x: 1000, y: 0, width: 600, height: 600 } };
  const spec = (x) => ({ x, y: 40, w: 500, h: 500, children: Array.from({ length: 250 }, (_, i) => ({ name: 'c' + i, w: 4, h: 4 })) });
  const a = h.send({ op: 'create', parent: h.page.id, select: false, zoom: false, spec: spec(40) }, { lease: left });
  const b = sendOn(h, 'hw-a', { op: 'create', parent: h.page.id, select: false, zoom: false, spec: spec(1040) }, { lease: right });
  await until(() => h.result(a) && resultIndex(h, b) >= 0);
  const order = h.messages.filter(m => m.type === 'progress').map(m => m.id === a ? 'a' : 'b').join('');
  assert.ok(order.includes('ab') || order.includes('ba'), 'the zone jobs really interleaved: ' + order);
  assert.equal(h.result(a).result.created.length, 1, JSON.stringify(h.result(a)));
  assert.equal(h.messages[resultIndex(h, b)].result.created.length, 1, JSON.stringify(h.messages[resultIndex(h, b)]));
});
