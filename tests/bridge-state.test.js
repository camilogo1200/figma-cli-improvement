import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateState } from '../bridge/migrate-state.mjs';
import { request } from '../bridge/fig.mjs';
import { PROJECT_ROOT } from '../src/lib/bridge-build.js';

const exec = promisify(execFile);
const stateURL = new URL('../src/lib/bridge-state.js', import.meta.url).href;
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'ultimate-state-test-'));
  t.after(() => {
    if (dirname(resolve(home)) !== resolve(tmpdir()) || realpathSync(home) !== resolve(home)) throw Error('Unsafe cleanup target');
    rmSync(home, { recursive: true, force: true });
  });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.FIGMA_ULTIMATE_STATE_DIR;
  // shared: the original figma-cli's folder. previous: this bridge before 3.0.
  return { home, env, shared: join(home, '.figma-ds-cli'), previous: join(home, '.insula-figma-cli'), state: join(home, '.figma-cli-ultimate') };
}
const run = (env, code) => exec(process.execPath, ['--input-type=module', '-e', code], { env, windowsHide: true, timeout: 5000 });
const probe = `import {STATE_DIR,PID_FILE,TOKEN_FILE,ensureToken} from ${JSON.stringify(stateURL)};
  ensureToken(); console.log(JSON.stringify({STATE_DIR,PID_FILE,TOKEN_FILE}));`;

test('all default clients isolate PID and token; custom state cannot opt into the original figma-cli directory', async t => {
  const { home, env, shared, state } = fixture(t);
  const paths = JSON.parse((await run(env, probe)).stdout);
  assert.deepEqual(paths, { STATE_DIR: state, PID_FILE: join(state, 'daemon.pid'), TOKEN_FILE: join(state, '.daemon-token') });
  assert.equal(existsSync(join(home, '.figma-cli-daemon.pid')), false);
  assert.equal(existsSync(shared), false);
  const custom = join(home, 'custom');
  assert.equal(JSON.parse((await run({ ...env, FIGMA_ULTIMATE_STATE_DIR: custom }, probe)).stdout).PID_FILE, join(custom, 'daemon.pid'));
  await assert.rejects(run({ ...env, FIGMA_ULTIMATE_STATE_DIR: join(shared, '..', '.figma-ds-cli') }, probe), /cannot use the original figma-cli state directory/);
});

test('migration from the previous version preserves durable state and is required before startup; its PID/token stay untouched', async t => {
  const { home, env, previous, state } = fixture(t);
  mkdirSync(previous);
  const journal = JSON.stringify({ schema: 1, fence: 7, records: [], fileHolds: [{ fileKey: 'held-file', state: 'held' }], taskLanes: [] });
  const pairing = JSON.stringify({ schema: 1, records: [{ hash: 'a'.repeat(64), createdAt: 123 }] });
  writeFileSync(join(previous, 'coordinator-journal.json'), journal);
  writeFileSync(join(previous, 'paired-computers.json'), pairing);
  writeFileSync(join(previous, '.daemon-token'), 'foreign-token');
  writeFileSync(join(previous, 'daemon.pid'), '123');
  writeFileSync(join(home, '.figma-cli-daemon.pid'), '456');
  await assert.rejects(run(env, probe), /have not been moved yet/);
  const result = migrateState({ source: previous, target: state });
  assert.deepEqual(result.preserved, ['coordinator-journal.json', 'paired-computers.json']);
  assert.equal(readFileSync(join(state, 'coordinator-journal.json'), 'utf8'), journal);
  assert.equal(readFileSync(join(state, 'paired-computers.json'), 'utf8'), pairing);
  assert.equal(existsSync(join(state, '.daemon-token')), false);
  assert.equal(existsSync(join(state, 'daemon.pid')), false);
  assert.deepEqual(migrateState({ source: previous, target: state }), result);
  await run(env, probe);
  assert.notEqual(readFileSync(join(state, '.daemon-token'), 'utf8'), 'foreign-token');
  assert.equal(readFileSync(join(previous, '.daemon-token'), 'utf8'), 'foreign-token');
  assert.equal(readFileSync(join(previous, 'daemon.pid'), 'utf8'), '123');
  assert.equal(readFileSync(join(home, '.figma-cli-daemon.pid'), 'utf8'), '456');
  assert.equal(readFileSync(join(previous, 'coordinator-journal.json'), 'utf8'), journal);
  assert.equal(readFileSync(join(previous, 'paired-computers.json'), 'utf8'), pairing);
});

