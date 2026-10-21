import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { StructuredBridge } from './structured-bridge.js';
import { LIMITS, bridgeError } from './bridge-protocol.js';

const fail = (kind, message) => { throw bridgeError(kind, message, { outcome: 'not-started' }); };
const short = v => typeof v === 'string' ? v.slice(0, 128) : null;
const ident = (v, name) => { if (typeof v !== 'string' || !/^[\w:.-]{1,128}$/.test(v)) fail('invalid-request', name + ' must be a short identifier'); return v; };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const LOOPBACK = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
const ORIGINS = ['null', 'https://www.figma.com', 'https://figma.com'];

// A highway is one agent's private road into one Figma file. The lobby (the
// daemon's main port) only opens and closes highways. Each one listens on its own
// loopback port with exactly one agent socket and one plugin socket, and is a
// coordinator channel: its own queue, its own holds, its own results outbox.
// A drop on either end detaches that end for resumeMs; nothing is cancelled or
// replayed, and other highways never notice.
export class Highways {
  constructor(coordinator, { expectedBuild, log = () => {}, activity = () => {}, resumeMs = 60000, agentWaitMs = 30000, max = 16, outboxMax = 64, outboxBytes = 64 * 1048576 } = {}) {
    Object.assign(this, { coordinator, expectedBuild, log, activity, resumeMs, agentWaitMs, max, outboxMax, outboxBytes });
    coordinator.onWorkerReady = w => this.announce(w);
  }
  list() { return [...this.coordinator.highways.values()]; }

  async open({ fileKey, agentId, label } = {}) {
    ident(fileKey, 'fileKey'); agentId = ident(agentId ?? 'agent', 'agentId');
    const worker = [...this.coordinator.workers.values()].find(w => w.fileKey === fileKey && w.bridge.connected());
    if (!worker) fail('plugin-offline', 'Open figma-cli-ultimate in file ' + fileKey + ' first.');
    if (this.coordinator.highways.size >= this.max) fail('queue-full', 'Highway capacity reached; close an idle highway first.');
    const id = 'hw-' + randomUUID(), ticket = randomBytes(32).toString('hex');
    const bridge = new StructuredBridge({ expectedBuild: this.expectedBuild, log: this.log, activity: this.activity, resumeMs: this.resumeMs });
    const h = { kind: 'highway', id, fileKey, workerId: worker.workerId, sessionEpoch: id, agentId, label: short(label) || agentId, ticket, bridge,
      active: null, state: 'opening', agentState: 'waiting', agentWs: null, outbox: [], outboxSize: 0, requests: new Map(), inflight: new Set(), openedAt: Date.now(), port: null };
    bridge.onLateResult = msg => this.coordinator.lateResult(h, msg);
    bridge.onProgress = (wireId, progress) => this.progress(h, wireId, progress);
    h.server = createServer((req, res) => res.writeHead(404).end());
    h.wss = new WebSocketServer({ server: h.server, maxPayload: LIMITS.resultBytes, perMessageDeflate: false });
    h.wss.on('connection', (ws, req) => this.connection(h, ws, req));
    await new Promise((resolve, reject) => { h.server.once('error', reject); h.server.listen(0, '127.0.0.1', () => { h.server.off('error', reject); resolve(); }); });
    h.port = h.server.address().port;
    this.coordinator.highways.set(id, h);
    h.agentTimer = setTimeout(() => { if (h.agentState === 'waiting') this.close(id, 'The agent never connected'); }, this.agentWaitMs);
    h.agentTimer.unref?.();
    this.announce(worker, h);
    this.coordinator.noteLobby({ event: 'opened', highwayId: id, fileKey, agentId, port: h.port });
    return { highwayId: id, port: h.port, ticket, fileKey, agentId, resumeMs: this.resumeMs };
  }

  // The plugin learns about highways only over its paired control socket, and
  // again whenever that socket reconnects (for example after reopening the plugin).
  announce(worker, only) {
    if (!worker.bridge.connected()) return;
    for (const h of only ? [only] : this.list()) if (h.fileKey === worker.fileKey && ['opening', 'open'].includes(h.state)) {
      worker.bridge.session.ws.send(JSON.stringify({ type: 'open-highway', highwayId: h.id, sessionEpoch: h.sessionEpoch, port: h.port, ticket: h.ticket, agentId: h.agentId, label: h.label }));
    }
  }

