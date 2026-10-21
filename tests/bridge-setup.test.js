import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PairingApprovals } from '../src/lib/bridge-pairing.js';
import { registration, withRegistration, registerInFigma, PLUGIN_ID } from '../cli/figma-plugins.mjs';
import { pickFile } from '../cli/index.mjs';

const flush = () => new Promise(r => setImmediate(r));
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ultimate-setup-'));
  t.after(() => { if (dirname(resolve(dir)) !== resolve(tmpdir()) || realpathSync(dir) !== resolve(dir)) throw Error('Unsafe cleanup'); rmSync(dir, { recursive: true }); });
  return dir;
}

test('a terminal that is watching answers pairing requests and keeps the dialog closed', async () => {
  let dialogs = 0;
  const approvals = new PairingApprovals({ dialog: async () => { dialogs++; return false; } });
  assert.deepEqual(approvals.list(), []);
  const approved = approvals.approve({ file: 'Checkout', challenge: '123456' });
  const [request] = approvals.list();
  assert.equal(request.file, 'Checkout'); assert.equal(request.challenge, '123456');
  assert.equal(dialogs, 0);
  assert.equal(approvals.answer(request.id, true), true);
  assert.equal(await approved, true);
  assert.deepEqual(approvals.list(), []);
  assert.equal(approvals.answer(request.id, true), false, 'an answered request cannot be answered twice');
});

test('without a terminal the dialog decides, and a terminal answer closes an open dialog', async () => {
  let now = 0, dialogSignal, resolveDialog;
  const approvals = new PairingApprovals({ now: () => now, dialog: ({ signal }) => { dialogSignal = signal; return new Promise(r => { resolveDialog = r; }); } });
  now = 10000;
  const byDialog = approvals.approve({ file: 'A', challenge: '111111' });
  resolveDialog(true); assert.equal(await byDialog, true);
  const declined = approvals.approve({ file: 'B', challenge: '222222' });
  resolveDialog(false); assert.equal(await declined, false);
  const byTerminal = approvals.approve({ file: 'C', challenge: '333333' });
  const [request] = approvals.list();
  approvals.answer(request.id, true);
  assert.equal(await byTerminal, true); assert.equal(dialogSignal.aborted, true);
});

test('a closed plugin or a full queue never leaves an approvable request behind', async () => {
  const approvals = new PairingApprovals({ dialog: null });
  const controller = new AbortController();
  const gone = approvals.approve({ file: 'A', challenge: '111111', signal: controller.signal });
  controller.abort();
  assert.equal(await gone, false); assert.deepEqual(approvals.list(), []);
  const waiting = Array.from({ length: 8 }, (_, i) => approvals.approve({ file: 'F' + i, challenge: '000000' }));
  assert.equal(await approvals.approve({ file: 'overflow', challenge: '999999' }), false);
  for (const r of approvals.list()) approvals.answer(r.id, false);
  assert.deepEqual(await Promise.all(waiting), Array(8).fill(false));
});

// Shapes as Figma Desktop writes them in settings.json → localFileExtensions.
function figmaSettings(manifestDir) {
  return {
    themePreference: 'system',
    localFileExtensions: [
      { id: 2, manifestPath: join('C:', 'Downloads', 'figma-cli', 'plugin', 'code.js'), fileMetadata: { type: 'code', manifestFileId: 1 } },
      { id: 3, manifestPath: join('C:', 'Downloads', 'figma-cli', 'plugin', 'ui.html'), fileMetadata: { type: 'ui', manifestFileId: 1 } },
      { id: 1, manifestPath: join(manifestDir, 'old', 'manifest.json'), lastKnownName: 'figma-cli-ultimate', lastKnownPluginId: 'insula-figma-cli-structured',
        fileMetadata: { type: 'manifest', codeFileId: 4, uiFileIds: [7] }, cachedContainsWidget: false },
      { id: 4, manifestPath: join(manifestDir, 'old', 'code.js'), fileMetadata: { type: 'code', manifestFileId: 1 } },
      { id: 7, manifestPath: join(manifestDir, 'old', 'ui.html'), fileMetadata: { type: 'ui', manifestFileId: 1 } },
      { id: 20, manifestPath: join('C:', 'other', 'manifest.json'), lastKnownName: 'Other plugin', lastKnownPluginId: '123',
        fileMetadata: { type: 'manifest', codeFileId: 21, uiFileIds: [22] }, cachedContainsWidget: false },
      { id: 21, manifestPath: join('C:', 'other', 'code.js'), fileMetadata: { type: 'code', manifestFileId: 20 } },
      { id: 22, manifestPath: join('C:', 'other', 'ui.html'), fileMetadata: { type: 'ui', manifestFileId: 20 } },
    ],
  };
}

