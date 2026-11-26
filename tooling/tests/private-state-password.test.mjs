// Private-state password from an owner-only file (Preprod ceremony and council approvals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateStatePassword } from '../wallet/private-state-password.mjs';
import { ownerOnly } from '../wallet/wallet-lib.mjs';
import { ROOT } from '../deploy/network.mjs';

const GOOD = 'Qx7#mVr2!pLw9Zt$Kd';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pppw-'));
const fileWith = (content, { restrict = true } = {}) => { const f = path.join(tmp(), 'pw.txt'); fs.writeFileSync(f, content); if (restrict) ownerOnly(f); return f; };

test('PW-1: reads the file, strips a UTF-8 BOM and the trailing newline, never returns more', () => {
  for (const content of [GOOD, `${GOOD}\n`, `${GOOD}\r\n`, `﻿${GOOD}\r\n`]) {
    assert.equal(privateStatePassword({ MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE: fileWith(content) }), GOOD);
  }
});

test('PW-2: refusals never contain the password', () => {
  const cases = [
    [{ MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE: fileWith(GOOD), MIDNIGHT_PRIVATE_STATE_PASSWORD: GOOD }, /not both/],
    [{}, /MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE/],
    [{ MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE: fileWith('') }, /empty/],
    [{ MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE: fileWith('alllowercaseletters') }, /3 of/],
    [{ MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE: fileWith(`${GOOD}\nsecond line`) }, /one line/],
    [{ MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE: path.join(ROOT, 'package.json') }, /inside a git checkout/],
    [{ MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE: path.join(tmp(), 'missing.txt') }, /not found/],
  ];
  if (process.platform === 'win32') cases.push([{ MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE: fileWith(GOOD, { restrict: false }) }, /owner-only/]);
  for (const [env, re] of cases) {
    assert.throws(() => privateStatePassword(env), (e) => re.test(e.message) && !e.message.includes(GOOD) && !e.message.includes('alllowercaseletters'));
  }
});

test('PW-3: the plain variable still works where it did; the devnet dry run keeps its local default', () => {
  assert.equal(privateStatePassword({ MIDNIGHT_PRIVATE_STATE_PASSWORD: GOOD }), GOOD);
  assert.equal(privateStatePassword({}, { devnetDefault: 'Local-Devnet-Only-1' }), 'Local-Devnet-Only-1');
});
