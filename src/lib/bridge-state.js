import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export const LEGACY_STATE_DIR = join(homedir(), '.figma-ds-cli');
export const DEFAULT_STATE_DIR = join(homedir(), '.insula-figma-cli');
const canonical = path => {
  const absolute = existsSync(path) ? realpathSync(path) : resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};
export const STATE_DIR = resolve(process.env.FIGMA_CLI_STATE_DIR || DEFAULT_STATE_DIR);
if (canonical(STATE_DIR) === canonical(LEGACY_STATE_DIR)) {
  throw new Error('Insula cannot use the shared .figma-ds-cli state directory. Unset FIGMA_CLI_STATE_DIR, run figma.mjs migrate-state, then reinstall the companion.');
}
export const TOKEN_FILE = join(STATE_DIR, '.daemon-token');
export const PID_FILE = join(STATE_DIR, 'daemon.pid');
export const DURABLE_STATE_FILES = ['coordinator-journal.json', 'paired-computers.json'];
export function assertStateMigrated() {
  if (canonical(STATE_DIR) !== canonical(DEFAULT_STATE_DIR)) return;
  for (const file of DURABLE_STATE_FILES) {
    if (existsSync(join(LEGACY_STATE_DIR, file)) && !existsSync(join(STATE_DIR, file))) {
      throw new Error('Preserve Insula pairing and reservations before starting: run node tools/figma-cli-insula/figma.mjs migrate-state with the old Insula daemon stopped.');
    }
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
