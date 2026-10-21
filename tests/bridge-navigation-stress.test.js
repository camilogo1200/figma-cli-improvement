import test from 'node:test';
import assert from 'node:assert/strict';
import { geometricFixture, randomPages, stressPlan, observePageChange, runStress } from './live/navigation-stress.mjs';
import { layoutFootprint } from '../src/lib/bridge-layout.js';

test('stress fixture preserves 24 independent measured roots and 1008 mixed geometric nodes', () => {
  const roots = geometricFixture('test');
  assert.equal(roots.length, 24); assert.equal(roots.reduce((n, r) => n + 1 + r.children.length, 0), 1008);
  assert.ok(roots.every(r => r.w === 180 && r.h === 240));
  assert.ok(roots[0].children.some(n => n.fill === 'none' && n.stroke));
  assert.ok(roots[0].children.some(n => n.fill !== 'none'));
  assert.doesNotThrow(() => layoutFootprint({ specs: roots }));
});

test('seeded navigation is repeatable, covers pages, and never immediately repeats a page', () => {
  const order = randomPages(20261020, 30, 3);
  assert.deepEqual(order, randomPages(20261020, 30, 3));
  assert.equal(new Set(order).size, 3); assert.ok(order.every((p, i) => !i || p !== order[i - 1]));
  assert.notDeepEqual(order, randomPages(20261021, 30, 3));
});

test('stress plan contends on one page first and then distributes callers across pages', () => {
  const plan = stressPlan();
  assert.equal(plan.jobs.length, 6); assert.equal(plan.totalNodes, 6048);
  assert.ok(plan.jobs.filter(j => j.round === 0).every(j => j.pageIndex === 0));
  assert.equal(new Set(plan.jobs.filter(j => j.round === 1).map(j => j.pageIndex)).size, 3);
});

test('UI concurrency evidence excludes queued switches, external jobs and between-job changes', () => {
  const owned = new Set(['ours']), before = { pageId: 'a', requestId: 'ours', phase: 'creating', workloadMode: 'ui' };
  assert.equal(observePageChange(before, { ...before, pageId: 'b' }, owned), true);
  assert.equal(observePageChange(before, { ...before, pageId: 'b', phase: 'planning' }, owned), false);
  assert.equal(observePageChange(before, { ...before, pageId: 'b', requestId: 'other' }, owned), false);
  assert.equal(observePageChange(before, before, owned), false);
  assert.equal(observePageChange({ ...before, workloadMode: 'queued' },
    { ...before, pageId: 'b', workloadMode: 'queued' }, owned), false);
  assert.equal(observePageChange({ ...before, workloadMode: 'queued' },
    { ...before, pageId: 'b' }, owned), false);
});

test('live stress refuses an active file before sending any plugin command', async () => {
  let calls = 0;
  const api = { health: async () => ({}), assertDaemon() {},
    coordinate: async () => ({ workers: [{ connected: true, fileKey: 'fileA', current: { requestId: 'existing' } }] }),
    cmd: async () => { calls++; } };
  await assert.rejects(runStress({ fileKey: 'fileA', mode: 'all' }, { api }), /idle/);
  assert.equal(calls, 0);
});
