// @ts-check
// One proof at a time (Garrett, 2026-11-25). The proof server runs with job
// capacity 1 and one worker; this provider makes sure our tooling never asks
// for more: every check/prove call in the process, from every provider
// (callers and cross-contract callees of one transaction, several contracts),
// goes through one FIFO queue, so a single proof is in flight at any moment.
// Peak proof-server memory is then the largest single proof, not a sum.
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { createProofProviderFromHandlers } from '@midnight-ntwrk/midnight-js-types';
import { Transaction, CostModel } from '@midnight-ntwrk/midnight-js-protocol/v9';

// One worker proved registerSchedule in 315 s on a quiet host and >15 min with
// kenya's CPUs contended (2026-11-25), past the client library's 300 s
// default. Match the proof server's --job-timeout 3600 (Joi, 2026-11-25);
// MIDNIGHT_PROOF_TIMEOUT_MS overrides.
export const PROOF_TIMEOUT_MS = Number(process.env.MIDNIGHT_PROOF_TIMEOUT_MS ?? 3_600_000);

/**
 * MIDNIGHT_PROOF_SERVER_RESET=<shell command> (e.g. `ssh kenya docker restart
 * wi16-proof-server`): restart the proof server before every proof. Its memory
 * grows across proofs (2026-11-25: registerLane alone peaked 9.5 GiB, but after
 * the other tariff proofs the server hit its 15 GiB cap and was OOM-killed);
 * a fresh server per proof bounds the peak by the largest single proof.
 */
async function resetProofServer(/** @type {string} */ cmd, /** @type {string} */ url) {
  const { execSync } = await import('node:child_process');
  execSync(cmd, { stdio: 'ignore', timeout: 120_000 });
  const v = `${url.replace(/\/$/, '')}/version`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(v, { signal: AbortSignal.timeout(5000) })).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`proof server not answering at ${v} after reset`);
}

/** @type {Promise<unknown>} */
let tail = Promise.resolve();
/** Runs `fn` after every earlier queued call has settled. */
function enqueue(/** @type {() => Promise<any>} */ fn) {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}

/**
 * Wraps a ProvingProvider so its check/prove calls go through the process-wide
 * queue. `beforeProve` (optional) runs inside the queue before every prove; if
 * it fails, that proof fails rather than running on an unreset server.
 * @param {any} base
 * @param {{ beforeProve?: () => Promise<void> }} [opts]
 */
export function serialProvingProvider(base, { beforeProve } = {}) {
  return {
    check: (/** @type {any} */ preimage, /** @type {any} */ key) => enqueue(() => base.check(preimage, key)),
    prove: (/** @type {any} */ preimage, /** @type {any} */ key, /** @type {any} */ binding) => enqueue(async () => {
      if (beforeProve) await beforeProve();
      return base.prove(preimage, key, binding);
    }),
    lookupKey: (/** @type {any} */ key) => base.lookupKey(key),
  };
}

/**
 * Drop-in for httpClientProofProvider (ledger 9 only): same proof server
 * protocol, one proof at a time. The timeout applies to each proof once it
 * leaves the queue.
 * @param {{ url: string, zkConfigProvider: any, timeout?: number }} o
 */
export function serialProofProvider({ url, zkConfigProvider, timeout = PROOF_TIMEOUT_MS }) {
  const reset = process.env.MIDNIGHT_PROOF_SERVER_RESET;
  const proving = serialProvingProvider(httpClientProvingProvider(url, zkConfigProvider, { timeout }),
    reset ? { beforeProve: () => resetProofServer(reset, url) } : {});
  return createProofProviderFromHandlers({
    v8: async () => { throw new Error('serialProofProvider proves ledger 9 transactions only'); },
    v9: (/** @type {any} */ tx) => tx.deserialize({ v9: Transaction }).prove(proving, CostModel.initialCostModel()),
  });
}
