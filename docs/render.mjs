#!/usr/bin/env node
// Regenerates the README images with headless Chrome or Edge:
//   - console-*.png   →  docs/images/: the real plugin/ui.html, driven by console-stub.js with sample data
//   - diagrams/*.svg  →  docs/images/<name>.png (after the console, which hero.svg embeds)
// No daemon, plugin or network connection is involved. Run: npm run docs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..'), images = join(here, 'images');
const browser = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p));
if (!browser) throw new Error('Set CHROME_PATH to a Chrome or Edge executable.');

function shot(url, [width, height], out, scale, extra = []) {
  execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${scale}`, ...extra,
    `--window-size=${width},${height}`, '--virtual-time-budget=5000', `--screenshot=${out}`, url], { stdio: 'ignore', timeout: 60000 });
  console.log('wrote', out);
}

const only = process.argv.slice(2);
const wanted = name => !only.length || only.some(o => name.includes(o));

// A Figma-like window around the plugin iframe; `canvas` adds a canvas behind it.
const FRAME = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;font:12px "Segoe UI",Inter,sans-serif;background:#ececf0}
body.canvas{background:#e9e9ec radial-gradient(#c9c9cf 1px,transparent 1px) 0 0/16px 16px}
.art{position:absolute;background:#fff;border-radius:3px;box-shadow:0 0 0 1px #d6d6dc}.art i{position:absolute;left:10px;right:10px;height:8px;border-radius:2px;background:#e3e5ea}
.win{position:absolute;z-index:2;left:20px;top:20px;background:#fff;border-radius:12px;box-shadow:0 10px 30px #0003,0 0 0 .5px #0004;overflow:hidden}
.bar{height:40px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;font-weight:600;color:#1c1c1e;border-bottom:1px solid #e6e6e6}
iframe{display:block;border:0}</style></head><body><div class="win" id="win"><div class="bar"><span>figma-cli-ultimate</span><span>✕</span></div><iframe id="f"></iframe></div><script>
const p=Object.fromEntries(new URLSearchParams(location.hash.slice(1))),f=document.getElementById('f'),win=document.getElementById('win');
f.style.width=p.w+'px';f.style.height=p.h+'px';
if(p.canvas==='1'){document.body.className='canvas';
  for(const [x,y,w,h] of [[360,30,150,200],[530,30,150,200],[700,30,150,200],[360,250,320,40]]){const a=document.createElement('div');a.className='art';Object.assign(a.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});for(let i=0;i<Math.floor(h/40);i++){const l=document.createElement('i');l.style.top=(14+i*30)+'px';a.append(l);}document.body.append(a);}
  win.style.top=(innerHeight-(+p.h+40)-20)+'px';}
f.src='ui.html#'+p.scene;</script></body></html>`;

// Small views get a Figma-like window (and the banner a canvas behind it). Console views
// are captured directly at the console's size: the scroll position only settles reliably
// in a top-level page.
const scenes = [
  { name: 'console-banner', window: [400, 40], page: [860, 360], canvas: true, scene: 'mode=stealth' },
  { name: 'console-compact', window: [360, 300], page: [400, 380], scene: 'mode=compact' },
  { name: 'console-overview', page: [1060, 904], scene: 'mode=console&tab=overview' },
  { name: 'console-highways', page: [1060, 904], scene: 'mode=console&tab=highways&scroll=section-title' },
  { name: 'console-canvas-map', page: [1060, 904], scene: 'mode=console&tab=zones&file=all&scroll=section-title' },
  { name: 'console-timeline', page: [1060, 904], scene: 'mode=console&tab=timeline&scroll=section-title' },
  { name: 'console-activity', page: [1060, 904], scene: 'mode=console&tab=activity&scroll=section-title' },
  { name: 'console-close-dialog', page: [1060, 904], scene: 'mode=console&tab=overview&dialog=close' },
  { name: 'console-signal', page: [1060, 904], scene: 'mode=console&tab=overview&theme=signal&scroll=section-title' },
].filter(s => wanted(s.name));

if (scenes.length) {
  const work = mkdtempSync(join(tmpdir(), 'figma-cli-docs-'));
  try {
    const stub = readFileSync(join(here, 'console-stub.js'), 'utf8');
    writeFileSync(join(work, 'ui.html'), readFileSync(join(root, 'plugin/ui.html'), 'utf8').replace('<head>', '<head><script>' + stub + '</script>'));
    writeFileSync(join(work, 'frame.html'), FRAME);
    for (const s of scenes) {
      const url = s.window ? pathToFileURL(join(work, 'frame.html')).href + `#w=${s.window[0]}&h=${s.window[1]}&canvas=${s.canvas ? 1 : 0}&scene=${encodeURIComponent(s.scene)}`
        : pathToFileURL(join(work, 'ui.html')).href + '#' + s.scene;
      shot(url, s.page, join(images, s.name + '.png'), 1.5);
    }
  } finally { if (process.env.KEEP_DOCS_WORK) console.log('kept', work); else rmSync(work, { recursive: true, force: true }); }
}

// Diagrams last: hero.svg embeds console-highways.png. Rounded corners stay transparent.
for (const file of readdirSync(join(here, 'diagrams')).filter(f => f.endsWith('.svg') && wanted(f))) {
  const svg = readFileSync(join(here, 'diagrams', file), 'utf8'), [, width, height] = svg.match(/width="(\d+)" height="(\d+)"/);
  const scale = +(svg.match(/data-scale="([\d.]+)"/)?.[1] ?? 2);   // the photo-heavy hero uses 1.5 to stay small
  shot(pathToFileURL(join(here, 'diagrams', file)).href, [+width, +height], join(images, file.replace(/\.svg$/, '.png')), scale, ['--default-background-color=00000000']);
}
