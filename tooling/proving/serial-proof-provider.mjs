// @ts-check
// One proof at a time (Garrett, 2026-11-25). The proof server runs with job
// capacity 1 and one worker; this provider makes sure our tooling never asks
// for more: every check/prove call in the process, from every provider
// (callers and cross-contract callees of one transaction, several contracts),
// goes through one FIFO queue, so a single proof is in flight at any moment.
// Peak proof-server memory is then the largest single proof, not a sum.
import { httpClientProvingProvider, DEFAULT_TIMEOUT } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { createProofProviderFromHandlers } from '@midnight-ntwrk/midnight-js-types';
import { Transaction, CostModel } from '@midnight-ntwrk/midnight-js-protocol/v9';

/** @type {Promise<unknown>} */
let tail = Promise.resolve();
/** Runs `fn` after every earlier queued call has settled. */
function enqueue(/** @type {() => Promise<any>} */ fn) {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}

/** Wraps a ProvingProvider so its check/prove calls go through the process-wide queue. */
export function serialProvingProvider(/** @type {any} */ base) {
  return {
    check: (/** @type {any} */ preimage, /** @type {any} */ key) => enqueue(() => base.check(preimage, key)),
    prove: (/** @type {any} */ preimage, /** @type {any} */ key, /** @type {any} */ binding) => enqueue(() => base.prove(preimage, key, binding)),
    lookupKey: (/** @type {any} */ key) => base.lookupKey(key),
  };
}

/**
 * Drop-in for httpClientProofProvider (ledger 9 only): same proof server
 * protocol, one proof at a time. The timeout applies to each proof once it
 * leaves the queue.
 * @param {{ url: string, zkConfigProvider: any, timeout?: number }} o
 */
export function serialProofProvider({ url, zkConfigProvider, timeout = DEFAULT_TIMEOUT }) {
  const proving = serialProvingProvider(httpClientProvingProvider(url, zkConfigProvider, { timeout }));
  return createProofProviderFromHandlers({
    v8: async () => { throw new Error('serialProofProvider proves ledger 9 transactions only'); },
    v9: (/** @type {any} */ tx) => tx.deserialize({ v9: Transaction }).prove(proving, CostModel.initialCostModel()),
  });
}
