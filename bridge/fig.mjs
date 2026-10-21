#!/usr/bin/env node
// Public Node HTTP APIs, finite deadlines, bounded response bodies, no automatic replay.
import { request as httpRequest } from 'node:http';
import { WebSocket as SocketClient } from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildIdentity } from '../src/lib/bridge-build.js';
import { LIMITS, deadline, executionBudget } from '../src/lib/bridge-protocol.js';
import { TOKEN_FILE } from '../src/lib/bridge-state.js';

const LOCAL = buildIdentity();
const PORT = Number(process.env.DAEMON_PORT || 3456);
export class BridgeError extends Error {
  constructor(kind, message, details = {}) { super(message); this.name = 'BridgeError'; Object.assign(this, { kind, ...details }); }
}
function token() { try { return readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } }
export function request(path, { payload, timeoutMs = 3000, signal, port = PORT, tokenValue = token() } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new BridgeError('client-gone', 'Request aborted before dispatch', { outcome: 'not-started' }));
    const body = payload === undefined ? null : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > LIMITS.messageBytes) return reject(new BridgeError('payload-too-large', 'Request body exceeds the byte limit', { outcome: 'not-started' }));
    let settled = false, chunks = [], bytes = 0, response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); chunks = [];
      if (error) { response?.destroy(); req.destroy(); reject(error); } else resolve(value);
    };
    const abort = () => finish(new BridgeError('client-gone', 'Request aborted; wait for cancellation acknowledgement', { outcome: 'uncertain' }));
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: body === null ? 'GET' : 'POST', agent: false,
      headers: { 'X-Daemon-Token': tokenValue, ...(body === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) } }, res => {
      response = res;
      res.on('error', e => finish(new BridgeError('daemon-lost', e.message, { outcome: 'uncertain' })));
      res.on('aborted', () => finish(new BridgeError('daemon-lost', 'Response interrupted', { outcome: 'uncertain' })));
      res.on('data', chunk => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > LIMITS.resultBytes) return finish(new BridgeError('result-too-large', 'Response body exceeds the byte limit', { outcome: 'uncertain' }));
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!json || typeof json !== 'object') throw new Error('Expected JSON object');
          if (res.statusCode >= 400 || json.error) return finish(new BridgeError(json.kind || 'daemon', json.error || 'HTTP ' + res.statusCode,
            { outcome: json.outcome || 'uncertain', requestId: json.requestId, details: json.details }));
          finish(null, json);
        } catch (e) { finish(new BridgeError('daemon', 'Invalid daemon response: ' + e.message, { outcome: 'uncertain' })); }
      });
    });
    const timer = setTimeout(() => finish(new BridgeError('client-timeout', 'Client deadline exceeded; mutation outcome may be unknown', { outcome: 'uncertain' })), timeoutMs);
    req.on('error', e => finish(new BridgeError(e.code === 'ECONNREFUSED' ? 'daemon-down' : 'daemon-lost', e.message,
      { outcome: e.code === 'ECONNREFUSED' ? 'not-started' : 'uncertain' })));
    signal?.addEventListener('abort', abort, { once: true }); req.end(body);
  });
}
export function assertDaemon(info, local = LOCAL) {
  if (info.root !== local.root || info.daemonBuild !== local.daemonBuild || info.protocol !== local.protocol || info.mode !== 'safe') {
    throw new BridgeError('build-mismatch', 'Wrong or stale daemon. Use node bridge/launcher.mjs diagnostics, then restart the owning daemon.', { outcome: 'not-started' });
  }
}
export function health() { return request('/health'); }
export function diagnostics() { return request('/diagnostics'); }
export async function post(payload, { signal, queueTimeoutMs, coordination } = {}) {
  const timeoutMs = deadline(payload.timeoutMs, executionBudget(payload.action, payload));
  queueTimeoutMs = deadline(queueTimeoutMs ?? payload.queueTimeoutMs, LIMITS.queueTimeoutMs);
  assertDaemon(await health());
  const answer = await request('/exec', { signal, timeoutMs: timeoutMs + queueTimeoutMs + 15000,
    payload: { ...payload, ...(coordination ? { coordination } : {}), timeoutMs, queueTimeoutMs, protocol: LOCAL.protocol, expectedRoot: LOCAL.root, expectedDaemonBuild: LOCAL.daemonBuild } });
  if (payload.action === 'cmd-batch' && (!Array.isArray(answer.result) || answer.result.length !== payload.cmds.length)) {
    throw new BridgeError('invalid-response', 'Batch response does not match the request', { outcome: 'uncertain' });
  }
  if (payload.action === 'cmd-batch' && answer.result.some(r => !r || r.success !== true)) {
    throw new BridgeError('batch-failed', 'Batch stopped after an item failed; inspect results before resuming', { outcome: 'partial', results: answer.result });
  }
  return answer.result;
}
export function cmd(c, timeoutMs, options) { return post({ action: 'cmd', cmd: c, timeoutMs }, options); }
export function cmdBatch(cs, timeoutMs, options) { return post({ action: 'cmd-batch', cmds: cs, timeoutMs }, options); }
export function lifecycle(c, options) { return post({ action: 'lifecycle', cmd: c, timeoutMs: 45000 }, options); }
export function coordinate(c, options) { return post({ action: 'coordinate', cmd: c }, options); }

