import { randomUUID } from 'node:crypto';
import { PROTOCOL, LIMITS, bridgeError, deadline, immediate, validateEnvelope } from './bridge-protocol.js';

// Deliberately a SINGLE worker. A second socket cannot steal an active session.
export class StructuredBridge {
  constructor({ expectedBuild, log = () => {}, activity = () => {}, limits = {}, handshakeMs = 10000, cancelGraceMs = 5000 } = {}) {
    this.expectedBuild = expectedBuild;
    this.log = log;
    this.activity = activity;
    this.limits = { ...LIMITS, ...limits };
    this.handshakeMs = handshakeMs;
    this.cancelGraceMs = cancelGraceMs;
    this.session = null;
    this.recoveryRequired = false;
    this.pending = new Map();
    this.pendingBytes = 0;
    this.recent = [];
    this.counts = { accepted: 0, succeeded: 0, failed: 0, uncertain: 0, rejected: 0 };
  }

  connected() { return !!(this.session?.ready && this.session.ws.readyState === 1); }

  attach(ws) {
    if (this.session) { ws.close(1008, 'A plugin is already attached; close it before switching files'); return false; }
    const s = this.session = { ws, id: randomUUID(), ready: false, busy: null, queued: 0, queuedBytes: 0, lastSeen: Date.now(), uncertain: new Set() };
    const fail = reason => this.disconnect(s, reason);
    s.handshake = setTimeout(() => fail('Plugin handshake timed out'), this.handshakeMs);
    s.keepalive = setInterval(() => {
      if (Date.now() - s.lastSeen > 60000) return fail('Plugin heartbeat lost');
      try { ws.ping(); } catch { fail('Plugin ping failed'); }
    }, 15000);
    ws.on('pong', () => { s.lastSeen = Date.now(); this.activity(); });
    ws.on('message', data => {
      if (this.session !== s) return;
      s.lastSeen = Date.now(); this.activity();
      try {
        if (data.length > this.limits.resultBytes) throw new Error('Plugin response too large');
        this.receive(s, JSON.parse(data.toString()));
      } catch (e) { fail('Invalid plugin message: ' + e.message); }
    });
    ws.on('close', () => fail('Plugin disconnected'));
    ws.on('error', () => fail('Plugin socket error'));
    return true;
  }

