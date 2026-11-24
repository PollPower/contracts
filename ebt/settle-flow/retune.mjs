// EBT v8 settle-flow — STEP A: emit retuneClass (kind 2) on the pilot monolith
// registry 556fe46f. Advances _actionSeq 5->6 and populates _classEntries.
// Coherent split: statutoryTotalBps=1785 (matches the enumerated statutory lane),
// producer 4643 / ops 2000 / ld 1572 / dao 0 / operatorMargin 0 = 10000.
//
// Run as plain .mjs under node from this workspace (repo-root node_modules,
// ledger 9 package set). OWNER_SEED env = deploy seed (submitter/DUST).
// Operator sig uses the PEM at OPERATOR_PEM (schedule.operatorPubkey).
// WI-16: network, REGISTRY_ADDRESS, REGISTRY_BUILD_DIR and the private-state
// password come from the environment via ./env.mjs. The retuneClass call
// targets the CURRENT registry interface and changes with the WI16-C-1 fix.
import { WebSocket } from 'ws'; globalThis.WebSocket = WebSocket;
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import * as Rx from 'rxjs';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import {
  CompactTypeBytes, CompactTypeVector, persistentHash,
} from '@midnight-ntwrk/compact-runtime';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
(ed).hashes.sha512 = sha512;
import { REG_BUILD, contractAddress, ownerProviders } from './env.mjs';

const REG = contractAddress('REGISTRY_ADDRESS');
const OPERATOR_PEM = (process.env.OPERATOR_PEM ?? '').trim();
if (!OPERATOR_PEM) throw new Error('OPERATOR_PEM must point at the schedule operator signing key (PEM)');

const SCHEDULE_ID = '0a0ca2e41632da85802a34207c58883f54cc2a1375ca77887c7b8dc682df101a';
// classPath — free choice, must match mirror+settle. Use a documented tag.
const CLASS_PATH = 'c1a55a7400000000000000000000000000000000000000000000000000000001'; // "class-a" pilot classPath

const hx = (s) => new Uint8Array(Buffer.from(String(s).replace(/^0x/, ''), 'hex'));
const hx32 = (s) => { const u = hx(s); if (u.length !== 32) throw new Error(`expected 32-byte hex, got ${u.length}`); return u; };
const toHex = (u) => Buffer.from(u).toString('hex');
const B32 = new CompactTypeBytes(32);

// Coherent split (sum 10000). statutoryTotalBps=1785 == statutory lane's bps.
const SPLIT = {
  producerShareBps:  4643n,
  ldShareBps:        1572n,
  opsShareBps:       2000n,
  daoShareBps:       0n,
  operatorMarginBps: 0n,
  statutoryTotalBps: 1785n,
};
const RATE = 28n;                 // in-band (refRate 28 ± 20%)
const NONCE = 1n;                 // first retune
// checkedDivide(refRate*bandBps, 10000) = checkedDivide(28*2000, 10000)=56000/10000
const DIV = { quotient: 5n, remainder: 6000n };

function fieldBytes32(v) {
  // (Uint as Field) as Bytes<32> — canonical little? Registry helper uses
  // convertFieldToBytes via compiler; but for OUR-side we only need to build
  // sig message identically to the circuit's retuneAuthHash. We rely on the
  // runtime to build the in-circuit hash; the operator sig is over retuneAuthHash
  // which the runtime discloses to the witness. So we DON'T precompute it here —
  // we sign inside the witness using the messageHash handed to us. (see below)
  throw new Error('unused');
}

async function main() {
  // Operator signing key (ed25519 PEM). We sign the messageHash the runtime hands
  // to the signature_valid witness — that IS retuneAuthHash. So the witness both
  // signs AND returns true, and the on-chain assert(signature_valid(...)) holds.
  const operatorKey = createPrivateKey(fs.readFileSync(OPERATOR_PEM, 'utf8'));

  // WI-16: wallet SDK 2 + Midnight.js 5 providers from the shared tooling.
  const { providers } = await ownerProviders(REG_BUILD, 'reg-retune-ceremony');

  // Witnesses for the registry contract.
  const witnesses = {
    signature_valid: (ctx, _pubkey, messageHash, _signature) => {
      // Sign the exact messageHash the circuit built (retuneAuthHash). The
      // operator sig arg passed in is ignored by our witness; we produce a real
      // ed25519 sig over messageHash and verify it => true.
      const sig = new Uint8Array(nodeSign(null, Buffer.from(messageHash), operatorKey));
      let ok = false; try { ok = ed.verify(sig, messageHash, _pubkey); } catch {}
      console.log('[witness] signature_valid msgHash=', toHex(messageHash), 'ok=', ok);
      return [ctx.privateState ?? ctx, ok];
    },
    multisig_signature_valid: (ctx, _payload, _authorityHash) => [ctx.privateState ?? ctx, false],
    charter_membership_proof: (ctx, _nodeId) => [ctx.privateState ?? ctx, {
      siblings: Array.from({ length: 12 }, () => new Uint8Array(32)),
      indices: Array.from({ length: 12 }, () => false),
    }],
    action_log_path_bits: (ctx, seq) => {
      const bits = []; let x = BigInt(seq);
      for (let i = 0; i < 24; i++) { bits.push((x & 1n) === 1n); x >>= 1n; }
      return [ctx.privateState ?? ctx, bits];
    },
  };
  const regModule = await import(pathToFileURL(path.join(REG_BUILD, 'contract', 'index.js')).href);
  const compiled = CompiledContract.make('tariff-registry', regModule.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(REG_BUILD),
  );
  const contract = await findDeployedContract(providers, {
    contractAddress: REG, compiledContract: compiled,
    privateStateId: 'reg-retune-ceremony', initialPrivateState: {},
  });

  const scheduleId = hx32(SCHEDULE_ID);
  const classPath = hx32(CLASS_PATH);
  const operatorId = hx32('3e64530c332524b85a8d4c53e2699392da6dc31a4080c5a2f1655261179ca6af');
  const operatorSignature = new Uint8Array(64); // ignored by our witness
  const currentTime = BigInt(Math.floor(Date.now() / 1000));

  console.log('=== retuneClass args ===');
  console.log('scheduleId :', SCHEDULE_ID);
  console.log('classPath  :', CLASS_PATH);
  console.log('split      :', JSON.stringify(SPLIT, (k,v)=>typeof v==='bigint'?String(v):v));
  console.log('rate       :', String(RATE), 'nonce:', String(NONCE), 'time:', String(currentTime));
  console.log('div        :', JSON.stringify(DIV,(k,v)=>String(v)));

  console.log('submitting retuneClass...');
  const tx = await contract.callTx.retuneClass(
    scheduleId, classPath, SPLIT, RATE, operatorId, operatorSignature, NONCE, currentTime, DIV, DIV);
  const txHash = tx?.public?.txHash ?? tx?.public?.txId ?? tx?.txHash ?? tx?.txId ?? 'unknown';
  console.log('RETUNE_CLASS SUBMITTED. txHash:', txHash);
  process.exit(0);
}
main().catch((e) => {
  console.error('FATAL:', e?.message || String(e));
  let cur = e;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur.cause) { console.error(`  cause[${i}]:`, cur.cause?.message || String(cur.cause)); cur = cur.cause; }
    else break;
  }
  console.error('STACK:', e?.stack);
  // dump own enumerable props
  try { console.error('PROPS:', JSON.stringify(e, Object.getOwnPropertyNames(e).filter(k=>k!=='stack'))); } catch {}
  process.exit(1);
});
