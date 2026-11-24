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
import { openDevnet, deploy, join, loadModule, liveState, finalizeContract, buildDir, ROOT, state } from './devnet-lib.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEbtSettleChain } from '../settle/ebt-settle-chain.mjs';
import { createLdRelay } from '../ld/ld-relay.mjs';
import * as L9 from '@midnight-ntwrk/midnight-js-protocol/v9';
import { checkFinalized, buildVerifierKeys, submitMaintenance, vkInsert, vkRemove, replaceAuthority } from '../deploy/finalize.mjs';
import { devnetCouncilKey, buildCouncilConstructorArgs } from '../council/council-keys-guard.mjs';
import { signDigest } from '../../tests/contract/council-signer.mjs';
import { signMessage } from '../../tests/contract/machine-signer.mjs';
import { runtimePersistentHash, padTag } from '../../tests/parity/harness.mjs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ActionLogTree } from '../../tests/contract/settle-world.mjs';
import { signSettle, settleHatArgs, chipHwId, sessionFrom16 } from '../../tests/contract/hat-signer.mjs';
import { submitSettleWithRetry } from '../settle/submit-settle.mjs';
import { findSettleChipEvents, decodeSettleChipEvent, verifySettleChipEvent, SETTLE_CHIP_EVENT } from '../watcher/settle-watcher-lib.mjs';
import { restoreIndexerMiscEvent, payloadWords } from '../events/event-codec.mjs';

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
const MEMBER = { ...jubjub('ld member'), payout: new Uint8Array(32).fill(0x31), kyc: new Uint8Array(32).fill(0xd1) };
const LD_WITNESSES = {
  witness_divmod: (/** @type {any} */ ctx, /** @type {bigint} */ n, /** @type {bigint} */ d) => [ctx.privateState, { quotient: n / d, remainder: n % d }],
};
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
  // The indexer provider decodes Misc events into name + payload (hex). `raw`
  // is the whole VersionedLogItem (framing + metadata), not our event bytes.
  const evs = await /** @type {any} */ (dn.providersFor('ebt-v8')).publicDataProvider.queryContractEvents({ contractAddress: S.ebt, types: ['Misc'] });
  console.log(`[watch:${tag}] indexer returned ${evs.length} Misc event(s) for EBT`);
  const L = await ledgerOf(dn, 'ebt-v8', S.ebt);
  for (const e of evs) {
    console.log(`[watch:${tag}]   event ${e.id}: name ${String(e.name).length / 2} B, payload ${String(e.payload).length / 2} B (raw log item ${String(e.raw).length / 2} B, not decoded)`);
    let restored;
    try { restored = restoreIndexerMiscEvent(e); } catch (err) { console.log(`[watch:${tag}]   REFUSED: ${/** @type {any} */ (err).message}`); continue; }
    console.log(`[watch:${tag}]   ${restored.name}: restored to ${restored.bytes.length} B`);
    if (restored.name !== SETTLE_CHIP_EVENT) continue;
    const ev = decodeSettleChipEvent(restored.bytes);
    const chip = L._chips.member(ev.chipPubkey) ? L._chips.lookup(ev.chipPubkey) : null;
    const r = verifySettleChipEvent(ev, chip);
    console.log(`[watch:${tag}]   watcher: ${r.ok ? 'OK' : 'ALERT ' + r.problems.join(',')} (uWh ${ev.sessionUwh}, uptime ${ev.uptimeMs}, nonce ${ev.nonce})`);
  }
}

/** LD v3 events read back from the indexer, restored to their exact layout. */
async function watchLdEvents(dn) {
  const evs = await /** @type {any} */ (dn.providersFor('living-dividend-v3')).publicDataProvider.queryContractEvents({ contractAddress: S.ld, types: ['Misc'] });
  console.log(`[watch:ld] indexer returned ${evs.length} Misc event(s) for LD`);
  for (const e of evs) {
    try {
      const r = restoreIndexerMiscEvent(e);
      const w = payloadWords(r.bytes).map((x) => Buffer.from(x).toString('hex').slice(0, 16));
      console.log(`[watch:ld]   event ${e.id}: ${r.name} (payload ${String(e.payload).length / 2} B -> ${r.bytes.length} B) words ${w.slice(0, 4).join(' ')}`);
    } catch (err) { console.log(`[watch:ld]   event ${e.id}: REFUSED ${/** @type {any} */ (err).message}`); }
  }
}

