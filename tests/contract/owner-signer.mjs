// Off-chain owner signer for EBT (WI16-C-2), exactly as the real tooling will
// do it: the argument digest and the message come from the contract's own
// exported pure circuits, then compact-runtime's Jubjub Schnorr signer signs.
import * as RT from '@midnight-ntwrk/compact-runtime';
import { padTag } from '../parity/harness.mjs';

const MSG_TYPE = new RT.CompactTypeVector(1, RT.CompactTypeField);

export function newOwnerKey() {
  const sk = RT.jubjubSampleScalar();
  return { sk, pk: RT.jubjubSchnorrVerifyingKey(sk) };
}

/**
 * Signs an owner action.
 * @param mod compiled EBT module (needs pureCircuits.ownerActionMessage + ownerDigest_<circuit>)
 * @param c   deployed harness handle (address bytes + ledger for the nonce)
 * @param circuit owner-gated circuit name
 * @param digestArgs arguments passed to pureCircuits[`ownerDigest_${circuit}`]
 * @param opts.sk signing key; opts.addressBytes / opts.nonce override (for negative tests)
 */
export function signOwnerAction(mod, c, circuit, digestArgs, { sk, addressBytes, nonce } = {}) {
  const digest = mod.pureCircuits[`ownerDigest_${circuit}`](...digestArgs);
  const msg = mod.pureCircuits.ownerActionMessage(
    addressBytes ?? c.addressBytes, padTag(circuit), digest, nonce ?? c.ledger()._ownerNonce,
  );
  return RT.jubjubSchnorrSign(MSG_TYPE, [msg], sk);
}

/** A well-formed signature by nobody (the PoC's "forged" input). */
export function garbageSignature() {
  return { announcement: RT.jubjubSchnorrVerifyingKey(1n), response: 12345n };
}
