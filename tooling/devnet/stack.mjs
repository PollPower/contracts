// @ts-check
// WI-16 step 4: the whole stack on the LOCAL devnet, stage by stage (resumable;
// state in build/devnet/state.json). LOCAL DEVNET ONLY.
//
//   node tooling/devnet/stack.mjs <stage> [<stage> ...]   or   all
//
// Stages (in order):
//   council   deploy Multisig v8 (2-of-3 software test keys), one on-chain approve
//   ...       (TariffRegistry, EBT staged deploy, LD v3, settle, claim, checks:
//             added as the run proceeds)
//
// The council keys are devnet-only software stand-ins for the Tangem rings,
// derived from fixed public labels and marked (x starts 0xDE7E): the council
// constructor builder refuses them on any network but the local devnet
// (tooling/council/council-keys-guard.mjs). The real ring keys go into the
// constructor at the Preprod ceremony.
import { createHash } from 'node:crypto';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { openDevnet, deploy, join, loadModule, insertMissingVks, state } from './devnet-lib.mjs';
import { devnetCouncilKey, buildCouncilConstructorArgs } from '../council/council-keys-guard.mjs';
import { signDigest } from '../../tests/contract/council-signer.mjs';
import { signMessage } from '../../tests/contract/machine-signer.mjs';
import { runtimePersistentHash, padTag } from '../../tests/parity/harness.mjs';

