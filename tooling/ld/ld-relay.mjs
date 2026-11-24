// @ts-check
// Living Dividend v3 relayer (WI-16 step 4). Members sign their own actions
// on device (wallet shim, Jubjub); the relayer proves and pays for the
// transaction. It refuses anything the contract would refuse BEFORE spending a
// proof, and it cannot act for a member without that member's signature: the
// contract checks the same signature in-circuit against the member's stored
// key, and the nonce bumps on every action (no replay).
//
//   checkLdAction(...)  pure pre-check -> { circuit, args }
//   createLdRelay({ providers, ldBuildDir, ldAddress, witnesses })
//     .memberState(memberIdHex) -> LdMemberState (consumer app's shape)
//     .submit(body)             -> { txHash }
// The providers must resolve cross-contract calls into EBT (claim mints there):
// contractModuleProvider + a ZK key registry over the LD and EBT builds.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

const MSG = new RT.CompactTypeVector(1, RT.CompactTypeField);
const HEX32 = /^[0-9a-fA-F]{64}$/;
const DEC = /^[0-9]{1,20}$/;
const hexb = (/** @type {string} */ s, /** @type {string} */ name) => {
  if (!HEX32.test(String(s))) throw new Error(`${name} must be 32-byte hex`);
  return new Uint8Array(Buffer.from(s, 'hex'));
};
const dec = (/** @type {any} */ s, /** @type {string} */ name) => {
  if (!DEC.test(String(s))) throw new Error(`${name} must be a non-negative decimal integer`);
  return BigInt(s);
};
const FIELD = /^[0-9]{1,78}$/;
/** A field element (curve coordinate / signature scalar): decimal, at most 78 digits. */
const fe = (/** @type {any} */ s, /** @type {string} */ name) => {
  if (!FIELD.test(String(s))) throw new Error(`${name} must be a decimal field element`);
  return BigInt(s);
};
const pad32 = (/** @type {string} */ s) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(s)); return b; };
const eq = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) => a.length === b.length && a.every((x, i) => x === b[i]);

export const MEMBER_ACTIONS = /** @type {const} */ (['claim', 'touchLiveness', 'requestPayoutChange', 'cancelPayoutChange']);

/**
 * Pure pre-check of a member action, exactly as the circuit will check it.
 * @param {{ ldModule: any, ledger: any, ldAddress: Uint8Array, body: any, blockTime: bigint }} p
 * @returns {{ circuit: string, args: any[], memberId: Uint8Array }}
 */
export function checkLdAction({ ldModule, ledger, ldAddress, body, blockTime }) {
  const P = ldModule.pureCircuits;
  const action = String(body.action);
  if (!MEMBER_ACTIONS.includes(/** @type {any} */ (action))) throw new Error(`unsupported action: ${action}`);
  const id = hexb(body.memberIdHex, 'memberIdHex');
  const pk = { x: fe(body.pk?.x, 'pk.x'), y: fe(body.pk?.y, 'pk.y') };
  if (!eq(P.memberId(pk), id)) throw new Error('memberId does not match the signing key');
  if (!ledger._members.member(id)) throw new Error('not a member of this Living Dividend');
  const m = ledger._members.lookup(id);
  if (!m.isLive) throw new Error('member is not live');
  if (m.pk.x !== pk.x || m.pk.y !== pk.y) throw new Error('signing key is not the registered member key');
  const t = dec(body.currentTime, 'currentTime');
  if (t > blockTime) throw new Error('currentTime is ahead of block time');
  const sig = {
    announcement: { x: fe(body.signature?.announcement?.x, 'signature.announcement.x'), y: fe(body.signature?.announcement?.y, 'signature.announcement.y') },
    response: fe(body.signature?.response, 'signature.response'),
  };
  let digest; let args;
  if (action === 'requestPayoutChange') {
    const np = { bytes: hexb(body.newPayoutHex, 'newPayoutHex') };
    if (eq(np.bytes, m.payout.bytes)) throw new Error('newPayoutHex is already the payout address');
    digest = P.payoutDigest(np, t);
    args = [id, np, t, sig];
  } else {
    if (body.newPayoutHex !== undefined) throw new Error('newPayoutHex is only for requestPayoutChange');
    if (action === 'cancelPayoutChange' && !ledger._pendingPayouts.member(id)) throw new Error('no pending payout change');
    digest = P.timeDigest(t);
    args = [id, t, sig];
  }
  const msg = P.memberMessage(ldAddress, pad32(action), id, digest, m.nonce);
  if (!RT.jubjubSchnorrVerify(MSG, [msg], m.pk, sig)) throw new Error('signature does not verify for this member, action, arguments and nonce');
  return { circuit: action, args, memberId: id };
}