// Independent callers can submit these concurrently. Routing is explicit when
// more than one file is connected; all geometry reservations stay server-side.
export async function createLayout(specs, { fileKey, pageId, laneId, label, agentId = 'automatic', timeoutMs = 120000, signal } = {}) {
  const status = await coordinate({ op: 'status' });
  const lane = laneId && status.taskLanes?.find(l => l.laneId === laneId);
  if (laneId && !lane) throw new BridgeError('invalid-request', 'Unknown task lane', { outcome: 'not-started' });
  if (lane && ((fileKey && fileKey !== lane.fileKey) || (pageId && pageId !== lane.pageId))) throw new BridgeError('lane-owner', 'Target does not match the task lane', { outcome: 'not-started' });
  fileKey ||= lane?.fileKey; pageId ||= lane?.pageId;
  const candidates = status.workers.filter(w => w.connected && (!fileKey || w.fileKey === fileKey));
  if (candidates.length !== 1) throw new BridgeError('ambiguous-worker', 'Choose a connected file or named lane', { outcome: 'not-started' });
  const worker = candidates[0];
  pageId ||= worker.pageId;
  if (!pageId) throw new BridgeError('invalid-request', 'Choose a page for this layout', { outcome: 'not-started' });
  return cmd({ op: 'create', parent: pageId, specs: Array.isArray(specs) ? specs : [specs], placement: 'auto', select: false, zoom: false }, timeoutMs,
    { signal, queueTimeoutMs: timeoutMs, coordination: { workerId: worker.workerId, sessionEpoch: worker.sessionEpoch, fileKey: worker.fileKey, pageId, ...(laneId ? { laneId } : {}), label, agentId, placement: 'auto' } });
}

