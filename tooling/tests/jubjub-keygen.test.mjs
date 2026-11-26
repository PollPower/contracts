// Jubjub keygen for the Preprod constructor keys K1 (tariff validator), K4
// (EBT owner), K6 (escrow attestor). Temp dirs and throwaway passphrases only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { keygen, ROLES } from '../keys/jubjub-keygen.mjs';
import { ownerPublicKey } from '../owner/owner-key-lib.mjs';
import { ROOT } from '../deploy/network.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ppkg-'));
const PASS = 'correct horse battery staple';

test('KG-1: writes an encrypted owner-only key file and returns only the public key', () => {
  const f = path.join(tmp(), 'validator.jubjub.enc');
  const out = keygen({ role: 'tariff-validator', file: f, passphrase: PASS });
  assert.deepEqual(Object.keys(out).sort(), ['inputsField', 'keyFile', 'publicKey', 'role']);
  assert.equal(out.inputsField, 'tariff.validatorPk');
  assert.match(out.publicKey.x, /^[0-9]+$/);
  assert.match(out.publicKey.y, /^[0-9]+$/);
  assert.equal(fs.statSync(f).size, 16 + 16 + 16 + 32, 'salt | iv | tag | encrypted scalar');
  const pk = ownerPublicKey(f, PASS, { checkMode: false });   // same format as owner-sign uses
  assert.equal(pk.x.toString(), out.publicKey.x);
  assert.equal(pk.y.toString(), out.publicKey.y);
  assert.throws(() => ownerPublicKey(f, 'wrong passphrase!!', { checkMode: false }), /wrong passphrase/);
  if (process.platform === 'win32') {
    const acl = execFileSync('icacls', [f], { encoding: 'utf8' });
    const grants = acl.split(/\r?\n/).map((l) => l.replace(f, '').trim()).filter((l) => /:\(/.test(l));
    assert.equal(grants.length, 1, `exactly one ACL entry, got:\n${acl}`);
    assert.ok(grants[0].toLowerCase().endsWith(String.fromCharCode(92) + `${process.env.USERNAME}:(F)`.toLowerCase()), grants[0]);
    assert.ok(!/\(I\)/.test(acl), 'no inherited entries');
  } else {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  }
});

test('KG-2: each role maps to its inputs field; two runs give different keys', () => {
  assert.deepEqual(ROLES, { 'tariff-validator': 'tariff.validatorPk', 'ebt-owner': 'ebt.ownerPk', 'escrow-attestor': 'ebt.escrowAttestorPk', 'schedule-operator': 'g16 params: schedule.operatorPk' });
  const d = tmp();
  const a = keygen({ role: 'escrow-attestor', file: path.join(d, 'a.enc'), passphrase: PASS });
  const b = keygen({ role: 'ebt-owner', file: path.join(d, 'b.enc'), passphrase: PASS });
  assert.equal(a.inputsField, 'ebt.escrowAttestorPk');
  assert.equal(b.inputsField, 'ebt.ownerPk');
  assert.notEqual(a.publicKey.x, b.publicKey.x);
  const op = keygen({ role: 'schedule-operator', file: path.join(d, 'op.enc'), passphrase: PASS });
  assert.equal(op.inputsField, 'g16 params: schedule.operatorPk');
});

test('KG-3: refuses an unknown role, a weak or missing passphrase, overwrite, a git checkout, a missing directory', () => {
  const d = tmp();
  const f = path.join(d, 'k.enc');
  assert.throws(() => keygen({ role: 'meter-authority', file: f, passphrase: PASS }), /role must be one of/);
  assert.throws(() => keygen({ role: 'ebt-owner', file: f, passphrase: '' }), /passphrase/);
  assert.throws(() => keygen({ role: 'ebt-owner', file: f, passphrase: 'short' }), /at least 12/);
  assert.ok(!fs.existsSync(f), 'nothing written on refusal');
  keygen({ role: 'ebt-owner', file: f, passphrase: PASS });
  const before = fs.readFileSync(f);
  assert.throws(() => keygen({ role: 'ebt-owner', file: f, passphrase: PASS }), /exists/);
  assert.deepEqual(fs.readFileSync(f), before, 'existing key untouched');
  assert.throws(() => keygen({ role: 'ebt-owner', file: path.join(ROOT, 'build', 'k.enc'), passphrase: PASS }), /inside a git checkout/);
  assert.throws(() => keygen({ role: 'ebt-owner', file: path.join(d, 'nope', 'k.enc'), passphrase: PASS }), /does not exist/);
});

test('KG-4: the CLI prints only the public key JSON and reads the passphrase from KEYGEN_PASSPHRASE', () => {
  const f = path.join(tmp(), 'cli.enc');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tooling', 'keys', 'jubjub-keygen.mjs'), '--role', 'tariff-validator', '--key', f],
    { encoding: 'utf8', env: { ...process.env, KEYGEN_PASSPHRASE: PASS } });
  const j = JSON.parse(out);
  assert.equal(j.role, 'tariff-validator');
  assert.ok(!out.includes(PASS));
  const raw = fs.readFileSync(f);
  assert.ok(!out.includes(raw.toString('hex').slice(96)), 'ciphertext not printed');
  assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'tooling', 'keys', 'jubjub-keygen.mjs'), '--role', 'tariff-validator', '--key', f + '2'],
    { encoding: 'utf8', env: { ...process.env, KEYGEN_PASSPHRASE: '' }, stdio: 'pipe' }), /KEYGEN_PASSPHRASE/);
});
