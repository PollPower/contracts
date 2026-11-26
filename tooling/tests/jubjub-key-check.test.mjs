// Key-file passphrase check (prints the public key only) and Jubjub point checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { keygen } from '../keys/jubjub-keygen.mjs';
import { checkKeyFile } from '../keys/jubjub-key-check.mjs';
import { assertJubjubKey, mul } from '../keys/jubjub-point.mjs';
import { ROOT } from '../deploy/network.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ppkc-'));
const PASS = 'correct horse battery staple';

function setup() {
  const d = tmp();
  const a = keygen({ role: 'escrow-attestor', file: path.join(d, 'k6.enc'), passphrase: PASS });
  const b = keygen({ role: 'ebt-owner', file: path.join(d, 'k4.enc'), passphrase: PASS });
  const params = path.join(d, 'params.json');
  fs.writeFileSync(params, JSON.stringify({ tariff: {}, ebt: { escrowAttestorPk: a.publicKey, ownerPk: b.publicKey } }));
  return { d, a, b, params };
}

test('KC-1: the right passphrase opens the file and the public key matches its params field', () => {
  const { a, params } = setup();
  const r = checkKeyFile({ file: a.keyFile, passphrase: PASS, params, field: 'ebt.escrowAttestorPk' });
  assert.deepEqual(r, { keyFile: a.keyFile, field: 'ebt.escrowAttestorPk', publicKey: a.publicKey, matches: true });
});

test('KC-2: a wrong passphrase, a key for another field, an unknown field, a missing file are refused', () => {
  const { a, b, params, d } = setup();
  assert.throws(() => checkKeyFile({ file: a.keyFile, passphrase: 'wrong passphrase!!', params, field: 'ebt.escrowAttestorPk' }), /does not open/);
  assert.throws(() => checkKeyFile({ file: b.keyFile, passphrase: PASS, params, field: 'ebt.escrowAttestorPk' }), /does NOT match ebt.escrowAttestorPk/);
  assert.throws(() => checkKeyFile({ file: a.keyFile, passphrase: PASS, params, field: 'ebt.nope' }), /field must be one of/);
  assert.throws(() => checkKeyFile({ file: path.join(d, 'none.enc'), passphrase: PASS, params, field: 'ebt.ownerPk' }), /not found/);
  assert.throws(() => checkKeyFile({ file: a.keyFile, passphrase: '', params, field: 'ebt.escrowAttestorPk' }), /KEYGEN_PASSPHRASE/);
});

test('KC-3: the CLI prints the public key and OK, never the passphrase; exit 1 on mismatch', () => {
  const { a, b, params } = setup();
  const cli = path.join(ROOT, 'tooling', 'keys', 'jubjub-key-check.mjs');
  const out = execFileSync(process.execPath, [cli, '--key', a.keyFile, '--params', params, '--field', 'ebt.escrowAttestorPk'],
    { encoding: 'utf8', env: { ...process.env, KEYGEN_PASSPHRASE: PASS } });
  assert.match(out, /^OK: .* opens with this passphrase; its public key matches ebt\.escrowAttestorPk/m);
  assert.ok(out.includes(a.publicKey.x) && out.includes(a.publicKey.y));
  assert.ok(!out.includes(PASS));
  assert.equal(out.trim().split(/\r?\n/).length, 3, 'three lines: OK, x, y');
  assert.throws(() => execFileSync(process.execPath, [cli, '--key', b.keyFile, '--params', params, '--field', 'ebt.escrowAttestorPk'],
    { encoding: 'utf8', env: { ...process.env, KEYGEN_PASSPHRASE: PASS }, stdio: 'pipe' }), /does NOT match/);
});

test('KC-4: Jubjub point check accepts runtime keys, refuses off-curve, identity and torsion-shifted points', () => {
  const g = RT.jubjubSchnorrVerifyingKey(RT.jubjubSampleScalar());
  assertJubjubKey(g, 'k');
  assert.throws(() => assertJubjubKey({ x: g.x, y: g.y + 1n }, 'k'), /not on the Jubjub curve/);
  assert.throws(() => assertJubjubKey({ x: 0n, y: 1n }, 'k'), /identity or low-order/);
  // g + (0, -1): the order-2 point shifts g out of the prime-order subgroup.
  const P = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
  const shifted = { x: (P - g.x) % P, y: (P - g.y) % P };
  assert.throws(() => assertJubjubKey(shifted, 'k'), /not in the prime-order subgroup/);
  assert.deepEqual(mul(g, 0n), { x: 0n, y: 1n });
});
