// Exact-length decoding of PollPower contract events (ledger 9 Misc events:
// name (32 bytes) || payload (256 bytes) = 288 bytes).
//
// The Compact runtime's value encoding DROPS TRAILING ZERO BYTES, so an event
// whose last fields are genuinely zero arrives shorter than its layout (seen:
// 288 -> 257). Decoders must restore the exact layout length: zero-pad data
// that is SHORTER, and REJECT data that is LONGER (it is not this event).
// Signatures and digests are always computed over the restored full-length
// fields (Garrett, 2026-11-24).
export const EVENT_LAYOUTS = Object.freeze({
  // EBT: the chip's native attestation behind a settle.
  'pp:ebt:v9:settleChip': { version: 1, length: 288 },
  // Living Dividend v3 history (four 32-byte words + zeros).
  'pp:ld:v3:register': { version: 1, length: 288 },
  'pp:ld:v3:unregister': { version: 1, length: 288 },
  'pp:ld:v3:claim': { version: 1, length: 288 },
  'pp:ld:v3:payoutRequest': { version: 1, length: 288 },
  'pp:ld:v3:payoutCancel': { version: 1, length: 288 },
  'pp:ld:v3:payoutSet': { version: 1, length: 288 },
  'pp:ld:v3:prune': { version: 1, length: 288 },
});

/** The 32-byte, zero-padded name field of an event type. */
export function nameField(name) {
  const b = Buffer.alloc(32);
  const n = Buffer.from(name, 'utf8');
  if (n.length > 32) throw new Error(`event name too long: ${name}`);
  n.copy(b);
  return b;
}

/**
 * Restores one event value (name || payload) to its exact layout length.
 * @param bytes the event value bytes (possibly trimmed of trailing zeros)
 * @param expectedName optional: refuse any other event type
 * @returns { name, version, bytes (exact length) }
 */
export function restoreEventValue(bytes, expectedName) {
  const b = Buffer.from(bytes);
  const head = Buffer.alloc(32);
  b.copy(head, 0, 0, Math.min(32, b.length));
  const name = head.toString('utf8').replace(/\0+$/, '');
  const layout = EVENT_LAYOUTS[name];
  if (!layout) throw new Error(`unknown event type: ${JSON.stringify(name)}`);
  if (expectedName && name !== expectedName) throw new Error(`expected ${expectedName}, got ${name}`);
  if (b.length > layout.length) throw new Error(`${name}: ${b.length} bytes is longer than its ${layout.length}-byte layout`);
  const full = Buffer.alloc(layout.length);
  b.copy(full);
  return { name, version: layout.version, bytes: full };
}

/** The 32-byte words of a restored event's payload. */
export const payloadWords = (full) => Array.from({ length: (full.length - 32) / 32 }, (_, i) => full.subarray(32 + 32 * i, 64 + 32 * i));

/**
 * Restores an event read through the midnight-js indexer provider
 * (queryContractEvents, eventType 'Misc': `name` and `payload` hex). The
 * provider's `raw` field is the whole VersionedLogItem (framing + metadata),
 * NOT the event bytes: never decode it as an event (devnet, 2026-11-24: a
 * 288-byte settleChip arrives as raw 373 B, name at offset 26).
 */
export function restoreIndexerMiscEvent(e, expectedName) {
  if (e.eventType !== undefined && e.eventType !== 'Misc') throw new Error(`not a Misc event: ${e.eventType}`);
  const hex = (x, what) => {
    const h = String(x).replace(/^0x/, '');
    if (!/^[0-9a-f]*$/i.test(h) || h.length % 2) throw new Error(`event ${what} is not hex`);
    return Buffer.from(h, 'hex');
  };
  const name = hex(e.name, 'name');
  if (name.length > 32) throw new Error('event name longer than 32 bytes');
  const name32 = Buffer.alloc(32);
  name.copy(name32);
  return restoreEventValue(Buffer.concat([name32, hex(e.payload, 'payload')]), expectedName);
}
