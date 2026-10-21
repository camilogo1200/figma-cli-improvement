// figma-ultimate: install, connect and drive the figma-cli-ultimate bridge.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fig from '../bridge/fig.mjs';
import { stampBuild, start, stop, restart, existing } from '../bridge/launcher.mjs';
import { buildIdentity, PROJECT_ROOT } from '../src/lib/bridge-build.js';
import { STATE_DIR, previousStatePending } from '../src/lib/bridge-state.js';
import { retirePrevious, previousDaemon, PREVIOUS_PORT } from './previous-version.mjs';
import { MANIFEST_PATH, figmaSettingsPath, readFigmaSettings, registration, registerInFigma, copyToClipboard } from './figma-plugins.mjs';

const VERSION = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
const ok = text => console.log('  ' + paint(32, '✓') + ' ' + text);
const bad = text => console.log('  ' + paint(31, '✗') + ' ' + text);
const note = text => console.log('  ' + paint(36, '•') + ' ' + text);
const hint = text => console.log('    ' + paint(90, text));
const heading = text => console.log('\n' + paint(1, text) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const same = (a, b) => process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;
const quoted = files => files.map(f => `“${f.file || f.fileKey}”`).join(', ');
const OPEN_PLUGIN = 'open a design file and run Plugins → Development → figma-cli-ultimate';

const HELP = `figma-cli-ultimate ${VERSION}

Setup and lifecycle
  figma-ultimate setup        Everything, once: build, start, automatic start, register, connect
      --register-figma          also register the plugin in Figma's settings (quit Figma first)
      --no-autostart            skip automatic start at sign-in
      --no-wait                 do not wait for the plugin to connect
  figma-ultimate doctor       Check every piece and print the next step
  figma-ultimate status       One-line summary (--json for details)
  figma-ultimate start | stop | restart
  figma-ultimate autostart on|off
  figma-ultimate register [--figma-settings]
  figma-ultimate approve      Approve a waiting plugin connection in this terminal
  figma-ultimate pair         Print a two-minute manual pairing code
  figma-ultimate uninstall    Turn off automatic start and stop the bridge

Working with files (JSON output; --file NAME|KEY when several files are connected)
  figma-ultimate files                 Connected files
  figma-ultimate info | pages | ping
  figma-ultimate find <name>           Nodes whose name contains <name>
  figma-ultimate children [prefix]     Page children, with duplicate names
  figma-ultimate tree <nodeId>
  figma-ultimate export <nodeId> [out.png]
  figma-ultimate send <commands.json>  One command or an array (a batch)
  figma-ultimate layout <layout.json>  {"specs":[…], "label":"…"}: placed in free space
  figma-ultimate cancel [requestId]
  figma-ultimate highways | lanes | workers | diagnostics
`;

function parse(args) {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file' || a === '-f') flags.file = args[++i];
    else if (a.startsWith('--file=')) flags.file = a.slice(7);
    else if (a === '-h') flags.help = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else rest.push(a);
  }
  return { flags, rest };
}
function readJson(path, command) {
  if (!path) throw new fig.BridgeError('invalid-request', `${command} needs a JSON file path`, { outcome: 'not-started' });
  return JSON.parse(readFileSync(path, 'utf8'));
}
function nodeMajor() { return Number(process.versions.node.split('.')[0]); }
const psError = e => String(e.stderr || e.message).split(/\r?\n/).map(l => l.trim()).find(l => l && !/^(At |\+|CategoryInfo|FullyQualifiedErrorId)/.test(l)) || e.message;

// ---- automatic start (Windows sign-in companion) ----
export function autostartState() {
  try {
    const c = JSON.parse(readFileSync(join(STATE_DIR, 'companion.json'), 'utf8'));
    return c.enabled ? (same(c.root, PROJECT_ROOT) ? 'on' : 'other') : 'off';
  } catch { return 'off'; }
}
async function autostart(on) {
  if (process.platform !== 'win32') throw new Error('Automatic start is available on Windows. On this system, run figma-ultimate start after signing in.');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(PROJECT_ROOT, 'bridge/install-companion.ps1'), '-NodePath', process.execPath, '-StateDirectory', STATE_DIR,
    ...(on ? [] : ['-Uninstall'])], { windowsHide: true, timeout: 20000 }).catch(e => { throw new Error(psError(e)); });
  return stdout.trim();
}

