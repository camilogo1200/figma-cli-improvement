// Opt-in live benchmark. No eval, deletion, replay, daemon restart, or plugin reload.
// Adapted from the 2026-10-16 coordinator acceptance fixture (24 cards / 1,008 nodes).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as bridge from '../../bridge/fig.mjs';
import { forFile } from '../../file-client.mjs';

const colors = ['#007AFF', '#5856D6', '#30B0C7', '#34C759'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorInfo = e => ({ message: e.message, kind: e.kind, outcome: e.outcome, details: e.details });
const requireThat = (condition, message) => { if (!condition) throw Error(message); };

export function randomPages(seed, count, pageCount, previous = -1) {
  requireThat(Number.isInteger(seed) && Number.isInteger(count) && count >= 0 && pageCount >= 2, 'Random navigation needs a seed and at least two pages');
  let state = seed >>> 0;
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const choices = Array.from({ length: pageCount }, (_, i) => i).filter(i => i !== previous);
    previous = choices[Math.floor(state / 0x100000000 * choices.length)]; return previous;
  });
}

export function geometricFixture(label, caller = 0, roots = 24) {
  requireThat(Number.isInteger(roots) && roots >= 1 && roots <= 24, 'Use 1..24 roots');
  const color = colors[caller % colors.length];
  return Array.from({ length: roots }, (_, i) => ({
    type: 'FRAME', name: `${label} · ${i + 1}`, x: 40 + i % 8 * 212, y: 40 + Math.floor(i / 8) * 272,
    w: 180, h: 240, fill: '#F2F2F7', radius: 16,
    children: [
      { type: 'RECTANGLE', x: 12, y: 12, w: 156, h: 36, fill: color, radius: 8 },
      ...Array.from({ length: 40 }, (_, j) => ({
        type: 'RECTANGLE', x: 12 + j % 5 * 32, y: 64 + Math.floor(j / 5) * 20,
        w: 24, h: j % 4 === 0 ? 16 : 12, radius: 3,
        fill: j % 3 === 1 ? 'none' : j % 3 ? '#D1D1D6' : color,
        ...(j % 3 === 1 ? { stroke: color, strokeWidth: 1, strokeAlign: 'INSIDE' } : {}),
      })),
    ],
  }));
}

export function stressPlan({ callers = 3, rounds = 2, roots = 24, seed = 20261020, mode = 'queued' } = {}) {
  requireThat(Number.isInteger(callers) && callers >= 2 && callers <= 4, 'Use 2..4 callers');
  requireThat(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3, 'Use 1..3 rounds');
  geometricFixture('plan', 0, roots);
  const phaseCount = mode === 'all' ? 2 : mode === 'baseline' ? 0 : 1;
  return { callers, rounds, roots, seed, phaseCount, nodesPerJob: roots * 42, totalRoots: callers * rounds * roots * phaseCount,
    totalNodes: callers * rounds * roots * 42 * phaseCount,
    jobs: Array.from({ length: rounds }, (_, round) => Array.from({ length: callers }, (_, caller) => ({
      caller, round, pageIndex: round === 0 ? 0 : (caller + round) % 3,
    }))).flat(),
    switchOrder: randomPages(seed, 12, 3) };
}

export function observePageChange(previous, next, ownedRequests) {
  // Both observations must bracket the SAME executing layout. Queued navigation
  // or a change between jobs must never count as concurrent UI navigation.
  return !!previous && previous.workloadMode === 'ui' && next.workloadMode === 'ui' &&
    previous.pageId !== next.pageId && next.phase === 'creating' &&
    previous.phase === 'creating' && next.requestId === previous.requestId && ownedRequests.has(next.requestId);
}

