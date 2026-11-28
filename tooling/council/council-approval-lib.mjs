// @ts-check
// Checks a council member's ring result (the JSON the Admin app's ring-check
// screen shares) before it is submitted as a Multisig v8 approval. Pure logic,
// no network; tooling/council/council-approve.mjs does the I/O.
//
// Refuses: a result for another hash; walletPublicKey (what the ring reports
// it signed with) differing from publicKey; a key that is not council slot
// 0, 1 or 2 ON CHAIN (so the retired demo key, or any other key on the ring,
// is refused even with a valid signature); a signature that does not verify;
// a slot other than the one claimed. S is normalised to low-S (the circuit's
// secp256k1EcdsaVerify takes low-S only).
import { parsePublicKey, parseSignature, nobleVerify, normalizeS, hexToBytes } from '../tangem/ring-signature.mjs';

/** @typedef {{ slot: number, x: bigint, y: bigint }} Slot */

/**
 * @param {{ result: any, digestHex: string, slots: Slot[], claimedSlot?: number }} o
 * @returns {{ slot: number, r: bigint, s: bigint, encoding: string, wasHighS: boolean }}
 */
export function checkRingResult({ result, digestHex, slots, claimedSlot }) {
  if (!result || typeof result !== 'object') throw new Error('ring result is not a JSON object');
  if (result.curve && String(result.curve).toLowerCase() !== 'secp256k1') throw new Error(`ring result is for curve ${result.curve}, not secp256k1`);
  const want = String(digestHex).toLowerCase().replace(/^0x/, '');
  if (String(result.hash ?? '').toLowerCase().replace(/^0x/, '') !== want) throw new Error('the ring signed a different hash (not this approval digest)');
  const pub = String(result.publicKey ?? '');
  const wpub = String(result.walletPublicKey ?? pub);
  const a = parsePublicKey(pub), b = parsePublicKey(wpub);
  if (a.x !== b.x || a.y !== b.y) throw new Error('walletPublicKey (what the ring signed with) differs from publicKey (what was selected)');
  const match = slots.find((s) => s.x === b.x && s.y === b.y);
  if (!match) throw new Error('REFUSED: the signing key is not council slot 0, 1 or 2 on chain (wrong key selected on the ring?)');
  if (claimedSlot !== undefined && claimedSlot !== match.slot) throw new Error(`REFUSED: the key is council slot ${match.slot}, not the claimed slot ${claimedSlot}`);
  const sig = parseSignature(String(result.signature ?? ''));
  if (!nobleVerify(hexToBytes(want), sig.r, sig.s, b).lowSNotRequired) throw new Error(`REFUSED: the signature does not verify against council slot ${match.slot}`);
  return { slot: match.slot, r: sig.r, s: normalizeS(sig.s), encoding: sig.encoding, wasHighS: normalizeS(sig.s) !== sig.s };
}

/** Council slots from a Multisig v8 ledger: slots 0.._adminCount-1. @returns {Slot[]} */
export function slotsFromLedger(/** @type {any} */ ledger) {
  const n = Number(ledger._adminCount);
  return Array.from({ length: n }, (_, slot) => { const p = ledger._adminPks.lookup(BigInt(slot)); return { slot, x: BigInt(p.x), y: BigInt(p.y) }; });
}

/** The on-chain slots must equal the off-chain council file, slot by slot. */
export function assertSlotsMatchFile(/** @type {Slot[]} */ onChain, /** @type {{ slot: number, publicKey: string }[]} */ fileSlots) {
  const f = [...fileSlots].sort((p, q) => p.slot - q.slot);
  if (onChain.length !== 3 || f.length !== 3) throw new Error(`expected 3 slots on chain and in the council file, got ${onChain.length} and ${f.length}`);
  for (const s of onChain) {
    const p = parsePublicKey(f[s.slot].publicKey);
    if (p.x !== s.x || p.y !== s.y) throw new Error(`REFUSED: council slot ${s.slot} on chain differs from the council file`);
  }
}
