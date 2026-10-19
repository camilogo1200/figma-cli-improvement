import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutFootprint, findSpace, positionedCommand, overlap } from '../src/lib/bridge-layout.js';

test('automatic arrangement leaves space for effects and preserves relative positions', () => {
  const cmd = { op: 'create', specs: [{ w: 120, h: 80, effects: [{ blur: 12 }] }, { w: 100, h: 150 }] };
  const size = layoutFootprint(cmd), rect = findSpace(size, [{ x: -50, y: -50, width: 500, height: 300 }]);
  assert.equal(rect.y, 298);
  assert.equal(overlap(size.placed[0].rect, size.placed[1].rect, 24), false);
  const placed = positionedCommand(cmd, size, rect, 'page1');
  assert.equal(placed.parent, 'page1'); assert.equal(placed.select, false); assert.equal(placed.zoom, false);
  assert.equal(placed.specs[1].x - placed.specs[0].x, size.placed[1].x - size.placed[0].x);
  assert.equal(cmd.specs[0].x, undefined);
  const explicit = layoutFootprint({ specs: [{ x: -100, y: -500, w: 50, h: 60 }, { x: 200, y: -100, w: 80, h: 100 }] });
  assert.equal(positionedCommand({}, explicit, findSpace(explicit, []), 'p').specs[1].y, 402);
});

test('placement avoids live artwork and durable reservations, including large gutters', () => {
  const size = { x: 0, y: 0, width: 150, height: 100 };
  const obstacles = [{ x: -10, y: -5, width: 200, height: 80 }, { x: 0, y: 160, width: 200, height: 100, gutter: 70 }, { x: 1000, y: 0, width: 100, height: 5000 }];
  const rect = findSpace(size, obstacles);
  assert.equal(rect.y, 330);
  for (const r of obstacles) assert.equal(overlap(rect, r, Math.max(48, r.gutter || 0)), false);
  // A gap before a later obstacle is usable; do not always append below everything.
  assert.equal(findSpace(size, [{ x: 0, y: 1000, width: 1000, height: 500 }]).y, 0);
});

test('unsafe or ambiguous dimensions fail before creating any nodes', () => {
  for (const specs of [[{w:'hug',h:100}], [{w:100,h:100,x:1}], [{w:100,h:100,x:0,y:0},{w:100,h:100,x:50,y:50}], [{w:100,h:100,effects:[null]}], {length:1}]) {
    assert.throws(()=>layoutFootprint({specs}), { kind:'layout-size-required',outcome:'not-started' });
  }
  assert.throws(()=>findSpace({x:0,y:0,width:100,height:100},[{x:NaN,y:0,width:1,height:1}]), {kind:'layout-size-required'});
});
