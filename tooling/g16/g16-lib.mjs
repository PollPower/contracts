// @ts-check
// G16: the post-deploy setup of the Preprod suite (TariffRegistry v1, EBT v8),
// as pure planning code. Every function here takes ledger snapshots and
// returns the exact circuit call to make (and, for council-gated calls, the
// action hash the council approves). Nothing here touches a network or a key:
// tooling/g16/g16-step.mjs and tooling/council/council-approve.mjs do the I/O,
// and tests/contract/g16-setup.test.mjs runs the same plans against the
// compiled contracts in memory.
//
// Order on Preprod (docs: pollpower-ops contracts/preprod-ceremony-checklist.md, G16):
//   1 bootstrap   TR bootstrapActionLog(24)                     anyone (deploy wallet)
//   2 charter     TR advanceEpoch(1, K3, charter root)          council 2-of-3
//   3 schedule    TR registerSchedule                            council 2-of-3 + validator (K1)
//   4 retune      TR retuneClass (the class split + rate)        operator key
//   5 lane        TR registerLane (each statutory lane)          council 2-of-3
//   6 ebt-mirror  EBT syncRegistryRoot + mirror schedule/class/lanes   anyone
//   7 k5-swap     EBT execOwnerOp(1, ...) = setMeterAuthority    owner (K4)
import * as RT from '@midnight-ntwrk/compact-runtime';
import { assertJubjubKey } from '../keys/jubjub-point.mjs';
import { registerLaneActionHash, registerLaneArgs, assertPollPowerRemit } from '../tariff/lane.mjs';

export const CHARTER_DEPTH = 12;
export const ACTION_LOG_DEPTH = 24n;
/** Action-log kinds (tariff-registry-v1.compact emitAction calls). */
export const KIND = Object.freeze({ SCHEDULE: 0, LANE: 1, RETUNE: 2, SCHEDULE_RETIRED: 3, EPOCH: 4, NATIONAL: 5, LANE_RETIRED: 7 });

const ZERO = new Uint8Array(32);
const V = (/** @type {number} */ n) => new RT.CompactTypeVector(n, new RT.CompactTypeBytes(32));
const ph = (/** @type {Uint8Array[]} */ parts) => RT.persistentHash(V(parts.length), parts);
export const pad32 = (/** @type {string} */ s) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(s)); return b; };
/** (x as Field) as Bytes<32>: little-endian. */
export const le32 = (/** @type {bigint | number | string} */ n) => {
  let x = BigInt(n);
  if (x < 0n) throw new Error('negative integer');
  const b = new Uint8Array(32);
  for (let i = 0; x > 0n; i++, x >>= 8n) { if (i >= 32) throw new Error('integer exceeds 32 bytes'); b[i] = Number(x & 0xffn); }
  return b;
};
export const hex = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString('hex');
const eq = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) => Buffer.from(a).equals(Buffer.from(b));
const isZero = (/** @type {Uint8Array} */ b) => eq(b, ZERO);

/** 32-byte hex (64 chars, optional 0x) to bytes, or throws naming the field. */
export function hex32(/** @type {unknown} */ v, /** @type {string} */ name) {
  const s = String(v ?? '').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`${name} must be 32 bytes of hex (64 characters)`);
  return Uint8Array.from(Buffer.from(s, 'hex'));
}

// ---------------------------------------------------------------------------
// Charter tree (TR assertCharterMembership): depth 12, leaf = H(pad("pp:fed:charter:leaf"), nodeId),
// inner = H(pad("pp:fed:charter:node"), left, right). An empty subtree is 32
// zero bytes at every level (as the devnet and the contract tests build it).
// ---------------------------------------------------------------------------

