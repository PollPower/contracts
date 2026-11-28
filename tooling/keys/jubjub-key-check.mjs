// @ts-check
// Confirms that a passphrase opens a Jubjub key file (K1, K4, K5, K6) and that
// its public key is the one in the ceremony params file. GARRETT RUNS THIS.
//
//   $env:KEYGEN_PASSPHRASE = <from Read-Host -AsSecureString>
//   node tooling/keys/jubjub-key-check.mjs --key <file> --params <preprod-params.json> --field <inputs field>
//
// Works for jubjub-keygen files and meter-authority-service keygen:jubjub files
// (same format). Prints "OK" and the PUBLIC x/y only; the private scalar stays
// inside this process. Exit 1 if the file does not open or the key differs.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ownerPublicKey } from '../owner/owner-key-lib.mjs';
import { assertJubjubKey } from './jubjub-point.mjs';

export const FIELDS = ['tariff.validatorPk', 'ebt.ownerPk', 'ebt.meterAuthorityPk', 'ebt.escrowAttestorPk'];

/**
 * @param {{ file: string, passphrase: string | undefined, params: string, field: string }} o
 * @returns {{ keyFile: string, field: string, publicKey: { x: string, y: string }, matches: true }}
 */
export function checkKeyFile({ file, passphrase, params, field }) {
  if (!FIELDS.includes(field)) throw new Error(`--field must be one of ${FIELDS.join(', ')}`);
  if (!passphrase) throw new Error('a passphrase is required (KEYGEN_PASSPHRASE)');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`key file not found: ${abs}`);
  const [sec, key] = field.split('.');
  const want = JSON.parse(fs.readFileSync(params, 'utf8'))?.[sec]?.[key];
  if (!want || !/^[0-9]+$/.test(String(want.x)) || !/^[0-9]+$/.test(String(want.y))) throw new Error(`${field} in ${params} is not a filled-in {x, y}`);
  assertJubjubKey(want, field);
  let pk;
  try { pk = ownerPublicKey(abs, passphrase, { checkMode: false }); } catch (e) {
    if (/wrong passphrase|malformed/.test(String(/** @type {any} */ (e)?.message))) throw new Error(`${abs} does not open with this passphrase (or is not a Jubjub key file)`);
    throw e;
  }
  const publicKey = { x: pk.x.toString(), y: pk.y.toString() };
  if (publicKey.x !== String(want.x) || publicKey.y !== String(want.y)) {
    throw new Error(`${abs} opens, but its public key does NOT match ${field} in ${params}`);
  }
  return { keyFile: abs, field, publicKey, matches: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const arg = (/** @type {string} */ k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  try {
    const r = checkKeyFile({ file: arg('--key'), passphrase: process.env.KEYGEN_PASSPHRASE, params: arg('--params'), field: arg('--field') });
    console.log(`OK: ${r.keyFile} opens with this passphrase; its public key matches ${r.field}\nx = ${r.publicKey.x}\ny = ${r.publicKey.y}`);
  } catch (e) {
    console.error(String(/** @type {any} */ (e)?.message ?? e));
    process.exit(1);
  }
}
