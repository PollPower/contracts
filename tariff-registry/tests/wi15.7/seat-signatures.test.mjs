import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Buffer } from 'buffer';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

import { loadSeatSignatures, PILOT_THRESHOLD } from '../../deploy/seat-signatures.ts';

ed.hashes.sha512 = sha512;

function toHex(bytes) {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function writeJsonFixture(tmpDir, name, value) {
  const file = path.join(tmpDir, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

async function synthesizeBundle(count = PILOT_THRESHOLD) {
  const actionHash = new Uint8Array(32);
  for (let i = 0; i < actionHash.length; i++) actionHash[i] = (i * 17) & 0xff;

  const entries = [];
  const signatures = [];
  const seatPubkeys = [];
  for (let i = 0; i < count; i++) {
    const sk = new Uint8Array(32);
    sk.fill(i + 1);
    const pk = await ed.getPublicKeyAsync(sk);
    const sig = await ed.signAsync(actionHash, sk);
    entries.push({
      seatId: i,
      signature: toHex(sig),
      publicKey: toHex(pk),
    });
    signatures.push(sig);
    seatPubkeys.push(pk);
  }

  return {
    fileJson: {
      actionHash: toHex(actionHash),
      epoch: 0,
      signatures: entries,
    },
    actionHash,
    signatures,
    seatPubkeys,
  };
}

test('WI-15.7 loader happy path returns unchanged ApprovalBundle', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wi15.7-seat-sigs-'));
  try {
    const built = await synthesizeBundle(3);
    const fixture = writeJsonFixture(tmpDir, 'happy.json', built.fileJson);
    const loaded = loadSeatSignatures(fixture);
    assert.equal(loaded.threshold, PILOT_THRESHOLD);
    assert.equal(loaded.signatures.length, 3);
    assert.equal(loaded.seatPubkeys.length, 3);
    assert.deepEqual(
      loaded.signatures.map((s) => toHex(s)),
      built.signatures.map((s) => toHex(s)),
    );
    assert.deepEqual(
      loaded.seatPubkeys.map((s) => toHex(s)),
      built.seatPubkeys.map((s) => toHex(s)),
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WI-15.7 loader throws when threshold not met', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wi15.7-seat-sigs-'));
  try {
    const built = await synthesizeBundle(2);
    const fixture = writeJsonFixture(tmpDir, 'below-threshold.json', built.fileJson);
    assert.throws(() => loadSeatSignatures(fixture), /threshold not met/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WI-15.7 loader throws on invalid signature', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wi15.7-seat-sigs-'));
  try {
    const built = await synthesizeBundle(3);
    const firstSigBytes = Buffer.from(built.fileJson.signatures[0].signature.slice(2), 'hex');
    firstSigBytes[0] ^= 0x01;
    built.fileJson.signatures[0].signature = `0x${firstSigBytes.toString('hex')}`;
    const fixture = writeJsonFixture(tmpDir, 'invalid-signature.json', built.fileJson);
    assert.throws(
      () => loadSeatSignatures(fixture),
      /signature verification failed for seatId 0/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WI-15.7 loader throws on wrong pubkey length', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wi15.7-seat-sigs-'));
  try {
    const built = await synthesizeBundle(3);
    built.fileJson.signatures[1].publicKey = `0x${built.fileJson.signatures[1].publicKey.slice(2, -2)}`;
    const fixture = writeJsonFixture(tmpDir, 'wrong-pubkey-len.json', built.fileJson);
    assert.throws(() => loadSeatSignatures(fixture), /invalid publicKey length/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WI-15.7 loader throws on malformed JSON', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wi15.7-seat-sigs-'));
  try {
    const fixture = path.join(tmpDir, 'malformed.json');
    writeFileSync(fixture, '{ "actionHash": "0x1234", ');
    assert.throws(() => loadSeatSignatures(fixture), /seat-signatures parse error/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