/** @param {Uint8Array[]} nodeIds in leaf order @returns {{ root: Uint8Array, proof: (nodeId: Uint8Array) => { siblings: Uint8Array[], indices: boolean[] } }} */
export function charterTree(nodeIds) {
  if (!nodeIds.length) throw new Error('the charter needs at least one node');
  if (nodeIds.length > 2 ** CHARTER_DEPTH) throw new Error(`the charter holds at most ${2 ** CHARTER_DEPTH} nodes`);
  const seen = new Set();
  for (const n of nodeIds) {
    if (!(n instanceof Uint8Array) || n.length !== 32) throw new Error('charter node ids must be 32 bytes');
    if (isZero(n)) throw new Error('a charter node id cannot be zero');
    if (seen.has(hex(n))) throw new Error(`duplicate charter node id ${hex(n)}`);
    seen.add(hex(n));
  }
  const leafTag = pad32('pp:fed:charter:leaf'), nodeTag = pad32('pp:fed:charter:node');
  /** @type {Uint8Array[][]} */
  const levels = [nodeIds.map((n) => ph([leafTag, n]))];
  for (let l = 0; l < CHARTER_DEPTH; l++) {
    const cur = levels[l], next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i], b = cur[i + 1] ?? ZERO;
      next.push(isZero(a) && isZero(b) ? ZERO : ph([nodeTag, a, b]));
    }
    levels.push(next);
  }
  const root = levels[CHARTER_DEPTH][0];
  return {
    root,
    proof(nodeId) {
      let idx = nodeIds.findIndex((n) => eq(n, nodeId));
      if (idx < 0) throw new Error(`node ${hex(nodeId)} is not in the charter`);
      const siblings = [], indices = [];
      for (let l = 0; l < CHARTER_DEPTH; l++) {
        const right = idx % 2 === 1;
        indices.push(right);
        siblings.push(levels[l][right ? idx - 1 : idx + 1] ?? ZERO);
        idx = Math.floor(idx / 2);
      }
      return { siblings, indices };
    },
  };
}

/** TR advanceEpoch's action hash (the contract has no pure circuit for it). */
export function advanceEpochActionHash(/** @type {Uint8Array} */ tr, /** @type {bigint} */ currentEpoch, /** @type {bigint} */ newEpoch, /** @type {bigint} */ rate, /** @type {Uint8Array} */ root) {
  return ph([pad32('pp:tariff:v1:advanceEpoch'), tr, le32(currentEpoch), le32(newEpoch), le32(rate), root]);
}

/** TR retuneActionPayloadHash (kind 2), to match an action-log entry before mirroring it. */
export function retunePayloadHash(/** @type {Uint8Array} */ sid, /** @type {Uint8Array} */ classPath, /** @type {any} */ s, /** @type {bigint} */ rate, /** @type {bigint} */ at) {
  return ph([pad32('pp:tariff:v1:actionPayload'), le32(2), sid, classPath, le32(s.producerShareBps), le32(s.ldShareBps),
    le32(s.opsShareBps), le32(s.daoShareBps), le32(s.operatorMarginBps), le32(s.statutoryTotalBps), le32(rate), le32(at)]);
}
const classSplitKey = (/** @type {Uint8Array} */ sid, /** @type {Uint8Array} */ c) => ph([pad32('pp:tariff:v1:classSplitKey'), sid, c]);
const ebtClassKey = (/** @type {Uint8Array} */ sid, /** @type {Uint8Array} */ c) => ph([pad32('pp:ebt:v8:classKey'), sid, c]);
const laneKey = (/** @type {Uint8Array} */ sid, /** @type {Uint8Array} */ by, /** @type {bigint} */ kind) => ph([pad32('pp:tariff:v1:laneKey'), sid, by, le32(kind)]);

/** The sanity-band divmod witnesses retuneClass needs (both edges use ref * band% / 100). */
export function bandDiv(/** @type {bigint} */ refRate, /** @type {bigint} */ bandPct) {
  const n = refRate * bandPct * 100n;
  return { quotient: n / 10000n, remainder: n % 10000n };
}

// ---------------------------------------------------------------------------
// Parameters (an owner-only file outside the repo, like preprod-params.json)
// ---------------------------------------------------------------------------

const BPS = ['producerShareBps', 'ldShareBps', 'opsShareBps', 'daoShareBps', 'operatorMarginBps', 'statutoryTotalBps'];
const uint = (/** @type {unknown} */ v, /** @type {string} */ name, max = 2n ** 64n - 1n) => {
  if (!/^[0-9]+$/.test(String(v ?? ''))) throw new Error(`${name} must be a non-negative integer`);
  const x = BigInt(String(v));
  if (x > max) throw new Error(`${name} is too large`);
  return x;
};
const point = (/** @type {any} */ p, /** @type {string} */ name) => { assertJubjubKey(p, name); return { x: BigInt(p.x), y: BigInt(p.y) }; };

