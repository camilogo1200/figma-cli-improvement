// Run against an explicitly selected, empty QA page. Keep the fixture for playback.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { forFile } from '../../file-client.mjs';

const paint = (op, nodeId, extra) => ({ op, nodeId, property: 'fills', paintIndex: 0, ...extra });
const transition = { type: 'SMART_ANIMATE', easing: { type: 'EASE_OUT' }, duration: 0.36 };
const viewports = [
  { name: 'Outfit', label: 'Choose shirt', w: 240, h: 160 },
  { name: 'Shirt', label: 'Back to outfit', w: 200, h: 140 },
];

function screen({ name, label, w, h }, index, component) {
  return { name, w, h, x: 320 * index, y: 0, clip: true, children: [
    { type: 'INSTANCE', name: 'Stage', of: component, x: 0, y: 0 },
    { type: 'RECT', name: 'Light', w, h, x: 0, y: 0, fill: { type: 'GRADIENT_LINEAR', angle: 90, stops: ['#FFFFFF00', '#FFFFFF20'] } },
    { type: 'TEXT', name: 'Heading', text: name, size: 16, color: '#FFFFFF', x: 40, y: 10 },
    { type: 'RECT', name: 'Control', x: 40, y: 40, w: 100, h: 40, fill: '#D4AD68', radius: 6 },
    { type: 'TEXT', name: 'Label', text: label, size: 11, color: '#231D19', x: 49, y: 44 },
    { type: 'RECT', name: label, x: 40, y: 40, w: 100, h: 40, fill: '#FFFFFF00' },
  ] };
}

async function capture(client, frames) {
  const captures = [];
  for (const { id, w, h } of frames) {
    const image = await client.cmd({ op: 'exportImage', id, format: 'PNG', scale: 1 });
    const png = PNG.sync.read(Buffer.from(image.base64, 'base64'));
    assert.equal(png.width, w); assert.equal(png.height, h);
    const pixel = (x, y) => Array.from(png.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
    captures.push({ data: png.data, stage: pixel(12, 12), control: pixel(60, 60) });
  }
  return captures;
}
const closeColors = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1);

// Only the two concrete click navigations in this fixture establish routes.
export function verifyFixtureGraph(frames, controls, graph) {
  const ids = new Set(graph.frames.map(f => f.id));
  assert.deepEqual(ids, new Set(frames.map(f => f.id)));
  assert.deepEqual(graph.starts, [{ nodeId: frames[0].id, name: 'Desktop' }]);
  for (const [i, frame] of frames.entries()) {
    const dest = frames[1 - i].id, label = frame.name + ' / ' + controls[i].name + ' ON_CLICK → ' + dest;
    const link = graph.reactions.find(r => r.sourceNodeId === controls[i].id && r.sourceFrameId === frame.id &&
      r.effectiveVisible && r.trigger?.type === 'ON_CLICK' && r.reactionIndex === 0);
    assert.ok(link, 'Missing ' + label);
    const [action] = link.actions;
    assert.ok(ids.has(action?.destinationId), 'Dangling destination ' + action?.destinationId + ' for ' + label);
    assert.equal(action.type, 'NODE', label); assert.equal(action.navigation, 'NAVIGATE', label);
    assert.equal(action.destinationId, dest, label);
    if (i === 0) {
      assert.equal(action.transition?.type, transition.type, label); assert.equal(action.transition.easing.type, transition.easing.type, label);
      assert.ok(Math.abs(action.transition.duration - transition.duration) < 0.00001, label);
    }
  }
  assert.equal(graph.reactions.length, 2);
}