const big = (/** @type {Uint8Array} */ b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const label = (/** @type {string} */ s) => new Uint8Array(createHash('sha256').update(`pollpower wi16 devnet ${s} (test key, not a secret)`).digest());
// Devnet council keys: marked (x starts 0xDE7E) and hard-blocked off-devnet.
const COUNCIL = [0, 1, 2].map(devnetCouncilKey);
const hexToBytes = (/** @type {string} */ h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

/** Devnet-only Jubjub key from a public label. */
const jubjub = (/** @type {string} */ s) => {
  const sk = RT.convertNumericToJubjubScalar(big(label(s)));
  return { sk, pk: RT.jubjubSchnorrVerifyingKey(sk) };
};
const VALIDATOR = jubjub('tariff validator');
const OPERATOR = jubjub('schedule operator');
const nowSec = () => BigInt(Math.floor(Date.now() / 1000) - 120);   // safely not ahead of block time

// Charter tree with one node (all-left path, zero siblings), as in the tests.
const NODE = new Uint8Array(32).fill(0x0e);
const ZERO = new Uint8Array(32);
const charterProof = { siblings: Array(12).fill(ZERO), indices: Array(12).fill(false) };
const charterRoot = (() => {
  let h = runtimePersistentHash([padTag('pp:fed:charter:leaf'), NODE]);
  for (let i = 0; i < 12; i++) h = runtimePersistentHash([padTag('pp:fed:charter:node'), h, ZERO]);
  return h;
})();
const pathBits = (/** @type {bigint} */ seq) => Array.from({ length: 24 }, (_, i) => ((seq >> BigInt(i)) & 1n) === 1n);
const TR_WITNESSES = {
  charter_membership_proof: (/** @type {any} */ ctx) => [ctx.privateState, charterProof],
  witness_divmod: (/** @type {any} */ ctx, /** @type {bigint} */ n, /** @type {bigint} */ d) => [ctx.privateState, { quotient: n / d, remainder: n % d }],
  action_log_path_bits: (/** @type {any} */ ctx, /** @type {bigint} */ seq) => [ctx.privateState, pathBits(seq)],
};
export const CLASS = new Uint8Array(32).fill(0xc1);
export const SPLIT = { producerShareBps: 6000n, ldShareBps: 1000n, opsShareBps: 2000n, daoShareBps: 500n, operatorMarginBps: 500n, statutoryTotalBps: 0n };

/** Current ledger of a deployed contract (via the indexer). */
async function ledgerOf(dn, name, address) {
  const mod = await loadModule(name);
  const st = await dn.providersFor(name).publicDataProvider.queryContractState(address);
  if (!st) throw new Error(`${name} at ${address}: no state from the indexer`);
  return mod.ledger(st.data);
}

const S = state.load();
const save = () => state.save(S);

/** Approve `actionHash` on the council with slots 0 and 1 (2-of-3). */
async function approve(dn, actionHash, slots = [0, 1]) {
  const ms = await loadModule('multisig-v8');
  const council = await join(dn, 'multisig-v8', S.council);
  const self = hexToBytes(S.council);
  const epoch = 0n;
  for (const i of slots) {
    const digest = ms.pureCircuits.approvalDigest(self, actionHash, epoch);
    const t0 = Date.now();
    await council.callTx.approve(actionHash, BigInt(i), signDigest(digest, COUNCIL[i].sk));
    console.log(`[stack]   council slot ${i} approved ${Buffer.from(actionHash).toString('hex').slice(0, 16)}… (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}

const STAGES = {
  async council(dn) {
    if (!S.council) {
      const { address } = await deploy(dn, 'multisig-v8', buildCouncilConstructorArgs(COUNCIL.map((k) => k.point), 2n, dn.net.networkId));
      S.council = address;
      save();
    }
    // One on-chain approval end to end (in-circuit secp256k1, real proof).
    const probe = label('council probe action');
    await approve(dn, probe, [0]);
    const ms = await join(dn, 'multisig-v8', S.council);
    const st = await dn.providersFor('multisig-v8').publicDataProvider.queryContractState(S.council);
    console.log(`[stack] council at ${S.council}; probe approval recorded: ${st ? 'yes' : '?'}`);
    void ms;
    S.councilProbe = true;
    save();
  },

  // TariffRegistry: staged deploy (ceremony variant + missing verifier keys),
  // bootstrap, a council-approved + validator-signed schedule, a retuned class.
  async tariff(dn) {
    if (!S.tr) {
      const { address } = await deploy(dn, 'tariff-registry-v1-ceremony',
        [{ bytes: hexToBytes(S.council) }, charterRoot, 100n, VALIDATOR.pk], TR_WITNESSES);
      S.tr = address;
      save();
    }
    if (!S.trVks) {
      S.trVks = await insertMissingVks(dn, 'tariff-registry-v1', S.tr, TR_WITNESSES);
      save();
    }
    const trMod = await loadModule('tariff-registry-v1');
    const P = trMod.pureCircuits;
    const tr = await join(dn, 'tariff-registry-v1', S.tr, TR_WITNESSES);
    let L = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
    if (!L._bootstrapComplete) {
      await tr.callTx.bootstrapActionLog(24n);
      console.log('[stack] TR action log bootstrapped');
    }
    const self = hexToBytes(S.tr);
    if (!S.scheduleId) {
      const opId = P.operatorKeyId(OPERATOR.pk);
      L = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
      const h = P.registerScheduleActionHash(self, NODE, new Uint8Array(32).fill(0x5c), opId, 100n, 1n, L._currentEpoch);
      await approve(dn, h);
      await tr.callTx.registerSchedule(NODE, new Uint8Array(32).fill(0x5c), opId, 100n, 1n, signMessage(P.signerMessage(h), VALIDATOR.sk), nowSec());
      L = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
      S.scheduleId = Buffer.from(L._activeScheduleByNode.lookup(NODE)).toString('hex');
      save();
      console.log(`[stack] schedule registered: ${S.scheduleId}`);
    }
    if (!S.classRetuned) {
      const sid = hexToBytes(S.scheduleId);
      const t = nowSec();
      L = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
      const auth = P.retuneAuthHash(self, sid, CLASS, SPLIT, 100n, L._currentEpoch, 1n, t);
      await tr.callTx.retuneClass(sid, CLASS, SPLIT, 100n, OPERATOR.pk, signMessage(P.signerMessage(auth), OPERATOR.sk), 1n, t,
        { quotient: 20n, remainder: 0n }, { quotient: 20n, remainder: 0n });
      S.classRetuned = true;
      save();
      console.log('[stack] class retuned');
    }
  },
};

const wanted = process.argv.slice(2);
if (!wanted.length) { console.error(`usage: stack.mjs <${Object.keys(STAGES).join('|')}|all> ...`); process.exit(2); }
const order = wanted.includes('all') ? Object.keys(STAGES) : wanted;
const dn = await openDevnet();
for (const st of order) {
  if (!STAGES[st]) throw new Error(`unknown stage ${st}`);
  console.log(`[stack] === ${st}`);
  await STAGES[st](dn);
}
console.log(`[stack] done; state in ${state.file}`);
process.exit(0);
