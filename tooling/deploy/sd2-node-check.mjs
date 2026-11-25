// @ts-check
// SD-2 at the node (Preprod gate G9): during the staged-deploy window, a raw
// transaction calling a circuit whose verifier key is NOT inserted yet must be
// rejected by the NODE, with the contract state unchanged. The devnet pass's
// SD-2 is refused client-side (Midnight.js's contract-type check); this one
// bypasses that check: it builds the call with createUnprovenCallTx against
// the FULL build (which has the circuit and its proving key), proves it with
// our proof server and submits it with submitTx. Devnet dry run only.
//
// The contract is a fresh staged EBT (ceremony build), deployed for this check
// and abandoned unfinalized (devnet only; never finalized later).
import { createUnprovenCallTx, submitTx } from '@midnight-ntwrk/midnight-js-contracts';
import { deploy, compiled, liveState } from './network.mjs';

// A witness-free view circuit of the full EBT that is not in the ceremony set:
// it runs locally without preconditions, so only the missing key can stop it.
export const SD2_CIRCUIT = 'getRegistryActionLogHeadSeq';

const hex = (/** @type {string} */ h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

/** Text of an error and its causes. */
export const errorText = (/** @type {any} */ e) => {
  const parts = [];
  for (let x = e, i = 0; x && i < 6; x = x.cause, i++) parts.push(String(x?.message ?? x), String(x?.name ?? ''));
  return parts.join(' | ');
};

/** True when the failure is the node refusing the submission (not a client-side check). */
export function isNodeRejection(/** @type {any} */ e) {
  const t = errorText(e);
  if (/not the expected contract type|ContractTypeError|VerifierKeyMismatch/i.test(t)) return false;   // client-side
  return /submitTx rejected|Invalid Transaction|1010|SubmitRejection|rejected the transaction/i.test(t);
}

/** Operation names present in a deployed contract state. */
export function operationNames(/** @type {any} */ state) {
  return state.operations().map((/** @type {string | Uint8Array} */ o) => (typeof o === 'string' ? o : Buffer.from(o).toString('hex')));
}

/**
 * @param {{ dn: any, rec: any, save: () => void, ebtInputs: any, log?: any }} o
 */
export async function sd2AtNode({ dn, rec, save, ebtInputs, log = console }) {
  if (dn.net.networkId !== 'undeployed') throw new Error('SD-2 node check: local devnet only');
  if (!rec.council || !rec.tr) throw new Error('SD-2 node check: council and TariffRegistry first');
  if (!rec.sd2Ebt) {
    const { address } = await deploy(dn, 'ebt-v8-ceremony', [
      ebtInputs.ownerPk, ebtInputs.meterAuthorityPk, { bytes: hex(rec.council) },
      { bytes: hex(ebtInputs.operationsRecipient) }, { bytes: hex(ebtInputs.daoRecipient) }, ebtInputs.escrowAttestorPk,
      { bytes: hex(rec.tr) },
    ]);
    rec.sd2Ebt = address;
    save();
  }
  const before = await liveState(dn, 'ebt-v8', rec.sd2Ebt);
  const opsBefore = operationNames(before);
  if (opsBefore.includes(SD2_CIRCUIT)) throw new Error(`SD-2 node check: ${SD2_CIRCUIT} already has a key on ${rec.sd2Ebt}; deploy a fresh staged EBT`);
  const providers = /** @type {any} */ (dn.providersFor('ebt-v8'));
  const full = await compiled('ebt-v8');
  let outcome;
  try {
    const call = await createUnprovenCallTx(providers, /** @type {any} */ ({ compiledContract: full, circuitId: SD2_CIRCUIT, contractAddress: rec.sd2Ebt }));
    await submitTx(providers, /** @type {any} */ ({ unprovenTx: call.private.unprovenTx, circuitId: SD2_CIRCUIT }));
    outcome = { accepted: true };
  } catch (e) {
    outcome = { accepted: false, nodeRejected: isNodeRejection(e), error: errorText(e).slice(0, 300) };
  }
  const after = await liveState(dn, 'ebt-v8', rec.sd2Ebt);
  const unchanged = Buffer.from(before.serialize()).equals(Buffer.from(after.serialize()));
  const ok = !outcome.accepted && outcome.nodeRejected && unchanged;
  rec.sd2Node = { contract: rec.sd2Ebt, circuit: SD2_CIRCUIT, opsBefore: opsBefore.length, ...outcome, stateUnchanged: unchanged, ok, abandoned: true };
  save();
  log.log(`[sd2-node] raw ${SD2_CIRCUIT} call on the staged EBT (${opsBefore.length} keys inserted, not this one): ${outcome.accepted ? 'ACCEPTED (FAIL)' : outcome.nodeRejected ? 'rejected by the node' : 'refused, but not by the node'}; state ${unchanged ? 'unchanged' : 'CHANGED'}`);
  if (!ok) throw new Error(`SD-2 node check FAILED: ${JSON.stringify(rec.sd2Node)}`);
  return rec.sd2Node;
}
