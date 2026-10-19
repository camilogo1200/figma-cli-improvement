import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAvailable } from '../bridge/companion.mjs';

test('companion starts only a missing daemon, never replaces a wrong build or active checkout', async () => {
  const local = { root: 'this-checkout', daemonBuild: 'current', protocol: 4 };
  let launches = 0;
  const launch = async () => { launches++; };
  assert.equal((await ensureAvailable({ local, launch, inspect: async () => { throw Object.assign(Error('Offline'), { kind: 'daemon-down' }); } })).status, 'ready');
  assert.equal(launches, 1);
  assert.equal((await ensureAvailable({ local, launch, inspect: async () => ({ ...local, mode: 'safe', busy: true }) })).status, 'ready');
  assert.equal((await ensureAvailable({ local, launch, inspect: async () => ({ ...local, daemonBuild: 'old', mode: 'safe' }) })).status, 'attention');
  assert.equal((await ensureAvailable({ local, launch, inspect: async () => { throw Error('Permission denied'); } })).status, 'attention');
  assert.equal(launches, 1);
});
