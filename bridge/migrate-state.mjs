import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PREVIOUS_STATE_DIR, STATE_DIR, DURABLE_STATE_FILES } from '../src/lib/bridge-state.js';
import { ReservationJournal } from '../src/lib/bridge-coordinator.js';
import { PairedComputers } from '../src/lib/bridge-pairing.js';

// Called only after setup has stopped the previous version's daemon.
// Retain the originals for recovery. Never migrate an administrative token,
// PID or supervisor config: those belong to the process that wrote them.
export function migrateState({ source = PREVIOUS_STATE_DIR, target = STATE_DIR } = {}) {
  new ReservationJournal(join(source, 'coordinator-journal.json'));
  new PairedComputers(join(source, 'paired-computers.json'));
  const files = DURABLE_STATE_FILES.filter(file => existsSync(join(source, file)))
    .map(file => ({ file, contents: readFileSync(join(source, file)) }));
  // Check every conflict before copying either file. An interrupted identical
  // copy is resumable, but newer destination state must never be overwritten.
  for (const { file, contents } of files) {
    const dest = join(target, file);
    if (existsSync(dest) && !contents.equals(readFileSync(dest))) {
      throw new Error('Destination state differs; preserve and reconcile it before migration: ' + dest);
    }
  }
  mkdirSync(target, { recursive: true });
  for (const { file, contents } of files) {
    const dest = join(target, file);
    try { writeFileSync(dest, contents, { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if (e.code !== 'EEXIST' || !contents.equals(readFileSync(dest))) throw e;
    }
  }
  return { source, stateDirectory: target, preserved: files.map(({ file }) => file) };
}
