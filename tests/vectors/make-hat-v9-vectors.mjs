// Writes tests/vectors/hat-v9.json: settleRecordDigest and hatMessage computed by the
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
  { ebtAddress: fill(0x11), sessionId: fill(0x61), amount: 0x0102030405n, producerKey: fill(0x63), producerAddr: fill(0x64), meterKeyHash: fill(0x65), chipHwId: fill(0x6a), chipSessionUwh: 0x0102030405n * 1000n + 7n, chipUptimeMs: 9000n, chipNonce: 7n, chipPubkey: fill(0x66), chipSigR: fill(0x67), chipSigS: fill(0x68) },
  { ebtAddress: fill(0xa0), sessionId: fill(0x01), amount: 1n, producerKey: fill(0x02), producerAddr: fill(0x03), meterKeyHash: fill(0x04), chipHwId: fill(0x00), chipSessionUwh: 1000n, chipUptimeMs: 0n, chipNonce: 0n, chipPubkey: fill(0x05), chipSigR: fill(0x06), chipSigS: fill(0x07) },
  { ebtAddress: fill(0xff), sessionId: fill(0xfe), amount: (1n << 64n) - 1n, producerKey: fill(0xfd), producerAddr: fill(0xfc), meterKeyHash: fill(0xfb), chipHwId: fill(0xf7), chipSessionUwh: (1n << 64n) - 1n, chipUptimeMs: (1n << 64n) - 1n, chipNonce: (1n << 63n), chipPubkey: fill(0xfa), chipSigR: fill(0xf9), chipSigS: fill(0xf8) },
];
const out = cases.map((c) => {
  const digest = P.settleRecordDigest(c.ebtAddress, c.sessionId, c.amount, c.producerKey, { bytes: c.producerAddr }, c.meterKeyHash, c.chipHwId, c.chipSessionUwh, c.chipUptimeMs, c.chipNonce);
  const msg = P.hatMessage(c.ebtAddress, digest, c.chipPubkey, c.chipSigR, c.chipSigS);
  const s = (v) => (typeof v === 'bigint' ? v.toString() : hex(v));
  return { input: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, s(v)])), settleRecordDigest: hex(digest), hatMessage: msg.toString() };
});
// manualReissue co-signature (meter authority): reissueMessage(self, producerKey, producerAddr, amount, seq).
const reissue = [
  { ebtAddress: fill(0x11), producerKey: fill(0x41), producerAddr: fill(0x42), amount: 1000n, seq: 0n },
  { ebtAddress: fill(0xa0), producerKey: fill(0x01), producerAddr: fill(0x02), amount: 1_000_000n, seq: 7n },
].map((c) => ({
  input: { ebtAddress: hex(c.ebtAddress), producerKey: hex(c.producerKey), producerAddr: hex(c.producerAddr), amount: c.amount.toString(), seq: c.seq.toString() },
  reissueMessage: P.reissueMessage(c.ebtAddress, c.producerKey, { bytes: c.producerAddr }, c.amount, c.seq).toString(),
}));
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hat-v9.json');
fs.writeFileSync(file, JSON.stringify({ source: 'pollpower-contracts-midnight build/l9/ebt-v8 (settleRecordDigest, hatMessage, reissueMessage)', cases: out, reissue }, null, 2) + '\n');
console.log(`wrote ${file}`);
