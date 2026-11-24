// @ts-check
// Staged deploys: finalization and the finalized-state check (Garrett,
// 2026-11-24; Preprod gate).
//
// The maintenance authority (CMA). Midnight.js deployContract gives every
// contract a one-key CMA: a fresh signing key, threshold 1, stored in the local
// private-state store. Whoever holds that key can insert or REMOVE verifier
// keys and replace the authority at any time, i.e. rewrite what every circuit
// does. During a staged deploy that is how the missing keys go in; afterwards
// it is a standing backdoor. So a staged deploy ends with ONE maintenance
// update that inserts the last verifier key(s) AND replaces the authority with
// a locked one (empty committee, threshold 1: no set of signatures can ever
// satisfy it). From then on the contract's circuits are fixed; upgrades are new
// deployments with a council-approved migration, as for every version so far.
//
// checkFinalized(): the on-chain operations equal the audited build's exactly
// (no missing circuit, no extra one, every verifier key byte-identical) and the
// authority is locked. Threshold 0 is NOT locked: it needs no signature at all.
import fs from 'node:fs';
import path from 'node:path';
import * as L9 from '@midnight-ntwrk/midnight-js-protocol/v9';
import { LedgerTransaction } from '@midnight-ntwrk/midnight-js-types';
import { submitTx } from '@midnight-ntwrk/midnight-js-contracts';

/** circuit id -> verifier key bytes of an audited build (`<buildDir>/keys/*.verifier`). */
export function buildVerifierKeys(/** @type {string} */ buildDir) {
  const dir = path.join(buildDir, 'keys');
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.verifier')).sort()) {
    out.set(f.slice(0, -'.verifier'.length), new Uint8Array(fs.readFileSync(path.join(dir, f))));
  }
  return out;
}

/** True iff no set of signatures can ever satisfy this maintenance authority. */
export function isLockedAuthority(/** @type {{committee: unknown[], threshold: number}} */ cma) {
  const t = Number(cma.threshold);
  return t >= 1 && t > cma.committee.length;
}

const same = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * @param {any} state  the live ContractState (compact-runtime / onchain-runtime)
 * @param {string} buildDir  the audited build the deployment must match
 * @param {{ requireLocked?: boolean }} [opts]
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkFinalized(state, buildDir, opts = {}) {
  const requireLocked = opts.requireLocked ?? true;
  const expected = buildVerifierKeys(buildDir);
  const problems = [];
  const live = new Set(state.operations().map((/** @type {string | Uint8Array} */ o) => (typeof o === 'string' ? o : Buffer.from(o).toString('hex'))));
  for (const [id, vk] of expected) {
    if (!live.has(id)) { problems.push(`missing:${id}`); continue; }
    const op = state.operation(id);
    const onChain = op?.verifierKey;
    if (!onChain || !same(new Uint8Array(onChain), vk)) problems.push(`vk-mismatch:${id}`);
  }
  for (const id of live) if (!expected.has(id)) problems.push(`unexpected:${id}`);
  const cma = state.maintenanceAuthority;
  if (requireLocked && !isLockedAuthority(cma)) problems.push(`authority-not-locked:committee=${cma.committee.length},threshold=${cma.threshold}`);
  return { ok: problems.length === 0, problems };
}

/** The locked authority a finalized contract carries (counter = current + 1). */
export const lockedAuthority = (/** @type {bigint} */ currentCounter) => new L9.ContractMaintenanceAuthority([], 1, currentCounter + 1n);

/** A verifier-key insert in the ledger's current operation version. */
export const vkInsert = (/** @type {string} */ id, /** @type {Uint8Array} */ vk) => new L9.VerifierKeyInsert(id, new L9.ContractOperationVersionedVerifierKey('v4', vk));
export const vkRemove = (/** @type {string} */ id) => new L9.VerifierKeyRemove(id, new L9.ContractOperationVersion('v4'));
export const replaceAuthority = (/** @type {any} */ cma) => new L9.ReplaceAuthority(cma);

/**
 * Builds, signs and submits one maintenance update carrying `updates`, signed
 * by `signers` (committee indices 0..n-1), at the authority's current counter.
 * @param {any} providers  midnight-js providers for the contract
 * @param {string} address
 * @param {any} state  the live ContractState (for the counter)
 * @param {any[]} updates
 * @param {any[]} signers  ledger signing keys
 * @param {string} networkId
 */
export async function submitMaintenance(providers, address, state, updates, signers, networkId) {
  let mu = new L9.MaintenanceUpdate(address, updates, state.maintenanceAuthority.counter);
  signers.forEach((sk, i) => { mu = mu.addSignature(BigInt(i), L9.signData(sk, mu.dataToSign)); });
  const tx = L9.Transaction.fromParts(networkId, undefined, undefined, L9.Intent.new(new Date(Date.now() + 10 * 60_000)).addMaintenanceUpdate(mu));
  const unprovenTx = LedgerTransaction.seal('v9', 'Unproven', tx);
  const r = await submitTx(providers, /** @type {any} */ ({ unprovenTx }));
  if (r.status !== 'SucceedEntirely') throw new Error(`maintenance update not applied: ${r.status}`);
  return r;
}
