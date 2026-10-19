import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const digest = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)
  ? createHash('sha256').update(token).digest('hex') : null;

// Only hashes are kept on disk. This credential authorizes plugin workers,
// never the launcher's administrative HTTP API.
export class PairedComputers {
  constructor(path) {
    this.path = path; this.records = new Map();
    if (path && existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved.schema !== 1 || !Array.isArray(saved.records) || saved.records.length > 16 ||
          saved.records.some(r => !/^[a-f0-9]{64}$/.test(r.hash))) throw Error('Invalid remembered pairing file');
      this.records = new Map(saved.records.map(r => [r.hash, r]));
    }
  }
  lookup(token) { const hash = digest(token); return hash && this.records.has(hash) ? hash : null; }
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = this.path + '.tmp';
    writeFileSync(temp, JSON.stringify({ schema: 1, records: [...this.records.values()] }), { mode: 0o600 });
    renameSync(temp, this.path);
  }
  issue() {
    if (this.records.size >= 16) throw Error('Remembered pairing limit reached. Forget an unused computer first.');
    const token = randomBytes(32).toString('hex'), hash = digest(token);
    this.records.set(hash, { hash, createdAt: Date.now() });
    try { this.save(); } catch (e) { this.records.delete(hash); throw e; }
    return token;
  }
  revoke(hash) {
    const old = this.records.get(hash); this.records.delete(hash);
    try { this.save(); } catch (e) { if (old) this.records.set(hash, old); throw e; }
  }
}

export function windowsPairingApproval() {
  let active = false, nextAllowed = 0;
  return async ({ file, challenge, signal }) => {
    if (process.platform !== 'win32') throw Error('Use Advanced pairing on this operating system.');
    if (active || Date.now() < nextAllowed) throw Error('Another connection request is pending. Try again shortly.');
    active = true; nextAllowed = Date.now() + 15000;
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
          '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../../bridge/approve-pairing.ps1', import.meta.url))],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        let output = '', settled = false;
        const finish = (error, approved) => {
          if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(approved);
        };
        const abort = () => { child.kill(); finish(null, false); };
        const timer = setTimeout(abort, 110000);
        signal?.addEventListener('abort', abort, { once: true });
        child.on('error', e => finish(e));
        child.stdin.on('error', () => {});
        child.stdout.on('data', b => { output = (output + b).slice(-32); });
        child.on('exit', code => finish(null, code === 0 && output.trim() === 'APPROVED'));
        // Untrusted file names are data on stdin, never PowerShell source/arguments.
        child.stdin.end(JSON.stringify({ file: String(file || 'Untitled file').replace(/[\x00-\x1f]/g, ' ').slice(0, 120), challenge }) + '\n');
        if (signal?.aborted) abort();
      });
    } finally { active = false; }
  };
}

export const pairingChallenge = () => String(randomInt(100000, 1000000));
