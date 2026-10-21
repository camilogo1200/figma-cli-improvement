// Releases before 3.0 ran under a working name ("insula"): daemon on port 3456,
// settings in ~/.insula-figma-cli and a sign-in shortcut of their own. Setup
// retires that installation of THIS code once, in an order that cannot race:
// 1. turn off its automatic start, 2. wait for its companion to exit (it would
// restart the daemon), 3. ask its idle daemon to stop, 4. move durable state.
// An installation from another folder, or any other program, is left alone.
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../bridge/fig.mjs';
import { PROJECT_ROOT } from '../src/lib/bridge-build.js';
import { PREVIOUS_STATE_DIR, previousStatePending } from '../src/lib/bridge-state.js';
import { migrateState } from '../bridge/migrate-state.mjs';

export const PREVIOUS_PORT = 3456;
const same = (a, b) => process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function previousToken() {
  try { return readFileSync(join(PREVIOUS_STATE_DIR, '.daemon-token'), 'utf8').trim() || null; } catch { return null; }
}
// { state: 'none' | 'ours' | 'other', info }
export async function previousDaemon() {
  const token = previousToken();
  if (!token) return { state: 'none' };
  try {
    const info = await request('/health', { port: PREVIOUS_PORT, tokenValue: token, timeoutMs: 2000 });
    return { state: same(info.root, join(PROJECT_ROOT, 'src')) ? 'ours' : 'other', info };
  } catch (e) { return { state: e.kind === 'daemon-down' ? 'none' : 'other' }; }
}
function companionRunning() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const id = createHash('sha256').update(resolve(PREVIOUS_STATE_DIR).toLowerCase()).digest('hex').slice(0, 20);
  return new Promise(done => {
    const socket = createConnection('\\\\.\\pipe\\insula-figma-' + id);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
  });
}
async function disableAutostart() {
  let changed = false;
  const config = join(PREVIOUS_STATE_DIR, 'companion.json');
  if (existsSync(config)) {
    const settings = JSON.parse(readFileSync(config, 'utf8'));
    if (settings.enabled && same(settings.root, PROJECT_ROOT)) { settings.enabled = false; writeFileSync(config, JSON.stringify(settings)); changed = true; }
  }
  if (process.platform === 'win32') {
    // The shortcut's description names the folder it was installed from.
    const script = "$p = Join-Path ([Environment]::GetFolderPath('Startup')) 'Insula Figma Companion.lnk'; if (Test-Path -LiteralPath $p) { $s = (New-Object -ComObject WScript.Shell).CreateShortcut($p); if ($s.Description -eq ('Insula Figma companion: ' + $env:FIGMA_ULTIMATE_ROOT)) { Remove-Item -LiteralPath $p; 'removed' } }";
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000, env: { ...process.env, FIGMA_ULTIMATE_ROOT: PROJECT_ROOT } });
    if (stdout.includes('removed')) changed = true;
  }
  return changed;
}

export async function retirePrevious({ log = () => {} } = {}) {
  const report = { autostart: false, daemon: 'none', migrated: [] };
  report.autostart = await disableAutostart();
  if (report.autostart) {
    log('Turning off the previous version’s automatic start…');
    for (let i = 0; i < 40 && await companionRunning(); i++) await sleep(500);
  }
  const old = await previousDaemon();
  report.daemon = old.state;
  if (old.state === 'ours') {
    if (old.info.busy || old.info.pending) {
      throw new Error(`The previous version (port ${PREVIOUS_PORT}) is still working. Let its jobs finish, then run figma-ultimate setup again.`);
    }
    await request('/shutdown', { port: PREVIOUS_PORT, tokenValue: previousToken(), payload: { expectedRoot: old.info.root, expectedDaemonBuild: old.info.daemonBuild, protocol: old.info.protocol } });
    for (let i = 0; i < 20 && (await previousDaemon()).state === 'ours'; i++) await sleep(250);
    report.daemon = 'stopped';
  }
  if (previousStatePending()) report.migrated = migrateState().preserved;
  return report;
}
