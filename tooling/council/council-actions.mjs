// @ts-check
// The council actions the rings approve on Preprod (Multisig v8, 2-of-3), one
// entry per action: how to prepare it (the action hash, from the chain's
// current state), how to execute it once approved, and how to verify it
// afterwards. Used by council-approve.mjs (prepare/status/submit/execute) and
// council-action-check.mjs (read-only).
//
//   ld-bind      EBT execMultisigOp(0): bind Living Dividend v3 (once)
//   tr-charter   TR advanceEpoch: install the real charter root, re-pass K3     (G16)
//   tr-schedule  TR registerSchedule: the first schedule (+ validator K1 signature at execute)  (G16)
//   tr-lane      TR registerLane: one statutory lane (--lane <index> in the G16 params)        (G16)
//
// A pending file stores the action, the addresses, the time and epoch it was
// prepared at and the action hash. execute re-plans from the chain with the
// stored time and refuses unless it yields the same action hash (the chain
// moved: prepare again). Nothing here holds a key: the validator signature is
// made by the caller's signer.
import { hexToBytes } from '../tangem/ring-signature.mjs';
import { planCharter, planSchedule, planLane, hex } from '../g16/g16-lib.mjs';

/** @typedef {{ rec: any, inputs: any, g16: any, ledger: (build: string, addr: string) => Promise<any>, module: (build: string) => Promise<any> }} Ctx */

const sameHash = (/** @type {Uint8Array} */ h, /** @type {any} */ p) => {
  if (hex(h) !== String(p.actionHash)) throw new Error('REFUSED: the chain no longer yields the approved action hash (state moved since prepare): prepare again');
};
const needG16 = (/** @type {Ctx} */ c) => { if (!c.g16) throw new Error('--g16 <params.json> is required for this action'); return c.g16; };
const done = (/** @type {any} */ plan, /** @type {string} */ what) => { if (plan.done) throw new Error(`REFUSED: ${what}: ${plan.done}`); return plan; };

