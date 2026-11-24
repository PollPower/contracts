// One proof at a time (Garrett, 2026-11-25): the proof server is run with
// job capacity 1, and every check/prove call our tooling makes, across all
// providers in the process, is queued so only one is in flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialProvingProvider } from '../proving/serial-proof-provider.mjs';

const fakeBase = (log, { failOn } = {}) => {
  let inFlight = 0;
  const run = async (kind, k) => {
    inFlight++;
    log.maxInFlight = Math.max(log.maxInFlight ?? 0, inFlight);
    log.order.push(`${kind}:${k}:start`);
    await new Promise((r) => setTimeout(r, 15));
    log.order.push(`${kind}:${k}:end`);
    inFlight--;
    if (k === failOn) throw new Error(`boom ${k}`);
    return new Uint8Array([1]);
  };
  return { check: (_p, k) => run('check', k), prove: (_p, k) => run('prove', k), lookupKey: async () => undefined };
};

test('SPV-1: concurrent prove/check calls reach the server one at a time, in call order', async () => {
  const log = { order: [] };
  const pp = serialProvingProvider(fakeBase(log));
  await Promise.all([pp.prove(null, 'a'), pp.check(null, 'b'), pp.prove(null, 'c')]);
  assert.equal(log.maxInFlight, 1);
  assert.deepEqual(log.order, ['prove:a:start', 'prove:a:end', 'check:b:start', 'check:b:end', 'prove:c:start', 'prove:c:end']);
});

test('SPV-2: the queue is shared by every provider in the process', async () => {
  const log = { order: [] };
  const base = fakeBase(log);
  const p1 = serialProvingProvider(base), p2 = serialProvingProvider(base);
  await Promise.all([p1.prove(null, 'x'), p2.prove(null, 'y'), p1.prove(null, 'z')]);
  assert.equal(log.maxInFlight, 1);
});

test('SPV-3 (negative): a failed proof is reported and does not block the next one', async () => {
  const log = { order: [] };
  const pp = serialProvingProvider(fakeBase(log, { failOn: 'bad' }));
  const r = await Promise.allSettled([pp.prove(null, 'bad'), pp.prove(null, 'good')]);
  assert.equal(r[0].status, 'rejected');
  assert.match(String(r[0].reason), /boom bad/);
  assert.equal(r[1].status, 'fulfilled');
  assert.equal(log.maxInFlight, 1);
});