/**
 * @param {{ providers: any, ldBuildDir: string, ldAddress: string, indexerUrl: string, witnesses?: any, log?: any }} o
 */
export async function createLdRelay({ providers, ldBuildDir, ldAddress, indexerUrl, witnesses, log = console }) {
  if (!indexerUrl) throw new Error('indexerUrl is required (latest block time)');
  const mod = await import(pathToFileURL(path.join(ldBuildDir, 'contract', 'index.js')).href);
  const w = witnesses ?? { witness_divmod: (/** @type {any} */ ctx, /** @type {bigint} */ n, /** @type {bigint} */ d) => [ctx.privateState, { quotient: n / d, remainder: n % d }] };
  const compiled = CompiledContract.make('living-dividend-v3', mod.Contract).pipe(CompiledContract.withWitnesses(w), CompiledContract.withCompiledFileAssets(ldBuildDir));
  /** @type {any} */ let joined;
  const ld = async () => (joined ??= await findDeployedContract(providers, /** @type {any} */ ({ compiledContract: compiled, contractAddress: ldAddress })));
  const ldBytes = hexb(ldAddress, 'ldAddress');
  const ledger = async () => {
    const read = await providers.publicDataProvider.queryContractState(ldAddress);
    if (!read) throw new Error(`LD ${ldAddress}: no state from the indexer`);
    return mod.ledger(read.contractState.deserialize({ v9: RT.ContractState }).data);
  };
  // Latest block time in seconds (the indexer's BlockInfo has no timestamp;
  // its GraphQL `block { timestamp }` is in milliseconds).
  const blockTime = async () => {
    const res = await fetch(indexerUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ block { height timestamp } }' }) });
    const j = await res.json();
    const ms = j?.data?.block?.timestamp;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) throw new Error('indexer returned no block timestamp');
    return BigInt(Math.floor(ms / 1000));
  };
  let queue = Promise.resolve();   // one relayed tx at a time (one fee wallet)

  return {
    /** memberId(pk) from the contract's own pure circuit (enrolment). */
    memberIdOf(/** @type {any} */ pk) {
      const k = { x: fe(pk?.x, 'pk.x'), y: fe(pk?.y, 'pk.y') };
      return { memberIdHex: Buffer.from(mod.pureCircuits.memberId(k)).toString('hex') };
    },
    async memberState(/** @type {string} */ memberIdHex) {
      const id = hexb(memberIdHex, 'memberIdHex');
      const L = await ledger();
      const base = { ldAddressHex: ldAddress.toLowerCase(), memberIdHex: memberIdHex.toLowerCase(), blockTime: String(await blockTime()) };
      if (!L._members.member(id)) return { ...base, registered: false, live: false, nonce: '0', payoutHex: '', pendingPayout: null };
      const m = L._members.lookup(id);
      const pp = L._pendingPayouts.member(id) ? L._pendingPayouts.lookup(id) : null;
      return {
        ...base, registered: true, live: m.isLive, nonce: String(m.nonce), payoutHex: Buffer.from(m.payout.bytes).toString('hex'),
        pendingPayout: pp ? { payoutHex: Buffer.from(pp.payout.bytes).toString('hex'), effectiveAt: String(pp.effectiveAt) } : null,
      };
    },
    async submit(/** @type {any} */ body) {
      const run = async () => {
        const { circuit, args } = checkLdAction({ ldModule: mod, ledger: await ledger(), ldAddress: ldBytes, body, blockTime: await blockTime() });
        const t0 = Date.now();
        const r = await (await ld()).callTx[circuit](...args);
        const txHash = r?.public?.txHash ?? r?.public?.txId;
        log.log(`[ld-relay] ${circuit} for ${String(body.memberIdHex).slice(0, 12)}... in ${((Date.now() - t0) / 1000).toFixed(0)}s (tx ${txHash})`);
        return { txHash: String(txHash) };
      };
      const p = queue.then(run, run);
      queue = p.then(() => undefined, () => undefined);
      return p;
    },
  };
}