  receive(s, msg) {
    if (this.session !== s) return;
    if (msg.type === 'hello') {
      if (s.ready) throw new Error('Duplicate hello');
      if (msg.protocol !== PROTOCOL || msg.build !== this.expectedBuild || msg.busy !== false) {
        return this.disconnect(s, 'Plugin build mismatch; rerun the Insula development plugin');
      }
      s.ready = true;
      s.identity = { version: msg.version, protocol: msg.protocol, build: msg.build, file: msg.file, page: msg.page, pageId: msg.pageId,
        fileKey: msg.fileKey || null, instanceId: msg.instanceId || null, capabilities: msg.capabilities || null };
      clearTimeout(s.handshake);
      this.log('plugin-ready', s.identity);
      return;
    }
    if (!s.ready) throw new Error('Hello required');
    if (msg.type === 'status') {
      if (msg.file && ((msg.fileKey || null) !== s.identity.fileKey || (msg.instanceId || null) !== s.identity.instanceId)) return this.disconnect(s, 'Worker identity changed during its session');
      s.queued = msg.queued || 0; s.queuedBytes = msg.queuedBytes || 0;
      if (msg.file) Object.assign(s.identity, { file: msg.file, page: msg.page, pageId: msg.pageId,
        fileKey: msg.fileKey || null, instanceId: msg.instanceId || null, capabilities: msg.capabilities || null });
      return;
    }
    const p = this.pending.get(msg.id);
    if (msg.type === 'busy') {
      if (msg.busy && p?.session === s && p.startedAt === undefined) {
        s.busy = { id: msg.id, op: msg.op, since: Date.now() };
        p.startedAt = Date.now();
        clearTimeout(p.timer);
        p.timer = setTimeout(() => this.expire(p, 'daemon-timeout', 'Execution deadline exceeded'), p.timeoutMs);
      } else if (!msg.busy && s.busy?.id === msg.id) s.busy = null;
      s.queued = msg.queued || 0; s.queuedBytes = msg.queuedBytes || 0;
      return;
    }
    if (msg.type === 'progress') {
      if (p?.session === s) p.progress = { done: msg.done, total: msg.total, at: Date.now() };
      return;
    }
    if (msg.type !== 'result' && msg.type !== 'batch-result') return;
    if ((p?.session === s || s.uncertain.has(msg.id)) && (msg.outcome === 'uncertain' ||
        (Array.isArray(msg.results) && msg.results.some(result => result?.outcome === 'uncertain')))) this.recoveryRequired = true;
    // A cancelled/expired request may finish later. Only this socket can clear it.
    const late = s.uncertain.delete(msg.id);
    if (late && !s.uncertain.size) { clearTimeout(s.cancelTimer); s.cancelTimer = null; }
    if (late && !p) this.onLateResult?.(msg);
    if (!p || p.session !== s) return;
    if (msg.type !== (p.action === 'cmd-batch' ? 'batch-result' : 'result')) throw new Error('Response type does not match request');
    if (!msg.error && !Object.hasOwn(msg, p.action === 'cmd-batch' ? 'results' : 'result')) throw new Error('Missing result');
    if (msg.error) {
      if (msg.outcome === 'uncertain') this.recoveryRequired = true;
      this.settle(p, bridgeError(msg.kind || 'plugin', msg.error, { outcome: msg.outcome || 'failed', details: msg.details }));
    }
    else this.settle(p, null, msg.type === 'batch-result' ? msg.results : msg.result, msg.outcome);
  }

  dispatch(action, payload, { timeoutMs, queueTimeoutMs, signal, onId } = {}) {
    validateEnvelope(action, payload);
    timeoutMs = deadline(timeoutMs, action === 'cmd-batch' ? 120000 : 60000);
    queueTimeoutMs = deadline(queueTimeoutMs, LIMITS.queueTimeoutMs);
    if (signal?.aborted) return Promise.reject(bridgeError('client-gone', 'Client disconnected', { outcome: 'not-started' }));
    if (!this.connected()) return Promise.reject(bridgeError('plugin-offline', 'Matching Insula plugin not connected', { outcome: 'not-started' }));
    const s = this.session;
    const control = action === 'cmd' && immediate(payload.cmd);
    if (!control && this.lifecycleBusy) return Promise.reject(bridgeError('worker-busy', 'Document lifecycle operation is active', { outcome: 'not-started' }));
    const commands = action === 'cmd' ? [payload.cmd] : payload.cmds;
    if (commands.some(c => c.expectedFileKey !== undefined && (!s.identity.fileKey || c.expectedFileKey !== s.identity.fileKey))) {
      return Promise.reject(bridgeError('wrong-file', 'Connected worker cannot attest the expected file key', { outcome: 'not-started' }));
    }
    if (!control && (s.uncertain.size || this.recoveryRequired)) return Promise.reject(bridgeError('worker-uncertain', this.recoveryRequired
      ? 'A disconnected request has an unknown outcome. Reconcile the document and restart the daemon before resuming.'
      : 'Waiting for cancellation acknowledgement; do not replay mutations', { outcome: 'not-started' }));
    const id = randomUUID();
    const wire = JSON.stringify({ action, id, ...payload });
    const bytes = Buffer.byteLength(wire);
    const jobs = [...this.pending.values()].filter(p => p.control === control).length;
    if (bytes > this.limits.messageBytes || jobs >= (control ? 4 : this.limits.queueJobs) ||
        this.pendingBytes + bytes > this.limits.queueBytes + (control ? 16384 : 0) || s.ws.bufferedAmount > this.limits.messageBytes) {
      this.counts.rejected++;
      return Promise.reject(bridgeError('queue-full', 'Bridge capacity exceeded; retry only after capacity is available', { outcome: 'not-started' }));
    }
    return new Promise((resolve, reject) => {
      const p = { id, action, session: s, resolve, reject, bytes, control, op: action === 'cmd' ? payload.cmd.op : 'batch', enqueuedAt: Date.now(), timeoutMs, signal };
      p.abort = () => this.expire(p, 'client-gone', 'HTTP client disconnected');
      p.timer = setTimeout(() => this.expire(p, control ? 'daemon-timeout' : 'queue-timeout', control ? 'Control request deadline exceeded' : 'Queue deadline exceeded'), control ? timeoutMs : queueTimeoutMs);
      this.pending.set(id, p); this.pendingBytes += bytes; this.counts.accepted++;
      signal?.addEventListener('abort', p.abort, { once: true });
      try {
        onId?.(id);
        s.ws.send(wire, err => { if (err) this.expire(p, 'plugin-offline', 'Socket send failed'); });
      } catch { this.expire(p, 'plugin-offline', 'Socket send failed'); }
    });
  }