const S = state.load();
const save = () => state.save(S);

/**
 * Mirrors the TR schedule + class into an EBT (action-log proofs) and attests
 * the producer (owner signature). `flags` records progress (S or S.atk).
 * `joinAs`: the build to call through (the ceremony build mid-deploy).
 */
async function mirrorAndAttest(dn, ebtAddress, flags, rootHex, joinAs) {
  const trL = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
  const P = (await loadModule('ebt-v8')).pureCircuits;
  const ebt = await join(dn, joinAs, ebtAddress);
  const self = hexToBytes(ebtAddress);
  // Rebuild the action log exactly as the TR holds it (checked against the mirrored root).
  const tree = new ActionLogTree();
  const entries = [];
  for (let i = 0n; i < trL._actionSeq; i++) { const e = trL._actionLog.lookup(i); entries.push(e); tree.append(e.payloadHash); }
  if (Buffer.from(tree.root()).toString('hex') !== rootHex) throw new Error('JS action-log tree != the root EBT mirrors');
  const sid = hexToBytes(S.scheduleId);
  if (!flags.mirrored) {
    await ebt.callTx.mirrorScheduleLifecycle(entries[0], trL._registeredSchedules.lookup(sid), tree.proof(0));
    await ebt.callTx.mirrorClassStatutoryTotal(entries[1], sid, CLASS, SPLIT, 100n, BigInt(S.retuneTime), tree.proof(1));
    flags.mirrored = true;
    save();
    console.log('[stack] schedule + class mirrored into EBT');
  }
  if (!flags.attested) {
    const attKey = runtimePersistentHash([PRODUCER.key, PRODUCER.meter]);
    const args = [attKey, PRODUCER.key, PRODUCER.meter, 1n, new Uint8Array(32).fill(0x53), nowSec()];
    const L = await ledgerOf(dn, 'ebt-v8', ebtAddress);
    const msg = P.ownerActionMessage(self, padTag('attestProducerOwnership'), P.ownerDigest_attestProducerOwnership(...args), L._ownerNonce);
    await ebt.callTx.attestProducerOwnership(...args, RT.jubjubSchnorrSign(MSG1, [msg], OWNER.sk));
    flags.attested = true;
    save();
    console.log('[stack] producer attested');
  }
}

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
    if (!S.councilLocked) {
      await finalizeContract(dn, 'multisig-v8', S.council);   // full deploy: lock the authority
      S.councilLocked = true;
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
      S.trVks = await finalizeContract(dn, 'tariff-registry-v1', S.tr, TR_WITNESSES);   // last key + lock in one update
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
      S.ebtVks = await finalizeContract(dn, 'ebt-v8', S.ebt);   // last key + lock in one update
      save();
    }
    const ebtMod = await loadModule('ebt-v8');
    const P = ebtMod.pureCircuits;
    const ebt = await join(dn, 'ebt-v8', S.ebt);
    const self = hexToBytes(S.ebt);
    await mirrorAndAttest(dn, S.ebt, S, S.ebtRoot, 'ebt-v8');
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

  // Living Dividend v3: deploy, bind to EBT (council op 0), register a member
  // (LD -> Council isApproved and LD -> EBT dividendAccrued in one tx).
  async ld(dn) {
    if (!S.ld) {
      const { address } = await deploy(dn, 'living-dividend-v3', [{ bytes: hexToBytes(S.ebt) }, { bytes: hexToBytes(S.council) }], LD_WITNESSES);
      S.ld = address;
      save();
      dn.bind(address, 'living-dividend-v3');
    }
    if (!S.ldLocked) {
      await finalizeContract(dn, 'living-dividend-v3', S.ld, LD_WITNESSES);   // full deploy: lock the authority
      S.ldLocked = true;
      save();
    }
    const ebtMod = await loadModule('ebt-v8');
    const ldMod = await loadModule('living-dividend-v3');
    const P = ldMod.pureCircuits;
    const ldSelf = hexToBytes(S.ld);
    if (!S.ldBound) {
      const ebt = await join(dn, 'ebt-v8', S.ebt);
      const t = nowSec();
      const h = ebtMod.pureCircuits.councilActionHash(hexToBytes(S.ebt), 0n, { bytes: ldSelf }, ESCROW.pk, t);
      await approve(dn, h);
      await ebt.callTx.execMultisigOp(0n, { bytes: ldSelf }, ESCROW.pk, t);
      S.ldBound = true;
      save();
      console.log('[stack] LD bound in EBT (op 0)');
    }
    if (!S.memberId) {
      const ld = await join(dn, 'living-dividend-v3', S.ld, LD_WITNESSES);
      const t = nowSec();
      const h = P.registerActionHash(ldSelf, MEMBER.pk, { bytes: MEMBER.payout }, MEMBER.kyc, t);
      await approve(dn, h);
      const t0 = Date.now();
      await ld.callTx.register(MEMBER.pk, { bytes: MEMBER.payout }, MEMBER.kyc, t);
      S.memberId = Buffer.from(P.memberId(MEMBER.pk)).toString('hex');
      save();
      console.log(`[stack] member registered in ${((Date.now() - t0) / 1000).toFixed(0)}s (LD -> Council + LD -> EBT in one tx): ${S.memberId.slice(0, 16)}...`);
    }
  },

  // Claim: LD -> EBT dividendAccrued, then LD -> EBT mintDividend (a mint
  // inside a cross-contract call; two calls to EBT in one transaction).
  async claim(dn) {
    const ldMod = await loadModule('living-dividend-v3');
    const P = ldMod.pureCircuits;
    const ldSelf = hexToBytes(S.ld);
    const id = hexToBytes(S.memberId);
    const ld = await join(dn, 'living-dividend-v3', S.ld, LD_WITNESSES);
    const before = await ledgerOf(dn, 'ebt-v8', S.ebt);
    const ldL = await ledgerOf(dn, 'living-dividend-v3', S.ld);
    const nonce = ldL._members.lookup(id).nonce;
    const t = nowSec();
    const sig = RT.jubjubSchnorrSign(MSG1, [P.memberMessage(ldSelf, padTag('claim'), id, P.timeDigest(t), nonce)], MEMBER.sk);
    const t0 = Date.now();
    const r = await ld.callTx.claim(id, t, sig);
    const after = await ledgerOf(dn, 'ebt-v8', S.ebt);
    const ldAfter = await ledgerOf(dn, 'living-dividend-v3', S.ld);
    console.log(`[stack] claim in ${((Date.now() - t0) / 1000).toFixed(0)}s (tx ${r?.public?.txId ?? '-'})`);
    console.log(`[stack]   EBT dividendMinted ${before._dividendMinted} -> ${after._dividendMinted}, totalSupply ${before._totalSupply} -> ${after._totalSupply}; LD totalClaimed ${ldAfter._totalClaimed}`);
    S.claimed = String(ldAfter._totalClaimed);
    save();
    await watchLdEvents(dn);
  },

  // Staged-deploy window attacks (Garrett 2026-11-24). A fresh EBT, mid-deploy
  // (ceremony keys only, mirrors + producer attested, i.e. everything settle
  // needs except a registered chip). Each attack must be refused by the chain
  // (or the contract), and the state must be unchanged afterwards.
  async attacks(dn) {
    const A = (S.atk ??= {});
    const results = [];
    const check = (/** @type {string} */ id, /** @type {boolean} */ ok, /** @type {string} */ detail) => {
      results.push({ id, ok, detail });
      console.log(`[attack] ${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
    };
    /** Runs `fn`, expecting the chain or the contract to refuse it. */
    const refused = async (/** @type {() => Promise<any>} */ fn) => {
      try {
        const r = await fn();
        const status = r?.status ?? r?.public?.status;
        if (status && status !== 'SucceedEntirely') return { refused: true, why: `status ${status}` };
        return { refused: false, why: `accepted (${status ?? 'no status'})` };
      } catch (e) {
        const msg = [/** @type {any} */ (e)?.message, /** @type {any} */ (e)?.cause?.message, /** @type {any} */ (e)?.cause?.cause?.message].filter(Boolean).join(' | ');
        return { refused: true, why: msg.replace(/\s+/g, ' ').slice(0, 220) };
      }
    };
    const providers = /** @type {any} */ (dn.providersFor('ebt-v8'));
    const trL = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
    if (!A.ebt) {
      const root = trL.registryActionLogRoot;
      const { address } = await deploy(dn, 'ebt-v8-ceremony', [
        OWNER.pk, METER_AUTHORITY.pk, { bytes: hexToBytes(S.council) },
        { bytes: new Uint8Array(32).fill(0x21) }, { bytes: new Uint8Array(32).fill(0x23) }, ESCROW.pk, root,
      ]);
      A.ebt = address;
      A.root = Buffer.from(root).toString('hex');
      save();
    }
    dn.bind(A.ebt, 'ebt-v8');
    await mirrorAndAttest(dn, A.ebt, A, A.root, 'ebt-v8-ceremony');
    const full = buildDir('ebt-v8');
    const keys = buildVerifierKeys(full);
    const state0 = await liveState(dn, 'ebt-v8', A.ebt);
    const ops0 = state0.operations().length;

    // SD-1: the finalized-state check refuses a mid-deploy contract.
    const fz0 = checkFinalized(state0, full);
    check('SD-1 finalized check refuses mid-deploy', !fz0.ok && fz0.problems.some((p) => p.startsWith('authority-not-locked')),
      `${fz0.problems.filter((p) => p.startsWith('missing:')).length} missing, ${fz0.problems.filter((p) => !p.startsWith('missing:')).join(', ')}`);

    // SD-2: a circuit whose key is not inserted yet cannot be called.
    {
      const self = hexToBytes(A.ebt);
      const P = (await loadModule('ebt-v8')).pureCircuits;
      const t = nowSec();
      const r = await refused(async () => {
        const ebtFull = await join(dn, 'ebt-v8', A.ebt);
        return ebtFull.callTx.registerChip(CHIP.pk, chipHwId(CHIP), PRODUCER.meter, PRODUCER.key, { bytes: PRODUCER.payout }, t);
      });
      const L = await ledgerOf(dn, 'ebt-v8', A.ebt);
      check('SD-2 call a not-yet-inserted circuit (registerChip)', r.refused && !L._chips.member(CHIP.pk), r.why);
      void P; void self;
    }

    // SD-3: settle (in the ceremony set) with everything valid except a registered chip.
    {
      const ebtMod = await loadModule('ebt-v8');
      const self = hexToBytes(A.ebt);
      const amount = 10_000n;
      const sessionId16 = new Uint8Array(createHash('sha256').update(`attack settle ${A.ebt}`).digest()).slice(0, 16);
      const f = {
        sessionID: sessionFrom16(sessionId16), amount, producerKey: PRODUCER.key, producerAddr: { bytes: PRODUCER.payout },
        meterKeyHash: PRODUCER.meter, chipHwId: chipHwId(CHIP), chipSessionUwh: amount * 1000n + 1n,
        chipUptimeMs: 7_200_000n, chipNonce: BigInt(Date.now()),
      };
      const s = signSettle(ebtMod, { addressBytes: self }, f, { chip: CHIP, hatSk: METER_AUTHORITY.sk });
      const ld = (amount * SPLIT.ldShareBps) / 10000n, ops = (amount * SPLIT.opsShareBps) / 10000n, dao = (amount * SPLIT.daoShareBps) / 10000n;
      const args = [...settleHatArgs(f, s), hexToBytes(S.scheduleId), CLASS, 1n, 2n,
        [ZERO, ZERO, ZERO, ZERO], [0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n],
        10000n - SPLIT.ldShareBps - SPLIT.opsShareBps - SPLIT.daoShareBps, SPLIT.opsShareBps, SPLIT.ldShareBps, SPLIT.daoShareBps,
        amount - ld - ops - dao, ops, ld, dao, nowSec()];
      const r = await refused(async () => (await join(dn, 'ebt-v8-ceremony', A.ebt)).callTx.settle(...args));
      const L = await ledgerOf(dn, 'ebt-v8', A.ebt);
      check('SD-3 settle mid-deploy (valid HAT, no registered chip)', r.refused && L._totalSupply === 0n, `${r.why}; totalSupply ${L._totalSupply}`);
    }

    // SD-4..6: an outsider (fresh signing key) tries every maintenance action.
    const attacker = L9.sampleSigningKey();
    const attempt = async (/** @type {string} */ id, /** @type {any[]} */ updates, /** @type {() => Promise<boolean>} */ unchanged) => {
      const st = await liveState(dn, 'ebt-v8', A.ebt);
      const r = await refused(() => submitMaintenance(providers, A.ebt, st, updates, [attacker], dn.net.networkId));
      check(id, r.refused && await unchanged(), r.why);
    };
    await attempt('SD-4 outsider inserts the genuine registerChip key', [vkInsert('registerChip', keys.get('registerChip'))],
      async () => (await liveState(dn, 'ebt-v8', A.ebt)).operation('registerChip') === undefined);
    await attempt('SD-5 outsider inserts a foreign key under manualReissue', [vkInsert('manualReissue', keys.get('redeem'))],
      async () => (await liveState(dn, 'ebt-v8', A.ebt)).operation('manualReissue') === undefined);
    await attempt('SD-6 outsider removes settle', [vkRemove('settle')],
      async () => (await liveState(dn, 'ebt-v8', A.ebt)).operation('settle') !== undefined);
    await attempt('SD-7 outsider takes over the authority', [replaceAuthority(new L9.ContractMaintenanceAuthority([L9.signatureVerifyingKey(attacker)], 1, state0.maintenanceAuthority.counter + 1n))],
      async () => (await liveState(dn, 'ebt-v8', A.ebt)).maintenanceAuthority.committee.length === 1 && (await liveState(dn, 'ebt-v8', A.ebt)).maintenanceAuthority.counter === state0.maintenanceAuthority.counter);
    {
      const st = await liveState(dn, 'ebt-v8', A.ebt);
      check('SD-8 state unchanged by all attempts', st.operations().length === ops0 && st.maintenanceAuthority.counter === state0.maintenanceAuthority.counter,
        `${st.operations().length} operations, authority counter ${st.maintenanceAuthority.counter}`);
    }

    // SD-9: the authorized finalization: missing keys, the last one with the lock.
    if (!A.finalized) {
      await finalizeContract(dn, 'ebt-v8', A.ebt);
      A.finalized = true;
      save();
    }
    const fz1 = checkFinalized(await liveState(dn, 'ebt-v8', A.ebt), full);
    check('SD-9 finalized: exact audited keys + locked authority', fz1.ok, fz1.ok ? `${keys.size} keys` : fz1.problems.join(', '));

    // SD-10..12: after the lock, even the deployer's own key can change nothing.
    const deployerKey = await providers.privateStateProvider.getSigningKey(A.ebt);
    const after = async (/** @type {string} */ id, /** @type {any[]} */ updates, /** @type {any[]} */ signers) => {
      const st = await liveState(dn, 'ebt-v8', A.ebt);
      const r = await refused(() => submitMaintenance(providers, A.ebt, st, updates, signers, dn.net.networkId));
      const fz = checkFinalized(await liveState(dn, 'ebt-v8', A.ebt), full);
      check(id, r.refused && fz.ok, r.why);
    };
    await after('SD-10 deployer key removes settle after the lock', [vkRemove('settle')], [deployerKey]);
    await after('SD-11 deployer key restores its authority after the lock',
      [replaceAuthority(new L9.ContractMaintenanceAuthority([L9.signatureVerifyingKey(deployerKey)], 1, (await liveState(dn, 'ebt-v8', A.ebt)).maintenanceAuthority.counter + 1n))], [deployerKey]);
    await after('SD-12 unsigned update after the lock', [vkRemove('settle')], []);

    const failed = results.filter((r) => !r.ok);
    console.log(`[attack] ${results.length - failed.length}/${results.length} passed`);
    S.attackResults = results;
    save();
    if (failed.length) throw new Error(`staged-deploy attacks: ${failed.map((r) => r.id).join('; ')}`);
  },

  // pp-settle-service's REAL settle path on the devnet: prepare (the EBT's own
  // record digest), the Gap B journal, submit through the chain adapter (split
  // planned from EBT's live mirrors, retry, never resubmitting a landed
  // session); then a crash simulation (journaled, never submitted) settled by
  // replayPending, and a replay of a landed session that must not resubmit.
  async service(dn) {
    const svcDir = process.env.PP_SETTLE_SERVICE_DIR ?? path.resolve(ROOT, '..', 'pp-settle-service');
    const { createSettleV9 } = await import(pathToFileURL(path.join(svcDir, 'settle_v9.mjs')).href);
    const { createSettleJournal } = await import(pathToFileURL(path.join(svcDir, 'settle_journal.mjs')).href);
    const ebtMod = await loadModule('ebt-v8');
    const self = hexToBytes(S.ebt);
    const journalDir = path.join(ROOT, 'build', 'devnet', `journal-${S.ebt.slice(0, 8)}`);
    const providers = /** @type {any} */ (dn.providersFor('ebt-v8'));
    let submits = 0;
    const chain = await createEbtSettleChain({ providers, ebtBuildDir: buildDir('ebt-v8'), ebtAddress: S.ebt });
    const counting = { ...chain, settle: async (/** @type {any} */ p) => { const r = await chain.settle(p); if (r.status === 'submitted') submits++; return r; } };
    const svc = createSettleV9({
      ebtBuildDir: buildDir('ebt-v8'), ebtAddressHex: S.ebt,
      producerKeyHex: Buffer.from(PRODUCER.key).toString('hex'), producerAddrHex: Buffer.from(PRODUCER.payout).toString('hex'),
      meterKeyHashHex: Buffer.from(PRODUCER.meter).toString('hex'),
      tariff: { scheduleIdHex: S.scheduleId, classPathHex: Buffer.from(CLASS).toString('hex'), epoch: '1', fiatValueAtMint: '2' },
      journal: createSettleJournal(journalDir), chain: async () => counting,
    });
    const identity = { ieee: [...CHIP.ieee].map((x) => x.toString(16).padStart(2, '0')).join(':'), userid: CHIP.userid, pubkey: Buffer.from(CHIP.pk).toString('hex') };
    /** One software-chip session -> the bundle the service holds after countersign. */
    const bundleFor = async (/** @type {number} */ k, /** @type {bigint} */ uwh) => {
      const sid16 = new Uint8Array(createHash('sha256').update(`service ${S.ebt} ${k} ${Date.now()}`).digest()).slice(0, 16);
      const att = { sessionUwh: uwh, uptimeMs: 5_000_000n + BigInt(k), nonce: BigInt(Date.now()) * 10n + BigInt(k) };
      const pre = await svc.prepare({ attestation: att, identity, sessionId16: sid16 });
      const f = {
        sessionID: sessionFrom16(sid16), amount: BigInt(pre.amount), producerKey: PRODUCER.key, producerAddr: { bytes: PRODUCER.payout },
        meterKeyHash: PRODUCER.meter, chipHwId: chipHwId(CHIP), chipSessionUwh: uwh, chipUptimeMs: att.uptimeMs, chipNonce: att.nonce,
      };
      const s = signSettle(ebtMod, { addressBytes: self }, f, { chip: CHIP, hatSk: METER_AUTHORITY.sk });
      if (Buffer.from(s.recordDigest).toString('hex') !== pre.recordDigestHex) throw new Error('service record digest != contract record digest');
      return {
        fields: pre.fields, chipPubkeyHex: Buffer.from(s.chipPubkey).toString('hex'),
        chipSigHex: Buffer.concat([Buffer.from(s.chipSigR), Buffer.from(s.chipSigS)]).toString('hex'),
        hatSig: { announcement: { x: String(s.hatSig.announcement.x), y: String(s.hatSig.announcement.y) }, response: String(s.hatSig.response) },
      };
    };
    const supply = async () => (await ledgerOf(dn, 'ebt-v8', S.ebt))._totalSupply;

    // 1. Normal path: an odd amount (largest-remainder slices).
    const s0 = await supply();
    const b1 = await bundleFor(1, 12_345_678n);
    const t0 = Date.now();
    const r1 = await svc.submit(b1);
    console.log(`[service] submit: ${r1.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s, amount ${r1.amount}, split ${JSON.stringify(r1.split)}; supply ${s0} -> ${await supply()}`);
    if (await supply() - s0 !== 12_345n) throw new Error('service settle minted the wrong amount');

    // 2. Crash after countersign, before submit: journaled only; startup replay settles it.
    const b2 = await bundleFor(2, 3_000_999n);
    createSettleJournal(journalDir).begin(b2.fields.sessionId, b2);
    // 3. A landed session journaled again as pending (crash after landing, before 'done').
    createSettleJournal(journalDir).begin(b1.fields.sessionId + '', b1);
    const before = submits;
    const s1 = await supply();
    const replay = await svc.replayPending();
    console.log(`[service] replay: ${JSON.stringify(replay)}; new submits ${submits - before}; supply ${s1} -> ${await supply()}`);
    const byId = Object.fromEntries(replay.map((x) => [x.sessionId, x.status]));
    if (byId[b2.fields.sessionId] !== 'submitted') throw new Error('crashed bundle was not settled by replay');
    if (byId[b1.fields.sessionId] !== 'already-settled') throw new Error('landed session was resubmitted on replay');
    if (submits - before !== 1 || await supply() - s1 !== 3_000n) throw new Error('replay submitted the wrong number of settles');
    if (createSettleJournal(journalDir).pending().length) throw new Error('journal still has pending bundles');
    console.log('[service] PASS: submit, crash replay, no resubmit of a landed session');
    S.service = { ok: true, tx: r1.txHash };
    save();
  },

  // The LD v3 relayer on the devnet: the member signs as the wallet shim does
  // (memberMessage over this action, its arguments and the current nonce); the
  // relayer pre-checks and proves. claim -> touchLiveness -> requestPayoutChange
  // -> cancelPayoutChange, then a replayed claim body must be refused.
  async relay(dn) {
    const ldMod = await loadModule('living-dividend-v3');
    const P = ldMod.pureCircuits;
    const relay = await createLdRelay({ providers: dn.providersFor('living-dividend-v3'), ldBuildDir: buildDir('living-dividend-v3'), ldAddress: S.ld, indexerUrl: dn.net.indexer, witnesses: LD_WITNESSES });
    const ldSelf = hexToBytes(S.ld);
    const id = hexToBytes(S.memberId);
    const pk = { x: String(MEMBER.pk.x), y: String(MEMBER.pk.y) };
    const signAs = (/** @type {string} */ action, /** @type {any} */ digest, /** @type {bigint} */ nonce) => {
      const s = RT.jubjubSchnorrSign(MSG1, [P.memberMessage(ldSelf, padTag(action), id, digest, nonce)], MEMBER.sk);
      return { announcement: { x: String(s.announcement.x), y: String(s.announcement.y) }, response: String(s.response) };
    };
    const act = async (/** @type {string} */ action, /** @type {string | undefined} */ newPayoutHex) => {
      const st = await relay.memberState(S.memberId);
      const t = BigInt(st.blockTime) - 5n;
      const digest = action === 'requestPayoutChange' ? P.payoutDigest({ bytes: hexToBytes(newPayoutHex ?? '') }, t) : P.timeDigest(t);
      const body = { action, memberIdHex: S.memberId, pk, currentTime: String(t), ...(newPayoutHex ? { newPayoutHex } : {}), signature: signAs(action, digest, BigInt(st.nonce)) };
      const t0 = Date.now();
      const r = await relay.submit(body);
      console.log(`[relay] ${action}: tx ${r.txHash} (${((Date.now() - t0) / 1000).toFixed(0)}s), nonce ${st.nonce} -> ${(await relay.memberState(S.memberId)).nonce}`);
      return body;
    };
    const ebtBefore = await ledgerOf(dn, 'ebt-v8', S.ebt);
    const claimBody = await act('claim');
    const ebtAfter = await ledgerOf(dn, 'ebt-v8', S.ebt);
    console.log(`[relay]   EBT dividendMinted ${ebtBefore._dividendMinted} -> ${ebtAfter._dividendMinted}`);
    await act('touchLiveness');
    await act('requestPayoutChange', '32'.repeat(32));
    const mid = await relay.memberState(S.memberId);
    console.log(`[relay]   pending payout ${JSON.stringify(mid.pendingPayout)}`);
    if (!mid.pendingPayout || mid.pendingPayout.payoutHex !== '32'.repeat(32)) throw new Error('payout change not pending');
    await act('cancelPayoutChange');
    if ((await relay.memberState(S.memberId)).pendingPayout) throw new Error('payout change not cancelled');
    let refused = '';
    try { await relay.submit(claimBody); } catch (e) { refused = String(/** @type {any} */ (e)?.message ?? e); }
    if (!/signature does not verify/.test(refused)) throw new Error(`replayed claim was not refused before proving: ${refused || 'accepted'}`);
    console.log(`[relay] PASS: claim, touchLiveness, requestPayoutChange, cancelPayoutChange relayed; replayed claim refused (${refused.slice(0, 60)})`);
    S.relay = { ok: true };
    save();
  },

  // Re-run the watcher over the events already on chain.
  async watch(dn) { await watchEvents(dn, 'watch'); },

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
// 'all': a settle before LD (budget accrued with nobody registered stays in
// EBT) and one after registration, so the claim has something to mint.
const ALL = ['council', 'tariff', 'ebt', 'settle', 'ld', 'settle', 'claim', 'service', 'relay', 'watch', 'attacks'];
const order = wanted.includes('all') ? ALL : wanted;
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
