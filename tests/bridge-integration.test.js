import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { buildIdentity, PROJECT_ROOT } from '../src/lib/bridge-build.js';
import { request, assertDaemon } from '../bridge/fig.mjs';

const exec = promisify(execFile);
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(10); }
  throw new Error('Condition timed out');
}
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'insula-bridge-test-'));
  t.after(() => {
    // Delete only the exact directory allocated by this test, never a computed parent.
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || realpathSync(dir) !== resolve(dir)) throw new Error('Unsafe test cleanup target');
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
test('real daemon HTTP/WebSocket lifecycle on an isolated ephemeral port', { timeout: 20000 }, async t => {
  const state = temp(t), token = 'isolated-test-token', build = buildIdentity();
  assert.equal(build.pluginStamped, true, 'Run node bridge/launcher.mjs build before integration tests');
  writeFileSync(join(state, '.daemon-token'), token);
  const child = spawn(process.execPath, [join(PROJECT_ROOT, 'src/daemon.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DAEMON_MODE: 'plugin', DAEMON_PORT: '0', FIGMA_CLI_STATE_DIR: state } });
  let logs = '', errors = ''; child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { errors += b; });
  let ws;
  t.after(async () => { ws?.terminate(); if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  await until(() => logs.includes('daemon-start') || child.exitCode !== null);
  assert.equal(child.exitCode, null, errors);
  const start = logs.split('\n').map(s => { try { return JSON.parse(s); } catch { return {}; } }).find(e => e.event === 'daemon-start');
  const port = start.port, api = (path, options = {}) => request(path, { port, tokenValue: token, ...options });
  const envelope = extra => ({ protocol: build.protocol, expectedRoot: build.root, expectedDaemonBuild: build.daemonBuild, action: 'cmd', cmd: { op: 'ping' }, ...extra });

  await t.test('health exposes provenance; authentication and stale callers are rejected', async () => {
    const h = await api('/health'); assertDaemon(h, build); assert.equal(h.plugin, false);
    await assert.rejects(api('/health', { tokenValue: 'wrong' }), { kind: 'unauthorized' });
    await assert.rejects(api('/exec', { payload: envelope({ expectedDaemonBuild: 'old' }) }), { kind: 'build-mismatch', outcome: 'not-started' });
    await assert.rejects(api('/exec', { payload: envelope() }), { kind: 'plugin-offline', outcome: 'not-started' });
    await assert.rejects(api('/exec', { payload: envelope({ action: 'lifecycle', cmd: { op: 'inspect' } }) }), { kind: 'plugin-offline', outcome: 'not-started' });
    await assert.rejects(api('/exec', { payload: { action: 'eval', code: 'danger' } }), { kind: 'unsupported', outcome: 'not-started' });
  });
  const pairing = (await api('/exec', { payload: envelope({ action: 'coordinate', cmd: { op: 'pair' } }) })).result;
  ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`); await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', protocol: build.protocol, build: build.pluginBuild, busy: false, version: 'test', pairingCode: pairing.pairingCode, instanceId: 'test-instance', fileKey: 'testFile', file: 'Test file', page: 'Test page', pageId: '1:2' }));
  await until(async () => (await api('/health')).plugin);
  const commands = [];
  const answer = msg => ws.send(JSON.stringify(msg));
  ws.on('message', b => {
    const msg = JSON.parse(b); if (!msg.action) return; commands.push(msg);
    if (msg.action === 'cancel') { answer({ type: 'result', id: msg.id, error: 'cancelled', kind: 'cancelled', outcome: 'not-started' }); return; }
    if (msg.cmd?.op === 'hold') return;
    if (msg.action === 'cmd-batch') { answer({ type: 'batch-result', id: msg.id, results: msg.cmds.map((_, i) => ({ success: i === 0, result: i, error: i ? 'failed' : undefined, outcome: i ? 'failed' : 'succeeded' })), outcome: 'partial' }); return; }
    answer({ type: 'busy', id: msg.id, busy: true, op: msg.cmd.op });
    answer({ type: 'result', id: msg.id, result: msg.cmd.op === 'layoutInfo' ? {fileKey:'testFile',pageId:msg.cmd.pageId,bounds:[{x:0,y:0,width:100,height:100}]} : msg.cmd.op === 'create' ? {created:[{id:'auto-root'}]} : { ok: true } });
    answer({ type: 'busy', id: msg.id, busy: false });
  });
  await t.test('requests settle and a second plugin cannot steal the connection', async () => {
    assert.deepEqual((await api('/exec', { payload: envelope() })).result, { ok: true });
    const other = new WebSocket(`ws://127.0.0.1:${port}/plugin`);
    await once(other, 'open');
    other.send(JSON.stringify({ type: 'hello', protocol: build.protocol, build: build.pluginBuild, busy: false, instanceId: 'other', fileKey: 'testFile' }));
    const [code] = await once(other, 'close'); assert.equal(code, 4401);
    const d = await api('/diagnostics'); assert.equal(d.bridge.pending, 0); assert.equal(d.bridge.pendingBytes, 0);
    assert.equal(d.bridge.identity.file, 'Test file'); assert.ok(d.memory.rss > 0); assert.ok(d.eventLoopDelayMs.p99 >= 0);
    await assert.rejects(api('/exec', { payload: envelope({ action: 'lifecycle', cmd: { op: 'reload', expectedFileKey: 'copyKey', sourceFileKey: 'sourceKey', expectedFileName: '__Insula disposable test' } }) }), { kind: 'wrong-file', outcome: 'not-started' });
  });
  await t.test('HTTP abort releases the pending request and cancellation acknowledgement restores readiness', async () => {
    const controller = new AbortController(), p = api('/exec', { payload: envelope({ cmd: { op: 'hold' } }), signal: controller.signal });
    const rejected = assert.rejects(p, { kind: 'client-gone', outcome: 'uncertain' });
    await until(() => commands.some(c => c.cmd?.op === 'hold'));
    await assert.rejects(api('/shutdown', { payload: envelope() }), { kind: 'worker-busy' });
    controller.abort(); await rejected;
    await until(async () => { const d = await api('/diagnostics'); return commands.some(c => c.action === 'cancel') && !d.bridge.pending && !d.bridge.uncertain; });
    assert.equal((await api('/diagnostics')).bridge.pendingBytes, 0);
  });
  await t.test('finite queue deadlines cancel and report uncertainty without replay', async () => {
    const count = commands.length;
    await assert.rejects(api('/exec', { payload: envelope({ cmd: { op: 'hold' }, queueTimeoutMs: 30 }) }), { kind: 'queue-timeout', outcome: 'uncertain' });
    await until(async () => !(await api('/diagnostics')).bridge.uncertain);
    assert.equal(commands.slice(count).filter(c => c.cmd?.op === 'hold').length, 1);
  });
  await t.test('public client rejects failed batch items and exposes results to the caller', async () => {
    const code = `import {cmdBatch} from ${JSON.stringify(new URL('../bridge/fig.mjs', import.meta.url).href)}; try { await cmdBatch([{op:'ping'},{op:'ping'}]); process.exitCode=2; } catch(e) { console.log(JSON.stringify({kind:e.kind,outcome:e.outcome,results:e.results})); }`;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, timeout: 5000,
      env: { ...process.env, DAEMON_PORT: String(port), FIGMA_CLI_STATE_DIR: state } });
    const out = JSON.parse(stdout); assert.equal(out.kind, 'batch-failed'); assert.equal(out.results[0].success, true); assert.equal(out.results[1].success, false);
  });
  await t.test('named lane API and public layout client reserve space end to end', async () => {
    const coordinate=async(cmd,coordination)=>(await api('/exec',{payload:envelope({action:'coordinate',cmd,coordination})})).result;
    const status=await coordinate({op:'status'}),w=status.workers[0];
    const route={workerId:w.workerId,sessionEpoch:w.sessionEpoch,fileKey:w.fileKey};
    const lane=await coordinate({op:'create-lane',label:'Checkout',pageId:'1:2'},route);
    assert.equal((await coordinate({op:'lanes'}))[0].state,'waiting');
    const code=`import {createLayout} from ${JSON.stringify(new URL('../bridge/fig.mjs',import.meta.url).href)}; console.log(JSON.stringify(await createLayout({w:100,h:100},{laneId:${JSON.stringify(lane.laneId)}})));`;
    const {stdout}=await exec(process.execPath,['--input-type=module','-e',code],{windowsHide:true,timeout:5000,env:{...process.env,DAEMON_PORT:String(port),FIGMA_CLI_STATE_DIR:state}});
    assert.equal(JSON.parse(stdout).created[0].id,'auto-root');
    const placed=commands.at(-1);assert.equal(placed.cmd.op,'create');assert.equal(placed.lease.laneId,lane.laneId);assert.equal(placed.cmd.specs[0].y,150);
    assert.equal((await coordinate({op:'status'})).reservations[0].state,'committed');
    assert.equal((await coordinate({op:'remove-lane',laneId:lane.laneId},route)).removed,true);
  });
  await t.test('a file client gets its own highway from the lobby and releases it when done', async () => {
    // The plugin end: dial each highway the daemon announces on the paired socket.
    const roads = [];
    ws.on('message', b => {
      const m = JSON.parse(b); if (m.type !== 'open-highway') return;
      const road = new WebSocket(`ws://127.0.0.1:${m.port}/plugin`); roads.push({ road, port: m.port });
      road.on('open', () => road.send(JSON.stringify({ type: 'hello', role: 'plugin', ticket: m.ticket, protocol: build.protocol, build: build.pluginBuild, busy: false, fileKey: 'testFile', instanceId: 'test-instance' })));
      road.on('message', data => {
        const msg = JSON.parse(data); if (!msg.action || msg.action === 'cancel') return;
        road.send(JSON.stringify({ type: 'busy', id: msg.id, busy: true, op: msg.cmd.op }));
        road.send(JSON.stringify({ type: 'result', id: msg.id, result: { viaHighway: m.port, op: msg.cmd.op } }));
        road.send(JSON.stringify({ type: 'busy', id: msg.id, busy: false }));
      });
    });
    const before = commands.length;
    const code = `import {forFile} from ${JSON.stringify(new URL('../file-client.mjs', import.meta.url).href)}; const c=forFile('testFile'); const r=await c.cmd({op:'find',name:'x'}); await c.close(); console.log(JSON.stringify(r));`;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, timeout: 8000,
      env: { ...process.env, DAEMON_PORT: String(port), FIGMA_CLI_STATE_DIR: state } });
    const result = JSON.parse(stdout);
    assert.equal(result.op, 'find'); assert.equal(result.viaHighway, roads[0].port); assert.notEqual(roads[0].port, port);
    assert.equal(commands.length, before, 'nothing went through the shared control socket');
    await until(async () => (await api('/exec', { payload: envelope({ action: 'highway', cmd: { op: 'list' } }) })).result.length === 0);
    const lobby = (await api('/diagnostics')).bridge.coordinator.lobby.map(e => e.event);
    for (const event of ['opened', 'plugin-joined', 'agent-joined', 'closed']) assert.ok(lobby.includes(event), event + ' in ' + lobby);
    // A script that never closes its client must still exit when it is done: an idle
    // highway does not hold the process open (the daemon closes it after the agent leaves).
    const forgetful = `import {forFile} from ${JSON.stringify(new URL('../file-client.mjs', import.meta.url).href)}; const c=forFile('testFile'); console.log(JSON.stringify(await c.cmd({op:'find',name:'y'})));`;
    const second = await exec(process.execPath, ['--input-type=module', '-e', forgetful], { windowsHide: true, timeout: 8000,
      env: { ...process.env, DAEMON_PORT: String(port), FIGMA_CLI_STATE_DIR: state } });
    assert.equal(JSON.parse(second.stdout).op, 'find');
    await until(async () => (await api('/diagnostics')).bridge.coordinator.lobby.some(e => e.event === 'agent-away'));
    roads.forEach(r => r.road.terminate());
  });
  await t.test('shutdown is ownership checked and drains the owned idle daemon', async () => {
    await assert.rejects(api('/shutdown', { payload: envelope({ expectedRoot: 'other' }) }), { kind: 'build-mismatch' });
    const exiting = once(child, 'exit');
    assert.equal((await api('/shutdown', { payload: envelope() })).result, 'stopping'); await exiting;
  });
});

