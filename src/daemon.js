#!/usr/bin/env node
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { wrapCodeIfNeeded } from './lib/eval-wrap.js';
import { BridgeCoordinator } from './lib/bridge-coordinator.js';
import { Highways } from './lib/bridge-highways.js';
import { join } from 'node:path';
import { LIMITS, bridgeError, deadline } from './lib/bridge-protocol.js';
import { BodyBudget, ResponseSlots, readJsonBody, withDeadline } from './lib/bridge-http.js';
import { buildIdentity } from './lib/bridge-build.js';
import { ensureToken, PID_FILE, STATE_DIR } from './lib/bridge-state.js';
import { documentLifecycle } from './lib/bridge-lifecycle.js';
import { windowsPairingApproval } from './lib/bridge-pairing.js';

const BUILD = buildIdentity();
const PORT = Number(process.env.DAEMON_PORT || 3456);
const MODE = process.env.DAEMON_MODE || 'auto';
const IDLE_TIMEOUT_MS = Number(process.env.DAEMON_IDLE_TIMEOUT || 3600000);
const SESSION_TOKEN = ensureToken();
function validateRequest(req) {
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return 'Invalid host header';
  if (!SESSION_TOKEN || req.headers['x-daemon-token'] !== SESSION_TOKEN) return 'Invalid or missing token';
  return null;
}
let idleTimer;
function resetIdleTimer() { clearTimeout(idleTimer); idleTimer = setTimeout(shutdown, IDLE_TIMEOUT_MS); }
const bridge = new BridgeCoordinator({ expectedBuild: BUILD.pluginBuild, activity: resetIdleTimer,
  journalPath: join(STATE_DIR, 'coordinator-journal.json'),
  pairingPath: join(STATE_DIR, 'paired-computers.json'), approvePairing: windowsPairingApproval(),
  resources: () => ({ sampledAt: Date.now(), source: 'Node process', memory: process.memoryUsage(), eventLoopDelayMs: { mean: Number.isFinite(loopDelay.mean) ? loopDelay.mean / 1e6 : null, p99: loopDelay.percentile(99) / 1e6 } }),
  log: (event, data) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data })) });
// The main port is the lobby: agents ask it for a private highway port per file.
const highways = new Highways(bridge, { expectedBuild: BUILD.pluginBuild, activity: resetIdleTimer,
  log: (event, data) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data })) });
const loopDelay = monitorEventLoopDelay({ resolution: 20 }); loopDelay.enable();
const ingress = new BodyBudget();
const responses = new ResponseSlots();
let FigmaClient;
async function getFigmaClient() { return FigmaClient ||= (await import('./figma-client.js')).FigmaClient; }
let cdpClient = null, isCdpConnecting = false, lastHealthCheck = 0, lastHealthResult = false;
let cdpBusy = false, cdpUncertain = false;
const HEALTH_CACHE_MS = 30000;

async function isCdpHealthy(forceCheck = false) {
  // Quick WebSocket state check (no network call)
  if (!cdpClient || !cdpClient.ws) return false;
  if (cdpClient.ws.readyState !== 1) return false;

  // Use cached result if recent (avoids constant eval calls)
  const now = Date.now();
  if (!forceCheck && now - lastHealthCheck < HEALTH_CACHE_MS) {
    return lastHealthResult;
  }

  try {
    const result = await withDeadline(() => cdpClient.eval('typeof figma === "object" && figma !== null && !!figma.root ? 1 : 0'), 2000);
    lastHealthCheck = now;
    lastHealthResult = result === 1;
    return lastHealthResult;
  } catch {
    lastHealthCheck = now;
    lastHealthResult = false;
    return false;
  }
}