// A private highway into one file: its own port, queue, holds and timeline. The
// lobby call is token-authenticated; the highway port accepts only its ticket.
// If the socket drops, the client reconnects to the same port and receives the
// results that finished meanwhile. Requests are never resent automatically.
export async function openHighway(fileKey, { agentId = 'agent', label, signal, lobby = post } = {}) {
  const opened = await lobby({ action: 'highway', cmd: { op: 'open', fileKey, agentId, label } }, { signal });
  const client = new HighwayClient(opened);
  await client.ready;
  return client;
}
export class HighwayClient {
  constructor({ highwayId, port, ticket, fileKey, resumeMs = 60000 }, { WebSocketImpl = SocketClient } = {}) {
    Object.assign(this, { highwayId, port, ticket, fileKey, resumeMs, WebSocketImpl, pending: new Map(), inflight: new Set(), closed: false, serial: 0, attempts: 0, lostAt: null, everReady: false });
    this.waitReady(); this.connect();
  }
  waitReady() {
    this.isReady = false;
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.ready.catch(() => {});
  }
  connect() {
    const ws = this.ws = new this.WebSocketImpl('ws://127.0.0.1:' + this.port + '/agent');
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'agent', ticket: this.ticket }));
    ws.onmessage = event => {
      let m; try { m = JSON.parse(event.data); } catch { return; }
      if (m.type === 'ready') { Object.assign(this, { lostAt: null, attempts: 0, everReady: true, isReady: true }); this.hold(); this.readyResolve(m); return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { p.onProgress?.({ done: m.done, total: m.total }); return; }
      this.pending.delete(m.id); clearTimeout(p.timer); this.hold();
      if (m.type === 'result') p.resolve(m.result);
      else p.reject(new BridgeError(m.kind || 'daemon', m.error || 'Highway request failed', { outcome: m.outcome || 'uncertain', details: m.details }));
    };
    ws.onerror = () => {};
    ws.onclose = event => {
      if (this.ws !== ws || this.closed) return;
      const final = event.code === 4401 || event.code === 1000 || event.code === 1008 || !this.everReady;
      this.lostAt ??= Date.now();
      if (final || Date.now() - this.lostAt > this.resumeMs) return this.fail(event.reason || 'Highway connection closed', event.code === 4401 ? 'unauthorized' : 'highway-closed');
      // Same port, same ticket: the daemon keeps finished results until we return.
      if (this.isReady) this.waitReady();
      const retry = setTimeout(() => { if (!this.closed) this.connect(); }, Math.min(2000, 100 * 2 ** this.attempts++));
      if (!this.pending.size) retry.unref?.();
    };
  }
  // An idle highway must not keep a script's process alive (HTTP never did): the
  // socket holds the event loop only while requests are pending. When the process
  // exits, the daemon sees the agent leave and closes the highway after resumeMs.
  hold() { const socket = this.ws?._socket; if (!socket) return; if (this.pending.size) socket.ref?.(); else socket.unref?.(); }
  fail(reason, kind = 'highway-closed') {
    this.closed = true;
    this.readyReject(new BridgeError(kind, reason, { outcome: 'not-started' }));
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new BridgeError(kind, reason, { outcome: 'uncertain' })); this.pending.delete(id); }
  }
  async send(type, body, timeoutMs, { queueTimeoutMs, coordination, signal, onProgress } = {}) {
    if (this.closed) throw new BridgeError('highway-closed', 'This highway is closed; open a new one', { outcome: 'not-started' });
    if (signal?.aborted) throw new BridgeError('client-gone', 'Request aborted before dispatch', { outcome: 'not-started' });
    timeoutMs = deadline(timeoutMs, executionBudget(type === 'cmd' ? 'cmd' : 'cmd-batch', body)); queueTimeoutMs = deadline(queueTimeoutMs, LIMITS.queueTimeoutMs);
    await this.ready;
    const id = 'r' + (++this.serial) + '-' + Date.now().toString(36);
    const run = new Promise((resolve, reject) => {
      const p = { resolve, reject, onProgress };
      // Execution + queue + transport margin, like the lobby path. A deadline asks
      // the daemon to cancel; the outcome stays unknown until the agent checks.
      p.timer = setTimeout(() => { this.pending.delete(id); this.hold(); this.cancel(id); reject(new BridgeError('client-timeout', 'Client deadline exceeded; mutation outcome may be unknown', { outcome: 'uncertain' })); }, timeoutMs + queueTimeoutMs + 15000);
      signal?.addEventListener('abort', () => { if (this.pending.delete(id)) { clearTimeout(p.timer); this.hold(); this.cancel(id); reject(new BridgeError('client-gone', 'Request aborted; wait for cancellation acknowledgement', { outcome: 'uncertain' })); } }, { once: true });
      this.pending.set(id, p); this.hold();
      try { this.ws.send(JSON.stringify({ type, id, ...body, timeoutMs, queueTimeoutMs, ...(coordination ? { coordination } : {}) })); }
      catch { this.pending.delete(id); clearTimeout(p.timer); this.hold(); reject(new BridgeError('daemon-lost', 'Highway socket was not open; nothing was sent', { outcome: 'not-started' })); }
    });
    this.inflight.add(run); run.catch(() => {}).finally(() => this.inflight.delete(run));
    return run;
  }
  cancel(id) { try { this.ws.send(JSON.stringify({ type: 'cancel', id })); } catch {} }
  cmd(c, timeoutMs, options) { return this.send('cmd', { cmd: c }, timeoutMs, options); }
  async cmdBatch(cs, timeoutMs, options) {
    const results = await this.send('cmd-batch', { cmds: cs }, timeoutMs, options);
    if (!Array.isArray(results) || results.length !== cs.length) throw new BridgeError('invalid-response', 'Batch response does not match the request', { outcome: 'uncertain' });
    if (results.some(r => !r || r.success !== true)) throw new BridgeError('batch-failed', 'Batch stopped after an item failed; inspect results before resuming', { outcome: 'partial', results });
    return results;
  }
  // Waits for this client's own requests, then releases the port.
  async close() {
    if (this.closed) return;
    await Promise.allSettled([...this.inflight]);
    try { this.ws.send(JSON.stringify({ type: 'close' })); } catch {}
    this.fail('Closed by this client');
    try { this.ws.close(1000); } catch {}
  }
}

