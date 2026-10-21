import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL } from './bridge-protocol.js';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const normalize = s => s.replace(/\r\n/g, '\n');
const hash = entries => {
  const h = createHash('sha256');
  for (const [name, contents] of entries) h.update(name + '\0' + normalize(contents) + '\0');
  return h.digest('hex').slice(0, 24);
};
export function buildIdentity(root = PROJECT_ROOT) {
  const read = file => readFileSync(join(root, file), 'utf8');
  const code = read('plugin/code.js');
  const pluginBuild = hash([
    ['plugin/code.js', code.replace(/var BUILD = '[^']*';/, "var BUILD = 'development';")],
    ['plugin/ui.html', read('plugin/ui.html')], ['plugin/manifest.json', read('plugin/manifest.json')],
  ]);
  function files(dir) {
    return readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
      if (entry.name.startsWith('.')) return [];
      const name = dir + '/' + entry.name;
      return entry.isDirectory() ? files(name) : /\.(m?js|ps1)$/.test(name) ? [[name, read(name)]] : [];
    });
  }
  return { root: join(root, 'src'), version: JSON.parse(read('package.json')).version, protocol: PROTOCOL,
    pluginBuild, pluginStamped: code.includes("var BUILD = '" + pluginBuild + "';"),
    // No lockfile: npm leaves it out of installed packages, and the same sources
    // must fingerprint identically in a clone and in an install.
    daemonBuild: hash([...files('src'), ...files('bridge'), ['package.json', read('package.json')], ['pluginBuild', pluginBuild]]) };
}
