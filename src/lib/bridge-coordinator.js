import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { StructuredBridge } from './structured-bridge.js';
import { PROTOCOL, LIMITS, bridgeError, deadline, immediate, validateEnvelope } from './bridge-protocol.js';
import { PairedComputers, pairingChallenge } from './bridge-pairing.js';
import { sizedRoots, layoutFootprint, findSpace, positionedCommand } from './bridge-layout.js';

const fail = (kind, message, details) => { throw bridgeError(kind, message, { outcome: 'not-started', details }); };
const short = v => typeof v === 'string' ? v.slice(0, 128) : null;
const key = (v, name) => { if (typeof v !== 'string' || !/^[\w:.-]{1,128}$/.test(v)) fail('invalid-request', name + ' must be a short identifier'); return v; };
const READS = new Set(['ping', 'info', 'verifyFile', 'inspectReservation', 'find', 'children', 'tree', 'exportImage', 'audit', 'fonts', 'layoutInfo']);
const isRead = c => READS.has(c.op) || (c.op === 'page' && (!c.action || c.action === 'list'));
const WRITES = new Set(['create', 'update', 'remove', 'reactions', 'flowStart', 'page', 'image', 'select', 'undo', 'reload']);
export function rectangle(r) {
  if (!r || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k]) && Math.abs(r[k]) <= 1e7) || r.width <= 0 || r.height <= 0) fail('invalid-request', 'A finite, positive page-space rectangle is required');
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
export function intersects(a, b, gutter = 0) {
  return a.x < b.x + b.width + gutter && a.x + a.width + gutter > b.x && a.y < b.y + b.height + gutter && a.y + a.height + gutter > b.y;
}

// Only metadata is persisted. A receipt is written BEFORE dispatch; an unfinished
// receipt becomes a hold after restart, never an automatic mutation replay.
export class ReservationJournal {
  constructor(path) {
    this.path = path; this.fence = 0; this.records = new Map(); this.fileHolds = new Map(); this.taskLanes = new Map();
    if (path && existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data.schema !== 1 || !Array.isArray(data.records) || data.records.length > 512 || !Number.isSafeInteger(data.fence)) throw new Error('Invalid coordinator journal; preserve it for recovery');
      this.fence = data.fence;
      if (data.taskLanes && (!Array.isArray(data.taskLanes) || data.taskLanes.length > 64)) throw Error('Invalid task lane journal');
      for (const lane of data.taskLanes || []) { key(lane.laneId, 'laneId'); key(lane.fileKey, 'fileKey'); key(lane.pageId, 'pageId'); key(lane.agentId, 'agentId'); this.taskLanes.set(lane.laneId, lane); }
      for (const r of data.fileHolds || []) { if (typeof r.fileKey !== 'string') throw Error('Invalid file hold'); this.fileHolds.set(r.fileKey, { ...r, state: 'held' }); }
      for (const r of data.records) {
        key(r.requestId, 'requestId'); key(r.fileKey, 'fileKey'); key(r.pageId, 'pageId'); rectangle(r.rect);
        if (!['committed', 'released', 'held'].includes(r.state)) r.state = 'held';
        this.records.set(r.requestId, r);
      }
    }
  }
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp', fd = openSync(tmp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify({ schema: 1, fence: this.fence, records: [...this.records.values()], fileHolds: [...this.fileHolds.values()], taskLanes: [...this.taskLanes.values()] })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
  }
}

