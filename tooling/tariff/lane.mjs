// @ts-check
// TariffRegistry v1 statutory lanes, tooling side.
//
// registerLaneActionHash: the federation action hash registerLane asks the
// council to have approved (tariff-registry-v1.compact registerLane step d):
//   persistentHash<Vector<14, Bytes<32>>>([pad("pp:tariff:v1:registerLane"), self,
//     scheduleId, kind, leviedBy, bpsShare, remitAddress, basis, applicabilityHash,
//     statuteRefHash, effectiveEpoch, remittanceMode, currentEpoch, currentTime])
// with every integer as (x as Field) as Bytes<32> (little-endian). The contract
// has no pure circuit for it; tests/contract/statutory-lane.test.mjs pins this
// against the compiled registry (a hash over any other field is refused).
import * as RT from '@midnight-ntwrk/compact-runtime';

const V14 = new RT.CompactTypeVector(14, new RT.CompactTypeBytes(32));
const pad32 = (/** @type {string} */ s) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(s)); return b; };
const le32 = (/** @type {bigint | number} */ n) => {
  const b = new Uint8Array(32);
  let x = BigInt(n);
  if (x < 0n) throw new Error('negative integer');
  for (let i = 0; x > 0n; i++, x >>= 8n) { if (i >= 32) throw new Error('integer exceeds 32 bytes'); b[i] = Number(x & 0xffn); }
  return b;
};
const bytes32 = (/** @type {Uint8Array} */ b, /** @type {string} */ n) => { if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error(`${n} must be 32 bytes`); return b; };

/**
 * @typedef {{ scheduleId: Uint8Array, laneKindByte: bigint, leviedBy: Uint8Array, bpsShare: bigint,
 *   remitAddress: Uint8Array, basis: bigint, applicabilityHash: Uint8Array, statuteRefHash: Uint8Array,
 *   effectiveEpoch: bigint, remittanceMode: bigint }} LaneInput
 */

/** The action hash the council approves for TariffRegistry.registerLane. */
export function registerLaneActionHash(/** @type {Uint8Array} */ trAddress, /** @type {LaneInput} */ l, /** @type {bigint} */ currentEpoch, /** @type {bigint} */ currentTime) {
  return RT.persistentHash(V14, [
    pad32('pp:tariff:v1:registerLane'), bytes32(trAddress, 'trAddress'),
    bytes32(l.scheduleId, 'scheduleId'), le32(l.laneKindByte), bytes32(l.leviedBy, 'leviedBy'), le32(l.bpsShare),
    bytes32(l.remitAddress, 'remitAddress'), le32(l.basis), bytes32(l.applicabilityHash, 'applicabilityHash'),
    bytes32(l.statuteRefHash, 'statuteRefHash'), le32(l.effectiveEpoch), le32(l.remittanceMode),
    le32(currentEpoch), le32(currentTime),
  ]);
}

/** registerLane's argument list (before charterProof, currentTime). */
export const registerLaneArgs = (/** @type {LaneInput} */ l) => [l.scheduleId, l.laneKindByte, l.leviedBy, l.bpsShare,
  l.remitAddress, l.basis, l.applicabilityHash, l.statuteRefHash, l.effectiveEpoch, l.remittanceMode];

/** The registry's LaneRecord for (scheduleId, leviedBy, kind), or throws. */
export function findLane(/** @type {any} */ trLedger, /** @type {Uint8Array} */ scheduleId, /** @type {Uint8Array} */ leviedBy, /** @type {bigint} */ kind) {
  const eq = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) => Buffer.from(a).equals(Buffer.from(b));
  for (const [, r] of trLedger._registeredLanes) {
    if (eq(r.scheduleId, scheduleId) && eq(r.leviedBy, leviedBy) && BigInt(r.laneKindByte) === BigInt(kind)) return r;
  }
  throw new Error('lane not registered in the TariffRegistry');
}