/**
 * Validates the G16 parameters and converts them to contract values.
 * @param {any} raw
 * @param {{ refRate?: bigint, ldFloorBps?: bigint, opsFloorBps?: bigint, bandPct?: bigint }} [o]
 *   refRate: K3 (the deployed reference rate; the charter step must re-pass it unchanged).
 */
export function parseG16Params(raw, o = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('G16 params: not a JSON object');
  const nodeIds = (raw.charter?.nodeIds ?? []).map((/** @type {unknown} */ n, /** @type {number} */ i) => hex32(n, `charter.nodeIds[${i}]`));
  const tree = charterTree(nodeIds);
  const refRate = uint(raw.refRateFiatPerKwh, 'refRateFiatPerKwh');
  if (refRate === 0n) throw new Error('refRateFiatPerKwh must be positive');
  if (o.refRate !== undefined && refRate !== o.refRate) throw new Error(`refRateFiatPerKwh ${refRate} differs from K3 (${o.refRate}); G16 re-passes K3 unchanged`);

  const s = raw.schedule ?? {};
  const schedule = {
    nodeId: hex32(s.nodeId, 'schedule.nodeId'),
    scheduleHash: hex32(s.scheduleHashHex, 'schedule.scheduleHashHex'),
    operatorPk: point(s.operatorPk, 'schedule.operatorPk'),
  };
  if (!nodeIds.some((n) => eq(n, schedule.nodeId))) throw new Error('schedule.nodeId is not in charter.nodeIds');
  if (isZero(schedule.scheduleHash)) throw new Error('schedule.scheduleHashHex cannot be zero');

  const c = raw.class ?? {};
  const split = Object.fromEntries(BPS.map((k) => [k, uint(c.split?.[k], `class.split.${k}`, 10000n)]));
  const sum = BPS.reduce((a, k) => a + split[k], 0n);
  if (sum !== 10000n) throw new Error(`class.split sums to ${sum} bps, must be exactly 10000`);
  if (split.ldShareBps < (o.ldFloorBps ?? 200n)) throw new Error(`class.split.ldShareBps is below the LD floor (${o.ldFloorBps ?? 200n})`);
  if (split.opsShareBps < (o.opsFloorBps ?? 2000n)) throw new Error(`class.split.opsShareBps is below the ops floor (${o.opsFloorBps ?? 2000n})`);
  const klass = { classPath: hex32(c.classPathHex, 'class.classPathHex'), split, rate: uint(c.rateFiatPerKwh, 'class.rateFiatPerKwh') };
  const delta = bandDiv(refRate, o.bandPct ?? 20n).quotient;
  if (klass.rate < refRate - delta || klass.rate > refRate + delta) throw new Error(`class.rateFiatPerKwh ${klass.rate} is outside the ±${o.bandPct ?? 20n}% band around ${refRate} (${refRate - delta}..${refRate + delta})`);

  const statutoryAccounts = (raw.statutoryAccounts ?? []).map((/** @type {unknown} */ a, /** @type {number} */ i) => hex32(a, `statutoryAccounts[${i}]`));
  const lanes = (raw.lanes ?? []).map((/** @type {any} */ l, /** @type {number} */ i) => {
    const lane = {
      laneKindByte: uint(l.laneKindByte, `lanes[${i}].laneKindByte`, 15n), leviedBy: hex32(l.leviedByHex, `lanes[${i}].leviedByHex`),
      bpsShare: uint(l.bpsShare, `lanes[${i}].bpsShare`, 10000n), remitAddress: hex32(l.remitAddressHex, `lanes[${i}].remitAddressHex`),
      basis: uint(l.basis, `lanes[${i}].basis`, 255n), applicabilityHash: hex32(l.applicabilityHashHex, `lanes[${i}].applicabilityHashHex`),
      statuteRefHash: hex32(l.statuteRefHashHex, `lanes[${i}].statuteRefHashHex`), remittanceMode: uint(l.remittanceMode, `lanes[${i}].remittanceMode`, 255n),
    };
    if (isZero(lane.leviedBy)) throw new Error(`lanes[${i}].leviedByHex cannot be zero`);
    assertPollPowerRemit({ ...lane, scheduleId: ZERO, effectiveEpoch: 1n }, statutoryAccounts);
    return lane;
  });
  const keys = new Set(lanes.map((/** @type {any} */ l) => `${hex(l.leviedBy)}:${l.laneKindByte}`));
  if (keys.size !== lanes.length) throw new Error('two lanes share (leviedBy, laneKindByte)');
  const laneSum = lanes.reduce((/** @type {bigint} */ a, /** @type {any} */ l) => a + l.bpsShare, 0n);
  if (laneSum !== split.statutoryTotalBps) throw new Error(`the lanes sum to ${laneSum} bps but the class's statutoryTotalBps is ${split.statutoryTotalBps}`);

  const meterAuthorityPk = raw.meterAuthority?.newPk ? point(raw.meterAuthority.newPk, 'meterAuthority.newPk') : null;
  return { nodeIds, charterRoot: tree.root, charterProof: tree.proof, refRate, schedule, klass, statutoryAccounts, lanes, meterAuthorityPk };
}