// ---- connected files ----
export async function connectedFiles(coordinate = fig.coordinate) {
  const status = await coordinate({ op: 'status' });
  return status.workers.filter(w => w.connected);
}
export function pickFile(files, wanted) {
  if (!files.length) throw new fig.BridgeError('plugin-offline', `No Figma file is connected: ${OPEN_PLUGIN}.`, { outcome: 'not-started' });
  let match = files;
  if (wanted) {
    const w = wanted.toLowerCase();
    match = files.filter(f => f.fileKey === wanted);
    if (!match.length) match = files.filter(f => (f.file || '').toLowerCase() === w);
    if (!match.length) match = files.filter(f => (f.file || '').toLowerCase().includes(w));
  }
  if (match.length === 1) return match[0];
  const list = files.map(f => `"${f.file}" (${f.fileKey})`).join(', ');
  throw new fig.BridgeError('ambiguous-file', (wanted ? `No single connected file matches "${wanted}".` : 'Several files are connected; choose one with --file NAME.') + ' Connected: ' + list, { outcome: 'not-started' });
}

// ---- plugin registration ----
async function registerStep({ figmaSettings = false } = {}) {
  if (figmaSettings) {
    try {
      const res = await registerInFigma();
      if (!res.changed) ok('Plugin already registered in Figma');
      else ok('Registered the plugin in Figma' + (res.removed ? ` and removed ${res.removed} stale entr${res.removed === 1 ? 'y' : 'ies'}` : '') + `. Backup: ${res.backup}`);
      return true;
    } catch (e) { bad(e.message); }
  }
  let r = null;
  try { const settings = readFigmaSettings(); r = settings && registration(settings); } catch {}
  if (r?.registered) {
    ok('Plugin registered in Figma');
    if (r.copies.length) hint(`${r.copies.length} other copy registered too. To keep only this one: quit Figma, then figma-ultimate register --figma-settings`);
    return true;
  }
  const copied = await copyToClipboard(MANIFEST_PATH);
  note('Register the plugin in Figma Desktop (once per computer):');
  hint('1. Plugins → Development → Import plugin from manifest…');
  hint('2. Choose ' + MANIFEST_PATH + (copied ? '  (path copied to the clipboard)' : ''));
  if (r?.copies.length) hint(`An older copy is registered from ${r.copies[0].manifestPath}; importing replaces nothing, so remove it in Figma or use --figma-settings.`);
  hint('Or quit Figma and run: figma-ultimate register --figma-settings');
  return false;
}

// ---- waiting for the plugin, approving pairing in the terminal ----
async function waitForPlugin({ timeoutMs = 10 * 60000, announce = true } = {}) {
  let files = await connectedFiles();
  if (files.length) { ok('Connected: ' + quoted(files)); return true; }
  if (announce) note(`Now ${OPEN_PLUGIN}.`);
  hint('Waiting for it to connect… (Ctrl+C stops waiting; the bridge keeps running)');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { rl.close(); console.log(); note('Stopped waiting. The bridge keeps running; run figma-ultimate doctor any time.'); process.exit(130); });
  const answered = new Set(), end = Date.now() + timeoutMs;
  try {
    while (Date.now() < end) {
      for (const r of await fig.coordinate({ op: 'pairing-requests' })) {
        if (answered.has(r.id)) continue;
        answered.add(r.id);
        const reply = await rl.question(`  ${paint(33, '?')} Connect “${r.file}”? The plugin shows ${paint(1, r.challenge)}. Approve only if the numbers match [y/N] `);
        const approve = /^y(es)?$/i.test(reply.trim());
        const { answered: delivered } = await fig.coordinate({ op: 'pairing-answer', id: r.id, approve });
        if (!delivered) note('That request expired; click Connect this computer in the plugin again.');
        else approve ? ok('Approved. This computer is remembered for future files.') : note('Declined.');
      }
      files = await connectedFiles();
      if (files.length) { ok('Connected: ' + quoted(files)); return true; }
      await sleep(1000);
    }
    note('Still not connected after 10 minutes. Run figma-ultimate doctor to see what is missing.');
    return false;
  } finally { rl.close(); }
}