test('migration refuses invalid or conflicting state without overwriting either destination file', t => {
  const { previous, state } = fixture(t);
  mkdirSync(previous); mkdirSync(state);
  writeFileSync(join(previous, 'coordinator-journal.json'), '{broken');
  assert.throws(() => migrateState({ source: previous, target: state }));
  assert.equal(existsSync(join(state, 'coordinator-journal.json')), false);
  writeFileSync(join(previous, 'coordinator-journal.json'), JSON.stringify({ schema: 1, fence: 1, records: [] }));
  writeFileSync(join(previous, 'paired-computers.json'), JSON.stringify({ schema: 1, records: [] }));
  writeFileSync(join(state, 'paired-computers.json'), 'destination must survive');
  assert.throws(() => migrateState({ source: previous, target: state }), /Destination state differs/);
  assert.equal(existsSync(join(state, 'coordinator-journal.json')), false);
  assert.equal(readFileSync(join(state, 'paired-computers.json'), 'utf8'), 'destination must survive');
});

test('the bridge survives the original figma-cli stopping its PID and rotating its token', { timeout: 15000 }, async t => {
  const { home, env, shared, state } = fixture(t);
  mkdirSync(shared);
  const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env, windowsHide: true, stdio: 'ignore' });
  await once(foreign, 'spawn');
  const sharedPid = join(home, '.figma-cli-daemon.pid');
  writeFileSync(sharedPid, String(foreign.pid));
  writeFileSync(join(shared, '.daemon-token'), 'old-foreign-token');
  const child = spawn(process.execPath, [join(PROJECT_ROOT, 'src/daemon.js')], {
    env: { ...env, FIGMA_ULTIMATE_PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    for (const process of [child, foreign]) if (process.exitCode === null) { const exited = once(process, 'exit'); process.kill(); await exited; }
  });
  let log = '', errors = '';
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { errors += b; });
  const end = Date.now() + 5000;
  while (!log.includes('daemon-start') && child.exitCode === null && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.equal(child.exitCode, null, errors);
  const start = log.split('\n').map(s => { try { return JSON.parse(s); } catch { return {}; } }).find(s => s.event === 'daemon-start');
  assert.ok(start, errors || log);
  const token = readFileSync(join(state, '.daemon-token'), 'utf8');
  const api = (path, options = {}) => request(path, { port: start.port, tokenValue: token, ...options });
  assert.equal((await api('/health')).pid, child.pid);
  assert.equal((await api('/health')).stateDirectory, state);
  assert.equal(readFileSync(sharedPid, 'utf8'), String(foreign.pid));
  // Reproduce the other CLI's PID-driven stop and token rotation in a fake
  // home only. Never run a real connect command against the user's Figma.
  const foreignExited = once(foreign, 'exit');
  await run(env, `import {readFileSync,unlinkSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path'; import {homedir} from 'node:os';
    const pidPath=join(homedir(),'.figma-cli-daemon.pid');
    const pid=Number(readFileSync(pidPath,'utf8'));
    if(pid!==${foreign.pid}) throw Error('Unexpected fixture PID');
    process.kill(pid,'SIGTERM'); unlinkSync(pidPath);
    writeFileSync(join(homedir(),'.figma-ds-cli','.daemon-token'),'rotated-foreign-token');`);
  await foreignExited;
  assert.equal((await api('/health')).pid, child.pid);
  assert.equal(readFileSync(join(state, '.daemon-token'), 'utf8'), token);
  assert.equal(readFileSync(join(state, 'daemon.pid'), 'utf8'), String(child.pid));
  await assert.rejects(api('/health', { tokenValue: 'rotated-foreign-token' }), { kind: 'unauthorized' });
  const clientURL = new URL('../bridge/fig.mjs', import.meta.url).href;
  const clientHealth = JSON.parse((await run({ ...env, FIGMA_ULTIMATE_PORT: String(start.port) }, `import {health} from ${JSON.stringify(clientURL)}; console.log(JSON.stringify(await health()));`)).stdout);
  assert.equal(clientHealth.pid, child.pid);
  const exited = once(child, 'exit');
  await api('/shutdown', { payload: { expectedRoot: start.root, expectedDaemonBuild: start.daemonBuild, protocol: start.protocol } });
  await exited;
  assert.equal(existsSync(join(state, 'daemon.pid')), false);
  assert.equal(readFileSync(join(shared, '.daemon-token'), 'utf8'), 'rotated-foreign-token');
});