// Only act as a CLI when run directly — importing this module from a build
// script must not consume that script's argv.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
const [, , sub, arg] = process.argv;

if (isMain) {
  try {
    let out;
    switch (sub) {
      case 'ping':    out = await cmd({ op: 'ping' }); break;
      case 'info':    out = await cmd({ op: 'info' }); break;
      case 'health':  out = await health(); break;
      case 'diagnostics': out = await diagnostics(); break;
      case 'pair': out = await coordinate({ op: 'pair' }); break;
      case 'workers': out = await coordinate({ op: 'status' }); break;
      case 'lanes': out = await coordinate({ op: 'lanes' }); break;
      case 'highways': out = await post({ action: 'highway', cmd: { op: 'list' } }); break;
      case 'layout': {
        if (!arg) throw new Error('layout requires a JSON file with specs and a target file or lane');
        const { specs, spec, ...options } = JSON.parse(readFileSync(arg, 'utf8'));
        out = await createLayout(specs || spec, options); break;
      }
      case 'submit': {
        if (!arg) throw new Error('submit requires an envelope JSON file');
        out = await post(JSON.parse(readFileSync(arg, 'utf8'))); break;
      }
      case 'lifecycle': {
        if (!arg) throw new Error('lifecycle requires a JSON request file');
        out = await lifecycle(JSON.parse(readFileSync(arg, 'utf8'))); break;
      }
      case 'find':    out = await cmd({ op: 'find', name: arg || '' }); break;
      case 'children': {
        const kids = await cmd({ op: 'children', ...(arg ? { prefix: arg } : {}) }, 120000);
        const seen = new Map();
        for (const k of kids) seen.set(k.name, (seen.get(k.name) || 0) + 1);
        const duplicates = [...seen].filter(([, n]) => n > 1).map(([name, n]) => ({ name, n }));
        out = { count: kids.length, duplicates, children: kids };
        break;
      }
      case 'tree':    out = await cmd({ op: 'tree', id: arg, depth: 4 }); break;
      case 'cancel':  out = await cmd({ op: 'cancel', ...(arg ? { id: arg } : {}) }); break;
      case 'export': {
        const res = await cmd({ op: 'exportImage', id: arg, scale: 2 }, 90000);
        const dest = process.argv[4] || `figma-${String(arg || 'selection').replace(':', '-')}.png`;
        writeFileSync(dest, Buffer.from(res.base64, 'base64'));
        out = { saved: dest, id: res.id, name: res.name };
        break;
      }
      case 'send': {
        if (!arg) throw new Error('send requires a JSON file path');
        const spec = JSON.parse(readFileSync(arg, 'utf8'));
        out = Array.isArray(spec) ? await cmdBatch(spec) : await cmd(spec);
        break;
      }
      default:
        throw new Error(`Unknown subcommand "${sub}". Use: pair | workers | lanes | highways | layout | submit | ping | info | health | diagnostics | find | children | tree | cancel | export | send`);
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('✗ ' + e.message + (e.kind ? ` [${e.kind}]` : ''));
    if (e.results) console.error(JSON.stringify(e.results.map((r, index) => ({ index, success: r.success,
      created: r.result?.created?.map(n => ({ id: n.id, name: n.name })), error: r.error, kind: r.kind, outcome: r.outcome, details: r.details })), null, 2));
    process.exit(1);
  }
}
