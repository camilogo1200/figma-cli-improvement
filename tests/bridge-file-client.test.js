import test from 'node:test';
import assert from 'node:assert/strict';
import { forFile } from '../file-client.mjs';

function fixture() {
  const workers = [
    { fileKey: 'community', workerId: 'worker-a', sessionEpoch: 'a1', connected: true },
    { fileKey: 'tui', workerId: 'worker-b', sessionEpoch: 'b1', connected: true },
  ];
  const calls = [];
  const transport = {
    async coordinate(command, options) { if (command.op === 'status') return { workers }; calls.push({ command, options }); },
    async cmd(command, timeoutMs, options) { calls.push({ command, timeoutMs, options }); return { fileKey: options.coordination.fileKey }; },
    async cmdBatch(commands, timeoutMs, options) { calls.push({ commands, timeoutMs, options }); return commands.map(() => ({ success: true })); },
    async createLayout(specs, options) { calls.push({ specs, options }); },
  };
  return { workers, calls, transport };
}
test('concurrent callers route commands and batches to their own files and preserve lane/page metadata', async () => {
  const { calls, transport } = fixture();
  const a = forFile('community', transport), b = forFile('tui', transport);
  await Promise.all([
    a.cmd({ op: 'info' }, 5000),
    b.cmdBatch([{ op: 'info' }, { op: 'page', action: 'list' }], 10000, { coordination: { pageId: '0:1', laneId: 'tui-lane' } }),
  ]);
  assert.deepEqual(calls[0].options.coordination, { fileKey: 'community', workerId: 'worker-a', sessionEpoch: 'a1' });
  assert.deepEqual(calls[1].options.coordination, { fileKey: 'tui', workerId: 'worker-b', sessionEpoch: 'b1', pageId: '0:1', laneId: 'tui-lane' });
});
test('an offline target never falls through to the remaining file', async () => {
  const { workers, calls, transport } = fixture();
  workers[1].connected = false;
  await assert.rejects(forFile('tui', transport).cmd({ op: 'create' }), { kind: 'plugin-offline', outcome: 'not-started' });
  assert.equal(calls.length, 0);
});
test('fresh requests resolve new sessions, while an explicitly stale route fails before dispatch', async () => {
  const { workers, calls, transport } = fixture(), client = forFile('tui', transport);
  await client.cmd({ op: 'info' }); workers[1].sessionEpoch = 'b2';
  await client.cmd({ op: 'info' });
  assert.equal(calls[1].options.coordination.sessionEpoch, 'b2');
  await assert.rejects(client.cmd({ op: 'info' }, 1000, { coordination: { sessionEpoch: 'b1' } }), { kind: 'stale-session' });
  assert.equal(calls.length, 2);
});
test('cross-file overrides and legacy page commands fail before any document command', async () => {
  const { calls, transport } = fixture(), client = forFile('tui', transport);
  await assert.rejects(client.cmd({ op: 'remove', expectedFileKey: 'community' }), { kind: 'wrong-file' });
  await assert.rejects(client.cmd({ op: 'info' }, 1000, { coordination: { fileKey: 'community' } }), { kind: 'stale-session' });
  await assert.rejects(client.createLayout([], { fileKey: 'community' }), { kind: 'wrong-file' });
  await assert.rejects(client.cmd({ op: 'page', name: 'Board', create: true }), { kind: 'unsupported' });
  assert.equal(calls.length, 0);
});
test('failed mutations are not retried and cancellation prevents dispatch', async () => {
  const { calls, transport } = fixture();
  transport.cmd = async () => { calls.push('attempt'); throw Object.assign(Error('lost'), { kind: 'daemon-lost', outcome: 'uncertain' }); };
  const client = forFile('tui', transport);
  await assert.rejects(client.cmd({ op: 'create' }), { outcome: 'uncertain' });
  assert.equal(calls.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.cmd({ op: 'info' }, 1000, { signal: controller.signal }), { kind: 'client-gone' });
  assert.equal(calls.length, 1);
});
