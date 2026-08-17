// gen-mock-multisig.mjs — generate 4 MOCK/TEST-ONLY Ed25519 ring keys and
// compute the LD `multisigAuthority` (Bytes<32>) the deploy constructor stores.
//
// ============================================================================
//  *** MOCK / TEST-ONLY.  NOT A PRODUCTION MULTISIG AUTHORITY. ***
//  These keys are randomly generated here and printed/saved in the clear so
//  the parent can smoke-test LD register/unregister/rotateAuth on Preview.
//  DO NOT use this authority for anything holding real value.
// ============================================================================
//
// AUTHORITY-HASH CONSTRUCTION — must match what the contract verifies.
// The on-chain ring-membership check lives OFF-CHAIN in the witness
// `witness_multisigSignatureValid` -> verifyMultisigBundle() in
// living-dividend/witnesses.ts. That function computes (verbatim):
//
//     const sorted = [...bundle.signers].sort(compareUint8);   // byte-lex sort
//     const concat = new Uint8Array(sorted.length * 32);
//     for (i) concat.set(sorted[i], i*32);                      // 32B each, concatenated
//     const computed = sha256(concat);                          // @noble/hashes sha256
//     if (!bytesEq(computed, authorityHash)) return false;      // ring membership
//
// So:  multisigAuthority = SHA-256( concat( pubkeys sorted byte-lexicographically ) )
// where each pubkey is a raw 32-byte Ed25519 public key.
//
// (Citation: witnesses.ts, verifyMultisigBundle, lines ~140-160 —
//  "Ring membership check: SHA-256 of sorted, concatenated signer pubkeys.")
//
// The contract constructor just stores this value: `_multisigAuthority =
// disclose(multisigAuthority)`. No verification happens at deploy; the hash is
// only checked later when a multisig-gated circuit (register/unregister/
// setMultisigAuthority) runs and the witness re-derives it from the bundle.

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// @noble/ed25519 v3 needs a sync sha512 wired in (same as witnesses.ts).
ed.hashes.sha512 = sha512;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_JSON = path.join(__dirname, 'mock-multisig-keys.json');

const RING_SIZE = 4;
const THRESHOLD = 3; // 3-of-4 (informational; not part of the authority hash)

function toHex(u8) { return Buffer.from(u8).toString('hex'); }

// Same byte-lexicographic comparator witnesses.ts uses.
function compareUint8(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function computeAuthorityHash(pubkeys) {
  const sorted = [...pubkeys].sort(compareUint8);
  const concat = new Uint8Array(sorted.length * 32);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].length !== 32) throw new Error(`pubkey ${i} not 32 bytes`);
    concat.set(sorted[i], i * 32);
  }
  return sha256(concat);
}

async function main() {
  const keys = [];
  for (let i = 0; i < RING_SIZE; i++) {
    const priv = ed.utils.randomSecretKey ? ed.utils.randomSecretKey() : ed.utils.randomPrivateKey();
    const pub = await ed.getPublicAsync
      ? await ed.getPublicKeyAsync(priv)
      : ed.getPublicKey(priv);
    keys.push({
      index: i,
      label: `MOCK-ring-signer-${i}`,
      privHex: toHex(priv),
      pubHex: toHex(pub),
      pub, // keep bytes for hashing
    });
  }

  const pubkeys = keys.map((k) => k.pub);
  const authorityHash = computeAuthorityHash(pubkeys);
  const authorityHex = toHex(authorityHash);

  // Show the sorted order used (so parent can reproduce).
  const sortedPubHex = [...pubkeys].sort(compareUint8).map(toHex);

  const record = {
    _WARNING: 'MOCK / TEST-ONLY. NOT A PRODUCTION MULTISIG AUTHORITY. Keys are in the clear.',
    generatedAt: new Date().toISOString(),
    scheme: 'Ed25519 ring; multisigAuthority = SHA-256(concat(pubkeys sorted byte-lexicographically))',
    citation: 'living-dividend/witnesses.ts verifyMultisigBundle (ring membership: SHA-256 of sorted concatenated 32B pubkeys)',
    ringSize: RING_SIZE,
    threshold: THRESHOLD,
    signers: keys.map((k) => ({ index: k.index, label: k.label, privHex: k.privHex, pubHex: k.pubHex })),
    sortedPubkeyOrderHex: sortedPubHex,
    multisigAuthorityHex: authorityHex,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(record, null, 2));

  console.log('--- MOCK multisig ring (TEST-ONLY) ---');
  keys.forEach((k) => console.log(`  signer[${k.index}] pub: ${k.pubHex}`));
  console.log('');
  console.log('sorted pubkey order (byte-lex):');
  sortedPubHex.forEach((h, i) => console.log(`  [${i}] ${h}`));
  console.log('');
  console.log(`construction     : SHA-256( concat( sorted 32B pubkeys ) )`);
  console.log(`multisigAuthority: ${authorityHex}`);
  console.log(`saved keys       : ${OUT_JSON}`);
  console.log(`MULTISIG_AUTHORITY_HEX=${authorityHex}`);
}

main().catch((e) => {
  console.error('FATAL:', e?.stack || e?.message || e);
  process.exit(1);
});
