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
import { planSettleArgs } from '../settle/settle-plan.mjs';
import { createSettleWatcherService } from '../watcher/settle-watcher-service.mjs';
import { registerLaneActionHash, registerLaneArgs, findLane, assertPollPowerRemit } from '../tariff/lane.mjs';
import { deployCouncil, deployTariffRegistry, deployEbt, deployLd, suiteManifest } from '../deploy/deploy-suite.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import * as L9 from '@midnight-ntwrk/midnight-js-protocol/v9';
import { checkFinalized, buildVerifierKeys, submitMaintenance, vkInsert, vkRemove, replaceAuthority } from '../deploy/finalize.mjs';
import { devnetCouncilKey, buildCouncilConstructorArgs } from '../council/council-keys-guard.mjs';
import { signDigest, newCouncilKey } from '../../tests/contract/council-signer.mjs';
import { signMessage } from '../../tests/contract/machine-signer.mjs';
import { runtimePersistentHash, padTag } from '../../tests/parity/harness.mjs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ActionLogTree } from '../../tests/contract/settle-world.mjs';
import { signSettle, chipHwId, sessionFrom16 } from '../../tests/contract/hat-signer.mjs';
import { submitSettleWithRetry } from '../settle/submit-settle.mjs';
import { findSettleChipEvents, decodeSettleChipEvent, verifySettleChipEvent, SETTLE_CHIP_EVENT } from '../watcher/settle-watcher-lib.mjs';
import { restoreIndexerMiscEvent, payloadWords } from '../events/event-codec.mjs';
import { parsePublicKey, parseSignature, nobleVerify, normalizeS } from '../tangem/ring-signature.mjs';
import { channelsFromEnv, demoLabelledSink } from '../watcher/alert-channels.mjs';
import { webhookSink } from '../watcher/settle-watcher-loop.mjs';
import readline from 'node:readline';

