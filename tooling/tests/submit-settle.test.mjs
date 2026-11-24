// submitSettleWithRetry: retries transient failures, never resubmits a session
// that already landed, and never retries a contract refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitSettleWithRetry } from '../settle/submit-settle.mjs';

const quiet = { log() {} };
const noSleep = async () => {};

test('SS-1: transient failures are retried until the submit succeeds', async () => {
  let n = 0;
  const r = await submitSettleWithRetry({
    args: [1], sleep: noSleep, log: quiet, alreadySettled: async () => false,
    submit: async () => { if (++n < 3) throw new Error('ECONNRESET proof server'); return { txId: 'ok' }; },
  });
  assert.deepEqual(r, { status: 'submitted', tx: { txId: 'ok' }, attempts: 3 });
});

test('SS-2 (negative): a submit that landed but timed out locally is not resubmitted', async () => {
  let submits = 0;
  let landed = false;
  const r = await submitSettleWithRetry({
    args: [1], sleep: noSleep, log: quiet, alreadySettled: async () => landed,
    submit: async () => { submits++; landed = true; throw new Error('timeout waiting for finalization'); },
  });
  assert.equal(r.status, 'already-settled');
  assert.equal(submits, 1);
});

test('SS-3 (negative): a contract refusal is permanent (no retry)', async () => {
  let submits = 0;
  await assert.rejects(submitSettleWithRetry({
    args: [1], sleep: noSleep, log: quiet, alreadySettled: async () => false,
    submit: async () => { submits++; throw new Error('failed assert: CHIP_NONCE_REPLAYED'); },
  }), /CHIP_NONCE_REPLAYED/);
  assert.equal(submits, 1);
});

test('SS-4 (negative): gives up after the attempts, with the last error', async () => {
  let submits = 0;
  await assert.rejects(submitSettleWithRetry({
    args: [1], attempts: 3, sleep: noSleep, log: quiet, alreadySettled: async () => false,
    submit: async () => { submits++; throw new Error(`ETIMEDOUT ${submits}`); },
  }), /ETIMEDOUT 3/);
  assert.equal(submits, 3);
});
