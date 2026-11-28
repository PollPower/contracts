// Client limiter for the Blockfrost bridge (G2c: about 8 requests/s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenBucket, rateFromEnv } from '../network/rate-limit.mjs';

test('RL-1: the bucket serves at most `rate` per second after the burst, in order', async () => {
  let t = 0;
  const b = tokenBucket({ rate: 8, burst: 8, now: () => t, sleep: async (ms) => { t += ms; } });
  const done = [];
  await Promise.all(Array.from({ length: 40 }, (_, i) => b.take().then(() => done.push([i, t]))));
  assert.deepEqual(done.map(([i]) => i), [...Array(40).keys()], 'served in order');
  assert.equal(done[7][1], 0, 'burst of 8 immediately');
  // 32 more at 8/s take 4 s of the fake clock.
  assert.ok(Math.abs(done[39][1] - 4000) <= 10, `last at ${done[39][1]} ms`);
  for (let k = 8; k + 8 < 40; k++) assert.ok(done[k + 8][1] - done[k][1] >= 990, 'no more than 8 in any second after the burst');
});

test('RL-2: rate from MIDNIGHT_RATE_LIMIT_RPS, default 8, refuses nonsense', () => {
  assert.equal(rateFromEnv({}), 8);
  assert.equal(rateFromEnv({ MIDNIGHT_RATE_LIMIT_RPS: '5' }), 5);
  for (const bad of ['0', '-1', 'x', '1000']) assert.throws(() => rateFromEnv({ MIDNIGHT_RATE_LIMIT_RPS: bad }), /MIDNIGHT_RATE_LIMIT_RPS/);
});

test('RL-3: only the limited hosts wait; others pass straight through', async () => {
  const { installRateLimit } = await import('../network/rate-limit.mjs');
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push([String(u), Date.now()]); return new Response('ok'); };
  try {
    installRateLimit({ hosts: ['midnight-preprod.blockfrost.io'], rate: 4 });
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => fetch('https://rpc.midnight-preprod.blockfrost.io/x')));
    const limitedMs = Date.now() - t0;
    const t1 = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => fetch('http://127.0.0.1:1/x')));
    assert.ok(limitedMs >= 900, `8 requests at 4/s (burst 4) take about 1 s, took ${limitedMs} ms`);
    assert.ok(Date.now() - t1 < 200, 'unlimited host not delayed');
  } finally {
    globalThis.fetch = orig;
  }
});