test('registration keeps exactly one copy of this plugin and never touches other plugins', () => {
  const base = join(tmpdir(), 'figma-ultimate-fixture'), manifest = join(base, 'plugin', 'manifest.json');
  const before = figmaSettings(base);
  const found = registration(before, manifest);
  assert.equal(found.registered, false); assert.equal(found.copies.length, 1); assert.equal(found.orphans.length, 2);
  const { settings, changed, removed } = withRegistration(before, manifest);
  assert.equal(changed, true); assert.equal(removed, 3);
  assert.equal(settings.themePreference, 'system');
  const list = settings.localFileExtensions, byId = new Map(list.map(e => [e.id, e]));
  assert.equal(byId.size, list.length, 'ids stay unique');
  assert.deepEqual(list.filter(e => [20, 21, 22].includes(e.id)), before.localFileExtensions.filter(e => [20, 21, 22].includes(e.id)));
  const ours = list.filter(e => e.fileMetadata.type === 'manifest' && e.lastKnownPluginId === PLUGIN_ID);
  assert.equal(ours.length, 1); assert.equal(ours[0].manifestPath, manifest);
  assert.equal(byId.get(ours[0].fileMetadata.codeFileId).manifestPath, join(base, 'plugin', 'code.js'));
  assert.equal(byId.get(ours[0].fileMetadata.uiFileIds[0]).manifestPath, join(base, 'plugin', 'ui.html'));
  assert.ok(!list.some(e => String(e.manifestPath).includes('Downloads') || String(e.manifestPath).includes('old')));
  assert.equal(registration(settings, manifest).registered, true);
  assert.equal(withRegistration(settings, manifest).changed, false, 'a clean registration is left as it is');
  assert.equal(withRegistration({}, manifest).settings.localFileExtensions.length, 3);
});

test('editing Figma settings requires Figma closed, keeps a backup and writes atomically', async t => {
  const dir = scratch(t), path = join(dir, 'settings.json'), manifest = join(dir, 'plugin', 'manifest.json');
  const original = JSON.stringify(figmaSettings(dir));
  writeFileSync(path, original);
  await assert.rejects(registerInFigma({ path, manifestPath: manifest, running: async () => true }), /Quit Figma Desktop first/);
  assert.equal(readFileSync(path, 'utf8'), original);
  const result = await registerInFigma({ path, manifestPath: manifest, running: async () => false });
  assert.equal(result.changed, true); assert.equal(readFileSync(result.backup, 'utf8'), original);
  assert.equal(registration(JSON.parse(readFileSync(path, 'utf8')), manifest).registered, true);
  assert.deepEqual(await registerInFigma({ path, manifestPath: manifest, running: async () => true }), { changed: false }, 'nothing to do needs no restart');
  assert.ok(!readdirSync(dir).some(f => f.endsWith('.tmp')));
  await assert.rejects(registerInFigma({ path: join(dir, 'missing.json'), manifestPath: manifest }), /settings were not found/);
  assert.equal(existsSync(join(dir, 'missing.json')), false);
});

test('commands pick one connected file by key, name or unique part of the name', () => {
  const files = [
    { workerId: 'w1', fileKey: 'KEY1', file: 'Checkout flows' },
    { workerId: 'w2', fileKey: 'KEY2', file: 'Brand library' },
    { workerId: 'w3', fileKey: 'KEY3', file: 'Brand library v2' },
  ];
  assert.equal(pickFile(files, 'KEY2').workerId, 'w2');
  assert.equal(pickFile(files, 'checkout').workerId, 'w1');
  assert.equal(pickFile(files, 'brand library').workerId, 'w2', 'an exact name wins over a longer match');
  assert.throws(() => pickFile(files, 'brand'), { kind: 'ambiguous-file' });
  assert.throws(() => pickFile(files), { kind: 'ambiguous-file' });
  assert.equal(pickFile(files.slice(0, 1)).workerId, 'w1');
  assert.throws(() => pickFile([]), { kind: 'plugin-offline' });
});
