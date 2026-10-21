// Documentation stub: plays the plugin sandbox and the daemon for plugin/ui.html so
// the console can be photographed with sample data. It replaces WebSocket and the
// parent window inside the rendered copy only; it never opens a real connection.
(() => {
  const scene = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  const mode = scene.mode || 'console', theme = scene.theme || 'ios', started = Date.now();
  const deliver = msg => setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { pluginMessage: msg }, origin: 'https://www.figma.com' })), 0);
  const identity = { file: 'Checkout flows', page: 'Checkout', pageId: 'p1', fileKey: 'fileA', instanceId: 'docs-instance', protocol: 4, build: 'docs' };
  const localJob = () => ({ id: 'x1', op: 'create', ms: Date.now() - started + 9000, done: 540, total: 1008, ownedNodes: 540, target: { page: 'Checkout', pageId: 'p1' } });
  window.parent = { postMessage(envelope) {
    const msg = envelope && envelope.pluginMessage; if (!msg) return;
    if (msg.type === 'identify') {
      deliver({ type: 'identity', ...identity, deviceCredential: 'a'.repeat(64), uiMode: mode, uiTheme: theme, busy: false });
      deliver({ type: 'status', ...identity, queued: 1, queuedBytes: 480000, limits: { queueJobs: 8, queueBytes: 16777216 }, current: localJob(), queue: [] });
    }
    if (msg.type === 'ui-mode') deliver({ type: 'ui-mode', mode: msg.mode });
  } };

  const grid = (cols, rows, boxes) => {
    const bits = new Array(cols * rows).fill(0);
    for (const [x0, y0, x1, y1] of boxes) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) bits[y * cols + x] = 1;
    let hex = ''; for (let i = 0; i < bits.length; i += 4) hex += (bits[i] * 8 + bits[i + 1] * 4 + bits[i + 2] * 2 + bits[i + 3]).toString(16); return hex;
  };
  const screens = []; for (let r = 0; r < 3; r++) for (let c = 0; c < 7; c++) screens.push([c * 7, r * 10, c * 7 + 4, r * 10 + 7]);
  function telemetry(sequence) {
    const now = Date.now(), done = 540, hwDone = 225;
    return { type: 'telemetry', schema: 1, sequence, coordinatorEpoch: 'docs', sampledAt: now, held: 1, maxWorkers: 4,
      budgets: { jobs: 5, maxJobs: 32, bytes: 2400000, maxBytes: 33554432 },
      resources: { memory: { rss: 61000000, heapUsed: 18000000, external: 2000000 }, eventLoopDelayMs: { p99: 11.3 } },
      workers: [
        { workerId: 'w1', sessionEpoch: 's1', fileKey: 'fileA', file: 'Checkout flows', page: 'Checkout', pageId: 'p1', connected: true, quarantine: false,
          current: { requestId: 'r1', wireId: 'x1', laneId: 'auto-r1', label: 'Checkout · 24 screens', agentId: 'checkout-builder', op: 'create', category: 'change', phase: 'creating', executionMs: 9000, progress: { done, total: 1008 } } },
        { workerId: 'w2', sessionEpoch: 's2', fileKey: 'fileB', file: 'Brand library', page: 'Components', pageId: 'q1', connected: true, quarantine: false, current: null },
      ],
      highways: [
        { id: 'hw-1', fileKey: 'fileA', workerId: 'w1', sessionEpoch: 'hw-1', agentId: 'onboarding-builder', label: 'Onboarding', port: 51234, state: 'open', agent: 'connected', plugin: 'connected', queued: 2, outbox: 0, quarantine: false,
          current: { requestId: 'h1', wireId: 'hx1', laneId: 'auto-h1', label: 'Onboarding · 12 screens', op: 'create', category: 'change', executionMs: 6000, progress: { done: hwDone, total: 600 },
            target: { pageId: 'p3', page: 'Onboarding', nodeId: 'p3', kind: 'write', bounds: null } } },
        { id: 'hw-2', fileKey: 'fileA', workerId: 'w1', sessionEpoch: 'hw-2', agentId: 'audit-bot', label: 'Audit', port: 51240, state: 'open', agent: 'away', plugin: 'connected', queued: 0, outbox: 1, quarantine: false, current: null },
        { id: 'hw-3', fileKey: 'fileB', workerId: 'w2', sessionEpoch: 'hw-3', agentId: 'brand-builder', label: 'Brand', port: 51251, state: 'open', agent: 'connected', plugin: 'connected', queued: 1, outbox: 0, quarantine: true, current: null },
      ],
      lobby: [
        { at: now - 4000, event: 'agent-away', highwayId: 'hw-2', fileKey: 'fileA', agentId: 'audit-bot' },
        { at: now - 9000, event: 'plugin-resumed', highwayId: 'hw-1', fileKey: 'fileA' },
        { at: now - 19000, event: 'agent-joined', highwayId: 'hw-1', fileKey: 'fileA', agentId: 'onboarding-builder' },
        { at: now - 20000, event: 'opened', highwayId: 'hw-1', fileKey: 'fileA', agentId: 'onboarding-builder', port: 51234 },
        { at: now - 26000, event: 'closed', highwayId: 'hw-0', fileKey: 'fileB', reason: 'Closed by the agent' },
      ],
      lanes: [
        { requestId: 'r1', workerId: 'w1', laneId: 'auto-r1', label: 'Checkout · 24 screens', agentId: 'checkout-builder', pageId: 'p1', state: 'running', waitMs: 300, bytes: 900000 },
        { requestId: 'r2', workerId: 'w1', laneId: 'auto-r2', label: 'Settings · 8 screens', agentId: 'checkout-builder', pageId: 'p1', state: 'queued', waitMs: 4100, bytes: 300000, blockedReason: 'waiting-worker-turn' },
      ],
      reservations: [
        { requestId: 'r1', fileKey: 'fileA', pageId: 'p1', laneId: 'auto-r1', agentId: 'checkout-builder', label: 'Checkout · 24 screens', state: 'running', rect: { x: 0, y: 2300, width: 4900, height: 1500 }, gutter: 24, nodeCount: 0, roots: [] },
        { requestId: 'r3', fileKey: 'fileA', pageId: 'p1', laneId: 'auto-r3', agentId: 'audit-bot', label: 'Audit legend', state: 'committed', completedAt: now - 30000, rect: { x: 5100, y: 0, width: 900, height: 700 }, gutter: 24, nodeCount: 1, roots: [{ rect: { x: 5120, y: 20, width: 860, height: 640 } }] },
        { requestId: 'r4', fileKey: 'fileB', pageId: 'q2', laneId: 'auto-r4', agentId: 'brand-builder', label: 'Icon sheet', state: 'held', rect: { x: 0, y: 0, width: 1200, height: 900 }, gutter: 24, nodeCount: 0, roots: [] },
      ],
      earlierCommitted: [{ fileKey: 'fileA', count: 4 }],
      sketches: [
        { workerId: 'w1', fileKey: 'fileA', pageId: 'p1', page: 'Checkout', roots: 21, cols: 48, rows: 30, extent: { x: 0, y: 0, width: 6000, height: 2200 }, cells: grid(48, 30, screens), measuredAt: now - 8000 },
        { workerId: 'w1', fileKey: 'fileA', pageId: 'p3', page: 'Onboarding', roots: 6, cols: 48, rows: 30, extent: { x: 0, y: 0, width: 3000, height: 1200 }, cells: grid(48, 30, [[0, 0, 14, 12], [17, 0, 31, 12], [34, 0, 47, 12], [0, 16, 22, 29]]), measuredAt: now - 3000 },
        { workerId: 'w2', fileKey: 'fileB', pageId: 'q1', page: 'Components', roots: 1840, cols: 48, rows: 30, extent: { x: -2000, y: -500, width: 30000, height: 16000 }, cells: grid(48, 30, [[0, 0, 47, 3], [0, 6, 30, 12], [33, 6, 47, 20], [0, 15, 29, 29]]), measuredAt: now - 60000 },
      ],
      timeline: [
        { id: 't1', workerId: 'w1', laneId: 'auto-r1', label: 'Placement scan · Checkout', op: 'layoutInfo', category: 'query', outcome: 'succeeded', start: now - 41000, end: now - 40500 },
        { id: 't2', workerId: 'w1', laneId: '$control', op: 'info', category: 'query', outcome: 'succeeded', start: now - 30000, end: now - 29990 },
        { id: 't3', workerId: 'w1', laneId: '$exclusive', op: 'exportImage', category: 'screenshot', outcome: 'succeeded', start: now - 22000, end: now - 19000 },
        { id: 't4', workerId: 'w1', laneId: '$exclusive', op: 'find', category: 'query', outcome: 'succeeded', start: now - 12000, end: now - 11800 },
        { id: 't5', workerId: 'w2', laneId: 'batch-r8', label: 'Batch 8 · 30 commands', op: 'batch', category: 'batch', outcome: 'partial', start: now - 50000, end: now - 31000 },
        { id: 't6', workerId: 'w2', laneId: '$control', op: 'ping', category: 'control', outcome: 'succeeded', start: now - 9000, end: now - 8995 },
        { id: 't7', workerId: 'w1', highwayId: 'hw-1', laneId: 'auto-h0', op: 'create', category: 'change', outcome: 'succeeded', start: now - 38000, end: now - 33000 },
        { id: 't8', workerId: 'w1', highwayId: 'hw-1', laneId: '$control', op: 'find', category: 'query', outcome: 'succeeded', start: now - 26000, end: now - 25800 },
        { id: 't9', workerId: 'w1', highwayId: 'hw-2', laneId: '$exclusive', op: 'exportImage', category: 'screenshot', outcome: 'succeeded', start: now - 32000, end: now - 27000 },
      ],
      recent: [
        { id: 't4', workerId: 'w1', laneId: '$exclusive', op: 'find', category: 'query', outcome: 'succeeded', items: 24, responseBytes: 5120, target: { pageId: 'p1', page: 'Checkout', nodeId: 'p1', kind: 'read' }, completedAt: now - 11800, queueMs: 0, executionMs: 200 },
        { id: 't3', workerId: 'w1', laneId: '$exclusive', op: 'exportImage', category: 'screenshot', outcome: 'succeeded', responseBytes: 2202009, target: { pageId: 'p1', page: 'Checkout', nodeId: '127:44', kind: 'snapshot' }, completedAt: now - 19000, queueMs: 400, executionMs: 3000 },
        { id: 't5', workerId: 'w2', laneId: 'batch-r8', label: 'Batch 8 · 30 commands', op: 'batch', category: 'batch', outcome: 'partial', items: 30, kind: 'batch-failed', completedAt: now - 31000, queueMs: 1200, executionMs: 19000 },
        { id: 't1', workerId: 'w1', laneId: 'auto-r1', label: 'Placement scan · Checkout', agentId: 'checkout-builder', op: 'layoutInfo', category: 'query', outcome: 'succeeded', items: 21, responseBytes: 3100, target: { pageId: 'p1', page: 'Checkout', nodeId: null, kind: 'read' }, completedAt: now - 40500, queueMs: 0, executionMs: 500 },
      ] };
  }

  let sequence = 0, applied = false;
  // Scroll the console's main column so the section heading sits at the top. Repeated on
  // every sample because the panel paints asynchronously after showPanel().
  function scrollScene() {
    const target = scene.scroll && document.getElementById(scene.scroll), main = document.querySelector('main');
    if (target && main) main.scrollTop += target.getBoundingClientRect().top - main.getBoundingClientRect().top - 8;
  }
  function apply() {
    if (!applied) {
      applied = true;
      setTimeout(() => {
        if (scene.tab) window.showPanel(scene.tab);
        if (scene.dialog === 'close') window.openCloseDialog();
        // The map jumps to a file with held work; the documentation shows every file.
        const picker = scene.file === 'all' && document.getElementById(scene.tab === 'zones' ? 'zone-page-full' : 'zone-page');
        if (picker) { picker.value = ''; picker.dispatchEvent(new Event('change')); }
      }, 100);
    }
    setTimeout(scrollScene, 300);
  }
  class FakeSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 5); }
    receive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    send(text) {
      let msg; try { msg = JSON.parse(text); } catch { return; }
      if (!/:3456\//.test(this.url) || msg.type !== 'hello') return;
      setTimeout(() => {
        this.receive({ type: 'ready', workerId: 'w1', sessionEpoch: 's1', coordinatorEpoch: 'docs', credential: 'docs-credential' });
        const tick = () => { this.receive(telemetry(++sequence)); apply(); };
        setTimeout(tick, 30); setInterval(tick, 1000);
      }, 5);
    }
    close() { this.readyState = 3; }
  }
  window.WebSocket = FakeSocket;
})();
