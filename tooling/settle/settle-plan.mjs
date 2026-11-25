// @ts-check
// planSettleArgs: EBT `settle`'s full argument list, built from the contract's
// LIVE mirrors (WI-16 step 4; used by the devnet stack and, through the chain
// adapter, by pp-settle-service).
//
// v9 binds the dividend / ops / DAO shares to the mirrored class
// (SPLIT_OFF_CLASS) and the statutory lanes to the mirrored lanes
// (LANE_SUM_MISMATCH, SLICE_OFF_POLICY). A countersigned session is spent once,
// so the split is never hardcoded: it is read from EBT's own mirrors at submit
// time, and anything the contract would refuse is refused here first.
import * as RT from '@midnight-ntwrk/compact-runtime';

const pad32 = (/** @type {string} */ s) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(s)); return b; };
const eq = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) => a.length === b.length && a.every((x, i) => x === b[i]);
const V3 = new RT.CompactTypeVector(3, new RT.CompactTypeBytes(32));

/** EBT's classKey(scheduleId, classPath): persistentHash([pad("pp:ebt:v8:classKey"), scheduleId, classPath]). */
export const classKeyOf = (/** @type {Uint8Array} */ scheduleId, /** @type {Uint8Array} */ classPath) =>
  RT.persistentHash(V3, [pad32('pp:ebt:v8:classKey'), scheduleId, classPath]);

/**
 * Largest-remainder apportionment: each slice within one base unit of its
 * exact bps share, and the slices sum exactly to `amount`.
 */
export function slicesFor(/** @type {bigint} */ amount, /** @type {bigint[]} */ bps) {
  const exact = bps.map((b) => amount * b);
  const floors = exact.map((x) => x / 10000n);
  let left = amount - floors.reduce((a, x) => a + x, 0n);
  const order = exact.map((x, i) => ({ i, rem: x % 10000n })).sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
  for (const { i, rem } of order) { if (left === 0n) break; if (rem > 0n) { floors[i] += 1n; left -= 1n; } }
  if (left !== 0n) throw new Error(`apportionment left ${left} unassigned (bps do not sum to 10000?)`);
  return floors;
}

const SPLIT_FIELDS = ['producerShareBps', 'ldShareBps', 'opsShareBps', 'daoShareBps', 'operatorMarginBps', 'statutoryTotalBps'];
const LANE_FIELDS = ['bpsShare', 'remitAddress', 'retiredEpoch', 'effectiveEpoch', 'remittanceMode'];
const same = (/** @type {any} */ a, /** @type {any} */ b) => (a instanceof Uint8Array ? eq(a, b) : toBig(a) === toBig(b));

/** TariffRegistry's classSplitKey(scheduleId, classPath) (its own tag, not EBT's). */
export const registryClassKeyOf = (/** @type {Uint8Array} */ scheduleId, /** @type {Uint8Array} */ classPath) =>
  RT.persistentHash(V3, [pad32('pp:tariff:v1:classSplitKey'), scheduleId, classPath]);

/**
 * Fix #5: after a sync, the class and this schedule's lanes in EBT's mirrors
 * must equal the TariffRegistry's own records, or a retune / lane change
 * synced but not re-mirrored would settle at the old split. Lanes are matched
 * by (scheduleId, leviedBy, kind), so the two contracts' key tags don't matter.
 */
export function assertMirrorsCurrent(/** @type {any} */ L, /** @type {any} */ R, /** @type {Uint8Array} */ scheduleId, /** @type {Uint8Array} */ classPath) {
  const rk = registryClassKeyOf(scheduleId, classPath);
  if (R._classEntries.member(rk)) {
    const reg = R._classEntries.lookup(rk).bps;
    const ck = classKeyOf(scheduleId, classPath);
    const mir = L._classSplitMirror.member(ck) ? L._classSplitMirror.lookup(ck) : null;
    if (!mir || SPLIT_FIELDS.some((k) => !same(reg[k], mir[k]))) throw new Error('CLASS_MIRROR_BEHIND: the class split in EBT differs from the TariffRegistry; re-mirror it (mirrorClassStatutoryTotal) before settling');
  }
  const mirrored = [...L._registeredLanesMirror].map(([, m]) => m.record);
  for (const [, rec] of R._registeredLanes) {
    if (!eq(rec.scheduleId, scheduleId)) continue;
    const m = mirrored.find((x) => eq(x.scheduleId, rec.scheduleId) && eq(x.leviedBy, rec.leviedBy) && toBig(x.laneKindByte) === toBig(rec.laneKindByte));
    if (!m || LANE_FIELDS.some((k) => !same(rec[k], m[k]))) throw new Error('LANE_MIRROR_BEHIND: a lane of this schedule in EBT differs from the TariffRegistry; re-mirror it before settling');
  }
}

/** The live statutory lanes of `scheduleId` at `epoch` (as settleCheckSlot requires). */
export function liveLanes(/** @type {any} */ ledger, /** @type {Uint8Array} */ scheduleId, /** @type {bigint} */ epoch) {
  const out = [];
  for (const [, m] of ledger._registeredLanesMirror) {
    const r = m.record;
    if (!eq(r.scheduleId, scheduleId)) continue;
    if (r.effectiveEpoch > epoch) continue;
    if (r.retiredEpoch !== 0n && r.retiredEpoch <= epoch) continue;
    out.push(r);
  }
  if (out.length > 4) throw new Error(`SCHEDULE_LANE_OVERFLOW: more than 4 live lanes (${out.length})`);
  return out;
}