  connection(h, ws, req) {
    if (!LOOPBACK.test(req.headers.host || '') || !['opening', 'open'].includes(h.state)) return ws.close(1008, 'Highway unavailable');
    const role = req.url === '/agent' ? 'agent' : req.url === '/plugin' ? 'plugin' : null;
    if (!role) return ws.close(1008, 'Unknown highway endpoint');
    if (role === 'plugin' && req.headers.origin && !ORIGINS.includes(req.headers.origin)) return ws.close(1008, 'Invalid origin');
    const timer = setTimeout(() => ws.close(1008, 'Highway hello required'), 5000);
    ws.once('message', data => {
      clearTimeout(timer);
      let msg;
      try { if (data.length > 8192) throw Error(); msg = JSON.parse(data.toString()); } catch { return ws.close(1008, 'Invalid hello'); }
      if (msg?.type !== 'hello' || !same(msg.ticket, h.ticket)) return ws.close(4401, 'Invalid highway ticket');
      if (role === 'agent') this.agent(h, ws); else this.plugin(h, ws, msg);
    });
  }

  plugin(h, ws, msg) {
    if (msg.fileKey !== h.fileKey) return ws.close(1008, 'This highway belongs to another file');
    // A reopened plugin is a new instance: it cannot finish the old one's work.
    const old = h.bridge.session;
    if (old && old.identity?.instanceId !== (msg.instanceId || null)) h.bridge.disconnect(old, 'The plugin was reopened');
    const resumed = !!h.bridge.session;
    if (!h.bridge.attach(ws)) return;
    h.bridge.receive(h.bridge.session, { ...msg, type: 'hello' });
    if (!h.bridge.session) return;
    h.state = 'open';
    this.coordinator.noteLobby({ event: resumed ? 'plugin-resumed' : 'plugin-joined', highwayId: h.id, fileKey: h.fileKey });
    queueMicrotask(() => this.coordinator.drain(h));
  }

  agent(h, ws) {
    if (h.agentWs && h.agentWs.readyState === 1) return ws.close(1008, 'This highway already has an agent');
    clearTimeout(h.agentTimer); clearTimeout(h.awayTimer);
    const resumed = h.agentState === 'away';
    Object.assign(h, { agentWs: ws, agentState: 'connected', agentSeen: Date.now() });
    this.sendAgent(h, { type: 'ready', highwayId: h.id, fileKey: h.fileKey, resumed, outbox: h.outbox.length, plugin: h.bridge.connected() ? 'connected' : 'waiting' });
    // Results that finished while the agent was away, in completion order.
    const waiting = h.outbox.splice(0); h.outboxSize = 0;
    for (const m of waiting) this.sendAgent(h, m);
    ws.on('message', data => this.agentMessage(h, ws, data));
    ws.on('pong', () => { if (h.agentWs === ws) h.agentSeen = Date.now(); });
    ws.on('close', () => this.agentLost(h, ws));
    ws.on('error', () => this.agentLost(h, ws));
    h.agentPing = setInterval(() => {
      if (h.agentWs !== ws) return clearInterval(h.agentPing);
      if (Date.now() - h.agentSeen > 60000) return ws.terminate?.() ?? ws.close();
      try { ws.ping(); } catch {}
    }, 15000);
    h.agentPing.unref?.();
    this.coordinator.noteLobby({ event: resumed ? 'agent-resumed' : 'agent-joined', highwayId: h.id, fileKey: h.fileKey, agentId: h.agentId, delivered: waiting.length });
  }

  agentLost(h, ws) {
    if (h.agentWs !== ws || !['opening', 'open'].includes(h.state)) return;
    clearInterval(h.agentPing);
    Object.assign(h, { agentWs: null, agentState: 'away' });
    // Running work continues; finished results wait in the outbox for the agent.
    h.awayTimer = setTimeout(() => this.close(h.id, 'The agent did not come back'), this.resumeMs);
    h.awayTimer.unref?.();
    this.coordinator.noteLobby({ event: 'agent-away', highwayId: h.id, fileKey: h.fileKey, agentId: h.agentId });
  }

  sendAgent(h, msg) {
    const ws = h.agentWs, wire = JSON.stringify(msg);
    if (ws && ws.readyState === 1 && ws.bufferedAmount < LIMITS.messageBytes) { try { ws.send(wire); return true; } catch {} }
    if (['progress', 'ready'].includes(msg.type)) return false;
    // Bounded: the oldest undelivered result is dropped first, never the newest.
    h.outbox.push(msg); h.outboxSize += Buffer.byteLength(wire);
    while (h.outbox.length > this.outboxMax || h.outboxSize > this.outboxBytes) h.outboxSize -= Buffer.byteLength(JSON.stringify(h.outbox.shift()));
    return false;
  }

