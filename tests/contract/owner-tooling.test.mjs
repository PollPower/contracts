// EBT owner tooling (tooling/owner): an owner signature produced from the
// encrypted key file is accepted by the compiled EBT, including for the
// council-gated manualReissue; the key file is protected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExists, loadContract, deploy, b32, runtimePersistentHash } from '../parity/harness.mjs';
import { generateOwnerKey, ownerPublicKey, signOwnerAction, decodeArg, assertPrivateMode } from '../../tooling/owner/owner-key-lib.mjs';
import { newMachineKey } from './machine-signer.mjs';

const skip = buildExists('ebt-v8') ? false : 'build/l9/ebt-v8 missing';
const checkMode = process.platform !== 'win32';

test('OWN-1: keygen -> sign from the encrypted file -> the compiled EBT accepts the owner action', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-'));
  const file = path.join(dir, 'owner.key');
  const pk = generateOwnerKey(file, 'pass-123');
  assert.deepEqual(ownerPublicKey(file, 'pass-123', { checkMode }), pk);
  const mod = await loadContract('ebt-v8');
  const e = await deploy(mod, {}, [pk, newMachineKey().pk, { bytes: b32(0xa2) }, { bytes: b32(0x21) }, { bytes: b32(0x23) }, newMachineKey().pk, b32(0xa4)]);
  const producer = b32(0x51), meter = b32(0x52);
  const json = [{ $bytes: Buffer.from(runtimePersistentHash([producer, meter])).toString('hex') }, { $bytes: '51'.repeat(32) }, { $bytes: '52'.repeat(32) }, { $int: '1' }, { $bytes: '53'.repeat(32) }, { $int: '0' }];
  const args = decodeArg(json);
  const sig = signOwnerAction({ mod, keyFile: file, passphrase: 'pass-123', circuit: 'attestProducerOwnership', args, ebtAddressBytes: e.addressBytes, nonce: e.ledger()._ownerNonce, checkMode });
  await e.call('attestProducerOwnership', ...args, sig);
  assert.equal(e.ledger()._ownerNonce, 1n);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OWN-2 (negative): wrong passphrase, overwrite, loose permissions and untyped JSON are refused', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-'));
  const file = path.join(dir, 'owner.key');
  generateOwnerKey(file, 'pass-123');
  assert.throws(() => ownerPublicKey(file, 'nope', { checkMode: false }), /decrypt/);
  assert.throws(() => generateOwnerKey(file, 'x'), /Refusing to overwrite/);
  assert.throws(() => assertPrivateMode(0o100644, file), /permissions/);
  assert.doesNotThrow(() => assertPrivateMode(0o100600, file));
  assert.throws(() => decodeArg(['12']), /must be/);
  assert.throws(() => decodeArg({ $bytes: 'zz' }), /bad \$bytes/);
  fs.rmSync(dir, { recursive: true, force: true });
});
