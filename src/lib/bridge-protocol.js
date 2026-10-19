// Wire limits are mirrored in plugin/code.js (checked by the regression suite).
export const PROTOCOL = 4;
export const LIMITS = Object.freeze({
  messageBytes: 8 * 1024 * 1024,
  resultBytes: 32 * 1024 * 1024,
  queueBytes: 16 * 1024 * 1024,
  queueJobs: 8,
  batchItems: 128,
  specNodes: 10000,
  specDepth: 64,
  exportPixels: 32 * 1024 * 1024,
  timeoutMs: 600000,
  queueTimeoutMs: 30000,
});

export function bridgeError(kind, message, details = {}) {
  return Object.assign(new Error(message), { kind, ...details });
}

export function deadline(value, fallback) {
  const n = value === undefined ? fallback : value;
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.timeoutMs) {
    throw bridgeError('invalid-request', `timeoutMs must be an integer between 1 and ${LIMITS.timeoutMs}`);
  }
  return n;
}

export const immediate = cmd => ['ping', 'info', 'cancel', 'verifyFile', 'inspectReservation'].includes(cmd?.op);

export function validateEnvelope(action, payload) {
  if (action === 'cmd') {
    if (!payload.cmd || Array.isArray(payload.cmd) || typeof payload.cmd !== 'object' || typeof payload.cmd.op !== 'string') {
      throw bridgeError('invalid-request', 'cmd must be an object with an op');
    }
  } else if (action === 'cmd-batch') {
    if (!Array.isArray(payload.cmds) || !payload.cmds.length || payload.cmds.length > LIMITS.batchItems) {
      throw bridgeError('invalid-request', `cmds must contain 1–${LIMITS.batchItems} commands`);
    }
    for (const cmd of payload.cmds) validateEnvelope('cmd', { cmd });
  } else throw bridgeError('invalid-request', 'Expected cmd or cmd-batch');
}
