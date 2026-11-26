// @ts-check
// Creates a Preprod constructor key (Jubjub) that Garrett holds: K1 tariff
// validator, K4 EBT owner, K6 escrow attestor, and the G16 schedule operator
// (retunes the class; its public key goes into the G16 params). GARRETT RUNS THIS HIMSELF.
//
//   $env:KEYGEN_PASSPHRASE = <from Read-Host -AsSecureString, never typed on the command line>
//   node tooling/keys/jubjub-keygen.mjs --role <tariff-validator|ebt-owner|escrow-attestor|schedule-operator> --key <file>
//
// Writes the key encrypted (owner-key format: salt | iv | tag | AES-256-GCM of
// the 32-byte scalar, key from PBKDF2-SHA256(passphrase, 200k); owner-sign.mjs
// reads it), owner-only (icacls: inheritance removed, one entry; chmod 600
// elsewhere). Refuses: an unknown role, a passphrase under 12 characters, an
// existing file, a path inside a git checkout, a missing directory. Prints
// ONLY the public key and the inputs-file field it goes into.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateOwnerKey, ownerPublicKey } from '../owner/owner-key-lib.mjs';
import { gitWorkTreeOf, ownerOnly } from '../wallet/wallet-lib.mjs';
import { devnetJubjubKeys } from '../deploy/preprod-ceremony.mjs';

/** Role -> the field of the ceremony inputs file the public key goes into. */
export const ROLES = Object.freeze({ 'tariff-validator': 'tariff.validatorPk', 'ebt-owner': 'ebt.ownerPk', 'escrow-attestor': 'ebt.escrowAttestorPk', 'schedule-operator': 'g16 params: schedule.operatorPk' });

/**
 * @param {{ role: string, file: string, passphrase: string | undefined }} o
 * @returns {{ role: string, inputsField: string, keyFile: string, publicKey: { x: string, y: string } }}
 */
export function keygen({ role, file, passphrase }) {
  const inputsField = /** @type {Record<string, string>} */ (ROLES)[role];
  if (!inputsField) throw new Error(`--role must be one of ${Object.keys(ROLES).join(', ')}`);
  if (!passphrase) throw new Error('a passphrase is required (KEYGEN_PASSPHRASE)');
  if (passphrase.length < 12) throw new Error('the passphrase must be at least 12 characters');
  if (!file) throw new Error('--key <file> is required');
  const abs = path.resolve(file);
  const repo = gitWorkTreeOf(path.dirname(abs));
  if (repo) throw new Error(`REFUSING: ${abs} is inside a git checkout (${repo}); keys live outside every repository`);
  if (!fs.existsSync(path.dirname(abs))) throw new Error(`REFUSING: directory ${path.dirname(abs)} does not exist`);
  if (fs.existsSync(abs)) throw new Error(`REFUSING: ${abs} exists (never overwritten)`);
  const pk = generateOwnerKey(abs, passphrase);
  try {
    ownerOnly(abs);
    const back = ownerPublicKey(abs, passphrase, { checkMode: false });
    if (back.x !== pk.x || back.y !== pk.y) throw new Error('key file does not read back to the same public key');
    if (devnetJubjubKeys().some((d) => d.x === pk.x && d.y === pk.y)) throw new Error('generated a devnet test key (impossible by chance)');
  } catch (e) {
    fs.rmSync(abs, { force: true });
    throw e;
  }
  return { role, inputsField, keyFile: abs, publicKey: { x: pk.x.toString(), y: pk.y.toString() } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const arg = (/** @type {string} */ k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  try {
    console.log(JSON.stringify(keygen({ role: arg('--role'), file: arg('--key'), passphrase: process.env.KEYGEN_PASSPHRASE }), null, 2));
  } catch (e) {
    console.error(String(/** @type {any} */ (e)?.message ?? e));
    process.exit(1);
  }
}
