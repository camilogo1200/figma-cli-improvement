// Per-user supervisor. Never kills Figma or replaces another checkout's daemon.
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATE_DIR } from '../src/lib/bridge-state.js';
import { PROJECT_ROOT, buildIdentity } from '../src/lib/bridge-build.js';
import { health, assertDaemon } from './fig.mjs';
import { start } from './launcher.mjs';

export async function ensureAvailable({ inspect = health, launch = start, local = buildIdentity() } = {}) {
  try { const current = await inspect(); assertDaemon(current, local); return { status: 'ready' }; }
  catch (e) {
    if (e.kind !== 'daemon-down') return { status: 'attention', message: e.message };
    await launch(); return { status: 'ready' };
  }
}

export async function supervise() {
  const config = join(STATE_DIR, 'companion.json');
  const lock = createServer(socket => socket.end());
  const id = createHash('sha256').update(STATE_DIR.toLowerCase()).digest('hex').slice(0, 20);
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\insula-figma-' + id : join(STATE_DIR, 'companion.sock');
  const acquired = await new Promise((resolve, reject) => {
    lock.once('error', e => e.code === 'EADDRINUSE' ? resolve(false) : reject(e));
    lock.listen(address, () => resolve(true));
  });
  if (!acquired) return;
  let stopped = false, previous = '';
  const stop = () => { stopped = true; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    while (!stopped && existsSync(config)) {
      const settings = JSON.parse(readFileSync(config, 'utf8'));
      if (settings.enabled !== true || settings.root !== PROJECT_ROOT) break;
      let state;
      try { state = await ensureAvailable(); } catch (e) { state = { status: 'attention', message: e.message }; }
      const signature = JSON.stringify(state);
      if (signature !== previous) {
        writeFileSync(join(STATE_DIR, 'companion-status.json'), JSON.stringify({ ...state, pid: process.pid, updatedAt: new Date().toISOString() }));
        previous = signature;
      }
      await new Promise(resolve => setTimeout(resolve, state.status === 'ready' ? 5000 : 15000));
    }
  } finally { lock.close(); process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) supervise().catch(e => { console.error(e.message); process.exitCode = 1; });