// ---- commands ----
async function setup(flags) {
  heading(`figma-cli-ultimate ${VERSION} · setup`);
  if (nodeMajor() < 20) { bad(`Node.js ${process.versions.node} is too old. Install Node.js 20 or newer.`); process.exitCode = 1; return; }
  ok(`Node.js ${process.versions.node}`);
  const build = stampBuild();
  ok(`Plugin build ${build.pluginBuild.slice(0, 8)}`);
  const previous = await retirePrevious({ log: note });
  if (previous.autostart) ok('Turned off the previous version’s automatic start');
  if (previous.daemon === 'stopped') ok(`Stopped the previous version on port ${PREVIOUS_PORT}`);
  if (previous.daemon === 'other') note(`Port ${PREVIOUS_PORT} belongs to another program or installation; left it alone`);
  if (previous.migrated.length) ok('Moved pairings and reservations from the previous version');
  try { await start(); ok(`Bridge running on 127.0.0.1:${fig.PORT}`); }
  catch (e) {
    if (e.kind !== 'build-mismatch') throw e;
    await restart(); ok(`Restarted the bridge on 127.0.0.1:${fig.PORT} with this build`);
  }
  if (!flags['no-autostart']) {
    if (process.platform !== 'win32') note('Automatic start is Windows-only for now. After a restart, run figma-ultimate start.');
    else try { await autostart(true); ok('Automatic start is on: the bridge starts when you sign in'); } catch (e) { bad('Automatic start: ' + e.message); }
  }
  await registerStep({ figmaSettings: !!flags['register-figma'] });
  if (flags['no-wait'] || !process.stdin.isTTY) {
    const files = await connectedFiles();
    if (files.length) ok('Connected: ' + quoted(files));
    else { note(`Next: ${OPEN_PLUGIN}.`); hint('Then run figma-ultimate approve to approve it here, or approve the Windows dialog.'); }
    return;
  }
  if (await waitForPlugin()) {
    console.log();
    note('Ready. Try: figma-ultimate files · figma-ultimate info · figma-ultimate doctor');
  }
}

async function doctor(flags) {
  const checks = [], add = (level, name, detail, fix = null) => checks.push({ level, name, detail, fix });
  add(nodeMajor() >= 20 ? 'ok' : 'error', 'Node.js', process.versions.node, nodeMajor() >= 20 ? null : 'Install Node.js 20 or newer');
  const local = buildIdentity();
  add(local.pluginStamped ? 'ok' : 'error', 'Plugin build', local.pluginStamped ? local.pluginBuild.slice(0, 8) : 'not stamped', local.pluginStamped ? null : 'figma-ultimate build');
  if (previousStatePending()) add('error', 'Previous version', 'its pairings and reservations have not been moved', 'figma-ultimate setup');
  if ((await previousDaemon()).state === 'ours') add('warn', 'Previous version', `still running on port ${PREVIOUS_PORT}`, 'figma-ultimate setup');
  let daemon = null;
  try {
    daemon = await existing();
    if (!daemon) add('error', 'Bridge', 'not running', 'figma-ultimate start');
    else try { fig.assertDaemon(daemon, local); add('ok', 'Bridge', `running on 127.0.0.1:${fig.PORT}`); }
    catch { add('error', 'Bridge', 'running an older build', 'figma-ultimate restart'); daemon = null; }
  } catch (e) {
    add('error', 'Bridge', e.kind === 'unauthorized' ? `port ${fig.PORT} is used by another program` : e.message, e.kind === 'unauthorized' ? `stop the program on port ${fig.PORT}` : 'figma-ultimate restart');
  }
  if (process.platform === 'win32') {
    const a = autostartState();
    add(a === 'on' ? 'ok' : 'warn', 'Automatic start', a === 'on' ? 'on' : a === 'other' ? 'set up by another installation' : 'off', a === 'on' ? null : 'figma-ultimate autostart on');
  }
  let settings = null;
  try { settings = readFigmaSettings(); } catch {}
  if (!settings) add('warn', 'Figma Desktop', figmaSettingsPath() ? 'settings not found; is Figma Desktop installed?' : 'not available on this system');
  else {
    const r = registration(settings);
    add(r.registered ? 'ok' : 'error', 'Plugin in Figma', r.registered ? 'registered' : r.copies.length ? `registered from another folder: ${r.copies[0].manifestPath}` : 'not registered',
      r.registered ? null : `Plugins → Development → Import plugin from manifest… → ${MANIFEST_PATH}`);
    if (r.registered && r.copies.length) add('warn', 'Older plugin copies', `${r.copies.length} also registered`, 'quit Figma, then figma-ultimate register --figma-settings');
  }
  if (daemon) {
    const files = await connectedFiles().catch(() => []);
    add(files.length ? 'ok' : 'warn', 'Connected files', files.length ? quoted(files) : 'none', files.length ? null : OPEN_PLUGIN);
  }
  if (flags.json) { console.log(JSON.stringify({ version: VERSION, port: fig.PORT, stateDirectory: STATE_DIR, checks }, null, 2)); }
  else {
    heading(`figma-cli-ultimate ${VERSION} · doctor`);
    for (const c of checks) {
      (c.level === 'ok' ? ok : c.level === 'warn' ? note : bad)(`${c.name}: ${c.detail}`);
      if (c.fix) hint('→ ' + c.fix);
    }
    console.log();
  }
  process.exitCode = checks.some(c => c.level === 'error') ? 1 : 0;
}

