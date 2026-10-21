import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export const DEFAULT_STATE_DIR = join(homedir(), '.figma-cli-ultimate');
// Releases before 3.0 kept the same durable files under their working name;
// `figma-ultimate setup` moves them here once.
export const PREVIOUS_STATE_DIR = join(homedir(), '.insula-figma-cli');
// The original figma-cli keeps its own daemon token and PID here. Never share it.
export const SHARED_STATE_DIR = join(homedir(), '.figma-ds-cli');
const canonical = path => {
  const absolute = existsSync(path) ? realpathSync(path) : resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};
export const STATE_DIR = resolve(process.env.FIGMA_ULTIMATE_STATE_DIR || DEFAULT_STATE_DIR);
if (canonical(STATE_DIR) === canonical(SHARED_STATE_DIR)) {
  throw new Error('figma-cli-ultimate cannot use the original figma-cli state directory (.figma-ds-cli). Unset FIGMA_ULTIMATE_STATE_DIR.');
}
export const TOKEN_FILE = join(STATE_DIR, '.daemon-token');
export const PID_FILE = join(STATE_DIR, 'daemon.pid');
export const DURABLE_STATE_FILES = ['coordinator-journal.json', 'paired-computers.json'];
export function previousStatePending() {
  if (canonical(STATE_DIR) !== canonical(DEFAULT_STATE_DIR)) return false;
  return DURABLE_STATE_FILES.some(file => existsSync(join(PREVIOUS_STATE_DIR, file)) && !existsSync(join(STATE_DIR, file)));
}
export function assertStateMigrated() {
  if (previousStatePending()) {
    throw new Error('Pairings and reservations from the previous version have not been moved yet. Run: figma-ultimate setup');
  }
}
export function ensureToken() {
  assertStateMigrated();
  mkdirSync(STATE_DIR, { recursive: true });
  // An atomic create prevents concurrent launchers from rotating a live daemon's token.
  try { writeFileSync(TOKEN_FILE, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const value = readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!value) throw new Error('Daemon token is empty; restore it before starting the daemon');
  return value;
}