// ---------------------------------------------------------------------------
// Plans. Each takes ledger snapshots (from the indexer or the in-memory
// harness) and returns { circuit, args } (+ actionHash for council steps), or
// { done: reason } when the chain already has it. They refuse anything out of order.
// ---------------------------------------------------------------------------

/** @typedef {ReturnType<typeof parseG16Params>} G16 */

export function planBootstrap(/** @type {any} */ trL) {
  if (trL._bootstrapComplete) return { done: 'the action log is already bootstrapped' };
  return { circuit: 'bootstrapActionLog', args: [ACTION_LOG_DEPTH] };
}

export function planCharter(/** @type {Uint8Array} */ tr, /** @type {any} */ trL, /** @type {G16} */ g, /** @type {bigint} */ t) {
  if (!trL._bootstrapComplete) throw new Error('REFUSED: bootstrap the TariffRegistry action log first');
  if (eq(trL._governanceRoot, g.charterRoot)) return { done: `the charter root is already installed (epoch ${trL._currentEpoch})` };
  if (BigInt(trL._refRateFiatPerKwh) !== g.refRate) throw new Error(`REFUSED: the registry's reference rate is ${trL._refRateFiatPerKwh}, the params re-pass ${g.refRate}`);
  const cur = BigInt(trL._currentEpoch), next = cur + 1n;
  return { circuit: 'advanceEpoch', args: [next, g.refRate, g.charterRoot, t], actionHash: advanceEpochActionHash(tr, cur, next, g.refRate, g.charterRoot), epoch: cur };
}

/** registerSchedule, minus the validator signature (inserted at args[5] when executing). */
export function planSchedule(/** @type {any} */ trP, /** @type {Uint8Array} */ tr, /** @type {any} */ trL, /** @type {G16} */ g, /** @type {bigint} */ t) {
  if (!eq(trL._governanceRoot, g.charterRoot)) throw new Error('REFUSED: install the charter root first (step charter)');
  const s = g.schedule;
  if (trL._activeScheduleByNode.member(s.nodeId)) return { done: `node ${hex(s.nodeId)} already has schedule ${hex(trL._activeScheduleByNode.lookup(s.nodeId))}` };
  const cur = BigInt(trL._currentEpoch), eff = cur + 1n;
  const opId = trP.operatorKeyId(s.operatorPk);
  const actionHash = trP.registerScheduleActionHash(tr, s.nodeId, s.scheduleHash, opId, g.refRate, eff, cur);
  return { circuit: 'registerSchedule', args: [s.nodeId, s.scheduleHash, opId, g.refRate, eff, null, t], actionHash, signerMessage: trP.signerMessage(actionHash), epoch: cur };
}

export function activeSchedule(/** @type {any} */ trL, /** @type {G16} */ g) {
  if (!trL._activeScheduleByNode.member(g.schedule.nodeId)) throw new Error('REFUSED: register the schedule first (step schedule)');
  return trL._activeScheduleByNode.lookup(g.schedule.nodeId);
}