async function getCdpClient() {
  // Fast path: if we have a client with open WebSocket, use it
  if (cdpClient && cdpClient.ws && cdpClient.ws.readyState === 1) {
    return cdpClient;
  }

  // WebSocket closed, need to reconnect
  if (cdpClient) {
    console.log('[daemon] CDP WebSocket closed, reconnecting...');
    try { cdpClient.close(); } catch {}
    cdpClient = null;
    lastHealthResult = false;
  }

  // Wait if another connection attempt is in progress
  if (isCdpConnecting) {
    while (isCdpConnecting) {
      await new Promise(r => setTimeout(r, 100));
    }
    // The other attempt may have failed and left cdpClient null —
    // fall through and try connecting ourselves instead of returning null.
    if (cdpClient && cdpClient.ws && cdpClient.ws.readyState === 1) {
      return cdpClient;
    }
  }

  isCdpConnecting = true;
  try {
    const ClientClass = await getFigmaClient();
    cdpClient = new ClientClass();
    // FIGMA_FILE pins the daemon to a specific open file (substring match on the
    // tab title). Without it Figma's first design tab wins, which silently sends
    // commands to the wrong file when several are open.
    await cdpClient.connect(process.env.FIGMA_FILE || null);
    lastHealthCheck = Date.now();
    lastHealthResult = true;
    console.log('[daemon] Connected to Figma via CDP (Yolo Mode)');
    // Pages remain lazy; ordinary connection must not load the whole document.
  } finally {
    isCdpConnecting = false;
  }
  return cdpClient;
}

async function evalViaCdp(code) {
  const client = await getCdpClient();
  return client.eval(code);
}