export const ACTIONS = {
  'ld-bind': {
    label: 'bind Living Dividend v3 in the EBT (EBT council op 0, once)',
    target: { key: 'ebt', build: 'ebt-v8', consumed: '_consumedCouncilActions' },
    needs: ['council', 'ebt', 'ld'],
    async prepare(/** @type {Ctx} */ c, /** @type {bigint} */ t) {
      const esc = c.inputs?.ebt?.escrowAttestorPk;
      if (!esc) throw new Error('--inputs: no ebt.escrowAttestorPk');
      const L = await c.ledger('ebt-v8', c.rec.ebt);
      if (L._livingDividendAddress.is_some) throw new Error('REFUSED: Living Dividend is already bound in this EBT');
      const ebtMod = await c.module('ebt-v8');
      const escrow = { x: BigInt(esc.x), y: BigInt(esc.y) };
      const actionHash = ebtMod.pureCircuits.councilActionHash(hexToBytes(c.rec.ebt), 0n, { bytes: hexToBytes(c.rec.ld) }, escrow, t);
      return { actionHash, fields: { ld: c.rec.ld, escrowAttestorPk: { x: String(escrow.x), y: String(escrow.y) } }, describe: `bind Living Dividend ${c.rec.ld} in EBT ${c.rec.ebt} (op 0, once)` };
    },
    async call(/** @type {Ctx} */ c, /** @type {any} */ p) {
      const ebtMod = await c.module('ebt-v8');
      const esc = { x: BigInt(p.escrowAttestorPk.x), y: BigInt(p.escrowAttestorPk.y) };
      sameHash(ebtMod.pureCircuits.councilActionHash(hexToBytes(p.ebt), 0n, { bytes: hexToBytes(p.ld) }, esc, BigInt(p.time)), p);
      return { build: 'ebt-v8', address: p.ebt, circuit: 'execMultisigOp', args: [0n, { bytes: hexToBytes(p.ld) }, esc, BigInt(p.time)] };
    },
    async verify(/** @type {Ctx} */ c, /** @type {any} */ p) {
      const L = await c.ledger('ebt-v8', p.ebt);
      const bound = L._livingDividendAddress.is_some ? hex(L._livingDividendAddress.value.bytes) : null;
      return [[bound === String(p.ld).toLowerCase(), `EBT _livingDividendAddress = ${bound ?? '(none)'}`]];
    },
  },

  'tr-charter': {
    label: 'install the charter root in the TariffRegistry (advanceEpoch; re-passes K3)',
    target: { key: 'tr', build: 'tariff-registry-v1', consumed: '_consumedFederationApprovals' },
    needs: ['council', 'tr'],
    async prepare(/** @type {Ctx} */ c, /** @type {bigint} */ t) {
      const g = needG16(c);
      const plan = done(planCharter(hexToBytes(c.rec.tr), await c.ledger('tariff-registry-v1', c.rec.tr), g, t), 'charter');
      return { actionHash: plan.actionHash, fields: { newEpoch: String(plan.args[0]), refRate: String(g.refRate), charterRoot: hex(g.charterRoot), nodes: g.nodeIds.length },
        describe: `TariffRegistry ${c.rec.tr}: advanceEpoch to ${plan.args[0]}, charter root ${hex(g.charterRoot)} (${g.nodeIds.length} node${g.nodeIds.length === 1 ? '' : 's'}), reference rate ${g.refRate} (K3, unchanged)` };
    },
    async call(/** @type {Ctx} */ c, /** @type {any} */ p) {
      const plan = done(planCharter(hexToBytes(p.tr), await c.ledger('tariff-registry-v1', p.tr), needG16(c), BigInt(p.time)), 'charter');
      sameHash(plan.actionHash, p);
      return { build: 'tariff-registry-v1', address: p.tr, circuit: plan.circuit, args: plan.args };
    },
    async verify(/** @type {Ctx} */ c, /** @type {any} */ p) {
      const L = await c.ledger('tariff-registry-v1', p.tr);
      return [
        [hex(L._governanceRoot) === p.charterRoot, `TR _governanceRoot = ${hex(L._governanceRoot)}`],
        [BigInt(L._currentEpoch) >= BigInt(p.newEpoch), `TR epoch ${L._currentEpoch} (approved: ${p.newEpoch})`],
        [String(L._refRateFiatPerKwh) === p.refRate, `TR reference rate ${L._refRateFiatPerKwh} (K3 ${p.refRate})`],
      ];
    },
  },

  'tr-schedule': {
    label: 'register the first schedule in the TariffRegistry (registerSchedule; the validator key signs at execute)',
    target: { key: 'tr', build: 'tariff-registry-v1', consumed: '_consumedFederationApprovals' },
    needs: ['council', 'tr'],
    signer: 'validator',
    async prepare(/** @type {Ctx} */ c, /** @type {bigint} */ t) {
      const g = needG16(c);
      const trP = (await c.module('tariff-registry-v1')).pureCircuits;
      const plan = done(planSchedule(trP, hexToBytes(c.rec.tr), await c.ledger('tariff-registry-v1', c.rec.tr), g, t), 'schedule');
      return { actionHash: plan.actionHash, fields: { nodeId: hex(g.schedule.nodeId), scheduleHash: hex(g.schedule.scheduleHash), refRate: String(g.refRate), effectiveEpoch: String(plan.args[4]), trEpoch: String(plan.epoch) },
        describe: `TariffRegistry ${c.rec.tr}: schedule for node ${hex(g.schedule.nodeId)}, schedule hash ${hex(g.schedule.scheduleHash)}, reference rate ${g.refRate}, effective epoch ${plan.args[4]}` };
    },
    async call(/** @type {Ctx} */ c, /** @type {any} */ p, /** @type {(msg: bigint) => any} */ sign) {
      const trP = (await c.module('tariff-registry-v1')).pureCircuits;
      const plan = done(planSchedule(trP, hexToBytes(p.tr), await c.ledger('tariff-registry-v1', p.tr), needG16(c), BigInt(p.time)), 'schedule');
      sameHash(plan.actionHash, p);
      if (!sign) throw new Error('tr-schedule needs the validator key (K1) at execute: --key <file> with G16_KEY_PASSPHRASE');
      plan.args[5] = sign(plan.signerMessage);
      return { build: 'tariff-registry-v1', address: p.tr, circuit: plan.circuit, args: plan.args };
    },
    async verify(/** @type {Ctx} */ c, /** @type {any} */ p) {
      const L = await c.ledger('tariff-registry-v1', p.tr);
      const nid = hexToBytes(p.nodeId);
      const sid = L._activeScheduleByNode.member(nid) ? L._activeScheduleByNode.lookup(nid) : null;
      const rec = sid ? L._registeredSchedules.lookup(sid) : null;
      return [
        [!!rec, `schedule for node ${p.nodeId}: ${sid ? hex(sid) : '(none)'}`],
        [!!rec && hex(rec.scheduleHash) === p.scheduleHash && String(rec.refRateFiatPerKwh) === p.refRate && String(rec.effectiveEpoch) === p.effectiveEpoch,
          rec ? `schedule hash, rate ${rec.refRateFiatPerKwh}, effective epoch ${rec.effectiveEpoch} as approved` : 'schedule fields'],
      ];
    },
  },

  'tr-lane': {
    label: 'register a statutory lane in the TariffRegistry (registerLane; --lane <index>)',
    target: { key: 'tr', build: 'tariff-registry-v1', consumed: '_consumedFederationApprovals' },
    needs: ['council', 'tr'],
    async prepare(/** @type {Ctx} */ c, /** @type {bigint} */ t, /** @type {{ lane?: number }} */ o = {}) {
      const g = needG16(c);
      const i = Number(o.lane ?? NaN);
      if (!Number.isInteger(i)) throw new Error('--lane <index> is required (0-based, in the G16 params lanes list)');
      const plan = done(planLane(hexToBytes(c.rec.tr), await c.ledger('tariff-registry-v1', c.rec.tr), g, i, t), `lane ${i}`);
      const l = plan.lane;
      return { actionHash: plan.actionHash, fields: { lane: i, scheduleId: hex(l.scheduleId), leviedBy: hex(l.leviedBy), laneKindByte: String(l.laneKindByte), bpsShare: String(l.bpsShare), remitAddress: hex(l.remitAddress), effectiveEpoch: String(l.effectiveEpoch) },
        describe: `TariffRegistry ${c.rec.tr}: lane ${i}: kind ${l.laneKindByte}, ${l.bpsShare} bps, levied by ${hex(l.leviedBy)}, remitted to ${hex(l.remitAddress)} (mode ${l.remittanceMode}), effective epoch ${l.effectiveEpoch}` };
    },
    async call(/** @type {Ctx} */ c, /** @type {any} */ p) {
      const plan = done(planLane(hexToBytes(p.tr), await c.ledger('tariff-registry-v1', p.tr), needG16(c), Number(p.lane), BigInt(p.time)), `lane ${p.lane}`);
      sameHash(plan.actionHash, p);
      return { build: 'tariff-registry-v1', address: p.tr, circuit: plan.circuit, args: plan.args };
    },
    async verify(/** @type {Ctx} */ c, /** @type {any} */ p) {
      const L = await c.ledger('tariff-registry-v1', p.tr);
      let rec = null;
      for (const [, r] of L._registeredLanes) if (hex(r.scheduleId) === p.scheduleId && hex(r.leviedBy) === p.leviedBy && String(r.laneKindByte) === p.laneKindByte) rec = r;
      return [[!!rec && String(rec.bpsShare) === p.bpsShare && hex(rec.remitAddress) === p.remitAddress && String(rec.retiredEpoch) === '0',
        rec ? `lane registered: ${rec.bpsShare} bps to ${hex(rec.remitAddress)}, live` : 'lane not registered']];
    },
  },
};

/** @returns {any} */
export function actionOf(/** @type {string} */ name) {
  const a = /** @type {Record<string, any>} */ (ACTIONS)[name];
  if (!a) throw new Error(`--action must be one of ${Object.keys(ACTIONS).join(', ')}`);
  return a;
}
