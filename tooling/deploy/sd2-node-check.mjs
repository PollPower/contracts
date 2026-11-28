// @ts-check
// SD-2 at the node (Preprod gate G9): during the staged-deploy window, a raw
// transaction calling a circuit whose verifier key is NOT inserted yet must be
// rejected by the NODE, with the contract state unchanged. The devnet pass's
// SD-2 is refused client-side (Midnight.js's contract-type check, and
// Midnight.js builds a call only from an operation present in the on-chain
// state). This check plays a client that LIES about the state: its public
// data provider adds the circuit's operation, with the full build's verifier
// key, to the state it reads for that one contract. Midnight.js then builds
// the call (createUnprovenCallTx), our proof server proves it with the full
// build's proving key, and submitTx sends it. Only the node, checking against
// the real on-chain state, can refuse it. Devnet dry run only.
//
// The contract is a fresh staged EBT (ceremony build), deployed for this check
// and abandoned unfinalized (devnet only; never finalized later).
import fs from 'node:fs';
import path from 'node:path';
import { createUnprovenCallTx, submitTx } from '@midnight-ntwrk/midnight-js-contracts';
import { SerializedContractState } from '@midnight-ntwrk/midnight-js-types';
import { ContractState, ContractOperation } from '@midnight-ntwrk/compact-runtime';
import { deploy, compiled, liveState, buildDir } from './network.mjs';

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

/**
 * A public data provider that lies about one contract: every state it reads
 * for `address` also carries `circuit` with `verifierKey` (what an attacker's
 * client would do to build a call the chain has no key for).
 */
export function lyingProvider(/** @type {any} */ pdp, /** @type {string} */ address, /** @type {string} */ circuit, /** @type {Uint8Array} */ verifierKey) {
  const norm = (/** @type {any} */ a) => String(a).replace(/^0x/, '').toLowerCase();
  const target = norm(address);
  const forge = (/** @type {any} */ v) => {
    if (SerializedContractState.isSerializedContractState(v)) {
      const st = ContractState.deserialize(v.serialize());
      const op = new ContractOperation();
      op.verifierKey = verifierKey;
      st.setOperation(circuit, op);
      return SerializedContractState.fromBytes(/** @type {any} */ (v).era, st.serialize());
    }
    if (Array.isArray(v)) return v.map(forge);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, forge(x)]));
    return v;
  };
  return new Proxy(pdp, {
    get(t, k) {
      const f = t[k];
      if (typeof f !== 'function') return f;
      if (k === 'queryContractState' || k === 'queryZSwapAndContractState' || k === 'queryDeployContractState') {
        return async (/** @type {any} */ a, /** @type {any[]} */ ...rest) => { const res = await f.call(t, a, ...rest); return norm(a) === target ? forge(res) : res; };
      }
      return f.bind(t);
    },
  });
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
  if (!rec.council || !rec.tr || !rec.ebtFinal) throw new Error('SD-2 node check: council, TariffRegistry and the finalized EBT first (the control call needs it)');
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
  const real = /** @type {any} */ (dn.providersFor('ebt-v8'));
  const vk = new Uint8Array(fs.readFileSync(path.join(buildDir('ebt-v8'), 'keys', `${SD2_CIRCUIT}.verifier`)));
  const providers = { ...real, publicDataProvider: lyingProvider(real.publicDataProvider, rec.sd2Ebt, SD2_CIRCUIT, vk) };
  const full = await compiled('ebt-v8');
  const rawCall = async (/** @type {any} */ prov, /** @type {string} */ address) => {
    const call = await createUnprovenCallTx(prov, /** @type {any} */ ({ compiledContract: full, circuitId: SD2_CIRCUIT, contractAddress: address }));
    await submitTx(prov, /** @type {any} */ ({ unprovenTx: call.private.unprovenTx, circuitId: SD2_CIRCUIT }));
  };
  // Control: the same built-and-proven call on the finalized EBT, where the key
  // exists, must be ACCEPTED, so a rejection below is the missing key, not the path.
  let control;
  try {
    await rawCall({ ...real, publicDataProvider: lyingProvider(real.publicDataProvider, rec.ebt, SD2_CIRCUIT, vk) }, rec.ebt);
    control = { accepted: true };
  } catch (e) {
    control = { accepted: false, error: errorText(e).slice(0, 300) };
  }
  log.log(`[sd2-node] control: the same raw ${SD2_CIRCUIT} call on the finalized EBT (key present): ${control.accepted ? 'accepted' : 'REFUSED (the check cannot conclude)'}`);
  let outcome;
  try {
    await rawCall(providers, rec.sd2Ebt);
    outcome = { accepted: true };
  } catch (e) {
    outcome = { accepted: false, nodeRejected: isNodeRejection(e), error: errorText(e).slice(0, 300) };
  }
  const after = await liveState(dn, 'ebt-v8', rec.sd2Ebt);
  const unchanged = Buffer.from(before.serialize()).equals(Buffer.from(after.serialize()));
  const ok = control.accepted && !outcome.accepted && outcome.nodeRejected && unchanged;
  rec.sd2Node = { contract: rec.sd2Ebt, circuit: SD2_CIRCUIT, opsBefore: opsBefore.length, control, ...outcome, stateUnchanged: unchanged, ok, abandoned: true };
  save();
  log.log(`[sd2-node] raw ${SD2_CIRCUIT} call on the staged EBT (${opsBefore.length} keys inserted, not this one): ${outcome.accepted ? 'ACCEPTED (FAIL)' : outcome.nodeRejected ? 'rejected by the node' : 'refused, but not by the node'}; state ${unchanged ? 'unchanged' : 'CHANGED'}`);
  if (!ok) throw new Error(`SD-2 node check FAILED: ${JSON.stringify(rec.sd2Node)}`);
  return rec.sd2Node;
}
