// Development plugins are listed in Figma Desktop's settings.json under
// `localFileExtensions`. Figma has no supported API for adding one, so the
// default is a guided import. `register --figma-settings` edits the file only
// while Figma is closed (Figma rewrites it on exit), keeps a backup, and
// leaves every other plugin's entries untouched.
import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from '../src/lib/bridge-build.js';

export const PLUGIN_ID = 'figma-cli-ultimate';
export const PLUGIN_NAME = 'figma-cli-ultimate';
const PREVIOUS_PLUGIN_ID = 'insula-figma-cli-structured';
export const MANIFEST_PATH = join(PROJECT_ROOT, 'plugin', 'manifest.json');
const same = (a, b) => process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

export function figmaSettingsPath() {
  if (process.platform === 'win32') return process.env.APPDATA ? join(process.env.APPDATA, 'Figma', 'settings.json') : null;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Figma', 'settings.json');
  return null;
}
export function readFigmaSettings(path = figmaSettingsPath()) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Which entries belong to this plugin, and which code/ui entries no manifest uses.
export function registration(settings, manifestPath = MANIFEST_PATH) {
  const list = Array.isArray(settings?.localFileExtensions) ? settings.localFileExtensions : [];
  const manifests = list.filter(e => e?.fileMetadata?.type === 'manifest');
  const ours = manifests.find(e => same(e.manifestPath, manifestPath)) || null;
  const copies = manifests.filter(e => e !== ours && ([PLUGIN_ID, PREVIOUS_PLUGIN_ID].includes(e.lastKnownPluginId) || e.lastKnownName === PLUGIN_NAME));
  const used = new Set(manifests.flatMap(m => [m.fileMetadata.codeFileId, ...(m.fileMetadata.uiFileIds || [])]));
  const orphans = list.filter(e => ['code', 'ui'].includes(e?.fileMetadata?.type) && !used.has(e.id));
  return { registered: !!ours, ours, copies, orphans };
}

// Pure: settings with exactly one registration of this plugin, at manifestPath.
export function withRegistration(settings, manifestPath = MANIFEST_PATH) {
  const r = registration(settings, manifestPath), all = Array.isArray(settings?.localFileExtensions) ? settings.localFileExtensions : [];
  if (r.ours && !r.copies.length && !r.orphans.length) return { settings, changed: false, removed: 0 };
  const dropped = new Set([...r.copies, ...(r.ours ? [r.ours] : []), ...r.orphans]);
  for (const m of [...r.copies, ...(r.ours ? [r.ours] : [])]) {
    for (const id of [m.fileMetadata.codeFileId, ...(m.fileMetadata.uiFileIds || [])]) {
      const entry = all.find(e => e.id === id);
      if (entry) dropped.add(entry);
    }
  }
  const kept = all.filter(e => !dropped.has(e));
  let next = Math.max(0, ...kept.map(e => Number(e.id) || 0)) + 1;
  const dir = dirname(manifestPath), manifestId = next++, codeId = next++, uiId = next++;
  const localFileExtensions = [...kept,
    { id: manifestId, manifestPath, lastKnownName: PLUGIN_NAME, lastKnownPluginId: PLUGIN_ID,
      fileMetadata: { type: 'manifest', codeFileId: codeId, uiFileIds: [uiId] }, cachedContainsWidget: false },
    { id: codeId, manifestPath: join(dir, 'code.js'), fileMetadata: { type: 'code', manifestFileId: manifestId } },
    { id: uiId, manifestPath: join(dir, 'ui.html'), fileMetadata: { type: 'ui', manifestFileId: manifestId } }];
  return { settings: { ...settings, localFileExtensions }, changed: true, removed: r.copies.length + r.orphans.length };
}

export async function figmaRunning() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)('tasklist', ['/FI', 'IMAGENAME eq Figma.exe', '/NH'], { windowsHide: true, timeout: 10000 });
      return /figma\.exe/i.test(stdout);
    }
    if (process.platform === 'darwin') { await promisify(execFile)('pgrep', ['-x', 'Figma'], { timeout: 10000 }); return true; }
  } catch { return false; }
  return false;
}

export async function registerInFigma({ path = figmaSettingsPath(), manifestPath = MANIFEST_PATH, running = figmaRunning } = {}) {
  const settings = readFigmaSettings(path);
  if (!settings) throw new Error('Figma Desktop settings were not found. Open Figma Desktop once, quit it, then run this again.');
  const plan = withRegistration(settings, manifestPath);
  if (!plan.changed) return { changed: false };
  if (await running()) throw new Error('Quit Figma Desktop first: it rewrites its settings when it closes, which would undo this.');
  const backup = path + '.figma-ultimate-backup-' + new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(path, backup);
  writeFileSync(path + '.tmp', JSON.stringify(plan.settings));
  renameSync(path + '.tmp', path);
  return { changed: true, removed: plan.removed, backup };
}

export function copyToClipboard(text) {
  const command = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : null;
  if (!command) return Promise.resolve(false);
  return new Promise(done => {
    try {
      const child = spawn(command, [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.once('error', () => done(false)); child.once('exit', code => done(code === 0));
      child.stdin.end(text);
    } catch { done(false); }
  });
}
