// `npm test` entry point: runs every tests/*.test.js with `node --test`.
//
// The file list is expanded here, not by a glob on the command line. npm runs
// scripts through cmd.exe on Windows, which passes `tests/*.test.js` through
// untouched, and `node --test` only expands globs itself from Node 21 on, so
// Node 20 on Windows found no test files at all. Extra arguments are forwarded:
// `npm test -- --test-name-pattern=migration`.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter(name => name.endsWith('.test.js')).sort().map(name => relative(process.cwd(), join(dir, name)));
if (!files.length) { console.error(`No *.test.js files in ${dir}`); process.exit(1); }
const { status, error } = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
if (error) throw error;
process.exit(status ?? 1);
