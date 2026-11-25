// G6: the Preprod inputs builder (council keys from the off-chain file, other
// public parameters from a params file). Throwaway keys, temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { buildInputs, expandCompressed, keyNeedles, publishedIn } from '../deploy/build-preprod-inputs.mjs';
import { devnetCouncilKey } from '../council/council-keys-guard.mjs';

const compressed = () => Buffer.from(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)).toString('hex');
const jub = () => { const pk = RT.jubjubSchnorrVerifyingKey(RT.jubjubSampleScalar()); return { x: String(pk.x), y: String(pk.y) }; };
const params = () => ({
  tariff: { governanceRootHex: '0e'.repeat(32), refRateFiatPerKwh: '100', validatorPk: jub() },
  ebt: { ownerPk: jub(), meterAuthorityPk: jub(), escrowAttestorPk: jub(), operationsRecipientHex: '21'.repeat(32), daoRecipientHex: '23'.repeat(32) },
});
const council = (keys, threshold = 2) => ({ threshold, council: keys.map((k, slot) => ({ slot, publicKey: k })) });
const emptyRepo = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ppr-')); execFileSync('git', ['init', '-q', d]); return d; };
const repoWith = (text) => {
  const d = emptyRepo();
  fs.writeFileSync(path.join(d, 'f.txt'), text);
  execFileSync('git', ['-C', d, 'add', '.']);
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x']);
  fs.rmSync(path.join(d, 'f.txt'));   // gone from the tree, still in history
  return d;
};

test('IN-1: three fresh ring keys + params -> inputs the ceremony parses (2-of-3); report shows no key', () => {
  const keys = [compressed(), compressed(), compressed()];
  const { inputs, report } = buildInputs({ councilKeys: council(keys), params: params(), repos: [emptyRepo()] });
  assert.equal(inputs.council.points.length, 3);
  assert.equal(inputs.council.threshold, '2');
  const p0 = expandCompressed(keys[0], 's0');
  assert.equal(inputs.council.points[0].x, p0.x.toString());
  for (const k of keys) assert.ok(!report.join('\n').includes(k));
});

test('IN-2 (negative): a key that was ever published in a checked repo is refused (hex, x hex or x decimal, history included)', () => {
  const keys = [compressed(), compressed(), compressed()];
  const p1 = expandCompressed(keys[1], 's1');
  for (const needle of keyNeedles(keys[1], p1)) {
    assert.throws(() => buildInputs({ councilKeys: council(keys), params: params(), repos: [emptyRepo(), repoWith(`old key ${needle.toUpperCase()}`)] }), /council slot 1: PUBLISHED/);
  }
  assert.deepEqual(publishedIn(keyNeedles(keys[0], expandCompressed(keys[0], 's0')), [emptyRepo()]), []);
});

test('IN-3 (negative): devnet keys, denylisted keys, duplicates, bad points, gaps, missing keys and bad thresholds are refused', () => {
  const r = [emptyRepo()];
  const dev = devnetCouncilKey(0).point;
  const devC = Buffer.from(secp256k1.Point.fromAffine({ x: dev.x, y: dev.y }).toBytes(true)).toString('hex');
  const [a, b, c] = [compressed(), compressed(), compressed()];
  const cases = [
    [council([devC, b, c]), {}, /devnet test key/],
    [council([a, b, c]), { denylist: [b.toUpperCase()] }, /slot 1: on the denylist/],
    [council([a, a, c]), {}, /duplicate/],
    [council([a, '02' + 'ff'.repeat(32), c]), {}, /slot 1: not a point/],
    [council([a, 'zz', c]), {}, /slot 1: not a compressed/],
    [council([a, null, c]), {}, /slot 1: no public key yet/],
    [{ threshold: 2, council: [{ slot: 0, publicKey: a }, { slot: 2, publicKey: c }] }, {}, /without gaps/],
    [council([a, b, c], 1), {}, /majority/],
  ];
  for (const [ck, o, re] of cases) assert.throws(() => buildInputs({ councilKeys: ck, params: params(), repos: r, ...o }), re);
  assert.throws(() => buildInputs({ councilKeys: council([a, b, c]), params: { ...params(), ebt: { ...params().ebt, daoRecipientHex: 'nope' } }, repos: r }), /daoRecipientHex/);
});

test('IN-4 (negative): the CLI never writes inside a git checkout or over an existing file', () => {
  const run = (args) => { try { execFileSync(process.execPath, ['tooling/deploy/build-preprod-inputs.mjs', ...args], { stdio: 'pipe' }); return ''; } catch (e) { return String(e.stderr); } };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ppin-'));
  const ck = path.join(d, 'ck.json'); fs.writeFileSync(ck, JSON.stringify(council([compressed(), compressed(), compressed()])));
  const pf = path.join(d, 'p.json'); fs.writeFileSync(pf, JSON.stringify(params()));
  assert.match(run(['--council-keys', ck, '--params', pf, '--out', path.join(process.cwd(), 'build', 'in.json')]), /inside a git checkout/);
  const out = path.join(d, 'existing.json'); fs.writeFileSync(out, '{}');
  assert.match(run(['--council-keys', ck, '--params', pf, '--out', out]), /exists/);
});