async function status(flags) {
  const daemon = await existing();
  if (!daemon) { if (flags.json) console.log(JSON.stringify({ running: false, port: fig.PORT })); else bad(`Bridge not running on port ${fig.PORT}. Run figma-ultimate start.`); process.exitCode = 1; return; }
  const snapshot = await fig.coordinate({ op: 'status' });
  const files = snapshot.workers.filter(w => w.connected);
  if (flags.json) { console.log(JSON.stringify({ running: true, port: fig.PORT, build: daemon.daemonBuild, files: files.map(f => ({ file: f.file, fileKey: f.fileKey, page: f.page })), highways: snapshot.highways.length, held: snapshot.held }, null, 2)); return; }
  ok(`Bridge on 127.0.0.1:${fig.PORT} · ${files.length ? quoted(files) : 'no files connected'} · ${snapshot.highways.length} highway${snapshot.highways.length === 1 ? '' : 's'}${snapshot.held ? ` · ${snapshot.held} held for review` : ''}`);
}

async function fileCommand(sub, rest, flags) {
  switch (sub) {
    case 'files': return (await connectedFiles()).map(f => ({ file: f.file, fileKey: f.fileKey, page: f.page, pageId: f.pageId, busy: !!f.current, needsReview: !!f.quarantine }));
    case 'workers': return fig.coordinate({ op: 'status' });
    case 'lanes': return fig.coordinate({ op: 'lanes' });
    case 'highways': return fig.post({ action: 'highway', cmd: { op: 'list' } });
    case 'health': return fig.health();
    case 'diagnostics': {
      const out = { local: buildIdentity(), daemon: await fig.diagnostics(), node: process.version, stateDirectory: STATE_DIR };
      // Figma's own processes: find the one that grows before blaming the bridge for memory.
      if (process.platform === 'win32') {
        try {
          const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-Process Figma -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 5000 });
          out.figmaProcesses = stdout.trim() ? [].concat(JSON.parse(stdout)) : [];
        } catch (e) { out.figmaProcessError = e.message; }
      }
      return out;
    }
    case 'pair': return fig.coordinate({ op: 'pair' });
  }
  const target = pickFile(await connectedFiles(), flags.file || process.env.FIGMA_ULTIMATE_FILE);
  const coordination = { workerId: target.workerId, sessionEpoch: target.sessionEpoch, fileKey: target.fileKey };
  const run = (command, timeoutMs) => fig.cmd(command, timeoutMs, { coordination });
  switch (sub) {
    case 'ping': case 'info': return run({ op: sub });
    case 'pages': return run({ op: 'page', action: 'list' });
    case 'find': return run({ op: 'find', name: rest[0] || '' });
    case 'tree':
      if (!rest[0]) throw new fig.BridgeError('invalid-request', 'tree needs a node id', { outcome: 'not-started' });
      return run({ op: 'tree', id: rest[0], depth: 4 });
    case 'cancel': return run({ op: 'cancel', ...(rest[0] ? { id: rest[0] } : {}) });
    case 'children': {
      const kids = await run({ op: 'children', ...(rest[0] ? { prefix: rest[0] } : {}) }, 120000), seen = new Map();
      for (const k of kids) seen.set(k.name, (seen.get(k.name) || 0) + 1);
      return { count: kids.length, duplicates: [...seen].filter(([, n]) => n > 1).map(([name, n]) => ({ name, n })), children: kids };
    }
    case 'export': {
      const res = await run({ op: 'exportImage', id: rest[0], scale: 2 }, 90000);
      const dest = rest[1] || `figma-${String(rest[0] || 'selection').replace(/[:;]/g, '-')}.png`;
      writeFileSync(dest, Buffer.from(res.base64, 'base64'));
      return { saved: dest, id: res.id, name: res.name };
    }
    case 'send': {
      const input = readJson(rest[0], 'send');
      return Array.isArray(input) ? fig.cmdBatch(input, undefined, { coordination }) : run(input);
    }
    case 'layout': {
      const { specs, spec, pageId, label } = readJson(rest[0], 'layout');
      return fig.createLayout(specs || spec, { fileKey: target.fileKey, pageId, label, agentId: 'figma-ultimate' });
    }
  }
  return undefined;
}

