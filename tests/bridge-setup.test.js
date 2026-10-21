import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PairingApprovals } from '../src/lib/bridge-pairing.js';
import { registration, withRegistration, registerInFigma, PLUGIN_ID } from '../cli/figma-plugins.mjs';
import { pickFile } from '../cli/index.mjs';
import { installSkills, bundledSkills, skillTargets, SKILLS_DIR, RECEIPT } from '../cli/skills.mjs';

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

// ---- agent skills ----
const writeTree = (dir, files) => { for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); } };
const skillFiles = (path, names) => Object.fromEntries(names.map(n => [n, readFileSync(join(path, n), 'utf8')]));

test('the bundled skills follow the Agent Skills format', () => {
  const skills = bundledSkills();
  assert.deepEqual(skills.map(s => s.name), ['figma-ultimate', 'figma-ultimate-setup']);
  for (const skill of skills) {
    const text = skill.files.get('SKILL.md').toString('utf8').replace(/\r\n/g, '\n');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    assert.ok(front, `${skill.name} starts with frontmatter`);
    assert.equal(/^name: (.+)$/m.exec(front)?.[1], skill.name, 'name matches the folder');
    const description = /^description: (.+)$/m.exec(front)?.[1] || '';
    assert.ok(description.length > 80 && description.length <= 1024, `${skill.name} has a usable description`);
    assert.ok(text.split('\n').length < 500, 'SKILL.md stays short; detail goes into references/');
    for (const [, link] of text.matchAll(/\]\((references\/[^)#]+)/g)) assert.ok(skill.files.has(link), `${skill.name} links to ${link}`);
  }
  assert.ok(['spec.md', 'recovery.md', 'commands.md'].every(f => skills[0].files.has('references/' + f)));
});

test('skills install into the Claude Code and Codex layouts, for the user and for a project', t => {
  const dir = scratch(t), home = join(dir, 'home'), cwd = join(dir, 'project'), env = {};
  const names = bundledSkills().map(s => s.name);
  const user = installSkills({ home, cwd, env, version: '3.0.0' });
  assert.deepEqual(user.map(r => [r.agent, r.state]), [['Claude Code', 'installed'], ['Claude Code', 'installed'], ['Codex', 'installed'], ['Codex', 'installed']]);
  for (const base of [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')]) {
    for (const source of bundledSkills()) {
      for (const [rel, bytes] of source.files) assert.deepEqual(readFileSync(join(base, source.name, rel)), bytes, `${base} ${source.name}/${rel}`);
      const receipt = JSON.parse(readFileSync(join(base, source.name, RECEIPT), 'utf8'));
      assert.equal(receipt.version, '3.0.0'); assert.deepEqual(Object.keys(receipt.files), [...source.files.keys()]);
    }
  }
  assert.equal(existsSync(cwd), false, 'a user install writes nothing into the project');

  const claude = installSkills({ scope: 'project', codex: false, home, cwd, env });
  assert.deepEqual(claude.map(r => r.dir), names.map(n => join(cwd, '.claude', 'skills', n)));
  assert.ok(existsSync(join(cwd, '.claude', 'skills', 'figma-ultimate', 'references', 'spec.md')));
  assert.equal(existsSync(join(cwd, '.agents')), false);
  const codex = installSkills({ scope: 'project', claude: false, home, cwd, env });
  assert.deepEqual(codex.map(r => [r.dir, r.state]), names.map(n => [join(cwd, '.agents', 'skills', n), 'installed']));

  assert.equal(skillTargets({ home, env: { CLAUDE_CONFIG_DIR: join(dir, 'config') } })[0].dir, join(dir, 'config', 'skills'));
});

test('installing skills again is idempotent and updates an untouched older copy', t => {
  const dir = scratch(t), home = join(dir, 'home'), v1 = join(dir, 'v1'), v2 = join(dir, 'v2'), where = { home, cwd: dir, env: {}, codex: false };
  writeTree(v1, { 'demo/SKILL.md': '---\nname: demo\ndescription: v1\n---\n', 'demo/references/old.md': 'old' });
  writeTree(v2, { 'demo/SKILL.md': '---\nname: demo\ndescription: v2\n---\n', 'demo/references/new.md': 'new' });
  const installed = join(home, '.claude', 'skills', 'demo');
  assert.equal(installSkills({ source: v1, version: '1', ...where })[0].state, 'installed');
  const before = readdirSync(installed, { recursive: true }).sort();
  assert.equal(installSkills({ source: v1, version: '1', ...where })[0].state, 'unchanged');
  assert.deepEqual(readdirSync(installed, { recursive: true }).sort(), before);

  assert.equal(installSkills({ source: v2, version: '2', ...where })[0].state, 'updated');
  assert.deepEqual(skillFiles(installed, ['SKILL.md', 'references/new.md']), { 'SKILL.md': '---\nname: demo\ndescription: v2\n---\n', 'references/new.md': 'new' });
  assert.equal(existsSync(join(installed, 'references', 'old.md')), false, 'a file the old version installed is removed');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(installed, RECEIPT), 'utf8')).files), ['SKILL.md', 'references/new.md']);
  assert.equal(installSkills({ source: v2, version: '2', ...where })[0].state, 'unchanged');

  // An identical copy that was put there by hand is adopted, not reported as edited.
  const copied = join(dir, 'copied');
  writeTree(join(copied, '.claude', 'skills', 'demo'), { 'SKILL.md': '---\nname: demo\ndescription: v2\n---\n', 'references/new.md': 'new' });
  assert.equal(installSkills({ source: v2, version: '2', ...where, scope: 'project', cwd: copied })[0].state, 'unchanged');
  assert.ok(existsSync(join(copied, '.claude', 'skills', 'demo', RECEIPT)));
});

