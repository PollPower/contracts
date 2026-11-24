// The v9 settle signing flow, as production runs it (option 3, 2026-11-24):
//   1. the HAT chip signs chipDigest(...) with its Ed25519 key (on chip);
//   2. meter-authority-service checks that signature and its sanity rules,
//      then signs hatMessage(self, chipDigest, chipPubkey, chipSigR, chipSigS)
//      with the Jubjub meter-authority key;
//   3. settle carries the chip fields; the circuit verifies the Jubjub
//      signature and emits the chip key + signature for audit.
// The contract does not verify the Ed25519 chip signature (ledger 9 has no
// Ed25519 verifier); it binds it, so the audit record cannot be swapped.
import { ed25519 } from '@noble/curves/ed25519.js';
import { signMessage } from './machine-signer.mjs';

export function newChipKey() {
  const sk = ed25519.utils.randomSecretKey();
  return { sk, pk: ed25519.getPublicKey(sk) };
}

/**
 * Builds the chip and HAT signatures for a settle.
 * @param f { sessionID, amount, producerKey, producerAddr, meterKeyHash, meterTime, meterCounter }
 * @param opts.chip chip key; opts.hatSk Jubjub meter-authority key; opts.addressBytes override
 * @returns { chipDigest, chipPubkey, chipSigR, chipSigS, hatSig }
 */
export function signSettle(mod, target, f, { chip, hatSk, addressBytes }) {
  const self = addressBytes ?? target.addressBytes;
  const chipDigest = mod.pureCircuits.chipDigest(self, f.sessionID, f.amount, f.producerKey, f.producerAddr,
    f.meterKeyHash, f.meterTime, f.meterCounter);
  const chipSig = ed25519.sign(chipDigest, chip.sk);
  const chipSigR = chipSig.slice(0, 32);
  const chipSigS = chipSig.slice(32, 64);
  const msg = mod.pureCircuits.hatMessage(self, chipDigest, chip.pk, chipSigR, chipSigS);
  return { chipDigest, chipPubkey: chip.pk, chipSigR, chipSigS, hatSig: signMessage(msg, hatSk) };
}

/** settle's argument list up to and including hatSig. */
export const settleHatArgs = (f, s) => [
  f.sessionID, f.amount, f.producerKey, f.producerAddr, f.meterKeyHash,
  f.meterTime, f.meterCounter, s.chipPubkey, s.chipSigR, s.chipSigS, s.hatSig,
];
