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
import { openDevnet, deploy, join, loadModule, insertMissingVks, liveState, state } from './devnet-lib.mjs';
import { devnetCouncilKey, buildCouncilConstructorArgs } from '../council/council-keys-guard.mjs';
import { signDigest } from '../../tests/contract/council-signer.mjs';
import { signMessage } from '../../tests/contract/machine-signer.mjs';
import { runtimePersistentHash, padTag } from '../../tests/parity/harness.mjs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ActionLogTree } from '../../tests/contract/settle-world.mjs';
import { signSettle, settleHatArgs, chipHwId, sessionFrom16 } from '../../tests/contract/hat-signer.mjs';
import { submitSettleWithRetry } from '../settle/submit-settle.mjs';
import { findSettleChipEvents, decodeSettleChipEvent, verifySettleChipEvent, SETTLE_CHIP_EVENT } from '../watcher/settle-watcher-lib.mjs';
import { nameField } from '../events/event-codec.mjs';

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
const OWNER = jubjub('ebt owner');
const METER_AUTHORITY = jubjub('meter authority');
const ESCROW = jubjub('escrow attestor');
const MSG1 = new RT.CompactTypeVector(1, RT.CompactTypeField);
// Devnet software HAT chip: Ed25519 key from a label, hardware id with the
// reserved devnet prefix "PPDEV" (meter-authority-service refuses it off-devnet).
const CHIP = (() => {
  const sk = label('hat chip');
  return { sk, pk: ed25519.getPublicKey(sk), ieee: Buffer.concat([Buffer.from('PPDEV', 'ascii'), Buffer.from([0, 0, 1])]), userid: 1 };
})();
const PRODUCER = { key: new Uint8Array(32).fill(0x63), meter: new Uint8Array(32).fill(0x65), payout: new Uint8Array(32).fill(0x64) };
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
  const st = await liveState(dn, name, address);
  if (!st) throw new Error(`${name} at ${address}: no state from the indexer`);
  return mod.ledger(st.data);
}

/**
 * Reads a contract's events back from the INDEXER and runs the watcher on
 * settleChip events. Logs the raw framing (what precedes the event name) so
 * the exact indexer format is confirmed on the devnet.
 */