/** retuneClass, minus the operator signature (args[5]); sign `signerMessage`. */
export function planRetune(/** @type {any} */ trP, /** @type {Uint8Array} */ tr, /** @type {any} */ trL, /** @type {G16} */ g, /** @type {bigint} */ t) {
  const sid = activeSchedule(trL, g);
  const k = g.klass;
  const ck = classSplitKey(sid, k.classPath);
  if (trL._classEntries.member(ck)) {
    const e = trL._classEntries.lookup(ck);
    if (BPS.every((f) => BigInt(e.bps[f]) === k.split[f]) && BigInt(e.rateFiatPerKwh) === k.rate) return { done: 'the class already has this split and rate' };
  }
  const opId = trP.operatorKeyId(g.schedule.operatorPk);
  const rec = trL._registeredSchedules.lookup(sid);
  const div = bandDiv(BigInt(rec.refRateFiatPerKwh), BigInt(trL._SANITY_BAND_PCT));
  // retuneNonceKey(operatorId, scheduleId) at the current epoch; the registry expects prev + 1.
  const nk = ph([pad32('pp:tariff:v1:retuneNonce'), opId, sid, le32(BigInt(trL._currentEpoch))]);
  const nonce = (trL._retuneNonces.member(nk) ? BigInt(trL._retuneNonces.lookup(nk)) : 0n) + 1n;
  const auth = trP.retuneAuthHash(tr, sid, k.classPath, k.split, k.rate, BigInt(trL._currentEpoch), nonce, t);
  return { circuit: 'retuneClass', args: [sid, k.classPath, k.split, k.rate, g.schedule.operatorPk, null, nonce, t, div, div], signerMessage: trP.signerMessage(auth) };
}

/** registerLane for g.lanes[i]; the charter proof is an argument here (not a witness). */
export function planLane(/** @type {Uint8Array} */ tr, /** @type {any} */ trL, /** @type {G16} */ g, /** @type {number} */ i, /** @type {bigint} */ t) {
  const sid = activeSchedule(trL, g);
  const base = g.lanes[i];
  if (!base) throw new Error(`no lane ${i} in the params (have ${g.lanes.length})`);
  const k = laneKey(sid, base.leviedBy, base.laneKindByte);
  if (trL._registeredLanes.member(k) && BigInt(trL._registeredLanes.lookup(k).retiredEpoch) === 0n) return { done: `lane ${i} is already registered and live` };
  const cur = BigInt(trL._currentEpoch);
  const lane = { ...base, scheduleId: sid, effectiveEpoch: cur + 1n };
  assertPollPowerRemit(lane, g.statutoryAccounts);
  return { circuit: 'registerLane', args: [...registerLaneArgs(lane), g.charterProof(g.schedule.nodeId), t], actionHash: registerLaneActionHash(tr, lane, cur, t), epoch: cur, lane };
}

/**
 * EBT catch-up: syncRegistryRoot when EBT's mirror is behind, then the latest
 * action-log entry for our schedule, class and each lane that EBT has not
 * mirrored yet. `tree` is the JS action-log tree built from the TR ledger
 * (checked against the TR root by the caller). Returns the calls in order.
 */
