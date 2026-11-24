// Preprod ceremony guards: Preprod gets exactly what passed on a fresh devnet,
// with no devnet test keys, and only by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { qualifyingPass, parseInputs, devnetJubjubKeys } from '../deploy/preprod-ceremony.mjs';
import { devnetCouncilKey } from '../council/council-keys-guard.mjs';

const MANIFEST = { builds: { 'ebt-v8': 'aa', 'multisig-v8': 'bb' }, deployCode: { 'tooling/deploy/deploy-suite.mjs': 'cc' } };
const dirWith = (recs) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ppp-'));
  recs.forEach(([f, r]) => fs.writeFileSync(path.join(d, f), JSON.stringify(r)));
  return d;
};
const passRec = (o = {}) => ({ result: 'pass', gitClean: true, network: 'undeployed', manifest: MANIFEST, ...o });

test('PC-1: a clean passing devnet record with identical builds and deploy code qualifies', () => {
  const q = qualifyingPass(MANIFEST, dirWith([['2026-11-24T20-00-00-000Z-pass.json', passRec()]]));
  assert.equal(q.ok, true);
});

test('PC-2 (negative): a changed build, changed deploy code, failed / dirty / non-devnet pass, or none: refused', () => {
  const changedBuild = { ...MANIFEST, builds: { ...MANIFEST.builds, 'ebt-v8': 'zz' } };
  assert.deepEqual(qualifyingPass(changedBuild, dirWith([['a-pass.json', passRec()]])).ok, false);
  const changedCode = { ...MANIFEST, deployCode: { 'tooling/deploy/deploy-suite.mjs': 'dd' } };
  assert.match(qualifyingPass(changedCode, dirWith([['a-pass.json', passRec()]])).reasons[0], /deployCode:tooling\/deploy\/deploy-suite\.mjs/);
  assert.equal(qualifyingPass(MANIFEST, dirWith([['a-fail.json', passRec({ result: 'fail' })]])).ok, false);
  assert.equal(qualifyingPass(MANIFEST, dirWith([['a-pass.json', passRec({ gitClean: false })]])).ok, false);
  assert.equal(qualifyingPass(MANIFEST, dirWith([['a-pass.json', passRec({ network: 'preview' })]])).ok, false);
  assert.equal(qualifyingPass(MANIFEST, dirWith([])).ok, false);
});

const big = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const realPoint = () => { const raw = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false); return { x: String(big(raw.slice(1, 33))), y: String(big(raw.slice(33, 65))) }; };
const jub = () => { const pk = RT.jubjubSchnorrVerifyingKey(RT.jubjubSampleScalar()); return { x: String(pk.x), y: String(pk.y) }; };
const inputs = (o = {}) => ({
  council: { points: [realPoint(), realPoint(), realPoint()], threshold: '2' },
  tariff: { governanceRootHex: '0e'.repeat(32), refRateFiatPerKwh: '100', validatorPk: jub() },
  ebt: { ownerPk: jub(), meterAuthorityPk: jub(), escrowAttestorPk: jub(), operationsRecipientHex: '21'.repeat(32), daoRecipientHex: '23'.repeat(32) },
  ...o,
});

test('PC-3: real public inputs parse', () => {
  const p = parseInputs(inputs());
  assert.equal(p.council.points.length, 3);
  assert.equal(p.council.threshold, 2n);
});

test('PC-4 (negative): devnet test keys are refused (council marker, label-derived Jubjub keys)', () => {
  const dc = devnetCouncilKey(0).point;
  const bad = inputs();
  bad.council.points[1] = { x: String(dc.x), y: String(dc.y) };
  assert.throws(() => parseInputs(bad), /devnet test key/);
  const [validator, , owner] = devnetJubjubKeys();
  assert.throws(() => parseInputs(inputs({ tariff: { ...inputs().tariff, validatorPk: { x: String(validator.x), y: String(validator.y) } } })), /tariff.validatorPk is a devnet test key/);
  assert.throws(() => parseInputs(inputs({ ebt: { ...inputs().ebt, ownerPk: { x: String(owner.x), y: String(owner.y) } } })), /ebt.ownerPk is a devnet test key/);
  assert.throws(() => parseInputs(inputs({ ebt: { ...inputs().ebt, daoRecipientHex: 'zz' } })), /daoRecipientHex/);
});

test('PC-5 (negative): the entry refuses without the go-ahead flag, on a non-Preprod network, or with no step', () => {
  const run = (args, env = {}) => {
    try { execFileSync(process.execPath, ['tooling/deploy/preprod-ceremony.mjs', ...args], { env: { ...process.env, ...env }, stdio: 'pipe' }); return ''; } catch (e) { return String(e.stderr); }
  };
  assert.match(run(['--step', 'council']), /manual ceremony/);
  assert.match(run(['--i-have-garretts-go-ahead']), /--step must be one of/);
  assert.match(run(['--step', 'council', '--i-have-garretts-go-ahead'], { MIDNIGHT_NETWORK_ID: 'undeployed', MIDNIGHT_NODE_URL: 'http://127.0.0.1:1', MIDNIGHT_INDEXER_URL: 'http://127.0.0.1:1/g' }), /not preprod/);
});
