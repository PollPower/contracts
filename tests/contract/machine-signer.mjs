// Off-chain machine signer for WI16-C-1c (meter authority HAT, escrow
// attestor, schedule validator and operators). The message is always the
// Field returned by one of the contract's exported pure circuits
// (hatMessage, escrowMessage, reissueMessage, signerMessage), so the signer
// cannot drift from the circuit; compact-runtime's Jubjub Schnorr signs it.
import * as RT from '@midnight-ntwrk/compact-runtime';

const MSG_TYPE = new RT.CompactTypeVector(1, RT.CompactTypeField);

export function newMachineKey() {
  const sk = RT.jubjubSampleScalar();
  return { sk, pk: RT.jubjubSchnorrVerifyingKey(sk) };
}

export const signMessage = (msg, sk) => RT.jubjubSchnorrSign(MSG_TYPE, [msg], sk);