  expire(p, kind, message) {
    if (!this.pending.has(p.id)) return;
    const s = p.session;
    if (!p.control) {
      s.uncertain.add(p.id);
      if (!s.cancelTimer) s.cancelTimer = setTimeout(() => this.disconnect(s, 'Cancellation was not acknowledged; restart the plugin before resuming'), this.cancelGraceMs);
    }
    // Always use the socket that received this request, never a replacement.
    try { s.ws.send(JSON.stringify({ action: 'cancel', id: p.id, reason: kind })); } catch {}
    this.settle(p, bridgeError(kind, message, { requestId: p.id, outcome: 'uncertain' }));
  }

  settle(p, error, result, outcome) {
    if (!this.pending.delete(p.id)) return;
    clearTimeout(p.timer); p.signal?.removeEventListener('abort', p.abort);
    this.pendingBytes -= p.bytes;
    outcome = error?.outcome || outcome || (error ? 'failed' : 'succeeded');
    this.counts[outcome === 'succeeded' ? 'succeeded' : outcome === 'uncertain' ? 'uncertain' : 'failed']++;
    const event = { id: p.id, op: p.op, outcome, kind: error?.kind, requestBytes: p.bytes,
      queueMs: (p.startedAt ?? Date.now()) - p.enqueuedAt,
      executionMs: p.startedAt !== undefined ? Date.now() - p.startedAt : 0, progress: p.progress || null };
    this.recent.push(event); if (this.recent.length > 50) this.recent.shift();
    this.log('request-end', event);
    if (error) p.reject(error); else p.resolve(result);
  }

  disconnect(s, reason) {
    if (this.session !== s) return;
    if (s.uncertain.size || [...this.pending.values()].some(p => p.session === s && !p.control)) this.recoveryRequired = true;
    this.session = null;
    clearTimeout(s.handshake); clearTimeout(s.cancelTimer); clearInterval(s.keepalive);
    for (const p of [...this.pending.values()]) if (p.session === s) {
      this.settle(p, bridgeError('plugin-offline', reason, { requestId: p.id, outcome: 'uncertain' }));
    }
    s.uncertain.clear();
    try { s.ws.close(1008, String(reason).replace(/[^\x20-\x7e]/g, '?').slice(0, 120)); }
    catch { s.ws.terminate?.(); }
    this.log('plugin-disconnected', { reason });
  }

  diagnostics() {
    const s = this.session;
    return { protocol: PROTOCOL, expectedBuild: this.expectedBuild, identity: s?.identity || null,
      connected: this.connected(), busy: s?.busy || null, queued: s?.queued || 0, queuedBytes: s?.queuedBytes || 0,
      pending: this.pending.size, pendingBytes: this.pendingBytes, uncertain: s?.uncertain.size || 0, recoveryRequired: this.recoveryRequired,
      lastSeen: s?.lastSeen || null, limits: this.limits, counts: { ...this.counts }, recent: [...this.recent] };
  }

  close() { if (this.session) this.disconnect(this.session, 'Daemon shutting down'); }
}
