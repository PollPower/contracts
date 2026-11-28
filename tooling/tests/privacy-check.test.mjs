// Privacy check (Garrett, 2026-11-25): the contracts repo is public on
// purpose; council member names, ring card IDs, Tailscale addresses, internal
// hostnames and full secp256k1 public keys (outside test fixtures) never get in.
// Test inputs build the sensitive words from parts so this file itself passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { scanText, compareToBaseline } from '../privacy/check-private-details.mjs';

const rules = (text, file = 'docs/x.md') => scanText(text, file).map((f) => f.rule);
const NAME = ['jona', 'than'].join('');
const HOST = ['ken', 'ya'].join('');
const pub = Buffer.from(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)).toString('hex');

test('PC-1: council member names are caught in any case; the words are not stored in the check', async () => {
  assert.deepEqual(rules(`approved by ${NAME[0].toUpperCase()}${NAME.slice(1)} today`), ['council-name']);
  const src = (await import('node:fs')).readFileSync(new URL('../privacy/check-private-details.mjs', import.meta.url), 'utf8');
  assert.ok(!src.toLowerCase().includes(NAME));
});

test('PC-2: the founder is named publicly, but never next to a ring, card, slot or key holder', () => {
  assert.deepEqual(rules('Decision (Garrett, 2026-11-24): pause devnet passes'), []);
  assert.deepEqual(rules("slot 0 is Garrett's ring"), ['ring-holder']);
});

test('PC-3: Tangem card IDs are caught; the devnet chip id (digits only) and lowercase hashes are not', () => {
  assert.deepEqual(rules('card CB79000000018201 scanned'), ['card-id']);
  assert.deepEqual(rules('"cardId": "AB12000000001234"'), ['card-id']);
  assert.deepEqual(rules('ieee 5050444556000001; hash cb79000000018201'), []);
});

test('PC-4: Tailscale 100.64.0.0/10 addresses are caught; other 100.x are not', () => {
  assert.deepEqual(rules('http://100.101.7.3:9944'), ['tailscale-ip']);
  assert.deepEqual(rules('100.63.1.1 and 100.128.0.1'), []);
});

test('PC-5: internal hostnames are caught (lowercase host use), the country name is not', () => {
  assert.deepEqual(rules(`ssh ${HOST} docker ps`), ['internal-host']);
  assert.deepEqual(rules('rural Kenya, Kenya Revenue Authority'), []);
});

test('PC-6: full secp256k1 public keys are caught outside test fixtures, allowed inside them', () => {
  assert.deepEqual(rules(`publicKey ${pub}`, 'docs/council.md'), ['secp256k1-pubkey']);
  assert.deepEqual(rules(`publicKey ${pub}`, 'tests/contract/x.test.mjs'), []);
  assert.deepEqual(rules(`publicKey ${pub}`, 'tooling/tests/x.test.mjs'), []);
  assert.deepEqual(rules(`tx 00${'ab'.repeat(32)}`, 'docs/x.md'), []);   // a tx id, not 02/03-prefixed
});

test('PC-7: against the baseline, only new or increased findings fail', () => {
  const base = { 'docs/old.md': { 'internal-host': 3 } };
  const ok = compareToBaseline({ 'docs/old.md': { 'internal-host': 2 } }, base);
  assert.deepEqual(ok, []);
  const bad = compareToBaseline({ 'docs/old.md': { 'internal-host': 4 }, 'docs/new.md': { 'council-name': 1 } }, base);
  assert.deepEqual(bad.map((b) => `${b.file}:${b.rule}`).sort(), ['docs/new.md:council-name', 'docs/old.md:internal-host']);
});
