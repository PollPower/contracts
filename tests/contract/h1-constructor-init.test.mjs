// WI16-H-1: no first-caller initialization. Every authority is set by the
// constructor (the deploy transaction), and no exported circuit can set it
// afterwards. Runs the compiled Compact 0.36.1 contracts offline.
//
// Negative test from the finding: on v8 / v6.2, `initialize` was exported and
// made the first caller the owner / installed the admin set. Here we assert it
// no longer exists and that the contract is usable straight after deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, buildExists, loadContract, deploy, b32, hex } from '../parity/harness.mjs';

const circuitsOf = (name) =>
  JSON.parse(fs.readFileSync(path.join(BUILD, name, 'compiler', 'contract-info.json'), 'utf8')).circuits.map((c) => c.name);
const skipIf = (name) => (buildExists(name) ? false : `build/l9/${name} missing: run \`npm run build:contracts\``);
const unused = (n) => () => { throw new Error(`witness ${n} must not be called`); };

// ---------------------------------------------------------------- EBT
const EBT = ['ebt-v8', 'ebt-v8-ceremony'];
const OWNER = { bytes: new Uint8Array(32) }; // the harness's coin public key (all zero)
const ebtArgs = () => [
  OWNER,                    // owner
  b32(0xa1),                // meterAuthorityPubkey
  b32(0xa2),                // multisigAuthorityHash
  { bytes: b32(0x21) },     // operationsRecipient
  { bytes: b32(0x22) },     // dividendRecipient
  { bytes: b32(0x23) },     // daoRecipient
  b32(0xa3),                // escrowAttestorPubkey
  b32(0xa4),                // registryActionLogRoot
];
const ebtWitnesses = { signature_valid: unused('signature_valid'), multisig_signature_valid: unused('multisig_signature_valid') };

for (const name of EBT) {
  test(`H1-${name}-1 (negative): no exported initialize circuit`, { skip: skipIf(name) }, async () => {
    assert.ok(!circuitsOf(name).includes('initialize'), 'initialize must not be an exported circuit');
    const mod = await loadContract(name);
    assert.equal(new mod.Contract(ebtWitnesses).impureCircuits.initialize, undefined);
  });

  test(`H1-${name}-2: the constructor sets every authority`, { skip: skipIf(name) }, async () => {
    const mod = await loadContract(name);
    const c = await deploy(mod, ebtWitnesses, ebtArgs());
    const L = c.ledger();
    assert.equal(L._owner.is_left, true);
    assert.equal(hex(L._owner.left.bytes), hex(OWNER.bytes));
    assert.equal(hex(L._meterAuthorityPubkey), hex(b32(0xa1)));
    assert.equal(hex(L._multisigAuthority), hex(b32(0xa2)));
    assert.equal(hex(L._operationsRecipient.bytes), hex(b32(0x21)));
    assert.equal(hex(L._dividendRecipient.bytes), hex(b32(0x22)));
    assert.equal(hex(L._daoRecipient.bytes), hex(b32(0x23)));
    assert.equal(hex(L._escrowAttestorPubkey), hex(b32(0xa3)));
    assert.equal(hex(L._registryActionLogRootMirror), hex(b32(0xa4)));
    assert.equal(L._registryActionLogHeadSeqMirror, 0n);
    assert.equal(L._livingDividendAddress.is_some, false);
  });

  test(`H1-${name}-3: usable straight after deploy (no separate initialize step)`, { skip: skipIf(name) }, async () => {
    const mod = await loadContract(name);
    const c = await deploy(mod, ebtWitnesses, ebtArgs());
    // attestProducerOwnership is owner-gated; it previously failed with "not initialized" before initialize.
    const producer = Buffer.alloc(32, 0x51);
    const meter = Buffer.alloc(32, 0x52);
    const { createHash } = await import('node:crypto');
    const key = createHash('sha256').update(Buffer.concat([producer, meter])).digest();
    await c.call('attestProducerOwnership', new Uint8Array(key), producer, meter, 1n, b32(0x53), 0n);
    assert.equal(c.ledger().producerAttestations.member(new Uint8Array(key)), true);
  });
}

// ---------------------------------------------------------------- Multisig v6.2
const MS = 'multisig-v6.2';
const msWitnesses = { signature_valid: unused('signature_valid') };
const admins = [1, 2, 3, 4, 5].map((i) => b32(0xc0 + i));

test('H1-MS-1 (negative): no exported initialize circuit', { skip: skipIf(MS) }, async () => {
  assert.ok(!circuitsOf(MS).includes('initialize'), 'initialize must not be an exported circuit');
  const mod = await loadContract(MS);
  assert.equal(new mod.Contract(msWitnesses).impureCircuits.initialize, undefined);
});

test('H1-MS-2: the constructor installs the admin set and threshold', { skip: skipIf(MS) }, async () => {
  const mod = await loadContract(MS);
  const c = await deploy(mod, msWitnesses, [...admins, 3n]);
  const L = c.ledger();
  assert.equal(L._threshold, 3n);
  assert.equal(L._admins.size(), 5n);
  for (const a of admins) assert.equal(L._admins.member(a), true);
});

test('H1-MS-3 (negative): the constructor keeps the H-3 majority floor and bounds', { skip: skipIf(MS) }, async () => {
  const mod = await loadContract(MS);
  await assert.rejects(deploy(mod, msWitnesses, [...admins, 2n]), /majority/);
  await assert.rejects(deploy(mod, msWitnesses, [...admins, 0n]), /Threshold must be > 0/);
  await assert.rejects(deploy(mod, msWitnesses, [...admins, 6n]), /Threshold must be <= initial admin count/);
});
