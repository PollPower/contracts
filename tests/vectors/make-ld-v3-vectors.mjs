// Writes tests/vectors/ld-v3.json: memberId, timeDigest, payoutDigest and
// memberMessage computed by the COMPILED Living Dividend v3 pure circuits.
// The consumer app's wallet shim (which signs member actions on device) tests
// against this file. Regenerate after any change to those circuits:
//   node tests/vectors/make-ld-v3-vectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { loadContract, padTag } from '../parity/harness.mjs';

const mod = await loadContract('living-dividend-v3');
const P = mod.pureCircuits;
const hex = (u) => Buffer.from(u).toString('hex');
const fill = (b) => new Uint8Array(32).fill(b);
// Fixed scalars so the public keys (and ids) are reproducible.
const keys = [12345678901234567890n, 1n << 200n, 7n].map((sk) => ({ sk, pk: RT.jubjubSchnorrVerifyingKey(sk) }));
const cases = [];
for (const [i, k] of keys.entries()) {
  const ld = fill(0x10 + i);
  const id = P.memberId(k.pk);
  const time = 1_795_000_000n + BigInt(i);
  const payout = fill(0x50 + i);
  const nonce = BigInt(i * 3);
  for (const action of ['claim', 'touchLiveness', 'requestPayoutChange', 'cancelPayoutChange']) {
    const digest = action === 'requestPayoutChange' ? P.payoutDigest({ bytes: payout }, time) : P.timeDigest(time);
    cases.push({
      pk: { x: k.pk.x.toString(), y: k.pk.y.toString() }, memberId: hex(id), ldAddress: hex(ld), action,
      currentTime: time.toString(), newPayout: action === 'requestPayoutChange' ? hex(payout) : null,
      nonce: nonce.toString(), argsDigest: hex(digest),
      memberMessage: P.memberMessage(ld, padTag(action), id, digest, nonce).toString(),
    });
  }
}
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ld-v3.json');
fs.writeFileSync(file, JSON.stringify({ source: 'pollpower-contracts-midnight build/l9/living-dividend-v3 (memberId, timeDigest, payoutDigest, memberMessage)', cases }, null, 2) + '\n');
console.log(`wrote ${file} (${cases.length} cases)`);
