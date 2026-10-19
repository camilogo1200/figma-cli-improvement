import { LIMITS, bridgeError } from './bridge-protocol.js';

export class BodyBudget {
  constructor({ maxActive = 8, maxBytes = LIMITS.queueBytes } = {}) { Object.assign(this, { maxActive, maxBytes, active: 0, bytes: 0 }); }
}

// Keep a slot until the response is flushed/closed, not merely until plugin work
// finishes. Slow readers otherwise accumulate completed export buffers forever.
export class ResponseSlots {
  constructor(maxActive = 12) { this.maxActive = maxActive; this.active = 0; }
  acquire(res) {
    if (this.active >= this.maxActive || res.destroyed) return false;
    this.active++;
    const release = () => { this.active--; res.off('finish', release); res.off('close', release); };
    res.once('finish', release); res.once('close', release);
    return true;
  }
}

export function readJsonBody(req, { maxBytes = LIMITS.messageBytes, timeoutMs = 10000, budget } = {}) {
  if (budget && budget.active >= budget.maxActive) {
    req.resume();
    return Promise.reject(bridgeError('queue-full', 'Too many simultaneous request uploads', { outcome: 'not-started' }));
  }
  if (budget) budget.active++;
  return new Promise((resolve, reject) => {
    let chunks = [], bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (budget) { budget.active--; budget.bytes -= bytes; }
      req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', failed);
      chunks = [];
      if (error) { req.once('error', () => {}); req.resume(); reject(error); } else resolve(value);
    };
    const data = chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (budget) budget.bytes += chunk.length;
      if (bytes > maxBytes) return finish(bridgeError('payload-too-large', 'Request body exceeds the byte limit'));
      if (budget && budget.bytes > budget.maxBytes) return finish(bridgeError('queue-full', 'Request uploads exceed the shared byte budget', { outcome: 'not-started' }));
      chunks.push(chunk);
    };
    const end = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
        finish(null, { value, bytes });
      } catch (e) { finish(bridgeError('invalid-request', 'Invalid JSON body: ' + e.message)); }
    };
    const aborted = () => finish(bridgeError('client-gone', 'Request body interrupted'));
    const failed = () => finish(bridgeError('client-gone', 'Request stream failed'));
    const timer = setTimeout(() => finish(bridgeError('request-timeout', 'Request body deadline exceeded')), timeoutMs);
    req.on('data', data); req.on('end', end); req.on('aborted', aborted); req.on('error', failed);
    if (Number(req.headers['content-length']) > maxBytes) finish(bridgeError('payload-too-large', 'Request body exceeds the byte limit'));
  });
}

export async function withDeadline(fn, timeoutMs) {
  let timer;
  try { return await Promise.race([fn(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(bridgeError('daemon-timeout', 'Execution deadline exceeded', { outcome: 'uncertain' })), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
