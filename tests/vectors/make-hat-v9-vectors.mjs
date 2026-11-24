// Writes tests/vectors/hat-v9.json: chipDigest and hatMessage computed by the
// COMPILED EBT's exported pure circuits for a few inputs. Services that build
// these messages themselves (meter-authority-service, pp-settle-service) test
// against this file. Regenerate after any change to either circuit:
//   node tests/vectors/make-hat-v9-vectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContract } from '../parity/harness.mjs';

const mod = await loadContract('ebt-v8');
const P = mod.pureCircuits;
const hex = (u) => Buffer.from(u).toString('hex');
const fill = (b) => new Uint8Array(32).fill(b);
const cases = [
  { ebtAddress: fill(0x11), sessionId: fill(0x61), amount: 0x0102030405n, producerKey: fill(0x63), producerAddr: fill(0x64), meterKeyHash: fill(0x65), meterTime: 1795000000n, meterCounter: 7n, chipPubkey: fill(0x66), chipSigR: fill(0x67), chipSigS: fill(0x68) },
  { ebtAddress: fill(0xa0), sessionId: fill(0x01), amount: 1n, producerKey: fill(0x02), producerAddr: fill(0x03), meterKeyHash: fill(0x04), meterTime: 0n, meterCounter: 0n, chipPubkey: fill(0x05), chipSigR: fill(0x06), chipSigS: fill(0x07) },
  { ebtAddress: fill(0xff), sessionId: fill(0xfe), amount: (1n << 64n) - 1n, producerKey: fill(0xfd), producerAddr: fill(0xfc), meterKeyHash: fill(0xfb), meterTime: (1n << 64n) - 1n, meterCounter: (1n << 63n), chipPubkey: fill(0xfa), chipSigR: fill(0xf9), chipSigS: fill(0xf8) },
];
const out = cases.map((c) => {
  const digest = P.chipDigest(c.ebtAddress, c.sessionId, c.amount, c.producerKey, { bytes: c.producerAddr }, c.meterKeyHash, c.meterTime, c.meterCounter);
  const msg = P.hatMessage(c.ebtAddress, digest, c.chipPubkey, c.chipSigR, c.chipSigS);
  const s = (v) => (typeof v === 'bigint' ? v.toString() : hex(v));
  return { input: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, s(v)])), chipDigest: hex(digest), hatMessage: msg.toString() };
});
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hat-v9.json');
fs.writeFileSync(file, JSON.stringify({ source: 'pollpower-contracts-midnight build/l9/ebt-v8 (chipDigest, hatMessage)', cases: out }, null, 2) + '\n');
console.log(`wrote ${file}`);
