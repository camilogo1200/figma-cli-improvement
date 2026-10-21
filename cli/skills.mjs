// Agent skills: copies skills/<name>/ into Claude Code's and Codex's skill folders.
// Each installed copy carries a receipt with the hash of every file written, so a
// later install can tell an untouched copy (safe to update) from an edited one.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { PROJECT_ROOT } from '../src/lib/bridge-build.js';

export const SKILLS_DIR = join(PROJECT_ROOT, 'skills');
export const RECEIPT = '.figma-ultimate.json';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashOf = path => { try { return digest(readFileSync(path)); } catch { return null; } };
// Receipt paths are read back from disk: only plain paths inside the skill folder are trusted.
const safeRelative = rel => typeof rel === 'string' && rel !== '' && !isAbsolute(rel) && !rel.includes(':') && !rel.split(/[\\/]/).some(part => part === '..' || part === '');

// Claude Code reads ~/.claude/skills (or $CLAUDE_CONFIG_DIR/skills) and <project>/.claude/skills;
// Codex reads ~/.agents/skills and <repository>/.agents/skills.
export function skillTargets({ claude = true, codex = true, scope = 'user', home = homedir(), cwd = process.cwd(), env = process.env } = {}) {
  const user = scope === 'user', targets = [];
  if (claude) targets.push({ agent: 'Claude Code', dir: user ? join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills') : join(cwd, '.claude', 'skills') });
  if (codex) targets.push({ agent: 'Codex', dir: user ? join(home, '.agents', 'skills') : join(cwd, '.agents', 'skills') });
  return targets;
}

export function bundledSkills(source = SKILLS_DIR) {
  const files = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) return files(join(dir, entry.name), rel + '/');
    return entry.isFile() && entry.name !== RECEIPT ? [[rel, readFileSync(join(dir, entry.name))]] : [];
  });
  return readdirSync(source, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(source, entry.name, 'SKILL.md')))
    .map(entry => ({ name: entry.name, files: new Map(files(join(source, entry.name)).sort(([a], [b]) => a < b ? -1 : 1)) }));
}

function readReceipt(dir) {
  try {
    const receipt = JSON.parse(readFileSync(join(dir, RECEIPT), 'utf8'));
    const files = receipt?.files;
    if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.entries(files).every(([rel, sha]) => safeRelative(rel) && typeof sha === 'string')) return null;
    return receipt;
  } catch { return null; }
}

// installed | updated | unchanged | replaced (edited copy, --force) | modified (edited copy, left alone)
function installOne(skill, dir, { force, version }) {
  const wanted = new Map([...skill.files].map(([rel, bytes]) => [rel, digest(bytes)]));
  const fresh = !existsSync(dir), receipt = fresh ? null : readReceipt(dir);
  const now = rel => hashOf(join(dir, rel));
  const edited = receipt ? Object.keys(receipt.files).filter(rel => now(rel) !== receipt.files[rel]) : [];
  const stale = receipt ? Object.keys(receipt.files).filter(rel => !wanted.has(rel) && now(rel) !== null) : [];
  const writeReceipt = () => writeFileSync(join(dir, RECEIPT), JSON.stringify({ installedBy: 'figma-cli-ultimate', version, files: Object.fromEntries(wanted) }, null, 2) + '\n');
  if (!fresh && !stale.length && [...wanted].every(([rel, sha]) => now(rel) === sha)) {
    const recorded = receipt && Object.keys(receipt.files).length === wanted.size && [...wanted].every(([rel, sha]) => receipt.files[rel] === sha);
    if (!recorded || receipt.version !== version) writeReceipt();
    return { state: 'unchanged' };
  }
  const foreign = !fresh && (!receipt || edited.length > 0);
  if (foreign && !force) return { state: 'modified', edited: receipt ? edited : null };
  for (const rel of stale) rmSync(join(dir, rel));
  for (const [rel, bytes] of skill.files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
  }
  writeReceipt();
  return { state: fresh ? 'installed' : foreign ? 'replaced' : 'updated' };
}

export function installSkills({ force = false, version = 'development', source = SKILLS_DIR, ...where } = {}) {
  const skills = bundledSkills(source), results = [];
  for (const target of skillTargets(where)) {
    for (const skill of skills) {
      const dir = join(target.dir, skill.name);
      results.push({ agent: target.agent, skill: skill.name, dir, ...installOne(skill, dir, { force, version }) });
    }
  }
  return results;
}