async function runFixture(fileKey, pageId, report) {
  assert.ok(fileKey && pageId, 'Supply the disposable file key and empty page ID');
  const client = forFile(fileKey, undefined, { agentId: 'variables-qa' });
  const peer = forFile(fileKey, undefined, { agentId: 'variables-qa-peer' });
  const reader = forFile(fileKey, undefined, { agentId: 'prototype-qa' });
  try {
    const identity = await client.cmd({ op: 'verifyFile', expectedFileKey: fileKey });
    assert.ok(identity.capabilities.localColorVariables >= 1 && identity.capabilities.prototypeInspection >= 1, 'Open the updated plugin in the QA file');
    const pages = await client.cmd({ op: 'page', action: 'list' });
    const page = pages.find(p => p.id === pageId);
    assert.ok(page, 'QA page does not exist'); Object.assign(report, { file: identity.file, fileKey, page });
    assert.equal((await client.cmd({ op: 'children', id: pageId })).length, 0, 'Choose an empty QA page for this fixture');
    const create = specs => client.cmd({ op: 'create', parent: pageId, placement: 'manual', select: false, zoom: false, specs });
    const [component] = (await create([{ type: 'COMPONENT', name: 'QA / Stage', x: -320, y: 0, w: 240, h: 160, fill: '#332A45' }])).created;
    const frames = (await create(viewports.map((v, i) => screen(v, i, component.id)))).created;
    report.frames = frames; report.componentId = component.id;
    const children = await client.cmdBatch(frames.map(f => ({ op: 'children', id: f.id })));
    const stages = children.map(r => r.result.find(n => n.name === 'Stage').id);
    const controls = children.map((r, i) => r.result.find(n => n.name === viewports[i].label));
    const inspect = async () => (await client.cmdBatch(stages.map(id => paint('variables.inspectPaint', id)))).map(r => r.result);
    report.beforeBinding = await inspect();
    const upsert = { op: 'variables.upsertColor', collectionName: 'QA Studio ' + randomUUID().slice(0, 8), name: 'Stage/Background', value: '#332A45' };
    const receipts = await Promise.all([client.cmd(upsert), peer.cmd(upsert)]);
    const token = receipts[0];
    assert.equal(token.variableId, receipts[1].variableId); assert.equal(token.collectionId, receipts[1].collectionId);
    for (const flag of ['createdCollection', 'createdVariable', 'changed']) assert.equal(receipts.filter(r => r[flag]).length, 1);
    assert.equal((await client.cmd(upsert)).changed, false);
    const list = { op: 'variables.list', type: 'COLOR', collectionId: token.collectionId };
    const discovery = await reader.cmd(list);
    assert.equal(discovery.collections.length, 1); assert.equal(discovery.variables.length, 1);
    assert.equal(discovery.variables[0].id, token.variableId);
    const original = discovery.variables[0].valuesByMode[token.modeId];
    const write = value => client.cmd({ op: upsert.op, variableId: token.variableId, collectionId: token.collectionId, modeId: token.modeId, value });
    const bind = paint('variables.bindPaint', component.id, { variableId: token.variableId });
    assert.equal((await client.cmd(bind)).changed, true); assert.equal((await client.cmd(bind)).changed, false);
    async function verifyConsumers(hex) {
      const values = await inspect();
      for (const v of values) {
        assert.equal(v.mainComponentId, component.id); assert.equal(v.boundVariableId, token.variableId);
        assert.equal(v.effectiveModeId, token.modeId); assert.equal(v.resolvedHex, hex);
      }
      return values.map(v => v.resolvedHex);
    }
    report.variable = { collection: upsert.collectionName, variableId: token.variableId, collectionId: token.collectionId, modeId: token.modeId, stages };
    report.original = await verifyConsumers('#332A45FF');
    const baseline = await capture(client, frames);
    try {
      await write('#13634D'); report.test = await verifyConsumers('#13634DFF');
      const green = await capture(client, frames);
      report.samples = green.map((p, i) => ({ frameId: frames[i].id, stageBefore: baseline[i].stage, stageAfter: p.stage, controlBefore: baseline[i].control, controlAfter: p.control }));
      for (const sample of report.samples) {
        assert.ok(!closeColors(sample.stageBefore, sample.stageAfter)); assert.ok(closeColors(sample.controlBefore, sample.controlAfter));
      }
      report.colorTest = 'passed';
    } finally {
      // Requery on the original highway. A held write requires reconciliation.
      try {
        const current = (await client.cmd(list)).variables.find(v => v.id === token.variableId);
        if (!current) throw Error('Test variable disappeared before restoration');
        if (!['r', 'g', 'b', 'a'].every(k => original[k] === current.valuesByMode[token.modeId][k])) await write(original);
        report.restored = await verifyConsumers('#332A45FF');
        const restored = await capture(client, frames);
        assert.ok(restored.every((p, i) => closeColors(p.data, baseline[i].data)), 'Restored export differs from its baseline');
        report.restoration = 'passed';
      } catch (err) { report.restoration = err.message; }
    }
    assert.equal(report.restoration, 'passed');
    await client.cmdBatch([
      ...controls.map((n, i) => ({ op: 'reactions', id: n.id, reactions: [{ to: frames[1 - i].id, ...(i === 0 ? { transition } : {}) }] })),
      { op: 'flowStart', pageId, id: frames[0].id, name: 'Desktop' },
    ]);
    await reader.close();
    const graph = { frames: [], starts: [], reactions: [] }; let cursor;
    do {
      const part = await reader.cmd({ op: 'prototype.inspect', rootId: pageId, includeFlowStarts: true, limit: 1, ...(cursor ? { cursor } : {}) });
      graph.frames.push(...part.frames); graph.starts.push(...part.flowStartingPoints); graph.reactions.push(...part.reactions); cursor = part.nextCursor;
    } while (cursor);
    verifyFixtureGraph(frames, controls, graph); report.graph = graph;
  } finally { await Promise.all([client.close(), peer.close(), reader.close()]); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const report = { colorTest: 'pending', restoration: 'pending', playback: 'pending' };
  try { await runFixture(process.argv[2], process.argv[3], report); }
  catch (err) { report.error = { message: err.message, kind: err.kind, outcome: err.outcome, details: err.details, results: err.results }; process.exitCode = 1; }
  console.log(JSON.stringify(report, null, 2));
}