async function watchEvents(dn, tag) {
  const q = `query($a: HexEncoded!) { contractEvents(filter: { contractAddress: $a }) { id raw } }`;
  const res = await fetch(dn.net.indexer, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { a: S.ebt } }) });
  const body = await res.json();
  if (body.errors) { console.log(`[watch:${tag}] indexer error: ${JSON.stringify(body.errors).slice(0, 300)}`); return; }
  const evs = body.data?.contractEvents ?? [];
  console.log(`[watch:${tag}] indexer returned ${evs.length} EBT event(s)`);
  const NAME = nameField(SETTLE_CHIP_EVENT);
  const L = await ledgerOf(dn, 'ebt-v8', S.ebt);
  for (const e of evs) {
    const raw = Buffer.from(String(e.raw).replace(/^0x/, ''), 'hex');
    const at = raw.indexOf(NAME);
    console.log(`[watch:${tag}]   event ${e.id}: raw ${raw.length} B, settleChip name at offset ${at}, prefix ${raw.subarray(0, Math.max(0, at)).toString('hex')}`);
    if (at < 0) continue;
    const [full] = findSettleChipEvents([raw.subarray(at)]);
    const ev = decodeSettleChipEvent(full);
    const chip = L._chips.member(ev.chipPubkey) ? L._chips.lookup(ev.chipPubkey) : null;
    const r = verifySettleChipEvent(ev, chip);
    console.log(`[watch:${tag}]   watcher: ${r.ok ? 'OK' : 'ALERT ' + r.problems.join(',')} (uWh ${ev.sessionUwh}, nonce ${ev.nonce})`);
  }
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
    try {
      await council.callTx.approve(actionHash, BigInt(i), signDigest(digest, COUNCIL[i].sk));
    } catch (e) {
      // A resumed run may repeat an approval that already landed.
      if (/already approved/i.test(String(/** @type {any} */ (e)?.message ?? e) + String(/** @type {any} */ (e)?.cause?.message ?? ''))) {
        console.log(`[stack]   council slot ${i}: already approved`);
        continue;
      }
      throw e;
    }
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
    const st = await liveState(dn, 'multisig-v8', S.council);
    console.log(`[stack] council at ${S.council}; live state read back: ${st ? 'yes' : 'no'}`);
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
      dn.bind(address, 'tariff-registry-v1');
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
      S.retuneTime = t.toString();
      save();
      console.log('[stack] class retuned');
    }
  },

  // EBT: staged deploy, registry mirrors through action-log proofs, producer
  // attestation (owner), a council-registered devnet chip.
  async ebt(dn) {
    const trL = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
    if (!S.ebt) {
      const root = trL.registryActionLogRoot;
      const { address } = await deploy(dn, 'ebt-v8-ceremony', [
        OWNER.pk, METER_AUTHORITY.pk, { bytes: hexToBytes(S.council) },
        { bytes: new Uint8Array(32).fill(0x21) }, { bytes: new Uint8Array(32).fill(0x23) }, ESCROW.pk, root,
      ]);
      S.ebt = address;
      S.ebtRoot = Buffer.from(root).toString('hex');
      save();
      dn.bind(address, 'ebt-v8');
    }
    if (!S.ebtVks) {
      S.ebtVks = await insertMissingVks(dn, 'ebt-v8', S.ebt);
      save();
    }
    const ebtMod = await loadModule('ebt-v8');
    const P = ebtMod.pureCircuits;
    const ebt = await join(dn, 'ebt-v8', S.ebt);
    const self = hexToBytes(S.ebt);
    // Rebuild the action log exactly as the TR holds it (checked against the mirrored root).
    const tree = new ActionLogTree();
    const entries = [];
    for (let i = 0n; i < trL._actionSeq; i++) { const e = trL._actionLog.lookup(i); entries.push(e); tree.append(e.payloadHash); }
    if (Buffer.from(tree.root()).toString('hex') !== S.ebtRoot) throw new Error('JS action-log tree != the root EBT mirrors');
    const sid = hexToBytes(S.scheduleId);
    if (!S.mirrored) {
      await ebt.callTx.mirrorScheduleLifecycle(entries[0], trL._registeredSchedules.lookup(sid), tree.proof(0));
      await ebt.callTx.mirrorClassStatutoryTotal(entries[1], sid, CLASS, SPLIT, 100n, BigInt(S.retuneTime), tree.proof(1));
      S.mirrored = true;
      save();
      console.log('[stack] schedule + class mirrored into EBT');
    }
    if (!S.attested) {
      const producerKey = PRODUCER.key;
      const attKey = runtimePersistentHash([producerKey, PRODUCER.meter]);
      const args = [attKey, producerKey, PRODUCER.meter, 1n, new Uint8Array(32).fill(0x53), nowSec()];
      const L = await ledgerOf(dn, 'ebt-v8', S.ebt);
      const msg = P.ownerActionMessage(self, padTag('attestProducerOwnership'), P.ownerDigest_attestProducerOwnership(...args), L._ownerNonce);
      await ebt.callTx.attestProducerOwnership(...args, RT.jubjubSchnorrSign(MSG1, [msg], OWNER.sk));
      S.attested = true;
      save();
      console.log('[stack] producer attested');
    }
    if (!S.chipRegistered) {
      const t = nowSec();
      const h = P.councilChipHash(self, 1n, CHIP.pk, chipHwId(CHIP), PRODUCER.meter, PRODUCER.key, { bytes: PRODUCER.payout }, t);
      await approve(dn, h);
      await ebt.callTx.registerChip(CHIP.pk, chipHwId(CHIP), PRODUCER.meter, PRODUCER.key, { bytes: PRODUCER.payout }, t);
      S.chipRegistered = true;
      save();
      console.log(`[stack] devnet chip registered (ieee ${Buffer.from(CHIP.ieee).toString('hex')})`);
    }
  },

  // One metered settle: chip native attestation (software chip) -> meter-
  // authority countersign -> submit with retry; then the watcher re-verifies
  // the event read back from the INDEXER.
  async settle(dn) {
    const ebtMod = await loadModule('ebt-v8');
    const ebt = await join(dn, 'ebt-v8', S.ebt);
    const self = hexToBytes(S.ebt);
    const n = (S.settles ?? 0) + 1;
    const amount = 10_000n;
    const sessionId16 = new Uint8Array(createHash('sha256').update(`devnet settle ${S.ebt} ${n}`).digest()).slice(0, 16);
    const f = {
      sessionID: sessionFrom16(sessionId16), amount, producerKey: PRODUCER.key, producerAddr: { bytes: PRODUCER.payout },
      meterKeyHash: PRODUCER.meter, chipHwId: chipHwId(CHIP), chipSessionUwh: amount * 1000n + 777n,
      chipUptimeMs: 3_600_000n + BigInt(n), chipNonce: BigInt(Date.now()),
    };
    const s = signSettle(ebtMod, { addressBytes: self }, f, { chip: CHIP, hatSk: METER_AUTHORITY.sk });
    const ld = (amount * SPLIT.ldShareBps) / 10000n;
    const ops = (amount * SPLIT.opsShareBps) / 10000n;
    const dao = (amount * SPLIT.daoShareBps) / 10000n;
    const prod = amount - ld - ops - dao;
    const args = [...settleHatArgs(f, s), hexToBytes(S.scheduleId), CLASS, 1n, 2n,
      [ZERO, ZERO, ZERO, ZERO], [0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n],
      10000n - SPLIT.ldShareBps - SPLIT.opsShareBps - SPLIT.daoShareBps, SPLIT.opsShareBps, SPLIT.ldShareBps, SPLIT.daoShareBps,
      prod, ops, ld, dao, nowSec()];
    const t0 = Date.now();
    const r = await submitSettleWithRetry({
      args,
      submit: (a) => ebt.callTx.settle(...a),
      alreadySettled: async () => (await ledgerOf(dn, 'ebt-v8', S.ebt))._settledSessions.member(f.sessionID),
    });
    const txId = r.tx?.public?.txId;
    console.log(`[stack] settle ${r.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s (tx ${txId ?? '-'})`);
    S.settles = n;
    S.lastSettleTx = txId;
    save();
    const L = await ledgerOf(dn, 'ebt-v8', S.ebt);
    console.log(`[stack] EBT: totalSupply ${L._totalSupply}, dividendAccrued ${L._dividendAccrued}`);
    await watchEvents(dn, 'settle');
  },
};

const wanted = process.argv.slice(2);
if (!wanted.length) { console.error(`usage: stack.mjs <${Object.keys(STAGES).join('|')}|all> ...`); process.exit(2); }
const order = wanted.includes('all') ? Object.keys(STAGES) : wanted;
const dn = await openDevnet();
// Bind every deployed contract's build for cross-contract calls (TR/EBT -> Council, LD -> EBT).
if (S.council) dn.bind(S.council, 'multisig-v8');
if (S.tr) dn.bind(S.tr, 'tariff-registry-v1');
if (S.ebt) dn.bind(S.ebt, 'ebt-v8');
if (S.ld) dn.bind(S.ld, 'living-dividend-v3');
for (const st of order) {
  if (!STAGES[st]) throw new Error(`unknown stage ${st}`);
  console.log(`[stack] === ${st}`);
  await STAGES[st](dn);
}
console.log(`[stack] done; state in ${state.file}`);
process.exit(0);