export function planEbtMirror(/** @type {any} */ trL, /** @type {any} */ eL, /** @type {G16} */ g, /** @type {{ root: () => Uint8Array, proof: (seq: number) => any }} */ tree, /** @type {any[]} */ entries) {
  if (!eq(tree.root(), trL.registryActionLogRoot)) throw new Error('JS action-log tree != the TariffRegistry root');
  const calls = [];
  if (BigInt(eL._registryActionLogCountMirror) !== BigInt(trL._actionSeq) || !eq(eL._registryActionLogRootMirror, trL.registryActionLogRoot)) {
    calls.push({ circuit: 'syncRegistryRoot', args: [] });
  }
  const sid = activeSchedule(trL, g);
  const mirrored = (/** @type {Uint8Array} */ key, /** @type {number} */ seq) => eL._mirrorSeq.member(key) && BigInt(eL._mirrorSeq.lookup(key)) >= BigInt(seq);
  const last = (/** @type {(e: any) => boolean} */ f) => { for (let i = entries.length - 1; i >= 0; i--) if (f(entries[i])) return i; return -1; };
  const sSeq = last((e) => (Number(e.kind) === KIND.SCHEDULE || Number(e.kind) === KIND.SCHEDULE_RETIRED) && eq(e.scheduleId, sid));
  if (sSeq < 0) throw new Error('no schedule entry in the action log');
  if (!mirrored(sid, sSeq)) calls.push({ circuit: 'mirrorScheduleLifecycle', args: [entries[sSeq], trL._registeredSchedules.lookup(sid), tree.proof(sSeq)] });
  const ce = trL._classEntries.member(classSplitKey(sid, g.klass.classPath)) ? trL._classEntries.lookup(classSplitKey(sid, g.klass.classPath)) : null;
  if (!ce) throw new Error('REFUSED: retune the class first (step retune)');
  const want = retunePayloadHash(sid, g.klass.classPath, ce.bps, BigInt(ce.rateFiatPerKwh), BigInt(ce.lastUpdatedAt));
  const cSeq = last((e) => Number(e.kind) === KIND.RETUNE && eq(e.payloadHash, want));
  if (cSeq < 0) throw new Error('no action-log entry matches the class\'s current split');
  if (!mirrored(ebtClassKey(sid, g.klass.classPath), cSeq)) {
    calls.push({ circuit: 'mirrorClassStatutoryTotal', args: [entries[cSeq], sid, g.klass.classPath, ce.bps, BigInt(ce.rateFiatPerKwh), BigInt(ce.lastUpdatedAt), tree.proof(cSeq)] });
  }
  for (const l of g.lanes) {
    const k = laneKey(sid, l.leviedBy, l.laneKindByte);
    if (!trL._registeredLanes.member(k)) throw new Error(`REFUSED: lane ${hex(l.leviedBy).slice(0, 12)}…/${l.laneKindByte} is not registered yet (step lane)`);
    const rec = trL._registeredLanes.lookup(k);
    const lSeq = last((e) => (Number(e.kind) === KIND.LANE || Number(e.kind) === KIND.LANE_RETIRED) && eq(e.scheduleId, sid) && e.payloadHash && laneEntryMatches(e, rec));
    if (lSeq < 0) throw new Error('no action-log entry for a registered lane');
    if (!mirrored(k, lSeq)) calls.push({ circuit: Number(entries[lSeq].kind) === KIND.LANE ? 'mirrorRegisterLane' : 'mirrorRetireLane', args: [entries[lSeq], rec, tree.proof(lSeq)] });
  }
  return calls;
}

/** TR laneActionPayloadHash(kind, record): the entry's payloadHash for this record. */
function laneEntryMatches(/** @type {any} */ e, /** @type {any} */ r) {
  const h = ph([pad32('pp:tariff:v1:actionPayload'), le32(e.kind), r.scheduleId, le32(r.laneKindByte), r.leviedBy, le32(r.bpsShare), r.remitAddress,
    le32(r.basis), r.applicabilityHash, r.statuteRefHash, le32(r.effectiveEpoch), le32(r.retiredEpoch), le32(r.remittanceMode), le32(r.registeredAt)]);
  return eq(h, e.payloadHash);
}

/** K5 swap: EBT execOwnerOp(1, currentOwnerPk, newMeterAuthorityPk); the owner signs over these args at the current _ownerNonce. */
export function planK5Swap(/** @type {any} */ eL, /** @type {G16} */ g) {
  if (!g.meterAuthorityPk) throw new Error('meterAuthority.newPk is missing from the params');
  const cur = eL._meterAuthorityPubkey;
  if (BigInt(cur.x) === g.meterAuthorityPk.x && BigInt(cur.y) === g.meterAuthorityPk.y) return { done: 'EBT already uses this meter-authority key' };
  return { circuit: 'execOwnerOp', args: [1n, { x: BigInt(eL._ownerPk.x), y: BigInt(eL._ownerPk.y) }, g.meterAuthorityPk], nonce: BigInt(eL._ownerNonce) };
}