  async agentMessage(h, ws, data) {
    if (h.agentWs !== ws) return;
    h.agentSeen = Date.now(); this.activity();
    let m;
    try { if (data.length > LIMITS.messageBytes) throw Error(); m = JSON.parse(data.toString()); } catch { return ws.close(1008, 'Invalid agent message'); }
    if (m?.type === 'close') return this.close(h.id, 'Closed by the agent');
    if (m?.type === 'cancel') { const job = h.requests.get(m.id)?.jobId; if (job) this.coordinator.cancel(job, h.workerId); return; }
    const id = typeof m?.id === 'string' && m.id.length <= 128 ? m.id : null;
    if (!['cmd', 'cmd-batch'].includes(m?.type)) return this.sendAgent(h, { type: 'error', id, error: 'Unknown highway message', kind: 'invalid-request', outcome: 'not-started' });
    if (!id || h.requests.has(id)) return this.sendAgent(h, { type: 'error', id, error: 'Each request needs a unique id', kind: 'invalid-request', outcome: 'not-started' });
    const entry = { jobId: null, wireId: null };
    h.requests.set(id, entry);
    // The highway decides the file and session; an agent can only describe its zone.
    const coordination = m.coordination && typeof m.coordination === 'object' && !Array.isArray(m.coordination) ? { ...m.coordination } : undefined;
    if (coordination) for (const k of ['workerId', 'sessionEpoch', 'fileKey']) delete coordination[k];
    const run = this.coordinator.dispatch(m.type, m.type === 'cmd' ? { cmd: m.cmd } : { cmds: m.cmds }, { channel: h, coordination,
      timeoutMs: m.timeoutMs, queueTimeoutMs: m.queueTimeoutMs, onJob: job => { entry.jobId = job; }, onId: wire => { entry.wireId = wire; } });
    h.inflight.add(run);
    try { this.sendAgent(h, { type: 'result', id, result: await run }); }
    catch (e) { this.sendAgent(h, { type: 'error', id, error: e.message, kind: e.kind || 'daemon', outcome: e.outcome || 'not-started', details: e.details }); }
    finally { h.inflight.delete(run); h.requests.delete(id); }
  }

  progress(h, wireId, progress) {
    for (const [id, entry] of h.requests) if (entry.wireId === wireId) this.sendAgent(h, { type: 'progress', id, done: progress.done, total: progress.total });
    this.coordinator.schedulePublish(h);
  }

  // Queued work returns as not-started at once; a running job finishes in the
  // plugin first, so closing never turns finished work into an unknown outcome.
  async close(id, reason = 'Closed') {
    const h = this.coordinator.highways.get(id);
    if (!h || !['opening', 'open'].includes(h.state)) return false;
    h.state = 'closing'; clearTimeout(h.agentTimer); clearTimeout(h.awayTimer);
    for (const j of [...this.coordinator.jobs.values()]) if (j.worker === h && j.state === 'queued') {
      this.coordinator.finish(j, bridgeError('highway-closed', 'The highway closed before this job started: ' + reason, { outcome: 'not-started' }));
    }
    this.coordinator.noteLobby({ event: 'closing', highwayId: id, fileKey: h.fileKey, reason: short(reason) });
    await Promise.allSettled([...h.inflight]);
    this.shutdown(h, reason);
    return true;
  }

  shutdown(h, reason) {
    h.state = 'closed'; clearInterval(h.agentPing);
    const worker = [...this.coordinator.workers.values()].find(w => w.fileKey === h.fileKey && w.bridge.connected());
    try { worker?.bridge.session.ws.send(JSON.stringify({ type: 'close-highway', highwayId: h.id })); } catch {}
    try { h.agentWs?.close(1000, String(reason).replace(/[^\x20-\x7e]/g, '?').slice(0, 120)); } catch {}
    h.bridge.close(); h.wss.close(); h.server.close();
    this.coordinator.highways.delete(h.id);
    this.coordinator.noteLobby({ event: 'closed', highwayId: h.id, fileKey: h.fileKey, reason: short(reason) });
  }

  // Daemon shutdown: nothing can wait, so in-flight work keeps its receipts and holds.
  closeAll(reason = 'Daemon shutting down') { for (const h of this.list()) { clearTimeout(h.agentTimer); clearTimeout(h.awayTimer); this.shutdown(h, reason); } }
}
