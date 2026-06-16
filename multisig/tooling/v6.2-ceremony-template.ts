// =============================================================================
// v6.2-ceremony-template.ts — admin-set ceremony runner for PollPowerMultiSig
// v6.2 (H-3 hardened). TEMPLATE — staged for the pre-mainnet hardening ceremony.
//
// This is the v6.2 successor to swap-garrett-ring.ts / test-ceremony.ts. The
// ONLY substantive change from the v6 runners is the actionHash construction
// and the executeAddAdmin/executeRemoveAdmin calls, which now carry an atomic
// `newThreshold`. Everything else (wallet, providers, witness, approval
// casting, nonce tracking, safety aborts) is copied from the proven v6 runner.
//
// DO NOT RUN until:
//   1. multisig-v6.2-ed25519.compact is fully compiled (with ZK) and deployed.
//   2. A v6.2 deployment file exists (admins + sks + contractAddress).
//   3. The expected contract address constant below is set to the v6.2 address.
//
// Run (once ready), from settlement-api root on Kenya:
//   npx tsx contracts/dev/multisig-v6.2/v6.2-ceremony-template.ts
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Buffer } from 'buffer';
import { fileURLToPath } from 'node:url';

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
ed.hashes.sha512 = sha512;

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import {
  V62_OP,
  computeAdminSetActionHash,
  assertValidAdd,
  assertValidRemove,
  minMajorityThreshold,
} from './v6.2-actionhash.js';

// import { createWallet, createProviders, logger } from '<settlement-api>/src/utils.js';
// (path depends on where this is dropped in the settlement-api tree)

// ---------------------------------------------------------------------------
// CONFIGURE FOR THE v6.2 DEPLOYMENT
// ---------------------------------------------------------------------------
const EXPECTED_V62_ADDR = '<SET_AFTER_DEPLOY>';
const APPROVER_INDICES = [0, 1, 2]; // mock indices we hold SKs for (3-of-5)

// Example operation for this template: add a new ring AND raise threshold to
// keep a strict majority of the new set.
//   current set = 5, threshold 3  ->  add -> new size 6 -> majority needs 4.
const NEW_RING_PK_HEX = '<32-byte hex>';

// ---------------------------------------------------------------------------
// The witness — identical to the v6 ceremony.
// ---------------------------------------------------------------------------
const witnesses = {
  signature_valid(context: any, pubkey: Uint8Array, messageHash: Uint8Array, signature: Uint8Array) {
    if (pubkey.length !== 32 || messageHash.length !== 32 || signature.length !== 64) {
      return [context.privateState, false];
    }
    let ok = false;
    try {
      ok = ed.verify(signature, messageHash, pubkey);
    } catch {
      ok = false;
    }
    return [context.privateState, ok];
  },
};

// ---------------------------------------------------------------------------
// Sketch of the v6.2 ADD step (the part that differs from v6).
// `deployed`, `castApprovals`, `nonce`, `logger`, `hex`, `unwrap` come from the
// same boilerplate as swap-garrett-ring.ts — omitted here for the template.
// ---------------------------------------------------------------------------
//
//   const newRingPk = new Uint8Array(Buffer.from(NEW_RING_PK_HEX, 'hex'));
//   const currentSize = Number(unwrap(await deployed.callTx.getAdminCount()));   // e.g. 5
//   const oldThreshold = Number(unwrap(await deployed.callTx.getThreshold()));   // e.g. 3
//   const newThreshold = minMajorityThreshold(currentSize + 1);                  // 6 -> 4
//
//   // Fail BEFORE any on-chain tx if the (set, threshold) pair is invalid.
//   assertValidAdd(currentSize, newThreshold);
//
//   const nextNonce = nonce + 1n;
//   const actionHash = computeAdminSetActionHash(
//     V62_OP.addAdmin, newRingPk, newThreshold, nextNonce,
//   );
//   logger.info(`addAdmin(newRing, thr=${newThreshold}) nonce=${nextNonce} actionHash=${hex(actionHash)}`);
//
//   await castApprovals(actionHash, APPROVER_INDICES, 'addAdmin');
//
//   // v6.2 signature: executeAddAdmin(newAdmin, newThreshold)
//   const exec = await deployed.callTx.executeAddAdmin(newRingPk, newThreshold);
//
//   const cntAfter = Number(unwrap(await deployed.callTx.getAdminCount()));   // expect 6
//   const thrAfter = Number(unwrap(await deployed.callTx.getThreshold()));    // expect 4
//   assert(cntAfter === currentSize + 1 && thrAfter === newThreshold);
//   nonce = nextNonce;
//
// REMOVE step (mirror):
//   const newThresholdR = minMajorityThreshold(currentSize - 1);
//   assertValidRemove(currentSize, oldThreshold, newThresholdR);
//   const ahR = computeAdminSetActionHash(V62_OP.removeAdmin, removedPk, newThresholdR, nextNonceR);
//   ... approvals ...
//   await deployed.callTx.executeRemoveAdmin(removedPk, newThresholdR);
//
// KEY DIFFERENCES FROM v6 (for the reviewer):
//   1. op tags  "v6:addAdmin"   -> "v6.2:addAdmin"   (etc.)
//   2. hash      3-field         -> 4-field (threshold inserted before nonce)
//   3. callTx    executeAddAdmin(pk) -> executeAddAdmin(pk, newThreshold)
//   4. pre-flight assertValidAdd/Remove so the runner never proposes a tx the
//      contract's strict-majority guard would reject.
//
// =============================================================================

void witnesses;
void EXPECTED_V62_ADDR;
void APPROVER_INDICES;
void NEW_RING_PK_HEX;
void findDeployedContract;
void fs; void path; void fileURLToPath;
void V62_OP; void computeAdminSetActionHash; void assertValidAdd; void assertValidRemove; void minMajorityThreshold;
