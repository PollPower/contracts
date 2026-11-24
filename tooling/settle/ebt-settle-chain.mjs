// @ts-check
// EBT settle chain adapter (WI-16 step 4). pp-settle-service stays free of
// Midnight dependencies: it is handed this adapter, which runs where the
// contracts checkout (and its node_modules) lives.
//
//   const chain = await createEbtSettleChain({ providers, ebtBuildDir, ebtAddress });
//   await chain.settle({ fields, chip, tariff })   // plan from live mirrors, submit with retry
//   await chain.alreadySettled(sessionId32)
//
// fields / chip / tariff use the wire forms pp-settle-service holds (hex
// strings, decimal strings, hatSig as meter-authority-service returns it).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { planSettleArgs } from './settle-plan.mjs';
import { submitSettleWithRetry } from './submit-settle.mjs';

const HEX32 = /^[0-9a-fA-F]{64}$/;
const b = (/** @type {string} */ s, /** @type {string} */ name) => {
  if (!HEX32.test(String(s))) throw new Error(`${name} must be 64-hex`);
  return new Uint8Array(Buffer.from(s, 'hex'));
};

/** pp-settle-service's prepared fields (hex / decimal strings) -> settle's typed fields. */
export function typedFields(/** @type {any} */ f) {
  return {
    sessionID: b(f.sessionId, 'sessionId'), amount: BigInt(f.amount), producerKey: b(f.producerKey, 'producerKey'),
    producerAddr: { bytes: b(f.producerAddr, 'producerAddr') }, meterKeyHash: b(f.meterKeyHash, 'meterKeyHash'),
    chipHwId: b(f.chipHwId, 'chipHwId'), chipSessionUwh: BigInt(f.chipSessionUwh),
    chipUptimeMs: BigInt(f.chipUptimeMs), chipNonce: BigInt(f.chipNonce),
  };
}

/** chip pubkey (32 B hex) + Ed25519 signature (64 B hex) + hatSig -> settle's chip arguments. */
export function typedChip(/** @type {string} */ chipPubkeyHex, /** @type {string} */ chipSigHex, /** @type {any} */ hatSig) {
  if (!/^[0-9a-fA-F]{128}$/.test(String(chipSigHex))) throw new Error('chipSig must be 128-hex');
  const sig = Buffer.from(chipSigHex, 'hex');
  return { chipPubkey: b(chipPubkeyHex, 'chipPubkey'), chipSigR: new Uint8Array(sig.subarray(0, 32)), chipSigS: new Uint8Array(sig.subarray(32)), hatSig };
}

/**
 * @param {{ providers: any, ebtBuildDir: string, ebtAddress: string, log?: { log: Function }, retry?: { attempts?: number, baseDelayMs?: number } }} o
 */
export async function createEbtSettleChain({ providers, ebtBuildDir, ebtAddress, log = console, retry = {} }) {
  const mod = await import(pathToFileURL(path.join(ebtBuildDir, 'contract', 'index.js')).href);
  const compiled = CompiledContract.make('ebt-v8', mod.Contract).pipe(CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(ebtBuildDir));
  /** @type {any} */
  let joined;
  const ebt = async () => (joined ??= await findDeployedContract(providers, /** @type {any} */ ({ compiledContract: compiled, contractAddress: ebtAddress })));
  const ledger = async () => {
    const read = await providers.publicDataProvider.queryContractState(ebtAddress);
    if (!read) throw new Error(`EBT ${ebtAddress}: no state from the indexer`);
    return mod.ledger(read.contractState.deserialize({ v9: ContractState }).data);
  };
  const alreadySettled = async (/** @type {Uint8Array} */ sessionId32) => (await ledger())._settledSessions.member(sessionId32);

  return {
    ledger,
    alreadySettled,
    /**
     * Plans settle from EBT's live mirrors and submits it with retry. Never
     * resubmits a session already on chain.
     * @param {{ fields: any, chipPubkeyHex: string, chipSigHex: string, hatSig: any,
     *           tariff: { scheduleIdHex: string, classPathHex: string, epoch: bigint|string, fiatValueAtMint: bigint|string },
     *           currentTime?: bigint }} p
     */
    async settle(p) {
      const fields = typedFields(p.fields);
      if (await alreadySettled(fields.sessionID)) return { status: 'already-settled', attempts: 0, amount: fields.amount };
      const args = planSettleArgs({
        ebtModule: mod, ledger: await ledger(), fields, chip: typedChip(p.chipPubkeyHex, p.chipSigHex, p.hatSig),
        scheduleId: b(p.tariff.scheduleIdHex, 'scheduleId'), classPath: b(p.tariff.classPathHex, 'classPath'),
        epoch: BigInt(p.tariff.epoch), fiatValueAtMint: BigInt(p.tariff.fiatValueAtMint),
        currentTime: p.currentTime ?? BigInt(Math.floor(Date.now() / 1000) - 120),
      });
      const contract = await ebt();
      const r = await submitSettleWithRetry({
        args, log, ...retry,
        submit: (a) => contract.callTx.settle(...a),
        alreadySettled: () => alreadySettled(fields.sessionID),
      });
      // Planned slices (settle args 24..27 and lane amounts at 19).
      const split = { producer: String(args[24]), ops: String(args[25]), ld: String(args[26]), dao: String(args[27]), lanes: args[19].map(String) };
      return { status: r.status, attempts: r.attempts, txHash: r.tx?.public?.txHash ?? r.tx?.public?.txId, amount: fields.amount, split };
    },
  };
}