export class BridgeCoordinator {
  constructor({ expectedBuild, journalPath, pairingPath, approvePairing, activity = () => {}, log = () => {}, resources = () => ({}), bridgeFactory, maxWorkers = 4 } = {}) {
    this.expectedBuild = expectedBuild; this.activity = activity; this.log = log; this.resources = resources;
    this.factory = bridgeFactory || (() => new StructuredBridge({ expectedBuild, activity, log }));
    this.maxWorkers = maxWorkers; this.epoch = randomUUID(); this.seq = 0;
    this.computers = new PairedComputers(pairingPath); this.approvePairing = approvePairing;
    this.journal = new ReservationJournal(journalPath); this.workers = new Map(); this.pairings = new Map(); this.credentials = new Map();
    this.jobs = new Map(); this.receipts = []; this.lastLane = new Map(); this.turn = 0; this.batchSequence = 0; this.handshakes = new Set(); this.lifecycleBusy = false;
    this.uiTimer = null; this.uiDirty = false; this.progressWorkers = new Set();
    this.timer = setInterval(() => this.publish(), 1000); this.timer.unref();
  }
  pair() {
    for (const [k, v] of this.pairings) if (v < Date.now()) this.pairings.delete(k);
    if (this.pairings.size >= 8) fail('queue-full', 'Too many outstanding pairing codes');
    const pairingCode = randomBytes(12).toString('hex'); const expiresAt = Date.now() + 120000;
    this.pairings.set(pairingCode, expiresAt); return { pairingCode, expiresAt };
  }
  attach(ws, origin) {
    if (origin && !['null', 'https://www.figma.com', 'https://figma.com'].includes(origin)) return ws.close(1008, 'Invalid origin');
    if (this.handshakes.size >= 8) return ws.close(1008, 'Pairing capacity exceeded');
    this.handshakes.add(ws);
    const approval = new AbortController();
    let timer = setTimeout(() => { cleanup(); ws.close(1008, 'Pairing required'); }, 10000);
    const cleanup = () => { clearTimeout(timer); approval.abort(); this.handshakes.delete(ws); ws.off('message', hello); };
    const hello = async data => {
      try {
        if (data.length > 8192) throw new Error('Handshake too large');
        const msg = JSON.parse(data.toString());
        if (!['hello', 'pair-request'].includes(msg.type) || msg.protocol !== PROTOCOL || msg.build !== this.expectedBuild || msg.busy !== false) throw new Error('Build mismatch or busy plugin');
        const instanceId = key(msg.instanceId, 'instanceId'), fileKey = msg.fileKey ? key(msg.fileKey, 'fileKey') : null;
        let approved = false, deviceCredential;
        if (msg.type === 'pair-request') {
          if (!this.approvePairing) { cleanup(); return ws.close(4403, 'Use Advanced pairing to connect.'); }
          ws.off('message', hello); clearTimeout(timer);
          timer = setTimeout(() => { cleanup(); ws.close(4403, 'Approval expired. Click Connect to try again.'); }, 120000);
          const challenge = pairingChallenge();
          ws.send(JSON.stringify({ type: 'pair-pending', challenge }));
          approved = await this.approvePairing({ file: short(msg.file), challenge, signal: approval.signal });
          if (approval.signal.aborted || ws.readyState !== 1) return;
          if (!approved) { cleanup(); return ws.close(4403, 'Connection was not approved. Click Connect to try again.'); }
        }
        let deviceHash = this.computers.lookup(msg.deviceCredential);
        let auth = this.credentials.get(msg.credential);
        if (auth && (auth.fileKey !== fileKey || auth.instanceId !== instanceId)) throw new Error('Credential identity changed');
        if (!auth) {
          if (!deviceHash && !approved) {
            if (!this.pairings.has(msg.pairingCode) || this.pairings.get(msg.pairingCode) < Date.now()) { cleanup(); return ws.close(4401, 'Connect this computer to continue.'); }
            this.pairings.delete(msg.pairingCode);
          }
          auth = { workerId: randomUUID(), credential: randomBytes(32).toString('hex'), fileKey, instanceId, deviceHash };
        }
        const existing = this.workers.get(auth.workerId);
        if (existing?.bridge.connected() || existing?.active) throw new Error('Worker is already connected or settling');
        for (const w of this.workers.values()) if ((w.bridge.connected() || w.active) && (!fileKey || !w.fileKey || w.fileKey === fileKey)) throw new Error('Only one writing worker per file is allowed');
        const lifecycleBridge = [...this.workers.values()].find(w => w.fileKey === fileKey && w.bridge.lifecycleBusy)?.bridge;
        for (const [id, w] of this.workers) if (!w.bridge.connected() && !w.active) this.workers.delete(id);
        if (this.workers.size >= this.maxWorkers) throw new Error('Worker capacity exceeded');
        if (!deviceHash && (approved || msg.remember === true)) {
          deviceCredential = this.computers.issue(); deviceHash = this.computers.lookup(deviceCredential); auth.deviceHash = deviceHash;
        }
        this.credentials.set(auth.credential, auth);
        // Credentials are reconnect-only and bounded; old disconnected sessions must pair again.
        while (this.credentials.size > 16) this.credentials.delete(this.credentials.keys().next().value);
        const w = { ...auth, sessionEpoch: randomUUID(), bridge: lifecycleBridge || this.factory(), visible: true, mode: 'standard', active: null };
        w.bridge.onLateResult = msg => this.lateResult(w, msg);
        this.workers.set(w.workerId, w); cleanup();
        w.bridge.attach(ws); w.bridge.receive(w.bridge.session, { ...msg, type: 'hello' });
        ws.send(JSON.stringify({ type: 'ready', workerId: w.workerId, sessionEpoch: w.sessionEpoch, coordinatorEpoch: this.epoch, credential: w.credential, ...(deviceCredential ? { deviceCredential } : {}) }));
        ws.on('message', bytes => {
          try {
            const m = JSON.parse(bytes.toString());
            if (m.type === 'lane-control') {
              if (bytes.length > 4096 || typeof m.id !== 'string' || m.id.length > 128) return;
              try {
                const route = { workerId: w.workerId, sessionEpoch: w.sessionEpoch, fileKey: w.fileKey };
                const result = m.op === 'create-lane' ? this.createLane(m, route) : m.op === 'remove-lane' ? this.removeLane(m.laneId, route) : fail('invalid-request', 'Unknown lane action');
                ws.send(JSON.stringify({ type: 'lane-result', id: m.id, result })); this.publish();
              } catch (e) { ws.send(JSON.stringify({ type: 'lane-result', id: m.id, error: e.message })); }
              return;
            }
            if (m.type === 'forget-computer' && w.deviceHash) {
              this.computers.revoke(w.deviceHash);
              for (const [token, session] of this.credentials) if (session.deviceHash === w.deviceHash) this.credentials.delete(token);
              for (const other of this.workers.values()) if (other.deviceHash === w.deviceHash && other.bridge.connected()) {
                other.bridge.session.ws.send(JSON.stringify({ type: 'forgotten' })); other.bridge.session.ws.close(4401, 'Computer forgotten.');
              }
              return;
            }
            if (m.type === 'subscribe') { w.visible = m.visible === true; w.mode = m.mode === 'compact' ? 'compact' : 'standard'; if (w.visible) this.schedulePublish(); }
            if (m.type === 'progress' && w.active?.wireId === m.id) this.schedulePublish(w);
            if (m.type === 'coordinator-cancel' && typeof m.requestId === 'string') this.cancel(m.requestId, w.workerId);
          } catch { ws.close(1008, 'Invalid control message'); }
        });
        ws.on('close', () => { for (const j of [...this.jobs.values()]) if (j.worker === w && j.state === 'queued') this.finish(j, bridgeError('plugin-offline', 'Worker disconnected before dispatch', { outcome: 'not-started' })); });
        this.publish(w);
      } catch (e) { cleanup(); ws.close(1008, String(e.message).replace(/[^\x20-\x7e]/g, '?').slice(0, 120)); }
    };
    ws.on('message', hello); ws.on('close', cleanup); ws.on('error', cleanup);
  }
  connected() { return [...this.workers.values()].some(w => w.bridge.connected()); }
  createLane(input, route) {
    const w = this.select(route), pageId = key(input.pageId, 'pageId');
    if (!w.fileKey) fail('file-key-unavailable', 'This worker needs a live file identity.');
    if (this.journal.taskLanes.size >= 64) fail('queue-full', 'Remove an unused lane before creating another.');
    const label = short(input.label)?.trim(); if (!label) fail('invalid-request', 'Give the lane a name.');
    const lane = { laneId: 'lane-' + randomUUID(), fileKey: w.fileKey, pageId, label, agentId: 'operator', createdAt: Date.now() };
    this.journal.taskLanes.set(lane.laneId, lane);
    try { this.journal.save(); } catch (e) { this.journal.taskLanes.delete(lane.laneId); throw e; }
    return lane;
  }
  removeLane(laneId, route) {
    const w = this.select(route), lane = this.journal.taskLanes.get(key(laneId, 'laneId'));
    if (!lane || lane.fileKey !== w.fileKey) fail('invalid-request', 'This lane belongs to another file or no longer exists.');
    if ([...this.jobs.values()].some(j => j.laneId === laneId)) fail('worker-busy', 'Wait for this lane’s jobs before removing it.');
    this.journal.taskLanes.delete(laneId);
    try { this.journal.save(); } catch (e) { this.journal.taskLanes.set(laneId, lane); throw e; }
    return { removed: true };
  }
  laneSummary() {
    return [...this.journal.taskLanes.values()].map(lane => {
      const jobs = [...this.jobs.values()].filter(j => j.laneId === lane.laneId), w = [...this.workers.values()].find(w => w.fileKey === lane.fileKey && w.bridge.connected());
      return { ...lane, workerId: w?.workerId || null, state: !w ? 'offline' : jobs.some(j => j.state !== 'queued') ? 'running' : jobs.length ? 'queued' : 'waiting', jobs: jobs.length };
    });
  }
  select(route) {
    if (route) {
      const w = this.workers.get(route.workerId);
      if (!w?.bridge.connected()) fail('plugin-offline', 'Target worker is offline');
      if (route.sessionEpoch !== w.sessionEpoch || route.fileKey !== w.fileKey || !w.fileKey) fail('stale-session', 'Worker epoch or attested file key does not match');
      return w;
    }
    const all = [...this.workers.values()].filter(w => w.bridge.connected());
    if (!all.length) fail('plugin-offline', 'No paired worker is connected');
    if (all.length !== 1) fail('ambiguous-worker', 'Specify workerId, sessionEpoch and fileKey');
    return all[0];
  }
  get pending() { return this.jobs; }
  get session() { return [...this.workers.values()].find(w => w.bridge.connected())?.bridge.session; }
  get recoveryRequired() { return [...this.journal.fileHolds.values()].some(r => r.state === 'held') || [...this.journal.records.values()].some(r => r.state === 'held') || [...this.workers.values()].some(w => w.bridge.recoveryRequired); }
  quarantined(fileKey) { return this.journal.fileHolds.get(fileKey || '*')?.state === 'held' || this.journal.fileHolds.get('*')?.state === 'held' || [...this.journal.records.values()].some(r => r.fileKey === fileKey && r.state === 'held'); }
  protected(fileKey) { return [...this.journal.records.values()].some(r => r.fileKey === fileKey && r.state !== 'released'); }
  async dispatch(action, payload, options = {}) {
    validateEnvelope(action, payload);
    let route = options.coordination; const w = this.select(route);
    const commands = action === 'cmd' ? [payload.cmd] : payload.cmds;
    if (commands.some(c => c.coordination || c.lease)) fail('invalid-request', 'Routing belongs in the submission envelope');
    if (action === 'cmd' && immediate(payload.cmd)) {
      if (payload.cmd.op === 'cancel') for (const j of [...this.jobs.values()]) if (j.worker === w && (!payload.cmd.id || j.id === payload.cmd.id)) this.cancel(j.id, w.workerId);
      // Control/read commands bypass the canvas queue, but still leave an action
      // receipt. Keep response contents (especially image bytes) out of telemetry.
      const startedAt = Date.now(); let wireId, error;
      try {
        return await w.bridge.dispatch(action, payload, { ...options, onId: id => { wireId = id; options.onId?.(id); } });
      } catch (e) { error = e; throw e; }
      finally {
        if (wireId) this.record({ id: wireId, workerId: w.workerId, laneId: '$control', pageId: null,
          op: payload.cmd.op, category: isRead(payload.cmd) ? 'query' : 'control', outcome: error?.outcome || (error ? 'failed' : 'succeeded'),
          kind: error?.kind || null, completedAt: Date.now(), queueMs: 0, executionMs: Date.now() - startedAt });
      }
    }
    if (this.lifecycleBusy || w.bridge.lifecycleBusy) fail('worker-busy', 'Document lifecycle is active');
    if (w.bridge.recoveryRequired || this.quarantined(w.fileKey)) fail('worker-uncertain', 'This file has held work requiring reconciliation');
    const timeoutMs = deadline(options.timeoutMs, action === 'cmd-batch' ? 120000 : 60000), queueTimeoutMs = deadline(options.queueTimeoutMs, LIMITS.queueTimeoutMs);
    if (options.signal?.aborted) fail('client-gone', 'Client disconnected before admission');
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > LIMITS.messageBytes || this.jobs.size >= 32 || [...this.jobs.values()].reduce((s, j) => s + j.bytes, bytes) > 32 * 1048576) fail('queue-full', 'Coordinator job/byte budget exceeded');
    let lease = null, laneId = '$exclusive', id = randomUUID(), autoPlan = null;
    const c = payload.cmd, visiblePage = w.bridge.diagnostics().identity?.pageId;
    const namedLane = route?.laneId && this.journal.taskLanes.get(route.laneId);
    if (namedLane && (namedLane.fileKey !== w.fileKey || (route.pageId && route.pageId !== namedLane.pageId))) fail('lane-owner', 'Lane belongs to a different file or page.');
    const targetPage = namedLane?.pageId || route?.pageId || (!c?.parent || ['page', 'PAGE'].includes(c.parent) ? visiblePage : c.parent);
    const roots = c?.specs || (c?.spec ? [c.spec] : []);
    const automatic = action === 'cmd' && c.op === 'create' && !c.trackHistory && !route?.rect && c.placement !== 'manual' &&
      (namedLane || c.placement === 'auto' || route?.placement === 'auto' || (visiblePage && sizedRoots(c) && targetPage === visiblePage && roots.every(s => s.x == null && s.y == null)));
    if (automatic) {
      if (!w.fileKey) fail('file-key-unavailable', 'Automatic layout needs a file identity.');
      key(targetPage, 'pageId');
      if (c.parent && !['page', 'PAGE', targetPage].includes(c.parent)) fail('wrong-page', 'The layout parent must match the lane page.');
      if (route?.dependencies?.length) fail('unsupported-scope', 'Automatic layout dependencies require explicit reservations.');
      id = route?.requestId ? key(route.requestId, 'requestId') : id;
      if (this.jobs.has(id) || this.journal.records.has(id)) fail('duplicate-request', 'Request already admitted; inspect its outcome instead of replaying.');
      laneId = namedLane?.laneId || (route?.laneId ? key(route.laneId, 'laneId') : 'auto-' + id);
      autoPlan = { footprint: layoutFootprint(c), pageId: targetPage, agentId: namedLane?.agentId || key(route?.agentId || 'automatic', 'agentId'), label: namedLane?.label || short(route?.label || roots[0]?.name) || 'Automatic layout' };
      for (const r of this.journal.records.values()) if (r.fileKey === w.fileKey && r.laneId === laneId && r.state !== 'released' && (r.pageId !== targetPage || r.agentId !== autoPlan.agentId)) fail('lane-owner', 'A lane is bound to its page and agent');
      for (const j of this.jobs.values()) {
        const owner = j.lease || j.autoPlan;
        if (j.worker === w && j.laneId === laneId && owner && (owner.pageId !== targetPage || owner.agentId !== autoPlan.agentId)) fail('lane-owner', 'Queued work already binds this lane to its page and agent');
      }
    } else if (route?.laneId) {
      laneId = key(route.laneId, 'laneId'); id = key(route.requestId, 'requestId'); key(route.pageId, 'pageId');
      key(route.agentId, 'agentId');
      if (namedLane && route.agentId !== namedLane.agentId) fail('lane-owner', 'Lane belongs to a different agent.');
      if (this.jobs.has(id) || this.journal.records.has(id)) fail('duplicate-request', 'Request ID already admitted; inspect its receipt, do not replay', this.journal.records.get(id));
      if (action !== 'cmd' || payload.cmd.op !== 'create' || payload.cmd.trackHistory) fail('unsupported-scope', 'Zone lanes accept standalone create jobs; dependent batches and other writers require separate ownership contracts');
      if (payload.cmd.parent !== route.pageId || payload.cmd.select !== false || payload.cmd.zoom !== false) fail('invalid-request', 'Lane creation requires parent=pageId, select:false and zoom:false');
      const specs = payload.cmd.specs || [payload.cmd.spec];
      if (!Array.isArray(specs) || !specs.length || specs.length > 64 || specs.some(s => !s || !Number.isFinite(s.x) || !Number.isFinite(s.y))) fail('invalid-request', 'A lane job accepts 1..64 roots, each with explicit page-space x/y');
      const rect = rectangle(route.rect), gutter = route.gutter ?? 24;
      if (!Number.isFinite(gutter) || gutter < 0 || gutter > 10000) fail('invalid-request', 'Invalid gutter');
      const dependencies = route.dependencies || [];
      if (!Array.isArray(dependencies) || dependencies.length > 16) fail('invalid-request', 'At most 16 dependencies are allowed');
      dependencies.forEach(d => { key(d, 'dependency'); if (!this.journal.records.has(d)) fail('unknown-dependency', 'Dependencies must already be admitted'); });
      for (const r of this.journal.records.values()) {
        if (r.fileKey !== w.fileKey || r.state === 'released') continue;
        if (r.laneId === laneId && (r.pageId !== route.pageId || r.agentId !== route.agentId)) fail('lane-owner', 'A lane is bound to its page and agent');
        if (r.pageId === route.pageId && intersects(rect, r.rect, Math.max(gutter, r.gutter))) fail('zone-conflict', 'Zone intersects an existing reservation', { leaseId: r.leaseId, requestId: r.requestId, state: r.state });
      }
      if (this.journal.records.size >= 512) fail('journal-full', 'Receipt capacity reached; archive/reconcile before accepting more zone work');
      lease = { requestId: id, leaseId: randomUUID(), token: ++this.journal.fence, fileKey: w.fileKey, pageId: route.pageId,
        laneId, agentId: route.agentId, label: short(route.label), rect, gutter, dependencies, state: 'reserved', admittedAt: Date.now() };
      this.journal.records.set(id, lease); this.journal.save();
    } else if (this.protected(w.fileKey) && commands.some(c => !isRead(c))) fail('protected-file', 'Unscoped writers cannot bypass this file’s reservations');
    // A batch is one ordered unit of work with an automatically assigned lane.
    // Independent batches can be admitted together without sharing $exclusive;
    // the worker still finishes the current batch before taking another turn.
    const batch = action === 'cmd-batch';
    const label = batch ? short(route?.label) || `Batch ${++this.batchSequence} · ${commands.length} commands` : null;
    if (batch) laneId = 'batch-' + id;
    return new Promise((resolve, reject) => {
      const j = { id, worker: w, laneId, lease, autoPlan, label, payload, action, bytes, state: 'queued', enqueuedAt: Date.now(), timeoutMs, queueTimeoutMs, resolve, reject, signal: options.signal };
      j.abort = () => this.cancel(id, w.workerId, 'client-gone');
      j.timer = setTimeout(() => this.finish(j, bridgeError('queue-timeout', 'Coordinator queue deadline exceeded', { outcome: 'not-started' })), queueTimeoutMs);
      const turnKey = w.workerId + '/' + laneId;
      if (!this.lastLane.has(turnKey)) this.lastLane.set(turnKey, this.turn);
      this.jobs.set(id, j); options.signal?.addEventListener('abort', j.abort, { once: true });
      this.schedulePublish();
      queueMicrotask(() => this.drain(w));
    });
  }
  blocked(j) {
    for (const id of j.lease?.dependencies || []) {
      const r = this.journal.records.get(id);
      if (r.state === 'released' || r.state === 'held') return 'dependency-failed:' + id;
      if (r.state !== 'committed') return 'waiting-dependency:' + id;
    }
    return null;
  }
  async drain(w) {
    if (w.active || !w.bridge.connected()) return;
    const waiting = [...this.jobs.values()].filter(j => j.worker === w && j.state === 'queued');
    for (const j of waiting) if (this.blocked(j)?.startsWith('dependency-failed:')) this.finish(j, bridgeError('dependency-failed', 'A dependency did not commit', { outcome: 'not-started' }));
    const heads = new Map();
    for (const j of waiting) if (this.jobs.has(j.id) && !heads.has(j.laneId)) heads.set(j.laneId, j);
    const ready = [...heads.values()].filter(j => !this.blocked(j));
    // Least-recently-served lane: all ready peers get a turn, even under sustained arrivals.
    ready.sort((a, b) => (this.lastLane.get(w.workerId + '/' + a.laneId) || 0) - (this.lastLane.get(w.workerId + '/' + b.laneId) || 0) || a.enqueuedAt - b.enqueuedAt);
    const j = ready[0];
    if (!j) return;
    w.active = j; j.state = 'running'; j.startedAt = Date.now(); clearTimeout(j.timer); this.lastLane.set(w.workerId + '/' + j.laneId, ++this.turn);
    this.schedulePublish();
    try {
      if (!j.lease && !j.autoPlan && this.protected(w.fileKey) && (j.action === 'cmd' ? [j.payload.cmd] : j.payload.cmds).some(c => !isRead(c))) fail('protected-file', 'New reservations prevent this previously queued unscoped writer');
      if (this.quarantined(w.fileKey)) fail('worker-uncertain', 'A previous job requires reconciliation');
      if (j.autoPlan) {
        const plan = j.autoPlan;
        j.phase = 'planning';
        const scene = await w.bridge.dispatch('cmd', { cmd: { op: 'layoutInfo', pageId: plan.pageId, expectedFileKey: w.fileKey } },
          { timeoutMs: Math.min(j.timeoutMs, 30000), signal: j.signal, onId: id => { j.wireId = id; } });
        j.wireId = null;
        if (j.state === 'cancelling' || j.signal?.aborted) fail('cancelled', 'Layout cancelled before creation.');
        if (!w.bridge.connected() || scene.fileKey !== w.fileKey || scene.pageId !== plan.pageId || !Array.isArray(scene.bounds)) fail('wrong-file', 'Canvas identity changed during placement.');
        if (this.quarantined(w.fileKey)) fail('worker-uncertain', 'The file requires reconciliation.');
        const reserved = [...this.journal.records.values()].filter(r => r.fileKey === w.fileKey && r.pageId === plan.pageId && r.state !== 'released').map(r => ({ ...r.rect, gutter: r.gutter }));
        const rect = rectangle(findSpace(plan.footprint, [...scene.bounds, ...reserved]));
        if (this.journal.records.size >= 512) fail('journal-full', 'Receipt capacity reached.');
        j.lease = { requestId: j.id, leaseId: randomUUID(), token: ++this.journal.fence, fileKey: w.fileKey, pageId: plan.pageId, laneId: j.laneId, agentId: plan.agentId, label: plan.label, rect, gutter: 24, dependencies: [], state: 'reserved', admittedAt: j.enqueuedAt, automatic: true };
        this.journal.records.set(j.id, j.lease); this.journal.save();
        j.payload = { cmd: positionedCommand(j.payload.cmd, plan.footprint, rect, plan.pageId) }; j.phase = 'creating';
        this.schedulePublish();
      }
      if (j.lease) { j.lease.state = 'running'; this.journal.save(); }
      else if ((j.action === 'cmd' ? [j.payload.cmd] : j.payload.cmds).some(c => WRITES.has(c.op) && !isRead(c))) {
        j.fileHold = { fileKey: w.fileKey || '*', requestId: j.id, state: 'running', workerId: w.workerId, sessionEpoch: w.sessionEpoch };
        this.journal.fileHolds.set(j.fileHold.fileKey, j.fileHold); this.journal.save();
      }
      const scope = j.lease && { ...j.lease, sessionEpoch: w.sessionEpoch, coordinatorEpoch: this.epoch };
      const target = c => w.fileKey ? { ...c, expectedFileKey: c.expectedFileKey ?? w.fileKey } : c;
      const targeted = j.action === 'cmd' ? { cmd: target(j.payload.cmd) } : { cmds: j.payload.cmds.map(target) };
      const value = await w.bridge.dispatch(j.action, { ...targeted, ...(scope ? { lease: scope } : {}) },
        { timeoutMs: j.timeoutMs, queueTimeoutMs: j.queueTimeoutMs, signal: j.signal, onId: id => {
          j.wireId = id;
          const receipt = j.lease || j.fileHold;
          if (receipt) { Object.assign(receipt, { wireId: id, workerId: w.workerId, sessionEpoch: w.sessionEpoch }); this.journal.save(); }
        } });
      this.finish(j, null, value);
    } catch (e) { this.finish(j, e); }
    finally { w.active = null; queueMicrotask(() => this.drain(w)); }
  }
  finish(j, error, value) {
    if (!this.jobs.has(j.id)) return;
    clearTimeout(j.timer); j.signal?.removeEventListener('abort', j.abort);
    const outcome = error ? error.outcome || (j.wireId ? 'uncertain' : 'not-started') : (Array.isArray(value) && value.some(v => v.success === false) ? 'partial' : 'succeeded');
    if (j.lease) {
      j.lease.state = outcome === 'succeeded' ? 'committed' : ['not-started', 'rolled-back'].includes(outcome) ? 'released' : 'held';
      j.lease.outcome = outcome; j.lease.completedAt = Date.now();
      j.lease.nodeIds = value?.created?.map(n => n.id).slice(0, 10000) || [];
      j.lease.roots = value?.reservation?.roots?.slice(0, 64) || [];
      try { this.journal.save(); } catch (e) { j.lease.state = 'held'; error = bridgeError('journal-failed', e.message, { outcome: 'uncertain' }); }
    }
    if (j.fileHold) {
      if (['succeeded', 'not-started', 'rolled-back'].includes(outcome)) this.journal.fileHolds.delete(j.fileHold.fileKey);
      else j.fileHold.state = 'held';
      try { this.journal.save(); } catch (e) { j.fileHold.state = 'held'; this.journal.fileHolds.set(j.fileHold.fileKey, j.fileHold); error = bridgeError('journal-failed', e.message, { outcome: 'uncertain' }); }
    }
    this.jobs.delete(j.id);
    if (![...this.jobs.values()].some(other => other.worker === j.worker && other.laneId === j.laneId)) this.lastLane.delete(j.worker.workerId + '/' + j.laneId);
    this.record({ id: j.id, workerId: j.worker.workerId, laneId: j.laneId, label: j.lease?.label || j.autoPlan?.label || j.label, pageId: j.lease?.pageId || null,
      op: j.action === 'cmd' ? short(j.payload.cmd.op) : 'batch', outcome: error?.outcome || outcome, kind: error?.kind || null,
      category: j.action === 'cmd-batch' ? 'batch' : j.payload.cmd.op === 'exportImage' ? 'screenshot' : isRead(j.payload.cmd) ? 'query' : 'change',
      performance: value?.performance ? Object.fromEntries(['spatialChecks', 'spatialNodes', 'spatialMs', 'spatialMaxMs', 'yieldCount', 'yieldMs']
        .filter(k => Number.isFinite(value.performance[k]) && value.performance[k] >= 0).map(k => [k, value.performance[k]])) : null,
      completedAt: Date.now(), queueMs: (j.startedAt || Date.now()) - j.enqueuedAt, executionMs: j.startedAt ? Date.now() - j.startedAt : 0 });
    if (error) j.reject(error); else j.resolve(value);
    for (const w of this.workers.values()) queueMicrotask(() => this.drain(w));
  }
  record(receipt) {
    this.receipts.unshift(receipt); this.receipts.length = Math.min(50, this.receipts.length);
    this.schedulePublish();
  }
  cancel(id, workerId, kind = 'cancelled') {
    const j = this.jobs.get(id); if (!j || j.worker.workerId !== workerId) return false;
    if (j.state === 'queued') this.finish(j, bridgeError(kind, 'Cancelled before dispatch', { outcome: 'not-started' }));
    else { j.state = 'cancelling'; j.worker.bridge.session?.ws.send(JSON.stringify({ action: 'cancel', id: j.wireId, reason: kind })); }
    this.schedulePublish();
    return true;
  }
  lateResult(w, msg) {
    const lease = [...this.journal.records.values()].find(r => r.wireId === msg.id && r.workerId === w.workerId && r.sessionEpoch === w.sessionEpoch);
    const hold = [...this.journal.fileHolds.values()].find(r => r.wireId === msg.id && r.workerId === w.workerId && r.sessionEpoch === w.sessionEpoch);
    const outcome = msg.results?.some(v => v.outcome === 'uncertain') ? 'uncertain' : msg.results?.some(v => !v.success) ? 'partial' : msg.outcome || (msg.error ? 'failed' : 'succeeded');
    if (!lease && !hold) return;
    if (lease && ['not-started', 'rolled-back'].includes(outcome)) { lease.state = 'released'; lease.outcome = outcome; }
    else if (lease && outcome === 'succeeded' && Array.isArray(msg.result?.created)) { lease.state = 'committed'; lease.outcome = outcome; lease.nodeIds = msg.result.created.map(n => n.id).slice(0, 64); }
    if (hold && ['not-started', 'rolled-back', 'succeeded'].includes(outcome)) this.journal.fileHolds.delete(hold.fileKey);
    try { this.journal.save(); } catch { if (lease) lease.state = 'held'; if (hold) this.journal.fileHolds.set(hold.fileKey, hold); return; }
    const event = this.receipts.find(e => e.id === (lease || hold).requestId);
    if (event) { event.outcome = outcome; event.detail = 'Late acknowledgement from the original session'; }
  }
  async reconcile(requestId, route) {
    const w = this.select(route), r = this.journal.records.get(key(requestId, 'requestId'));
    if (!r || r.fileKey !== w.fileKey || r.state !== 'held') fail('invalid-request', 'Only a held reservation in this file can be reconciled');
    const d = w.bridge.diagnostics();
    if (w.active || d.busy || d.pending || d.uncertain || [...this.jobs.values()].some(j => j.worker === w)) fail('worker-busy', 'Reconciliation requires an idle, settled worker');
    // Block new work while the read-only plugin proof is in flight.
    w.bridge.lifecycleBusy = true;
    try {
      const proof = await w.bridge.dispatch('cmd', { cmd: { op: 'inspectReservation', expectedFileKey: r.fileKey, pageId: r.pageId,
        leaseId: r.leaseId, token: r.token, requestId: r.requestId } }, { timeoutMs: 10000 });
      if (proof.requestId !== r.requestId || proof.token !== r.token || proof.fileKey !== r.fileKey || !['committed', 'rolled-back'].includes(proof.state)) fail('unverifiable', 'Plugin proof does not match held reservation');
      if (proof.state === 'committed' && (JSON.stringify(proof.rect) !== JSON.stringify(r.rect) || proof.gutter !== r.gutter || !Array.isArray(proof.nodeIds) || !proof.nodeIds.length || proof.nodeIds.length > 64)) fail('unverifiable', 'Commit geometry does not match the held reservation');
      r.state = proof.state === 'committed' ? 'committed' : 'released'; r.outcome = proof.state === 'committed' ? 'succeeded' : 'rolled-back';
      r.nodeIds = Array.isArray(proof.nodeIds) ? proof.nodeIds.slice(0, 64) : []; r.reconciledAt = Date.now();
      try { this.journal.save(); } catch (e) { r.state = 'held'; throw e; }
      if (!this.quarantined(w.fileKey)) w.bridge.recoveryRequired = false;
      return { requestId, state: r.state, outcome: r.outcome, nodeIds: r.nodeIds };
    } finally { w.bridge.lifecycleBusy = false; }
  }
  diagnostics() {
    const all = [...this.workers.values()], d = all[0]?.bridge.diagnostics() || {};
    return { ...d, connected: this.connected(), pending: this.jobs.size + all.reduce((s, w) => s + [...w.bridge.pending.values()].filter(p => p.control).length, 0), pendingBytes: [...this.jobs.values()].reduce((s, j) => s + j.bytes, 0),
      busy: all.find(w => w.active)?.bridge.diagnostics().busy || null,
      uncertain: all.reduce((s, w) => s + (w.bridge.diagnostics().uncertain || 0), 0), recoveryRequired: this.recoveryRequired,
      coordinator: this.snapshot() };
  }
  snapshot(compact = false) {
    const now = Date.now(), jobs = [...this.jobs.values()], records = [...this.journal.records.values()].filter(r => r.state !== 'released');
    const workers = [...this.workers.values()].map(w => { const d = w.bridge.diagnostics(); return { workerId: w.workerId, sessionEpoch: w.sessionEpoch,
      fileKey: w.fileKey, file: short(d.identity?.file), page: short(d.identity?.page), pageId: d.identity?.pageId, connected: d.connected,
      quarantine: d.recoveryRequired || this.quarantined(w.fileKey), lastSeen: d.lastSeen,
      current: w.active ? { requestId: w.active.id, wireId: w.active.wireId, laneId: w.active.laneId, pageId: w.active.lease?.pageId || w.active.autoPlan?.pageId, label: w.active.lease?.label || w.active.autoPlan?.label || w.active.label,
        phase: w.active.phase || w.active.state, executionMs: now - w.active.startedAt, progress: w.bridge.pending.get(w.active.wireId)?.progress || null } : null }; });
    const snapshot = { type: 'telemetry', schema: 1, sequence: ++this.seq, coordinatorEpoch: this.epoch, sampledAt: now, source: 'daemon',
      workers, maxWorkers: this.maxWorkers, taskLanes: this.laneSummary(), budgets: { jobs: jobs.length, maxJobs: 32, bytes: jobs.reduce((s, j) => s + j.bytes, 0), maxBytes: 32 * 1048576 }, held: records.filter(r => r.state === 'held').length + [...this.journal.fileHolds.values()].filter(r => r.state === 'held').length };
    if (!compact) Object.assign(snapshot, { resources: this.resources(), lanes: jobs.map(j => ({ requestId: j.id, workerId: j.worker.workerId, laneId: j.laneId,
      pageId: j.lease?.pageId || j.autoPlan?.pageId, agentId: j.lease?.agentId || j.autoPlan?.agentId, label: j.lease?.label || j.autoPlan?.label || j.label, state: j.state, automatic: !!j.autoPlan || j.action === 'cmd-batch',
      blockedReason: this.blocked(j) || (j.state === 'queued' ? 'waiting-worker-turn' : null), waitMs: (j.startedAt || now) - j.enqueuedAt, bytes: j.bytes })),
      reservations: records.sort((a, b) => Number(b.state === 'held') - Number(a.state === 'held') || b.admittedAt - a.admittedAt).slice(0, 64).map(({ nodeIds, roots, dependencies, ...r }) => ({ ...r, roots: (roots || []).slice(0, 8), omittedRoots: Math.max(0, (nodeIds?.length || 0) - Math.min(8, roots?.length || 0)), nodeCount: nodeIds?.length || 0 })),
      fileHolds: [...this.journal.fileHolds.values()].filter(r => r.state === 'held'), omittedReservations: Math.max(0, records.length - 64), recent: this.receipts.slice(0, 20),
      latency: { scope: 'last 50 completed requests in this daemon session', count: this.receipts.length,
        queueP95Ms: this.percentile('queueMs'), executionP95Ms: this.percentile('executionMs') } });
    return snapshot;
  }
  percentile(field) { const s = this.receipts.map(r => r[field]).sort((a, b) => a - b); return s.length ? s[Math.ceil(s.length * .95) - 1] : null; }
  schedulePublish(worker) {
    if (this.closed) return;
    if (worker) this.progressWorkers.add(worker); else this.uiDirty = true;
    if (this.uiTimer) return;
    this.uiTimer = setTimeout(() => {
      this.uiTimer = null;
      const full = this.uiDirty, workers = [...this.progressWorkers];
      this.uiDirty = false; this.progressWorkers.clear();
      if (full) this.publish(); else for (const w of workers) this.publishProgress(w);
    }, 100);
    this.uiTimer.unref();
  }
  publishProgress(worker) {
    const job = worker.active, progress = worker.bridge.pending.get(job?.wireId)?.progress;
    if (!job || !progress) return;
    const wire = JSON.stringify({ type: 'worker-progress', schema: 1, coordinatorEpoch: this.epoch, sequence: ++this.seq,
      workerId: worker.workerId, sessionEpoch: worker.sessionEpoch, requestId: job.id, wireId: job.wireId, progress });
    for (const w of this.workers.values()) if (w.visible && w.bridge.connected() && w.bridge.session.ws.bufferedAmount < 65536) w.bridge.session.ws.send(wire);
  }
  publish(only) {
    for (const w of only ? [only] : this.workers.values()) if (w.visible && w.bridge.connected()) {
      const ws = w.bridge.session.ws;
      if (ws.bufferedAmount < 65536) { const wire = JSON.stringify(this.snapshot(w.mode === 'compact')); if (Buffer.byteLength(wire) <= 131072) ws.send(wire); }
    }
  }
  close() { this.closed = true; clearInterval(this.timer); clearTimeout(this.uiTimer); this.uiTimer = null; this.progressWorkers.clear(); for (const ws of this.handshakes) ws.close(); for (const w of this.workers.values()) w.bridge.close(); }
}
