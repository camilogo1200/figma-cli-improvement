#!/usr/bin/env node
// Daemon lifecycle shared by the figma-ultimate CLI and the sign-in companion.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { buildIdentity, PROJECT_ROOT } from '../src/lib/bridge-build.js';
import { ensureToken } from '../src/lib/bridge-state.js';
import { request, health, assertDaemon, PORT } from './fig.mjs';

export function stampBuild() {
  const info = buildIdentity();
  const path = join(PROJECT_ROOT, 'plugin/code.js');
  const old = readFileSync(path, 'utf8');
  const next = old.replace(/var BUILD = '[^']*';/, "var BUILD = '" + info.pluginBuild + "';");
  if (old !== next) writeFileSync(path, next);
  return buildIdentity();
}
export async function existing() {
  try { return await health(); } catch (e) { if (e.kind === 'daemon-down') return null; throw e; }
}
export async function start() {
  const local = stampBuild();
  ensureToken();
  const old = await existing();
  if (old) { assertDaemon(old, local); return old; }
  const child = spawn(process.execPath, [join(PROJECT_ROOT, 'src/daemon.js')], {
    cwd: PROJECT_ROOT, detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, FIGMA_ULTIMATE_PORT: String(PORT) },
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const info = await existing();
    if (info) { assertDaemon(info, local); return info; }
  }
  throw new Error(`The daemon did not start on port ${PORT}. Run node "${join(PROJECT_ROOT, 'src/daemon.js')}" in a terminal to see why.`);
}
export async function stop() {
  const old = await existing();
  if (!old) return { stopped: false };
  if (old.mode !== 'plugin' || !old.daemonBuild) throw new Error(`Port ${PORT} belongs to another program; stop it there.`);
  if (old.busy || old.pending) throw new Error('Work is active or uncertain. Cancel and reconcile it before restarting.');
  // Ask the running build to stop itself. Never kill a PID read from a stale file.
  await request('/shutdown', { payload: { expectedRoot: old.root, expectedDaemonBuild: old.daemonBuild, protocol: old.protocol } });
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!(await existing())) return { stopped: true };
  }
  throw new Error('The daemon has not stopped; no replacement was started.');
}
export async function restart() { await stop(); return start(); }

// Kept so older scripts that call this file keep working.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { main } = await import('../cli/index.mjs');
  await main(process.argv.slice(2));
}