test('public client has finite deadlines and bounds unreadable response failures', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/invalid') res.end('not-json');
    else if (req.url === '/interrupted') { res.writeHead(200); res.write('{'); setImmediate(() => res.destroy()); }
    // /stall intentionally never responds.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  await assert.rejects(request('/stall', { port, timeoutMs: 30 }), { kind: 'client-timeout', outcome: 'uncertain' });
  await assert.rejects(request('/invalid', { port }), { kind: 'daemon' });
  await assert.rejects(request('/interrupted', { port }), { kind: 'daemon-lost' });
});

test('concurrent startup token initialization never rotates an existing token', async t => {
  const state = temp(t), url = new URL('../src/lib/bridge-state.js', import.meta.url).href;
  const code = `import {ensureToken} from ${JSON.stringify(url)}; console.log(ensureToken());`;
  const run = () => exec(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, env: { ...process.env, FIGMA_CLI_STATE_DIR: state } });
  const first = (await run()).stdout.trim();
  const results = await Promise.all(Array.from({ length: 6 }, run));
  for (const r of results) assert.equal(r.stdout.trim(), first);
  assert.equal(readFileSync(join(state, '.daemon-token'), 'utf8'), first);
});

test('launcher provenance rejects a different checkout, stale daemon and wrong mode', () => {
  const good = { ...buildIdentity(), mode: 'safe' };
  assert.doesNotThrow(() => assertDaemon(good));
  for (const patch of [{ root: 'other' }, { daemonBuild: 'old' }, { protocol: 2 }, { mode: 'yolo' }]) {
    assert.throws(() => assertDaemon({ ...good, ...patch }), { kind: 'build-mismatch', outcome: 'not-started' });
  }
});