test('a skill edited by hand is never overwritten without --force', t => {
  const dir = scratch(t), home = join(dir, 'home'), v1 = join(dir, 'v1'), v2 = join(dir, 'v2'), where = { home, cwd: dir, env: {}, claude: false };
  writeTree(v1, { 'demo/SKILL.md': 'v1', 'demo/references/a.md': 'a1' });
  writeTree(v2, { 'demo/SKILL.md': 'v2', 'demo/references/a.md': 'a2' });
  const installed = join(home, '.agents', 'skills', 'demo');
  installSkills({ source: v1, ...where });
  writeFileSync(join(installed, 'references', 'a.md'), 'my notes');
  writeFileSync(join(installed, 'mine.md'), 'extra file of my own');
  for (const source of [v1, v2]) {
    const [result] = installSkills({ source, ...where });
    assert.equal(result.state, 'modified'); assert.deepEqual(result.edited, ['references/a.md']);
    assert.deepEqual(skillFiles(installed, ['SKILL.md', 'references/a.md']), { 'SKILL.md': 'v1', 'references/a.md': 'my notes' });
  }
  const [forced] = installSkills({ source: v2, force: true, ...where });
  assert.equal(forced.state, 'replaced');
  assert.deepEqual(skillFiles(installed, ['SKILL.md', 'references/a.md', 'mine.md']), { 'SKILL.md': 'v2', 'references/a.md': 'a2', 'mine.md': 'extra file of my own' });

  // A folder of the same name that figma-ultimate did not install is not ours to replace.
  const foreign = join(dir, 'foreign');
  writeTree(join(foreign, '.agents', 'skills', 'demo'), { 'SKILL.md': 'someone else' });
  const [other] = installSkills({ source: v2, ...where, scope: 'project', cwd: foreign });
  assert.equal(other.state, 'modified'); assert.equal(other.edited, null);
  assert.equal(readFileSync(join(foreign, '.agents', 'skills', 'demo', 'SKILL.md'), 'utf8'), 'someone else');

  // A receipt that points outside the skill folder is not trusted, and nothing outside is touched.
  writeFileSync(join(dir, 'outside.md'), 'keep');
  writeFileSync(join(installed, RECEIPT), JSON.stringify({ files: { '../../../outside.md': 'x', 'SKILL.md': 'y' } }));
  assert.equal(installSkills({ source: v1, ...where })[0].state, 'modified');
  assert.equal(readFileSync(join(dir, 'outside.md'), 'utf8'), 'keep');
});

test('figma-ultimate skills install works from the command line', t => {
  const dir = scratch(t), home = join(dir, 'home'), project = join(dir, 'project');
  mkdirSync(project);
  const bin = fileURLToPath(new URL('../bin/figma-ultimate.mjs', import.meta.url));
  const env = { ...process.env, HOME: home, USERPROFILE: home, FIGMA_ULTIMATE_STATE_DIR: join(dir, 'state'), NO_COLOR: '1' };
  delete env.CLAUDE_CONFIG_DIR;
  const run = (...args) => execFileSync(process.execPath, [bin, 'skills', ...args], { cwd: project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(run('install', '--project'), /Claude Code · figma-ultimate: installed[\s\S]*Codex · figma-ultimate-setup: installed/);
  assert.ok(existsSync(join(project, '.claude', 'skills', 'figma-ultimate', 'SKILL.md')));
  assert.ok(existsSync(join(project, '.agents', 'skills', 'figma-ultimate-setup', 'SKILL.md')));
  assert.equal(existsSync(home), false, '--project leaves the user folders alone');
  assert.match(run('install', '--project'), /up to date/);
  assert.match(run('install', '--codex'), /Codex · figma-ultimate: installed/);
  assert.ok(existsSync(join(home, '.agents', 'skills', 'figma-ultimate', 'SKILL.md')));
  assert.equal(existsSync(join(home, '.claude')), false);

  writeFileSync(join(project, '.claude', 'skills', 'figma-ultimate', 'SKILL.md'), 'edited');
  assert.throws(() => run('install', '--project', '--claude'), e => e.status === 1 && /edited by hand/.test(e.stdout));
  assert.equal(readFileSync(join(project, '.claude', 'skills', 'figma-ultimate', 'SKILL.md'), 'utf8'), 'edited');
  assert.match(run('install', '--project', '--claude', '--force'), /replaced the edited copy/);
  assert.equal(readFileSync(join(project, '.claude', 'skills', 'figma-ultimate', 'SKILL.md'), 'utf8'), readFileSync(join(SKILLS_DIR, 'figma-ultimate', 'SKILL.md'), 'utf8'));
  assert.throws(() => run('install', '--user', '--project'), e => e.status === 1 && /not both/.test(e.stderr));
});