export async function main(args = process.argv.slice(2)) {
  const [sub = 'help', ...more] = args, { flags, rest } = parse(more);
  try {
    if (sub === 'help' || sub === '--help' || sub === '-h' || flags.help) { console.log(HELP); return; }
    if (sub === 'version' || sub === '--version' || sub === '-v') { console.log(VERSION); return; }
    if (sub === 'setup') return await setup(flags);
    if (sub === 'doctor') return await doctor(flags);
    if (sub === 'status') return await status(flags);
    if (sub === 'build') { const b = stampBuild(); ok(`Plugin build ${b.pluginBuild.slice(0, 8)} · daemon build ${b.daemonBuild.slice(0, 8)}`); return; }
    if (sub === 'start') { await start(); ok(`Bridge running on 127.0.0.1:${fig.PORT}`); return; }
    if (sub === 'stop') { const r = await stop(); r.stopped ? ok('Bridge stopped') : note('Bridge was not running'); return; }
    if (sub === 'restart') { await restart(); ok(`Bridge restarted on 127.0.0.1:${fig.PORT}. Reopen the plugin in each file if it shows a build mismatch.`); return; }
    if (sub === 'autostart') {
      const on = rest[0] !== 'off';
      if (!['on', 'off', undefined].includes(rest[0])) throw new Error('Use: figma-ultimate autostart on|off');
      ok(await autostart(on)); return;
    }
    if (sub === 'register') { await registerStep({ figmaSettings: !!flags['figma-settings'] }); return; }
    if (sub === 'approve') { await waitForPlugin({ announce: false }); return; }
    if (sub === 'uninstall') {
      if (process.platform === 'win32' && autostartState() === 'on') ok(await autostart(false));
      const r = await stop(); r.stopped ? ok('Bridge stopped') : note('Bridge was not running');
      note('To remove the plugin: Figma → Plugins → Development → Manage plugins in development → Remove.');
      note('To remove the command: npm uninstall -g figma-cli-ultimate');
      hint(`Settings and pairings stay in ${STATE_DIR}; delete that folder to forget them.`);
      return;
    }
    const out = await fileCommand(sub, rest, flags);
    if (out === undefined) { console.error(`Unknown command "${sub}".\n`); console.log(HELP); process.exitCode = 1; return; }
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(paint(31, '✗ ') + e.message + (e.kind ? ` [${e.kind}]` : ''));
    if (e.kind === 'daemon-down') console.error('  The bridge is not running. Run figma-ultimate setup (first time) or figma-ultimate start.');
    if (e.results) console.error(JSON.stringify(e.results.map((r, index) => ({ index, success: r.success,
      created: r.result?.created?.map(n => ({ id: n.id, name: n.name })), error: r.error, kind: r.kind, outcome: r.outcome, details: r.details })), null, 2));
    process.exitCode = 1;
  }
}