const big = (/** @type {Uint8Array} */ b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const label = (/** @type {string} */ s) => new Uint8Array(createHash('sha256').update(`pollpower wi16 devnet ${s} (test key, not a secret)`).digest());
// Devnet council keys: marked (x starts 0xDE7E) and hard-blocked off-devnet.
const COUNCIL = [0, 1, 2].map(devnetCouncilKey);
const hexToBytes = (/** @type {string} */ h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

// Recorded-demo mode (Garrett, 2026-11-24): council slot 0 is a REAL Tangem
// ring (public key from the off-chain council keys file, DEVNET_RING_KEYS;
// whose ring: DEVNET_RING_HOLDER, required), slots 1-2 are devnet keys.
// Software approvals then use slots 1+2; the ring signs live in demo-ring.
// Demo runs keep their own state (DEVNET_STATE_FILE) and never count as a pass.
const RING = (() => {
  const f = process.env.DEVNET_RING_KEYS;
  if (!f) return null;
  const holder = process.env.DEVNET_RING_HOLDER;
  if (!holder) throw new Error('DEVNET_RING_HOLDER is required with DEVNET_RING_KEYS');
  const entry = JSON.parse(fs.readFileSync(f, 'utf8')).council?.find((/** @type {any} */ c) => String(c.holder).toLowerCase() === holder.toLowerCase());
  if (!entry) throw new Error(`no council ring for holder ${holder} in ${f}`);
  return { holder, publicKey: String(entry.publicKey), point: parsePublicKey(entry.publicKey).point };
})();
const SOFT = RING ? [1, 2] : [0, 1];

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
// The Preprod class carries a statutory lane (Garrett, 2026-11-24): 300 bps here,
// minted on chain at every settle to PollPower's statutory account, which
// remits in KES off-chain with a logged remittance (Garrett, 2026-11-25).
export const SPLIT = { producerShareBps: 5700n, ldShareBps: 1000n, opsShareBps: 2000n, daoShareBps: 500n, operatorMarginBps: 500n, statutoryTotalBps: 300n };
/** The devnet's statutory lane (scheduleId filled in at registration). */
const LANE = {
  laneKindByte: 1n, leviedBy: label('lane levied by'), bpsShare: 300n, remitAddress: label('lane remit address'),
  basis: 0n, applicabilityHash: label('lane applicability'), statuteRefHash: label('lane statute ref'),
  effectiveEpoch: 1n, remittanceMode: 1n,
};

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

// A full pass ('all') is valid only from a fresh state: fresh council, keys
// and contracts on the devnet, nothing resumed (Garrett, 2026-11-24).
const RUN_ALL = process.argv.slice(2).includes('all');
if (RING && (RUN_ALL || state.isDefault)) {
  console.error('[stack] REFUSING: ring (demo) mode needs its own DEVNET_STATE_FILE and is never a full pass');
  process.exit(3);
}
if (RUN_ALL && state.exists()) {
  console.error(`[stack] REFUSING 'all': run state already exists (${state.file}). A full pass must start fresh: move it aside first.`);
  process.exit(3);
}
const S = state.load();
const save = () => state.save(S);

/** The devnet's inputs to the shared deploy suite (Preprod passes real ones). */
const DEVNET_INPUTS = {
  council: { points: RING ? [RING.point, COUNCIL[1].point, COUNCIL[2].point] : COUNCIL.map((k) => k.point), threshold: 2n },
  tariff: { governanceRoot: charterRoot, refRateFiatPerKwh: 100n, validatorPk: VALIDATOR.pk, witnesses: TR_WITNESSES },
  ebt: {
    ownerPk: OWNER.pk, meterAuthorityPk: METER_AUTHORITY.pk, escrowAttestorPk: ESCROW.pk,
    operationsRecipient: '21'.repeat(32), daoRecipient: '23'.repeat(32),
  },
  ld: { witnesses: LD_WITNESSES },
};
/** The run record IS the stack state: the suite resumes a step from it. */
const suiteCtx = (/** @type {any} */ dn) => ({ dn, rec: S, save });

// --- recorded-demo helpers ---------------------------------------------------
const MEMBER2 = { ...jubjub('ld member 2'), payout: new Uint8Array(32).fill(0x32), kyc: new Uint8Array(32).fill(0xd2) };
const demoState = () => (S.demo ??= {});
const hx = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString('hex');
const short = (/** @type {Uint8Array | string} */ b) => { const h = typeof b === 'string' ? b : hx(b); return h.length > 16 ? `${h.slice(0, 8)}...${h.slice(-4)}` : h; };
const scene = (/** @type {number} */ n, /** @type {string} */ title) => console.log(`\n=== ${n}. ${title} ===`);
const say = (/** @type {string} */ s) => console.log(`  ${s}`);
/** Runs `fn`, printing how long it took (proof generation dominates). */
async function timed(/** @type {string} */ what, /** @type {() => Promise<any>} */ fn) {
  const t0 = Date.now();
  say(`${what} ...`);
  const r = await fn();
  say(`  done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return r;
}
/** The ring's shared result: DEMO_RING_RESULT=<file>, or pasted on stdin. */
async function readRingResult() {
  if (process.env.DEMO_RING_RESULT) return JSON.parse(fs.readFileSync(process.env.DEMO_RING_RESULT, 'utf8'));
  say('Sign it with the ring (admin app > Ring signature test), then paste the shared result here:');
  const rl = readline.createInterface({ input: process.stdin });
  let buf = '';
  for await (const line of rl) {
    buf += `${line}\n`;
    try { const j = JSON.parse(buf); rl.close(); return j; } catch { /* keep reading */ }
  }
  throw new Error('no ring result received');
}
/** Settle fields for a stored demo session { sid16, uwh, uptime, nonce }. */
const demoFields = (/** @type {any} */ d) => {
  const uwh = BigInt(d.uwh);
  return {
    sessionID: sessionFrom16(hexToBytes(d.sid16)), amount: uwh / 1000n, producerKey: PRODUCER.key, producerAddr: { bytes: PRODUCER.payout },
    meterKeyHash: PRODUCER.meter, chipHwId: chipHwId(CHIP), chipSessionUwh: uwh, chipUptimeMs: BigInt(d.uptime), chipNonce: BigInt(d.nonce),
  };
};
/** Council slots that have approved `actionHash` (epoch 0). */
async function approvalSlots(/** @type {any} */ dn, /** @type {Uint8Array} */ actionHash) {
  const msMod = await loadModule('multisig-v8');
  const st = await liveState(dn, 'multisig-v8', S.council);
  const V3 = new RT.CompactTypeVector(3, new RT.CompactTypeBytes(32));
  const key = RT.persistentHash(V3, [padTag('pp:ms:v8:approvalKey'), actionHash, new Uint8Array(32)]);
  const a = msMod.ledger(st.data)._approvals;
  return a.member(key) ? [0n, 1n, 2n].filter((i) => a.lookup(key).member(i)).map(String) : [];
}
/** The settleChip event for `sessionID`, read from the indexer and verified as the watcher does. */
async function settleEventFor(/** @type {any} */ dn, /** @type {Uint8Array} */ sessionID) {
  for (let tries = 0; tries < 6; tries++) {
    const evs = await /** @type {any} */ (dn.providersFor('ebt-v8')).publicDataProvider.queryContractEvents({ contractAddress: S.ebt, types: ['Misc'] });
    const L = await ledgerOf(dn, 'ebt-v8', S.ebt);
    for (const e of evs) {
      let r;
      try { r = restoreIndexerMiscEvent(e); } catch { continue; }
      if (r.name !== SETTLE_CHIP_EVENT) continue;
      const ev = decodeSettleChipEvent(r.bytes);
      if (hx(ev.sessionId) !== hx(sessionID)) continue;
      return verifySettleChipEvent(ev, L._chips.member(ev.chipPubkey) ? L._chips.lookup(ev.chipPubkey) : null);
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  return null;
}

/**
 * Syncs an EBT's root mirror with the TariffRegistry (syncRegistryRoot, a
 * cross-contract read; fix #5), then mirrors the TR schedule + class (and the
 * statutory lane once it exists) through action-log proofs, and attests the
 * producer (owner signature). `flags` records progress (S or S.atk).
 * `joinAs`: the build to call through (the ceremony build mid-deploy).
 */
async function mirrorAndAttest(dn, ebtAddress, flags, joinAs, { lane = true } = {}) {
  const trL = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
  const P = (await loadModule('ebt-v8')).pureCircuits;
  const ebt = await join(dn, joinAs, ebtAddress);
  const self = hexToBytes(ebtAddress);
  let eL = await ledgerOf(dn, 'ebt-v8', ebtAddress);
  if (eL._registryActionLogCountMirror !== trL._actionSeq) {
    await ebt.callTx.syncRegistryRoot();
    eL = await ledgerOf(dn, 'ebt-v8', ebtAddress);
    console.log(`[stack] EBT synced with the registry: ${eL._registryActionLogCountMirror} entries, root ${Buffer.from(eL._registryActionLogRootMirror).toString('hex').slice(0, 16)}...`);
  }
  // Rebuild the action log exactly as the TR holds it (checked against the root EBT read from TR).
  const tree = new ActionLogTree();
  const entries = [];
  for (let i = 0n; i < trL._actionSeq; i++) { const e = trL._actionLog.lookup(i); entries.push(e); tree.append(e.payloadHash); }
  if (Buffer.from(tree.root()).toString('hex') !== Buffer.from(eL._registryActionLogRootMirror).toString('hex')) {
    throw new Error('JS action-log tree != the root EBT read from the TariffRegistry');
  }
  const sid = hexToBytes(S.scheduleId);
  if (!flags.mirrored) {
    await ebt.callTx.mirrorScheduleLifecycle(entries[0], trL._registeredSchedules.lookup(sid), tree.proof(0));
    await ebt.callTx.mirrorClassStatutoryTotal(entries[1], sid, CLASS, SPLIT, 100n, BigInt(S.retuneTime), tree.proof(1));
    flags.mirrored = true;
    save();
    console.log('[stack] schedule + class mirrored into EBT');
  }
  if (lane && !flags.laneMirrored) {
    const seq = entries.findIndex((e) => Number(e.kind) === 1);
    if (seq < 0) throw new Error('no LANE_REGISTERED entry in the TariffRegistry action log');
    const rec = findLane(trL, sid, LANE.leviedBy, LANE.laneKindByte);
    await ebt.callTx.mirrorRegisterLane(entries[seq], rec, tree.proof(seq));
    flags.laneMirrored = true;
    save();
    console.log(`[stack] statutory lane mirrored into EBT (action ${seq})`);
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

/**
 * The statutory lane: council-approved registerLane on the TariffRegistry.
 * Runs AFTER EBT is deployed and mirrored (fix #5), so every run exercises a
 * registry change that EBT must catch up with: sync, re-mirror, then settle.
 */
async function registerStatutoryLane(dn) {
  if (S.laneRegistered) return;
  const tr = await join(dn, 'tariff-registry-v1', S.tr, TR_WITNESSES);
  const self = hexToBytes(S.tr);
  const lane = { ...LANE, scheduleId: hexToBytes(S.scheduleId) };
  assertPollPowerRemit(lane, [LANE.remitAddress]);   // devnet: the one PollPower statutory account
  const t = nowSec();
  let L = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
  await approve(dn, registerLaneActionHash(self, lane, L._currentEpoch, t));
  await tr.callTx.registerLane(...registerLaneArgs(lane), charterProof, t);
  L = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
  const rec = findLane(L, lane.scheduleId, lane.leviedBy, lane.laneKindByte);
  S.laneRegistered = true;
  save();
  console.log(`[stack] registry change after EBT's deploy: statutory lane registered: kind ${rec.laneKindByte}, ${rec.bpsShare} bps, remit mode ${rec.remittanceMode}, effective epoch ${rec.effectiveEpoch}`);
}

/** Approve `actionHash` on the council with slots 0 and 1 (2-of-3). */
async function approve(dn, actionHash, slots = SOFT) {
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
    await deployCouncil(suiteCtx(dn), DEVNET_INPUTS.council);
    // One on-chain approval end to end (in-circuit secp256k1, real proof).
    const probe = label('council probe action');
    await approve(dn, probe, [SOFT[0]]);
    // Read the approval back from the council's ledger (epoch 0: the epoch word is 32 zero bytes).
    const msMod = await loadModule('multisig-v8');
    const st = await liveState(dn, 'multisig-v8', S.council);
    const V3 = new RT.CompactTypeVector(3, new RT.CompactTypeBytes(32));
    const pad = new Uint8Array(32); pad.set(new TextEncoder().encode('pp:ms:v8:approvalKey'));
    const key = RT.persistentHash(V3, [pad, probe, new Uint8Array(32)]);
    const approvals = msMod.ledger(st.data)._approvals;
    const recorded = approvals.member(key) && approvals.lookup(key).member(BigInt(SOFT[0]));
    if (!recorded) throw new Error(`council probe approval (slot ${SOFT[0]}) is not recorded in the council ledger`);
    console.log(`[stack] council at ${S.council}${RING ? ` (slot 0: ${RING.holder}'s Tangem ring)` : ''}; probe approval by slot ${SOFT[0]} recorded in the ledger`);
    S.councilProbe = true;
    save();
  },

  // TariffRegistry: staged deploy (ceremony variant + missing verifier keys),
  // bootstrap, a council-approved + validator-signed schedule, a retuned class.
  async tariff(dn) {
    await deployTariffRegistry(suiteCtx(dn), DEVNET_INPUTS.tariff);
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
      console.log(`[stack] class retuned (statutory ${SPLIT.statutoryTotalBps} bps)`);
    }
  },

  // EBT: staged deploy, registry mirrors through action-log proofs, producer
  // attestation (owner), a council-registered devnet chip.
  async ebt(dn) {
    const trL = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
    await deployEbt(suiteCtx(dn), DEVNET_INPUTS.ebt);
    const ebtMod = await loadModule('ebt-v8');
    const P = ebtMod.pureCircuits;
    const ebt = await join(dn, 'ebt-v8', S.ebt);
    const self = hexToBytes(S.ebt);
    await mirrorAndAttest(dn, S.ebt, S, 'ebt-v8', { lane: false });
    // A registry change after EBT's deploy (the lane), then sync + re-mirror (fix #5).
    await registerStatutoryLane(dn);
    await mirrorAndAttest(dn, S.ebt, S, 'ebt-v8');
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
    await deployLd(suiteCtx(dn), DEVNET_INPUTS.ld);
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
      const { address } = await deploy(dn, 'ebt-v8-ceremony', [
        OWNER.pk, METER_AUTHORITY.pk, { bytes: hexToBytes(S.council) },
        { bytes: new Uint8Array(32).fill(0x21) }, { bytes: new Uint8Array(32).fill(0x23) }, ESCROW.pk,
        { bytes: hexToBytes(S.tr) },
      ]);
      A.ebt = address;
      save();
    }
    dn.bind(A.ebt, 'ebt-v8');
    await mirrorAndAttest(dn, A.ebt, A, 'ebt-v8-ceremony');
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
      const args = planSettleArgs({
        ebtModule: ebtMod, ledger: await ledgerOf(dn, 'ebt-v8', A.ebt), fields: f, chip: s,
        scheduleId: hexToBytes(S.scheduleId), classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: nowSec(),
      });
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

    // RA-chain (fix #5): no key can install a root. The finalized EBT has no
    // root or head setter, and its root is the one it read from the registry.
    {
      const st = await liveState(dn, 'ebt-v8', A.ebt);
      const noSetter = ['mirrorActionLogRoot', 'mirrorActionLogHead'].every((id) => st.operation(id) === undefined)
        && st.operation('syncRegistryRoot') !== undefined;
      const eL = await ledgerOf(dn, 'ebt-v8', A.ebt);
      const tL = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
      const same = Buffer.from(eL._registryActionLogRootMirror).equals(Buffer.from(tL.registryActionLogRoot));
      check('RA-chain no circuit takes a root; EBT root = registry root', noSetter && same,
        `setters absent: ${noSetter}; root ${Buffer.from(eL._registryActionLogRootMirror).toString('hex').slice(0, 16)}... = TR's: ${same}`);
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`[attack] ${results.length - failed.length}/${results.length} passed`);
    S.attackResults = results;
    save();
    if (failed.length) throw new Error(`staged-deploy attacks: ${failed.map((r) => r.id).join('; ')}`);
  },

  // Council rotation on chain (Preprod gate). The 72 h delay cannot elapse
  // on the devnet, so: 2-of-3 approve a rotation (slot 2 -> a standby key),
  // schedule it, check readyAt = schedule time + 72 h, check that an early
  // execute is refused, then cancel it with a 2-of-3 approval; the council
  // and its generation are unchanged afterwards. Execute itself is covered by
  // R-1/R-4 and C1b-TR-8 (contract tests with a controlled clock).
  async rotation(dn) {
    const ms = await loadModule('multisig-v8');
    const P = ms.pureCircuits;
    const council = await join(dn, 'multisig-v8', S.council);
    const self = hexToBytes(S.council);
    let L = await ledgerOf(dn, 'multisig-v8', S.council);
    const before = { epoch: L._epoch, slot2: L._adminPks.lookup(2n) };
    if (!S.rotation) {
      const standby = newCouncilKey().point;   // devnet only, never stored as a key
      S.rotation = { standby: { x: String(standby.x), y: String(standby.y) } };
      save();
    }
    const standby = { x: BigInt(S.rotation.standby.x), y: BigInt(S.rotation.standby.y), identity: false };
    const [slots] = buildCouncilConstructorArgs([COUNCIL[0].point, COUNCIL[1].point, standby], 2n, 'undeployed');
    if (!S.rotation.scheduled) {
      const h = P.rotationHash(self, L._epoch, L._rotationSeq, slots, 3n, 2n);
      await approve(dn, h, [0, 1]);
      const t = nowSec();
      await council.callTx.scheduleRotation(slots, 3n, 2n, t);
      S.rotation.scheduled = { at: String(t), hash: Buffer.from(h).toString('hex') };
      save();
      console.log(`[rotation] scheduled ${S.rotation.scheduled.hash.slice(0, 16)}... at ${t}`);
    }
    L = await ledgerOf(dn, 'multisig-v8', S.council);
    if (!S.rotation.cancelled) {
      if (!L._rotationPending) throw new Error('rotation not pending after schedule');
      if (L._rotationReadyAt !== BigInt(S.rotation.scheduled.at) + 259_200n) throw new Error(`readyAt ${L._rotationReadyAt} != schedule time + 72 h`);
      let refused = '';
      try { await council.callTx.executeRotation(slots, 3n, 2n); } catch (e) { refused = String(/** @type {any} */ (e)?.message ?? e); }
      if (!/ROTATION_NOT_READY/.test(refused)) throw new Error(`early execute was not refused as ROTATION_NOT_READY: ${refused.slice(0, 200) || 'it went through'}`);
      console.log('[rotation] early execute refused: ROTATION_NOT_READY');
      const ch = P.cancelRotationHash(self, L._epoch, L._pendingRotationHash);
      await approve(dn, ch, [0, 2]);
      await council.callTx.cancelRotation();
      S.rotation.cancelled = true;
      save();
    }
    L = await ledgerOf(dn, 'multisig-v8', S.council);
    if (L._rotationPending) throw new Error('rotation still pending after cancel');
    if (L._epoch !== before.epoch || L._adminPks.lookup(2n).x !== before.slot2.x) throw new Error('council changed by a cancelled rotation');
    console.log(`[rotation] PASS: 2-of-3 schedule (readyAt +72 h), early execute refused, 2-of-3 cancel; council and generation ${L._epoch} unchanged`);
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
    const chain = await createEbtSettleChain({
      providers, ebtBuildDir: buildDir('ebt-v8'), ebtAddress: S.ebt,
      registryAddress: S.tr, registryBuildDir: buildDir('tariff-registry-v1'),
    });
    // Registry gate on the real path (fix #5): a registry entry EBT has not
    // synced (a retune to the same split, nonce 2), so the adapter's first
    // settle must sync EBT itself, re-check, then plan.
    if (!S.gateRetuned) {
      const trMod = await loadModule('tariff-registry-v1');
      const P = trMod.pureCircuits;
      const tr = await join(dn, 'tariff-registry-v1', S.tr, TR_WITNESSES);
      const trSelf = hexToBytes(S.tr);
      const sid = hexToBytes(S.scheduleId);
      const t = nowSec();
      const L = await ledgerOf(dn, 'tariff-registry-v1', S.tr);
      const auth = P.retuneAuthHash(trSelf, sid, CLASS, SPLIT, 100n, L._currentEpoch, 2n, t);
      await tr.callTx.retuneClass(sid, CLASS, SPLIT, 100n, OPERATOR.pk, signMessage(P.signerMessage(auth), OPERATOR.sk), 2n, t,
        { quotient: 20n, remainder: 0n }, { quotient: 20n, remainder: 0n });
      S.gateRetuned = true;
      save();
    }
    {
      const trN = (await ledgerOf(dn, 'tariff-registry-v1', S.tr))._actionSeq;
      const ebtN = (await ledgerOf(dn, 'ebt-v8', S.ebt))._registryActionLogCountMirror;
      console.log(`[service] gate setup: registry ${trN} entries, EBT synced ${ebtN}`);
      S.gateBefore = { registry: String(trN), ebt: String(ebtN) };
      save();
    }
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
    {
      const trN = (await ledgerOf(dn, 'tariff-registry-v1', S.tr))._actionSeq;
      const ebtN = (await ledgerOf(dn, 'ebt-v8', S.ebt))._registryActionLogCountMirror;
      if (trN !== ebtN) throw new Error(`registry gate did not sync EBT (registry ${trN}, EBT ${ebtN})`);
      console.log(`[service] gate: EBT synced by the adapter (${S.gateBefore?.ebt} -> ${ebtN} of ${trN}), re-checked, settled`);
      S.gateSynced = { registry: String(trN), ebt: String(ebtN) };
      save();
    }

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

  // Watcher end to end on chain: a settle with a GARBAGE chip signature but a
  // valid meter-authority countersignature (a compromised service, or a
  // firmware still signing host hashes) is ACCEPTED by the contract (ledger 9
  // cannot verify Ed25519); the watcher must alert every council member for
  // exactly that settle and stay silent on every genuine one.
  async watcher(dn) {
    const ebtMod = await loadModule('ebt-v8');
    const ebt = await join(dn, 'ebt-v8', S.ebt);
    const self = hexToBytes(S.ebt);
    if (!S.badSettle) {
      const amount = 1_000n;
      const sid16 = new Uint8Array(createHash('sha256').update(`bad chip sig ${S.ebt} ${Date.now()}`).digest()).slice(0, 16);
      const f = {
        sessionID: sessionFrom16(sid16), amount, producerKey: PRODUCER.key, producerAddr: { bytes: PRODUCER.payout },
        meterKeyHash: PRODUCER.meter, chipHwId: chipHwId(CHIP), chipSessionUwh: amount * 1000n + 5n,
        chipUptimeMs: 9_000_000n, chipNonce: BigInt(Date.now()) * 7n,
      };
      const genuine = signSettle(ebtMod, { addressBytes: self }, f, { chip: CHIP, hatSk: METER_AUTHORITY.sk });
      // Forge: garbage chip signature, then countersign THAT (as a compromised service would).
      const chipSigR = new Uint8Array(32).fill(0x0b), chipSigS = new Uint8Array(32).fill(0x0d);
      const rd = ebtMod.pureCircuits.settleRecordDigest(self, f.sessionID, f.amount, f.producerKey, f.producerAddr, f.meterKeyHash, f.chipHwId, f.chipSessionUwh, f.chipUptimeMs, f.chipNonce);
      const hatSig = RT.jubjubSchnorrSign(MSG1, [ebtMod.pureCircuits.hatMessage(self, rd, genuine.chipPubkey, chipSigR, chipSigS)], METER_AUTHORITY.sk);
      const args = planSettleArgs({
        ebtModule: ebtMod, ledger: await ledgerOf(dn, 'ebt-v8', S.ebt), fields: f,
        chip: { chipPubkey: genuine.chipPubkey, chipSigR, chipSigS, hatSig },
        scheduleId: hexToBytes(S.scheduleId), classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: nowSec(),
      });
      const r = await ebt.callTx.settle(...args);
      S.badSettle = { tx: r?.public?.txId, sessionId: Buffer.from(f.sessionID).toString('hex') };
      save();
      console.log(`[watcher] forged-chip-signature settle ACCEPTED on chain (tx ${S.badSettle.tx}): the watcher's case`);
    }
    const got = { garrett: [], member1: [], member2: [] };
    const sinks = Object.keys(got).map((m) => ({ member: m, send: async (/** @type {any} */ a) => { /** @type {any} */ (got)[m].push(a); } }));
    const stateFile = path.join(ROOT, 'build', 'devnet', `watcher-${S.ebt.slice(0, 8)}-${Date.now()}.json`);
    const svc = await createSettleWatcherService({ publicDataProvider: dn.providersFor('ebt-v8').publicDataProvider, ebtBuildDir: buildDir('ebt-v8'), ebtAddress: S.ebt, sinks, stateFile });
    const r = await svc.pass();
    console.log(`[watcher] pass: checked ${r.checked}, alerts ${r.alerts}`);
    for (const [m, a] of Object.entries(got)) console.log(`[watcher]   ${m}: ${a.length} alert(s) ${a.map((x) => `${x.problems.join(',')} session ${String(x.sessionId).slice(0, 12)}`).join('; ')}`);
    const ok = r.alerts === 1 && Object.values(got).every((a) => a.length === 1 && a[0].sessionId === S.badSettle.sessionId && a[0].problems.includes('bad_chip_signature'));
    if (!ok) throw new Error('watcher did not alert every council member for exactly the forged settle');
    const again = await svc.pass();
    if (again.alerts !== 0) throw new Error('watcher re-alerted an already-processed event');
    console.log('[watcher] PASS: forged settle alerted to all 3 council members once; genuine settles silent; no re-alert');
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
    // Split planned from EBT's live mirrors (class + statutory lane), as pp-settle-service does.
    const args = planSettleArgs({
      ebtModule: ebtMod, ledger: await ledgerOf(dn, 'ebt-v8', S.ebt), registryLedger: await ledgerOf(dn, 'tariff-registry-v1', S.tr),
      fields: f, chip: s, scheduleId: hexToBytes(S.scheduleId), classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: nowSec(),
    });
    console.log(`[stack] planned split: producer ${args[24]}, ops ${args[25]}, dividend ${args[26]}, dao ${args[27]}, lanes ${args[19].join('/')}`);
    if (args[19][0] !== (amount * LANE.bpsShare) / 10000n) throw new Error('settle plan does not pay the statutory lane');
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

  // ---------------------------------------------------------------------------
  // Recorded demo (Garrett, 2026-11-24), on a ring-mode stack prepared with
  //   DEVNET_RING_KEYS=... DEVNET_STATE_FILE=build/devnet/demo-state.json \
  //     node tooling/devnet/stack.mjs council tariff ebt settle ld settle
  // then, on camera: demo-ring demo-settle demo-claim demo-attack demo-forged
  // (docs/demo/wi16-demo.md).
  // ---------------------------------------------------------------------------

  // 1. A council approval signed by the real Tangem ring (slot 0) + slot 1:
  //    registering a new Living Dividend member.
  async 'demo-ring'(dn) {
    if (!RING) throw new Error('demo-ring needs ring mode (DEVNET_RING_KEYS)');
    const D = demoState();
    const ms = await loadModule('multisig-v8');
    const P = (await loadModule('living-dividend-v3')).pureCircuits;
    D.regTime ??= String(nowSec());
    save();
    const t = BigInt(D.regTime);
    const h = P.registerActionHash(hexToBytes(S.ld), MEMBER2.pk, { bytes: MEMBER2.payout }, MEMBER2.kyc, t);
    const digest = ms.pureCircuits.approvalDigest(hexToBytes(S.council), h, 0n);
    scene(1, 'Council approval, signed by a Tangem ring');
    say(`Council: Multisig v8 ${short(S.council)}, 2-of-3. Slot 0 is ${RING.holder}'s Tangem ring; on this devnet slots 1-2 stand in for the other two members.`);
    say(`Action: register Living Dividend member ${short(P.memberId(MEMBER2.pk))} (after KYC).`);
    const council = await join(dn, 'multisig-v8', S.council);
    if (!D.ringApproved) {
      const digestHex = hx(digest);
      fs.writeFileSync(path.join(ROOT, 'build', 'devnet', 'demo-ring-digest.txt'), `${digestHex}\n`);
      say(`Hash for the ring: ${digestHex}`);
      const res = await readRingResult();
      if (String(res.hash).toLowerCase() !== digestHex) throw new Error('the ring signed a different hash');
      const pk = parsePublicKey(String(res.walletPublicKey ?? res.publicKey));
      if (pk.x !== RING.point.x || pk.y !== RING.point.y) throw new Error('the signature is not from the ring in council slot 0');
      const sig = parseSignature(String(res.signature));
      if (!nobleVerify(digest, sig.r, sig.s, pk).lowSNotRequired) throw new Error('the ring signature does not verify');
      say(`Ring signature received (${sig.encoding}); it verifies against the slot-0 key.`);
      await timed('Submitting the ring approval (secp256k1 checked inside the circuit, real proof)',
        () => council.callTx.approve(h, 0n, { r: sig.r, s: normalizeS(sig.s) }));
      D.ringApproved = true;
      save();
    }
    if (!D.secondApproved) {
      await timed('Second member approves (slot 1)', () => council.callTx.approve(h, 1n, signDigest(digest, COUNCIL[1].sk)));
      D.secondApproved = true;
      save();
    }
    const slots = await approvalSlots(dn, h);
    say(`Council ledger: approved by slots ${slots.join(' and ')} (threshold 2 met).`);
    if (!D.member2) {
      const ld = await join(dn, 'living-dividend-v3', S.ld, LD_WITNESSES);
      await timed('Registering the member (Living Dividend asks the council, contract to contract)',
        () => ld.callTx.register(MEMBER2.pk, { bytes: MEMBER2.payout }, MEMBER2.kyc, t));
      D.member2 = hx(P.memberId(MEMBER2.pk));
      save();
    }
    say(`Member ${short(D.member2)} is registered.`);
  },

  // 2. A metered settle: the chip's native attestation, the meter authority's
  //    countersignature, a split planned from the class (incl. the statutory
  //    lane); then the public event, re-verified the way the watcher does.
  async 'demo-settle'(dn) {
    const D = demoState();
    const ebtMod = await loadModule('ebt-v8');
    const ebt = await join(dn, 'ebt-v8', S.ebt);
    scene(2, 'A metered settle with the chip attestation');
    D.settle ??= { sid16: hx(new Uint8Array(createHash('sha256').update(`demo settle ${S.ebt} ${Date.now()}`).digest()).slice(0, 16)), uwh: '12345678', uptime: '5400000', nonce: String(Date.now()) };
    save();
    const f = demoFields(D.settle);
    const s = signSettle(ebtMod, { addressBytes: hexToBytes(S.ebt) }, f, { chip: CHIP, hatSk: METER_AUTHORITY.sk });
    say(`HAT chip ${CHIP.ieee.toString('hex')} (devnet software chip) signed its reading: ${f.chipSessionUwh} uWh over ${Number(f.chipUptimeMs) / 60000} min, nonce ${f.chipNonce}.`);
    say(`meter-authority-service checked that signature and countersigned. Amount = floor(uWh / 1000) = ${f.amount} EBT.`);
    const L0 = await ledgerOf(dn, 'ebt-v8', S.ebt);
    if (L0._settledSessions.member(f.sessionID)) { say('(already settled in an earlier take)'); return; }
    const args = planSettleArgs({ ebtModule: ebtMod, ledger: L0, fields: f, chip: s, scheduleId: hexToBytes(S.scheduleId), classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: nowSec() });
    say(`Split from the class on chain: producer ${args[24]}, operations ${args[25]}, Living Dividend ${args[26]}, DAO ${args[27]}, statutory lane ${args[19][0]} (paid on chain to the lane's remit address).`);
    const r = await timed('Proving and submitting settle', () => submitSettleWithRetry({
      args, submit: (a) => ebt.callTx.settle(...a),
      alreadySettled: async () => (await ledgerOf(dn, 'ebt-v8', S.ebt))._settledSessions.member(f.sessionID),
    }));
    const L1 = await ledgerOf(dn, 'ebt-v8', S.ebt);
    say(`Settled (tx ${short(String(r.tx?.public?.txId ?? '-'))}). EBT supply ${L0._totalSupply} -> ${L1._totalSupply}; dividend accrued ${L0._dividendAccrued} -> ${L1._dividendAccrued}.`);
    const ev = await settleEventFor(dn, f.sessionID);
    say(ev ? `Public settleChip event re-verified from the indexer: chip registered and active, Ed25519 signature ${ev.ok ? 'VALID' : 'INVALID: ' + ev.problems.join(',')}.` : 'settleChip event not yet indexed');
  },

  // 3. The new member claims Living Dividend: LD -> EBT dividendAccrued, then
  //    LD -> EBT mintDividend (a mint inside a contract-to-contract call).
  async 'demo-claim'(dn) {
    const D = demoState();
    if (!D.member2) throw new Error('run demo-ring first');
    const P = (await loadModule('living-dividend-v3')).pureCircuits;
    scene(3, 'The member claims Living Dividend');
    const id = hexToBytes(D.member2);
    const ld = await join(dn, 'living-dividend-v3', S.ld, LD_WITNESSES);
    const ldL = await ledgerOf(dn, 'living-dividend-v3', S.ld);
    const before = await ledgerOf(dn, 'ebt-v8', S.ebt);
    const nonce = ldL._members.lookup(id).nonce;
    const t = nowSec();
    say(`Member ${short(id)} signs a claim with their own key (Jubjub Schnorr, nonce ${nonce}).`);
    const sig = RT.jubjubSchnorrSign(MSG1, [P.memberMessage(hexToBytes(S.ld), padTag('claim'), id, P.timeDigest(t), nonce)], MEMBER2.sk);
    const r = await timed('Proving and submitting claim (LD calls EBT twice in one transaction)', () => ld.callTx.claim(id, t, sig));
    const after = await ledgerOf(dn, 'ebt-v8', S.ebt);
    say(`Claimed (tx ${short(String(r?.public?.txId ?? '-'))}): ${after._dividendMinted - before._dividendMinted} EBT minted straight to the member's payout address.`);
    say(`EBT dividend minted ${before._dividendMinted} -> ${after._dividendMinted}.`);
  },

  // 4. Attacks, refused by the contract (no state change).
  async 'demo-attack'(dn) {
    const D = demoState();
    if (!D.settle) throw new Error('run demo-settle first');
    const ebtMod = await loadModule('ebt-v8');
    const ebt = await join(dn, 'ebt-v8', S.ebt);
    scene(4, 'Attacks, refused');
    const L0 = await ledgerOf(dn, 'ebt-v8', S.ebt);
    const plan = (/** @type {any} */ f, /** @type {any} */ s) => planSettleArgs({ ebtModule: ebtMod, ledger: L0, fields: f, chip: s, scheduleId: hexToBytes(S.scheduleId), classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: nowSec() });
    let accepted = 0;
    const attempt = async (/** @type {string} */ what, /** @type {any[]} */ args) => {
      try {
        await ebt.callTx.settle(...args);
        accepted++;
        say(`!! ACCEPTED  ${what}`);
      } catch (e) {
        const msg = [/** @type {any} */ (e)?.message, /** @type {any} */ (e)?.cause?.message].filter(Boolean).join(' ');
        const why = msg.match(/Session already settled|CHIP_[A-Z_]+|SLICE_OFF_POLICY|LANE_SUM_MISMATCH|SPLIT_OFF_CLASS|[A-Z][A-Z_]{6,}/)?.[0] ?? msg.slice(0, 80);
        say(`REFUSED  ${what}: ${why}`);
      }
    };
    // a) replay the settle just made (same session, same chip nonce), freshly countersigned
    {
      const f = demoFields(D.settle);
      await attempt('Replay the same metered session', plan(f, signSettle(ebtMod, { addressBytes: hexToBytes(S.ebt) }, f, { chip: CHIP, hatSk: METER_AUTHORITY.sk })));
    }
    // b) a valid, countersigned reading, but the submitter moves the members' dividend slice to the producer
    const fresh = demoFields({ sid16: hx(new Uint8Array(createHash('sha256').update(`demo attack ${Date.now()}`).digest()).slice(0, 16)), uwh: '8000000', uptime: '3600000', nonce: String(Date.now() + 1) });
    const s2 = signSettle(ebtMod, { addressBytes: hexToBytes(S.ebt) }, fresh, { chip: CHIP, hatSk: METER_AUTHORITY.sk });
    {
      const a = plan(fresh, s2);
      a[24] = a[24] + a[26]; a[26] = 0n;
      await attempt('Valid reading, dividend slice redirected to the producer', a);
    }
    // c) same reading, statutory lane dropped and its slice handed to the producer
    {
      const a = plan(fresh, s2);
      a[24] = a[24] + a[19][0];
      a[17] = [ZERO, ZERO, ZERO, ZERO]; a[18] = [0n, 0n, 0n, 0n]; a[19] = [0n, 0n, 0n, 0n];
      await attempt('Valid reading, statutory lane skipped', a);
    }
    const L1 = await ledgerOf(dn, 'ebt-v8', S.ebt);
    say(`EBT supply unchanged: ${L0._totalSupply} -> ${L1._totalSupply}.`);
    if (accepted || L1._totalSupply !== L0._totalSupply) throw new Error('a demo attack was accepted');
  },

  // 5. A forged settle: garbage chip signature, valid meter-authority
  //    countersignature (a compromised service). Ledger 9 cannot check Ed25519
  //    in-circuit, so the chain accepts it; the watcher catches it from the
  //    public event and alerts the council (Telegram + email when configured).
  async 'demo-forged'(dn) {
    const D = demoState();
    const ebtMod = await loadModule('ebt-v8');
    const ebt = await join(dn, 'ebt-v8', S.ebt);
    const self = hexToBytes(S.ebt);
    scene(5, 'A forged settle, caught by the watcher');
    if (!D.forged) {
      const f = demoFields({ sid16: hx(new Uint8Array(createHash('sha256').update(`demo forged ${Date.now()}`).digest()).slice(0, 16)), uwh: '1000000', uptime: '9000000', nonce: String(Date.now() * 3) });
      const genuine = signSettle(ebtMod, { addressBytes: self }, f, { chip: CHIP, hatSk: METER_AUTHORITY.sk });
      const chipSigR = new Uint8Array(32).fill(0x0b), chipSigS = new Uint8Array(32).fill(0x0d);
      const rd = ebtMod.pureCircuits.settleRecordDigest(self, f.sessionID, f.amount, f.producerKey, f.producerAddr, f.meterKeyHash, f.chipHwId, f.chipSessionUwh, f.chipUptimeMs, f.chipNonce);
      const hatSig = RT.jubjubSchnorrSign(MSG1, [ebtMod.pureCircuits.hatMessage(self, rd, genuine.chipPubkey, chipSigR, chipSigS)], METER_AUTHORITY.sk);
      say('A compromised meter-authority-service countersigns a reading whose chip signature is garbage.');
      const args = planSettleArgs({ ebtModule: ebtMod, ledger: await ledgerOf(dn, 'ebt-v8', S.ebt), fields: f, chip: { chipPubkey: genuine.chipPubkey, chipSigR, chipSigS, hatSig }, scheduleId: hexToBytes(S.scheduleId), classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: nowSec() });
      const r = await timed('Proving and submitting the forged settle', () => ebt.callTx.settle(...args));
      D.forged = { tx: r?.public?.txId, sessionId: hx(f.sessionID) };
      save();
      say(`Accepted on chain (tx ${short(String(D.forged.tx))}): ledger 9 cannot verify Ed25519 inside a circuit. That is the watcher's job.`);
    }
    const realChannels = Boolean(process.env.WATCHER_TELEGRAM_TOKEN_FILE);
    const context = { network: 'devnet (demo)', ebtAddress: S.ebt };
    let sinks;
    if (process.env.DEMO_ALERT_BRIDGE) {
      // Joi's alert bridge (one webhook per council member -> council Telegram
      // group + that member's email); every alert labelled DEMO.
      const members = String(process.env.DEMO_ALERT_MEMBERS ?? '').split(',').map((m) => m.trim()).filter(Boolean);
      if (members.length !== 3) throw new Error('DEMO_ALERT_MEMBERS must list the three bridge member keys');
      const base = process.env.DEMO_ALERT_BRIDGE.replace(/\/$/, '');
      sinks = members.map((m) => demoLabelledSink(webhookSink(m, `${base}/alert/${m}`, undefined)));
    } else if (realChannels) {
      const nodemailer = (await import('nodemailer')).default;
      sinks = channelsFromEnv(process.env, { createTransport: (o) => nodemailer.createTransport(o), context });
    } else {
      sinks = ['garrett', 'member1', 'member2'].map((m) => ({ member: `test:${m}`, send: async () => {} }));
    }
    const stateFile = path.join(ROOT, 'build', 'devnet', `demo-watcher-${S.ebt.slice(0, 8)}.json`);
    const svc = await createSettleWatcherService({ publicDataProvider: dn.providersFor('ebt-v8').publicDataProvider, ebtBuildDir: buildDir('ebt-v8'), ebtAddress: S.ebt, sinks, stateFile });
    const r = await timed('Watcher pass over every settle event from the indexer', () => svc.pass());
    say(`Checked ${r.checked} settle event(s): ${r.alerts} alert(s), for session ${short(D.forged.sessionId)}: bad_chip_signature.`);
    const pending = svc.watcher.state().pendingAlerts;
    const missing = pending.length ? sinks.filter((s) => !pending[0].deliveredTo.includes(s.member)).map((s) => s.member) : [];
    say(`Delivered to: ${sinks.map((s) => s.member).filter((m) => !missing.includes(m)).join(', ')}${missing.length ? `; retrying: ${missing.join(', ')}` : ''}.`);
    say('Council next step: verify, then 2-of-3 revokeChip; from then on settle refuses this chip.');
  },
};

const wanted = process.argv.slice(2);
if (!wanted.length) { console.error(`usage: stack.mjs <${Object.keys(STAGES).join('|')}|all> ...`); process.exit(2); }
// 'all': a settle before LD (budget accrued with nobody registered stays in
// EBT) and one after registration, so the claim has something to mint.
const ALL = ['council', 'tariff', 'ebt', 'settle', 'ld', 'settle', 'claim', 'service', 'relay', 'watcher', 'attacks', 'rotation'];
const order = wanted.includes('all') ? ALL : wanted;
// Every full pass starts on a freshly restarted proof server (Garrett,
// 2026-11-25: its memory grows across proofs; the node host OOM-killed it mid-pass).
// DEVNET_PROOF_SERVER_RESTART (required; the shell command that restarts the
// devnet proof server, kept with the ops docs) runs first; failure stops the pass.
let proofServerRestartedAt;
if (RUN_ALL) {
  const cmd = process.env.DEVNET_PROOF_SERVER_RESTART;
  if (!cmd) { console.error("[stack] REFUSING 'all': DEVNET_PROOF_SERVER_RESTART is required (the command that restarts the devnet proof server)"); process.exit(3); }
  console.log('[stack] restarting the proof server (DEVNET_PROOF_SERVER_RESTART)');
  try { execSync(cmd, { stdio: 'inherit', timeout: 120_000 }); } catch (e) {
    console.error(`[stack] REFUSING 'all': proof server restart failed (${String(/** @type {any} */ (e)?.message ?? e).slice(0, 200)})`);
    process.exit(3);
  }
  const url = `${(process.env.MIDNIGHT_PROOF_SERVER_URL ?? '').replace(/\/$/, '')}/version`;
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    try { up = (await fetch(url, { signal: AbortSignal.timeout(5000) })).ok; } catch { /* starting */ }
    if (!up) await new Promise((r) => setTimeout(r, 4000));
  }
  if (!up) { console.error(`[stack] REFUSING 'all': proof server not answering at ${url} after restart`); process.exit(3); }
  proofServerRestartedAt = new Date().toISOString();
  console.log('[stack] proof server restarted and answering');
  // ...and on a fresh one for every proof (2026-11-25: memory retained across
  // proofs pushed registerLane over the 15 GiB cap), via serialProofProvider.
  process.env.MIDNIGHT_PROOF_SERVER_RESET ??= cmd;
  console.log('[stack] proof server is restarted before every proof (MIDNIGHT_PROOF_SERVER_RESET)');
}
const dn = await openDevnet();
const PASS = RUN_ALL ? {
  startedAt: new Date().toISOString(),
  gitCommit: execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(),
  gitClean: execSync('git status --porcelain -- tooling ebt multisig tariff-registry living-dividend', { cwd: ROOT }).toString().trim() === '',
  manifest: suiteManifest(),
  proofServerResetPerProof: Boolean(process.env.MIDNIGHT_PROOF_SERVER_RESET),
  network: dn.net.networkId,
  proofServerRestartedAt,
  stages: /** @type {any[]} */ ([]),
} : null;
const writePass = (/** @type {string} */ result, /** @type {string | undefined} */ error) => {
  if (!PASS) return;
  const out = { ...PASS, result, error, finishedAt: new Date().toISOString(),
    addresses: { council: S.council, tariffRegistry: S.tr, ebt: S.ebt, livingDividend: S.ld } };
  const dir = path.join(ROOT, 'docs', 'devnet-passes');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${PASS.startedAt.replace(/[:.]/g, '-')}-${result}.json`);
  fs.writeFileSync(f, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[stack] pass record: ${f}`);
};
// Bind every deployed contract's build for cross-contract calls (TR/EBT -> Council, LD -> EBT).
if (S.council) dn.bind(S.council, 'multisig-v8');
if (S.tr) dn.bind(S.tr, 'tariff-registry-v1');
if (S.ebt) dn.bind(S.ebt, 'ebt-v8');
if (S.ld) dn.bind(S.ld, 'living-dividend-v3');
for (const st of order) if (!STAGES[st]) throw new Error(`unknown stage ${st}`);
try {
  for (const st of order) {
    console.log(`[stack] === ${st}`);
    const t0 = Date.now();
    await STAGES[st](dn);
    PASS?.stages.push({ stage: st, ok: true, seconds: Math.round((Date.now() - t0) / 1000) });
  }
} catch (e) {
  const msg = String(/** @type {any} */ (e)?.message ?? e).slice(0, 500);
  PASS?.stages.push({ stage: 'FAILED', error: msg });
  writePass('fail', msg);
  throw e;
}
writePass(PASS && PASS.gitClean ? 'pass' : 'pass-dirty-tree');
console.log(`[stack] done; state in ${state.file}`);
process.exit(0);