const ZERO = new Uint8Array(32);
const toBig = (/** @type {any} */ x) => BigInt(x);
/** hatSig as meter-authority-service returns it (decimal strings) or as bigints. */
export const hatSigOf = (/** @type {any} */ s) => ({ announcement: { x: toBig(s.announcement.x), y: toBig(s.announcement.y) }, response: toBig(s.response) });

/**
 * @param {object} p
 * @param {any} p.ebtModule   the EBT build (for its ledger types; unused pure circuits kept for parity)
 * @param {any} p.ledger      EBT's current ledger (module.ledger(state.data))
 * @param {any} [p.registryLedger] the TariffRegistry's current ledger. Fix #5: when given, the
 *   plan is refused while the registry has entries EBT has not synced (syncRegistryRoot) and
 *   re-mirrored, so a retune or lane change never settles at the old split.
 * @param {any} p.fields      { sessionID, amount, producerKey, producerAddr:{bytes}, meterKeyHash, chipHwId, chipSessionUwh, chipUptimeMs, chipNonce }
 * @param {any} p.chip        { chipPubkey, chipSigR, chipSigS, hatSig }
 * @param {Uint8Array} p.scheduleId
 * @param {Uint8Array} p.classPath
 * @param {bigint} p.epoch
 * @param {bigint} p.fiatValueAtMint
 * @param {bigint} p.currentTime
 * @returns {any[]} settle's arguments in order
 */
export function planSettleArgs(p) {
  const L = p.ledger;
  if (p.registryLedger && toBig(p.registryLedger._actionSeq) > toBig(L._registryActionLogCountMirror)) {
    throw new Error(`REGISTRY_AHEAD_OF_MIRROR: the TariffRegistry has ${p.registryLedger._actionSeq} entries, EBT synced ${L._registryActionLogCountMirror}; `
      + 'call syncRegistryRoot and re-mirror the changed items before settling');
  }
  if (p.registryLedger) assertMirrorsCurrent(L, p.registryLedger, p.scheduleId, p.classPath);
  if (!L._scheduleLiveMirror.member(p.scheduleId) || L._scheduleLiveMirror.lookup(p.scheduleId) !== true) throw new Error('SCHEDULE_NOT_LIVE (mirror): refusing before submit');
  const ck = classKeyOf(p.scheduleId, p.classPath);
  if (!L._classSplitMirror.member(ck)) throw new Error('CLASS_NOT_LIVE (mirror): refusing before submit');
  const cls = L._classSplitMirror.lookup(ck);
  const lanes = liveLanes(L, p.scheduleId, p.epoch);
  const laneTotal = lanes.reduce((a, r) => a + toBig(r.bpsShare), 0n);
  if (laneTotal !== toBig(cls.statutoryTotalBps)) throw new Error(`LANE_SUM_MISMATCH (mirror): live lanes ${laneTotal} bps != class statutory ${cls.statutoryTotalBps}`);
  const ld = toBig(cls.ldShareBps), ops = toBig(cls.opsShareBps), dao = toBig(cls.daoShareBps);
  const producer = 10000n - ld - ops - dao - laneTotal;
  if (producer < 0n) throw new Error('class shares exceed 10000 bps');
  const amount = toBig(p.fields.amount);
  const [producerAmt, opsAmt, divAmt, daoAmt, ...laneAmts] = slicesFor(amount, [producer, ops, ld, dao, ...lanes.map((r) => toBig(r.bpsShare))]);
  const slot = (/** @type {number} */ i) => lanes[i];
  const f = p.fields;
  return [
    f.sessionID, amount, f.producerKey, f.producerAddr, f.meterKeyHash,
    f.chipHwId, toBig(f.chipSessionUwh), toBig(f.chipUptimeMs), toBig(f.chipNonce),
    p.chip.chipPubkey, p.chip.chipSigR, p.chip.chipSigS, hatSigOf(p.chip.hatSig),
    p.scheduleId, p.classPath, p.epoch, p.fiatValueAtMint,
    [0, 1, 2, 3].map((i) => slot(i)?.leviedBy ?? ZERO),
    [0, 1, 2, 3].map((i) => (slot(i) ? toBig(slot(i).laneKindByte) : 0n)),
    [0, 1, 2, 3].map((i) => laneAmts[i] ?? 0n),
    producer, ops, ld, dao,
    producerAmt, opsAmt, divAmt, daoAmt,
    p.currentTime,
  ];
}

/**
 * The settle path's registry gate (fix #5; the default on the chain adapter,
 * so the Preprod settle path always runs it). Reads the TariffRegistry and
 * EBT; if EBT has synced fewer registry entries, calls `sync`
 * (syncRegistryRoot) and re-reads BOTH; then plans with the registry's ledger,
 * so the plan is refused on REGISTRY_AHEAD_OF_MIRROR (the sync did not catch
 * up, or the registry moved again), CLASS_MIRROR_BEHIND or LANE_MIRROR_BEHIND
 * (synced, not yet re-mirrored: re-mirroring stays an explicit step).
 * @param {{ readEbt: () => Promise<any>, readRegistry: () => Promise<any>, sync: () => Promise<unknown>,
 *           log?: { log: Function }, plan: any }} o  `plan`: planSettleArgs' input without the ledgers
 * @returns {Promise<any[]>} settle's arguments
 */
export async function syncCheckAndPlan({ readEbt, readRegistry, sync, log = console, plan }) {
  let R = await readRegistry();
  let L = await readEbt();
  if (toBig(R._actionSeq) > toBig(L._registryActionLogCountMirror)) {
    log.log(`[settle] EBT has synced ${L._registryActionLogCountMirror} of ${R._actionSeq} registry entries: syncRegistryRoot`);
    await sync();
    R = await readRegistry();
    L = await readEbt();
  }
  return planSettleArgs({ ...plan, ledger: L, registryLedger: R });
}
