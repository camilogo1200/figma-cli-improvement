#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildIdentity, PROJECT_ROOT } from '../src/lib/bridge-build.js';
import { ensureToken, STATE_DIR, PID_FILE, TOKEN_FILE } from '../src/lib/bridge-state.js';
import { request, health, diagnostics, assertDaemon } from './fig.mjs';

export function stampBuild() {
  const info = buildIdentity();
  const path = join(PROJECT_ROOT, 'plugin/code.js');
  const old = readFileSync(path, 'utf8');
  const next = old.replace(/var BUILD = '[^']*';/, "var BUILD = '" + info.pluginBuild + "';");
  if (old !== next) writeFileSync(path, next);
  return buildIdentity();
}
async function existing() {
  try { return await health(); } catch (e) { if (e.kind === 'daemon-down') return null; throw e; }
}
export async function start() {
  if (process.env.DAEMON_PORT && process.env.DAEMON_PORT !== '3456') throw new Error('Paired Insula workers share the coordinator on port 3456.');
  const local = stampBuild();
  ensureToken();
  const old = await existing();
  if (old) { assertDaemon(old, local); return old; }
  const child = spawn(process.execPath, [join(PROJECT_ROOT, 'src/daemon.js')], {
    cwd: PROJECT_ROOT, detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, DAEMON_PORT: '3456', DAEMON_MODE: 'plugin' },
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const info = await existing();
    if (info) { assertDaemon(info, local); return info; }
  }
  throw new Error('Daemon did not start. Run this checkout’s src/daemon.js in a terminal with DAEMON_MODE=plugin for startup errors.');
}
export async function stop() {
  const local = buildIdentity(), old = await existing();
  if (!old) return { stopped: false };
  if (old.root !== local.root || old.mode !== 'safe') throw new Error('Port 3456 belongs to another checkout or mode; stop it from its own launcher.');
  if (![3, local.protocol].includes(old.protocol) || !old.daemonBuild) throw new Error('Legacy daemon: close its Figma plugin and stop it from the owning CLI (node src/index.js daemon stop), then use this launcher start.');
  if (old.busy || old.pending || old.cdpUncertain) throw new Error('Work is active or uncertain. Cancel and reconcile it before restarting.');
  // Ask the owning build to stop atomically. Never kill a PID read from a stale file.
  await request('/shutdown', { payload: { expectedRoot: old.root, expectedDaemonBuild: old.daemonBuild, protocol: old.protocol } });
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!(await existing())) return { stopped: true };
  }
  throw new Error('Daemon has not stopped; no replacement was started.');
}
export async function main(args = process.argv.slice(2)) {
  const [sub = 'diagnostics'] = args;
  let out;
  if (sub === 'build') out = stampBuild();
  else if (sub === 'migrate-state') {
    // A foreign token or unknown listener must fail closed, not count as down.
    if (await existing()) throw new Error('Stop the owning Insula daemon before migrating state.');
    const { migrateState } = await import('./migrate-state.mjs');
    out = migrateState();
  }
  else if (sub === 'companion-install' || sub === 'companion-uninstall') {
    if (process.platform !== 'win32') throw Error('Automatic startup is currently supported on Windows.');
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(PROJECT_ROOT, 'bridge/install-companion.ps1'), '-NodePath', process.execPath,
      '-StateDirectory', STATE_DIR, ...(sub === 'companion-uninstall' ? ['-Uninstall'] : [])], { windowsHide: true, timeout: 15000 });
    console.log(stdout.trim()); return;
  }
  else if (sub === 'start') out = await start();
  else if (sub === 'restart') { await stop(); out = await start(); }
  else if (sub === 'stop') out = await stop();
  else if (sub === 'diagnostics' || sub === 'status') {
    out = { local: buildIdentity(), state: { directory: STATE_DIR, pidFile: PID_FILE, tokenFile: TOKEN_FILE }, node: process.version, nodeExecutable: process.execPath };
    try { out.daemon = await diagnostics(); assertDaemon(out.daemon, out.local); out.matches = true; }
    catch (e) { out.matches = false; out.error = { kind: e.kind, message: e.message }; try { out.daemon ||= await health(); } catch {} }
    if (process.platform === 'win32') {
      try {
        const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "Get-Process Figma -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 5000 });
        out.figmaProcesses = stdout.trim() ? JSON.parse(stdout) : [];
      } catch (e) { out.figmaProcessError = e.message; }
    }
    if (!out.matches) process.exitCode = 1;
  } else {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, 'bridge/fig.mjs'), ...args], { windowsHide: true, stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
    return;
  }
  console.log(JSON.stringify(out, null, 2));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