function getMode() { return MODE === 'plugin' || bridge.connected() ? 'safe' : MODE === 'cdp' || cdpClient ? 'yolo' : 'disconnected'; }
function respond(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  let wire = JSON.stringify(payload);
  if (Buffer.byteLength(wire) > LIMITS.resultBytes) {
    status = 413; wire = JSON.stringify({ error: 'Result exceeds the response budget', kind: 'result-too-large', outcome: 'uncertain' });
  }
  res.setTimeout(15000, () => res.destroy()); // slow readers must not retain buffers indefinitely
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(wire);
}
async function handleRequest(req, res) {
  let controller, onClose;
  try {
    const auth = validateRequest(req);
    if (req.method === 'OPTIONS' || auth) return respond(res, 403, { error: auth || 'CORS preflight rejected', kind: 'unauthorized', outcome: 'not-started' });
    resetIdleTimer();
    if ((req.url === '/health' || req.url === '/diagnostics') && req.method === 'GET') {
      const plugin = bridge.diagnostics();
      const cdp = MODE !== 'plugin' && !cdpBusy && !cdpUncertain ? await isCdpHealthy() : false;
      const base = { status: plugin.connected || cdp ? 'ok' : 'disconnected', ...BUILD, pid: process.pid, stateDirectory: STATE_DIR,
        mode: getMode(), plugin: plugin.connected, busy: !!plugin.busy || cdpBusy || plugin.uncertain > 0 || !!bridge.lifecycleBusy,
        lifecycle: { active: !!bridge.lifecycleBusy, nativeRedo: false, automaticPluginRelaunch: false },
        pending: plugin.pending, recoveryRequired: plugin.recoveryRequired, cdp, cdpUncertain, file: plugin.identity?.file || cdpClient?.pageTitle || null,
        page: plugin.identity?.page || null, idleTimeoutMs: IDLE_TIMEOUT_MS };
      if (req.url === '/diagnostics') Object.assign(base, { uptimeSeconds: process.uptime(), memory: process.memoryUsage(),
        eventLoopDelayMs: { mean: Number.isFinite(loopDelay.mean) ? loopDelay.mean / 1e6 : 0, p99: loopDelay.percentile(99) / 1e6, max: loopDelay.max / 1e6 }, ingress: { ...ingress }, responses: { ...responses }, bridge: plugin });
      return respond(res, 200, base);
    }
    if (req.method !== 'POST' || !['/exec', '/shutdown', '/reconnect'].includes(req.url)) return respond(res, 404, { error: 'Not found', kind: 'invalid-request', outcome: 'not-started' });
    if (req.url === '/exec' && !responses.acquire(res)) {
      req.resume();
      throw bridgeError('queue-full', 'HTTP request/response capacity exceeded', { outcome: 'not-started' });
    }
    controller = new AbortController();
    onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    const { value: payload } = await readJsonBody(req, { budget: ingress });
    if (res.destroyed) return;
    // Structured clients must identify their checkout AND exact source build.
    if (['cmd', 'cmd-batch', 'lifecycle', 'coordinate', 'highway'].includes(payload.action) || req.url === '/shutdown') {
      if (payload.expectedRoot !== BUILD.root || payload.expectedDaemonBuild !== BUILD.daemonBuild || payload.protocol !== BUILD.protocol) {
        throw bridgeError('build-mismatch', 'Daemon belongs to another checkout or build. Use the project launcher diagnostics/restart.', { outcome: 'not-started' });
      }
      if (!BUILD.pluginStamped) throw bridgeError('build-mismatch', 'Run the project launcher build before starting the daemon', { outcome: 'not-started' });
    }
    if (req.url === '/shutdown') {
      if (responses.active || bridge.diagnostics().pending || bridge.diagnostics().uncertain || bridge.lifecycleBusy || cdpBusy || cdpUncertain) throw bridgeError('worker-busy', 'Cannot restart while work is active or uncertain', { outcome: 'not-started' });
      respond(res, 200, { result: 'stopping' }); setImmediate(shutdown); return;
    }
    if (req.url === '/reconnect') {
      if (MODE === 'plugin' || bridge.connected()) throw bridgeError('unsupported', 'Rerun the figma-cli-ultimate plugin to reconnect', { outcome: 'not-started' });
      if (cdpBusy || cdpUncertain) throw bridgeError('worker-busy', 'CDP work has not settled', { outcome: 'not-started' });
      cdpClient?.close(); cdpClient = null; await getCdpClient();
      return respond(res, 200, { status: 'reconnected', mode: 'yolo' });
    }
    let result;
    if (payload.action === 'highway') {
      const op = payload.cmd?.op;
      if (op === 'open') result = await highways.open(payload.cmd);
      else if (op === 'close') result = { closed: await highways.close(String(payload.cmd.highwayId || ''), 'Closed through the lobby') };
      else if (op === 'list') result = bridge.snapshot(true).highways;
      else throw bridgeError('invalid-request', 'Unknown highway operation', { outcome: 'not-started' });
    } else if (payload.action === 'coordinate') {
      if (payload.cmd?.op === 'pair') result = bridge.pair();
      else if (payload.cmd?.op === 'create-lane') result = bridge.createLane(payload.cmd, payload.coordination);
      else if (payload.cmd?.op === 'remove-lane') result = bridge.removeLane(payload.cmd.laneId, payload.coordination);
      else if (payload.cmd?.op === 'lanes') result = bridge.laneSummary();
      else if (payload.cmd?.op === 'status') result = bridge.snapshot();
      else if (payload.cmd?.op === 'receipt') result = bridge.journal.records.get(payload.cmd.requestId) || null;
      else if (payload.cmd?.op === 'reconcile') result = await bridge.reconcile(payload.cmd.requestId, payload.coordination);
      else if (payload.cmd?.op === 'cancel') { const w = bridge.select(payload.coordination); result = { cancelled: bridge.cancel(payload.cmd.requestId, w.workerId) }; }
      else throw bridgeError('invalid-request', 'Unknown coordinator operation');
    } else if (payload.action === 'lifecycle') {
      const worker = bridge.select(payload.coordination);
      if (bridge.pending.size || bridge.protected(worker.fileKey)) throw bridgeError('worker-busy', 'Lifecycle requires idle work and no protected zones', { outcome: 'not-started' });
      bridge.lifecycleBusy = true;
      let guard, lifecycleError = null;
      const lifecycleStarted = Date.now();
      try {
        if (payload.cmd?.op === 'reload') {
          if (bridge.quarantined(worker.fileKey)) throw bridgeError('worker-uncertain', 'File requires reconciliation', { outcome: 'not-started' });
          guard = { fileKey: worker.fileKey || '*', requestId: 'lifecycle-' + Date.now(), state: 'running' };
          bridge.journal.fileHolds.set(guard.fileKey, guard); bridge.journal.save();
        }
        result = await documentLifecycle(worker.bridge, payload.cmd, { signal: controller.signal, port: Number(process.env.FIGMA_CDP_PORT || 9222) });
        if (guard) { bridge.journal.fileHolds.delete(guard.fileKey); bridge.journal.save(); }
      } catch (error) {
        lifecycleError = error;
        if (guard) {
          if (error.outcome === 'not-started') bridge.journal.fileHolds.delete(guard.fileKey);
          else { guard.state = 'held'; bridge.journal.fileHolds.set(guard.fileKey, guard); }
          bridge.journal.save();
        }
        throw error;
      }
      finally {
        bridge.lifecycleBusy = false;
        // Document inspection and reloads run outside the plugin queue; still leave a receipt.
        bridge.record({ id: 'lifecycle-' + lifecycleStarted, workerId: worker.workerId, laneId: '$control', pageId: null,
          op: 'lifecycle:' + String(payload.cmd?.op || 'unknown').slice(0, 32), category: 'control',
          outcome: lifecycleError ? lifecycleError.outcome || 'failed' : 'succeeded', kind: lifecycleError?.kind || null,
          completedAt: Date.now(), queueMs: 0, executionMs: Date.now() - lifecycleStarted });
      }
    } else if (['cmd', 'cmd-batch'].includes(payload.action)) {
      result = await bridge.dispatch(payload.action, payload.action === 'cmd' ? { cmd: payload.cmd } : { cmds: payload.cmds },
        { timeoutMs: payload.timeoutMs, queueTimeoutMs: payload.queueTimeoutMs, signal: controller.signal, coordination: payload.coordination });
    } else {
      if (!['eval', 'render', 'render-batch'].includes(payload.action)) throw bridgeError('invalid-request', 'Unknown action', { outcome: 'not-started' });
      if (MODE === 'plugin' || bridge.connected()) throw bridgeError('unsupported', 'This plugin uses structured commands. Use the figma-cli-ultimate launcher send command.', { outcome: 'not-started' });
      if (cdpBusy || cdpUncertain) throw bridgeError('worker-busy', 'CDP is busy or its previous outcome is uncertain', { outcome: 'not-started' });
      cdpBusy = true;
      try {
        result = await withDeadline(async () => {
          let code = payload.code;
          if (payload.action !== 'eval') {
            const Client = await getFigmaClient(), parser = new Client();
            if (payload.collection) parser.setCollection(payload.collection);
            code = payload.action === 'render' ? await parser.parseJSX(payload.jsx) : await parser.parseJSXBatch(payload.jsxArray, { gap: payload.gap ?? 40, vertical: !!payload.vertical });
          }
          if (controller.signal.aborted) throw bridgeError('client-gone', 'Client disconnected before execution', { outcome: 'not-started' });
          return evalViaCdp(wrapCodeIfNeeded(code));
        }, deadline(payload.timeoutMs, payload.action === 'eval' ? 30000 : 90000));
      } catch (e) {
        if (e.kind === 'daemon-timeout') controller.abort(); // prevent a late parser from dispatching eval
        if (e.outcome !== 'not-started') { e.outcome = 'uncertain'; cdpUncertain = true; }
        throw e;
      }
      finally { cdpBusy = false; }
    }
    respond(res, 200, { result, mode: getMode() });
  } catch (e) {
    const status = e.kind === 'payload-too-large' ? 413 : ['invalid-request', 'build-mismatch', 'unsupported'].includes(e.kind) ? 400 : ['queue-full', 'worker-busy', 'worker-uncertain'].includes(e.kind) ? 429 : e.kind === 'plugin-offline' ? 503 : 500;
    respond(res, status, { error: e.message, kind: e.kind || 'daemon', outcome: e.outcome || 'not-started', requestId: e.requestId, details: e.details });
  } finally { if (onClose) res.off('close', onClose); }
}
const httpServer = createServer(handleRequest);
httpServer.headersTimeout = 10000;
httpServer.requestTimeout = 15000; // body upload only; execution uses explicit deadlines
const wss = new WebSocketServer({ server: httpServer, path: '/plugin', maxPayload: LIMITS.resultBytes, perMessageDeflate: false });
wss.on('connection', (ws, req) => {
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return ws.close(1008, 'Invalid host');
  bridge.attach(ws, req.headers.origin);
});
httpServer.on('error', err => { console.error('[daemon] ' + err.message); process.exit(err.code === 'EADDRINUSE' ? 0 : 1); });
httpServer.listen(PORT, '127.0.0.1', () => {
  writeFileSync(PID_FILE, String(process.pid)); resetIdleTimer();
  console.log(JSON.stringify({ event: 'daemon-start', port: httpServer.address().port, mode: MODE, ...BUILD }));
  if (MODE !== 'plugin') getCdpClient().catch(() => {});
});
let stopping = false;
function shutdown() {
  if (stopping) return; stopping = true;
  clearTimeout(idleTimer); loopDelay.disable(); highways.closeAll(); bridge.close(); cdpClient?.close();
  try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE); } catch {}
  wss.close(); httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
