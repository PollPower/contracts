// Finalized-state check for staged deploys (Garrett, 2026-11-24): before a
// contract is used (and as a Preprod gate), its on-chain state must hold
// EXACTLY the audited build's verifier keys, byte for byte, and its maintenance
// authority must be locked (no committee can ever sign another update).
//
// Offline: ContractState is built locally from the real build's verifier keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as R from '@midnight-ntwrk/compact-runtime';
import { BUILD, buildExists } from '../parity/harness.mjs';
import { checkFinalized, isLockedAuthority, buildVerifierKeys } from '../../tooling/deploy/finalize.mjs';

const NAME = 'ebt-v8';
const skip = buildExists(NAME) && fs.existsSync(path.join(BUILD, NAME, 'keys')) ? false : 'ebt-v8 full-ZK build missing';

/** A local ContractState holding `ids` from the build (optionally a swapped key), with `authority`. */
function stateWith(ids, authority, swap = {}) {
  const keys = buildVerifierKeys(path.join(BUILD, NAME));
  const st = new R.ContractState();
  for (const id of ids) {
    const op = new R.ContractOperation();
    op.verifierKey = swap[id] ?? keys.get(id);
    st.setOperation(id, op);
  }
  if (authority) st.maintenanceAuthority = authority;
  return st;
}
const LOCKED = () => new R.ContractMaintenanceAuthority([], 1, 15n);
const deployerKey = () => R.signatureVerifyingKey(R.sampleSigningKey());

test('FZ-1: complete build + locked authority passes', { skip }, () => {
  const ids = [...buildVerifierKeys(path.join(BUILD, NAME)).keys()];
  assert.equal(ids.length, 20);   // fix #5: -mirrorActionLogRoot -mirrorActionLogHead +syncRegistryRoot
  assert.deepEqual(checkFinalized(stateWith(ids, LOCKED()), path.join(BUILD, NAME)), { ok: true, problems: [] });
});

test('FZ-2 (negative): mid-deploy (ceremony keys only) fails, naming every missing circuit', { skip }, () => {
  const ceremony = ['attestProducerOwnership', 'mirrorClassStatutoryTotal', 'mirrorRegisterLane', 'mirrorScheduleLifecycle', 'revokeProducerOwnership', 'settle', 'syncRegistryRoot'];
  const r = checkFinalized(stateWith(ceremony, LOCKED()), path.join(BUILD, NAME));
  assert.equal(r.ok, false);
  assert.equal(r.problems.filter((p) => p.startsWith('missing:')).length, 13);
  assert.ok(r.problems.includes('missing:registerChip'));
});

test('FZ-3 (negative): a foreign verifier key for a known circuit fails', { skip }, () => {
  const keys = buildVerifierKeys(path.join(BUILD, NAME));
  const ids = [...keys.keys()];
  // A real, well-formed key, but another circuit's: what a malicious insert would look like.
  const r = checkFinalized(stateWith(ids, LOCKED(), { settle: keys.get('redeem') }), path.join(BUILD, NAME));
  assert.deepEqual(r.problems, ['vk-mismatch:settle']);
});

test('FZ-4 (negative): an extra operation not in the audited build fails', { skip }, () => {
  const keys = buildVerifierKeys(path.join(BUILD, NAME));
  const ids = [...keys.keys()];
  const st = stateWith(ids, LOCKED());
  const op = new R.ContractOperation();
  op.verifierKey = keys.get('redeem');
  st.setOperation('backdoorMint', op);
  assert.deepEqual(checkFinalized(st, path.join(BUILD, NAME)).problems, ['unexpected:backdoorMint']);
});

test('FZ-5 (negative): any authority that can still sign fails; threshold 0 (anyone) fails', () => {
  const k = deployerKey();
  assert.equal(isLockedAuthority(new R.ContractMaintenanceAuthority([k], 1, 0n)), false, 'deployer key (midnight-js default)');
  assert.equal(isLockedAuthority(new R.ContractMaintenanceAuthority([k, deployerKey(), deployerKey()], 2, 1n)), false, '2-of-3 committee');
  assert.equal(isLockedAuthority(new R.ContractMaintenanceAuthority([], 0, 1n)), false, 'threshold 0: no signature needed at all');
  assert.equal(isLockedAuthority(new R.ContractMaintenanceAuthority([k], 0, 1n)), false, 'threshold 0 with a committee');
  assert.equal(isLockedAuthority(new R.ContractMaintenanceAuthority([], 1, 1n)), true, 'empty committee, threshold 1');
  assert.equal(isLockedAuthority(new R.ContractMaintenanceAuthority([k], 2, 1n)), true, 'threshold above committee size');
});

test('FZ-6 (negative): complete keys but the deployer authority still live fails', { skip }, () => {
  const ids = [...buildVerifierKeys(path.join(BUILD, NAME)).keys()];
  const r = checkFinalized(stateWith(ids, new R.ContractMaintenanceAuthority([deployerKey()], 1, 14n)), path.join(BUILD, NAME));
  assert.deepEqual(r.problems, ['authority-not-locked:committee=1,threshold=1']);
});