export async function runStress(config, { api = bridge, save = () => {}, saveImage = () => {},
  onEvent = () => {}, onUiSwitch, sleep = delay, now = Date.now } = {}) {
  const plan = stressPlan(config);
  requireThat(/^[A-Za-z0-9]{1,128}$/.test(config.fileKey || ''), 'An exact Figma file key is required');
  requireThat(['baseline', 'queued', 'ui', 'all'].includes(config.mode), 'Mode must be baseline, queued, ui, or all');
  requireThat(plan.jobs.filter(j => j.pageIndex === 0).length * plan.nodesPerJob * (config.mode === 'all' ? 2 : 1) <= 9000,
    'Reduce roots, callers, or rounds to keep each test page below the spatial scan budget');
  api.assertDaemon(await api.health());
  const client = forFile(config.fileKey, api), initial = await api.coordinate({ op: 'status' });
  const worker = initial.workers.find(w => w.connected && w.fileKey === config.fileKey);
  requireThat(worker && !worker.current && !worker.quarantine &&
    !(initial.lanes || []).some(j => j.workerId === worker.workerId), 'Target file must be connected, idle, and free of quarantine');
  const originalPages = await client.cmd({ op: 'page', action: 'list' });
  const requestedPages = config.switchPageIds || [];
  requireThat(!requestedPages.length || (requestedPages.length >= 2 && new Set(requestedPages).size === requestedPages.length),
    'Supply at least two distinct switch page IDs');
  requireThat(requestedPages.every(id => originalPages.some(p => p.id === id)), 'Every switch page must exist in the bound file');
  const report = { schema: 1, runId: randomUUID(), fileKey: config.fileKey, mode: config.mode, plan,
    startedAt: now(), status: 'running', pages: [], jobs: [], baseline: [], queuedNavigation: [],
    uiRequests: [], uiChangesDuringLayout: [], samples: [], receipts: [], errors: [], screenshots: [] };
  const persist = () => save(report);
  const ownedRequests = new Set();
  let stop = false, previousSample;
  const captureError = e => { report.errors.push(errorInfo(e)); stop = true; persist(); };
  const navigation = async (page, collection) => {
    const event = { pageId: page.id, page: page.name, startedAt: now() }; collection.push(event); persist();
    try {
      const result = await client.cmd({ op: 'page', action: 'select', id: page.id }, undefined, { queueTimeoutMs: 120000 });
      event.navigation = result.navigation; event.wallMs = now() - event.startedAt;
      requireThat(result.current === true, 'Navigation did not reach its target');
    } catch (e) { event.error = errorInfo(e); throw e; } finally { persist(); }
  };
  try {
    // New pages isolate all test artwork. Heavy existing pages are navigation
    // targets only. Leave evidence and test artwork in place for inspection.
    if (config.mode !== 'baseline') for (let i = 0; i < 3; i++) {
      const page = await client.cmd({ op: 'page', action: 'create',
        name: `__Bridge stress ${report.runId.slice(0, 8)} · ${i + 1}`, select: false });
      report.pages.push(page); persist();
    }
    const pool = requestedPages.length ? requestedPages.map(id => originalPages.find(p => p.id === id))
      : config.mode === 'baseline' ? originalPages.slice(0, 3) : report.pages;
    requireThat(pool.length >= 2, 'Select at least two distinct navigation pages');
    requireThat(new Set(pool.map(p => p.id)).size === pool.length, 'Navigation pages must be distinct');
    const order = randomPages(plan.seed, 12, pool.length);
    report.navigationPages = pool; persist();
    for (const index of order.slice(0, 4)) await navigation(pool[index], report.baseline);
    if (config.mode === 'baseline') {
      report.finalStatus = await api.coordinate({ op: 'status' });
      requireThat(!report.finalStatus.workers.find(w => w.fileKey === config.fileKey)?.quarantine, 'Navigation left a quarantine');
      report.status = 'passed'; return report;
    }

    for (const workloadMode of config.mode === 'all' ? ['queued', 'ui'] : [config.mode]) {
    if (stop) break;
    report.phase = workloadMode; previousSample = undefined; report.nextSwitch = null; persist();
    // Each caller awaits its own job; callers submit together. First round
    // contends on one page; later rounds use different explicit page parents.
    let layoutsDone = false;
    const callers = Array.from({ length: plan.callers }, (_, caller) => (async () => {
      for (const item of plan.jobs.filter(j => j.caller === caller)) {
        if (stop) break;
        const page = report.pages[item.pageIndex], requestId = randomUUID();
        const label = `__Bridge stress ${report.runId.slice(0, 8)} · ${workloadMode} · agent ${caller + 1} · round ${item.round + 1}`;
        const event = { ...item, phase: workloadMode, requestId, pageId: page.id, startedAt: now(), label };
        report.jobs.push(event); ownedRequests.add(requestId); persist();
        try {
          const result = await client.cmd({ op: 'create', parent: page.id, placement: 'auto', select: false, zoom: false,
            specs: geometricFixture(label, caller, plan.roots) }, 120000, { queueTimeoutMs: 120000,
            coordination: { requestId, agentId: `stress-${caller}`, pageId: page.id, label, placement: 'auto' } });
          event.wallMs = now() - event.startedAt; event.created = result.created; event.performance = result.performance;
          requireThat(result.created?.length === plan.roots && result.created.every(n => n.w === 180 && n.h === 240),
            'Root count or measured size differs from the fixture');
        } catch (e) { event.error = errorInfo(e); captureError(e); } finally { persist(); }
      }
    })());
    const completion = Promise.allSettled(callers).then(results => {
      for (const r of results) if (r.status === 'rejected') captureError(r.reason);
      layoutsDone = true;
    });
    const monitor = (async () => {
      let uiIndex = 0;
      while (!layoutsDone) {
        try {
          const started = now(), info = await client.cmd({ op: 'ping' }, 10000), pingMs = now() - started;
          const status = await api.coordinate({ op: 'status' });
          const w = status.workers.find(w => w.fileKey === config.fileKey && w.connected);
          const sameJob = info.current?.id && info.current.id === w?.current?.wireId;
          const sample = { at: now(), workloadMode, pingMs, pageId: info.pageId,
            requestId: sameJob ? w.current.requestId : null, phase: sameJob ? w.current.phase : null, quarantine: w?.quarantine };
          if (report.samples.length < 1200) report.samples.push(sample);
          for (const r of status.recent || []) if (ownedRequests.has(r.id) && !report.receipts.some(old => old.id === r.id)) report.receipts.push(r);
          if (observePageChange(previousSample, sample, ownedRequests)) report.uiChangesDuringLayout.push({ before: previousSample, after: sample });
          previousSample = sample;
          requireThat(w && !w.quarantine, 'File disconnected or became quarantined during stress test');
          if (report.nextSwitch && sample.pageId === report.nextSwitch.pageId) {
            report.nextSwitch.observedAt = now();
            // Includes automation/operator response time, NOT pure native API latency.
            report.nextSwitch.requestToObservationMs = now() - report.nextSwitch.requestedAt;
            report.nextSwitch = null;
          }
          if (workloadMode === 'ui' && !stop && !report.nextSwitch && uiIndex < order.length &&
              sample.phase === 'creating' && ownedRequests.has(sample.requestId)) {
            let page = pool[order[uiIndex++]];
            if (page.id === sample.pageId) page = pool.find(p => p.id !== sample.pageId);
            const request = { pageId: page.id, page: page.name, requestedAt: now(), duringRequestId: sample.requestId };
            report.nextSwitch = request; report.uiRequests.push(request); persist();
            onEvent({ type: 'switch-in-figma-ui', ...request });
            // An external UI driver may click Figma here. Never call page.select
            // from this hook: it would queue behind the layout under test.
            if (onUiSwitch) request.driver = await onUiSwitch(request);
          }
          persist();
        } catch (e) { captureError(e); break; }
        await sleep(500);
      }
    })();
    const queuedSwitches = (async () => {
      if (workloadMode !== 'queued') return;
      await sleep(100);
      for (const index of order) {
        if (stop || layoutsDone) break;
        try { await navigation(pool[index], report.queuedNavigation); } catch (e) { captureError(e); break; }
      }
    })();
    await Promise.allSettled([completion, monitor, queuedSwitches]);
    }
    // Even after a failure, wait for admitted requests to settle; never replay.
    report.finalStatus = await api.coordinate({ op: 'status' });
    // The last layout can finish after the monitor's final sample.
    for (const r of report.finalStatus.recent || []) {
      if (ownedRequests.has(r.id) && !report.receipts.some(old => old.id === r.id)) report.receipts.push(r);
    }
    persist();
    requireThat(!report.errors.length, 'A stress operation failed; inspect the recorded error before another run');
    for (const page of report.pages) {
      const expected = report.jobs.filter(j => j.pageId === page.id).flatMap(j => j.created || []);
      const children = await client.cmd({ op: 'children', id: page.id }, 120000);
      requireThat(children.length === expected.length && expected.every(n => children.some(c => c.id === n.id && c.w === 180 && c.h === 240)),
        'Test roots were lost, resized, or routed to the wrong page');
      if (expected.length) {
        const png = await client.cmd({ op: 'exportImage', id: expected[0].id, scale: 1 });
        const name = `page-${report.pages.indexOf(page) + 1}.png`;
        saveImage(name, png.base64); report.screenshots.push({ pageId: page.id, nodeId: expected[0].id, name });
      }
    }
    requireThat(!report.finalStatus.workers.find(w => w.fileKey === config.fileKey)?.quarantine, 'Run left the file quarantined');
    requireThat(!['ui', 'all'].includes(config.mode) || report.uiChangesDuringLayout.length >= 2,
      'UI concurrency not demonstrated: require two page changes during executing layouts, using Figma UI');
    requireThat(!['queued', 'all'].includes(config.mode) || report.queuedNavigation.length > 0, 'No navigation overlapped the layout workload');
    report.status = 'passed';
  } catch (e) {
    report.status = 'failed'; report.errors.push(errorInfo(e));
  } finally { report.finishedAt = now(); persist(); }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--file-key', '--mode', '--seed', '--callers', '--rounds', '--roots', '--switch-pages', '--output']);
  const values = new Map(); let live = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run') { live = true; continue; }
    if (args[i] === '--plan') continue;
    requireThat(allowed.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'Unknown or incomplete option: ' + args[i]);
    values.set(args[i], args[++i]);
  }
  const config = { fileKey: values.get('--file-key'), mode: values.get('--mode') || 'all',
    ...(values.has('--switch-pages') ? { switchPageIds: values.get('--switch-pages').split(',') } : {}) };
  for (const key of ['seed', 'callers', 'rounds', 'roots']) if (values.has('--' + key)) config[key] = Number(values.get('--' + key));
  if (!live) { console.log(JSON.stringify({ ...config, plan: stressPlan(config), live: false }, null, 2)); return; }
  const dir = resolve(values.get('--output') || join('recovery', 'navigation-stress', randomUUID()));
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir, { recursive: false }); // Existing evidence must never be overwritten.
  const report = await runStress(config, {
    save: report => writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2)),
    saveImage: (name, base64) => writeFileSync(join(dir, name), Buffer.from(base64, 'base64')),
    onEvent: event => console.log(JSON.stringify(event)),
  });
  console.log(JSON.stringify({ status: report.status, report: join(dir, 'report.json'), errors: report.errors }));
  if (report.status !== 'passed') process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => {
  console.error(JSON.stringify(errorInfo(e))); process.exitCode = 1;
});
