// EBT owner key tooling (WI16-C-2; needed for manualReissue, Gap C).
//
// The EBT owner is a Jubjub key; every owner-gated circuit takes a Schnorr
// signature over ownerActionMessage(self, pad(circuit), ownerDigest_<circuit>(args), nonce).
// This library keeps the key encrypted at rest and signs through the COMPILED
// contract's own pure circuits, so the message can never drift from the
// circuit.
//
// Key file: salt(16) | iv(16) | tag(16) | AES-256-GCM(32-byte LE scalar), key
// from PBKDF2-SHA256(passphrase, 200k) — the same format as
// meter-authority-service's Jubjub key. Owner-only permissions are required
// (refused otherwise on POSIX). The secret is never printed or returned.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as RT from '@midnight-ntwrk/compact-runtime';

const SALT = 16, IV = 16, TAG = 16, ITERS = 200_000;
const MSG_TYPE = new RT.CompactTypeVector(1, RT.CompactTypeField);
const aesKey = (pass, salt) => crypto.pbkdf2Sync(pass, salt, ITERS, 32, 'sha256');
const le32 = (x) => Buffer.from(RT.convertBigintToBytes(32, x, 'owner-key'));
const fromLe = (b) => { let x = 0n; for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x; };

export function assertPrivateMode(mode, file) {
  if ((mode & 0o077) !== 0) throw new Error(`Refusing to use ${file}: permissions ${(mode & 0o777).toString(8)} allow group/other access; chmod 600 it`);
}

/** Creates a new owner key file (refuses to overwrite). Returns the public key only. */
export function generateOwnerKey(file, passphrase) {
  if (!passphrase) throw new Error('OWNER_KEY_PASSPHRASE is required');
  if (fs.existsSync(file)) throw new Error(`Refusing to overwrite existing key file: ${file}`);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sk = RT.jubjubSampleScalar();
  const salt = crypto.randomBytes(SALT);
  const iv = crypto.randomBytes(IV);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey(passphrase, salt), iv);
  const enc = Buffer.concat([c.update(le32(sk)), c.final()]);
  fs.writeFileSync(file, Buffer.concat([salt, iv, c.getAuthTag(), enc]), { mode: 0o600, flag: 'wx' });
  return RT.jubjubSchnorrVerifyingKey(sk);
}

function loadSecret(file, passphrase, { checkMode = process.platform !== 'win32' } = {}) {
  if (!fs.existsSync(file)) throw new Error(`Owner key file not found: ${file}`);
  if (checkMode) assertPrivateMode(fs.statSync(file).mode, file);
  const d = fs.readFileSync(file);
  if (d.length !== SALT + IV + TAG + 32) throw new Error(`Owner key file is malformed: ${file}`);
  const dec = crypto.createDecipheriv('aes-256-gcm', aesKey(passphrase, d.subarray(0, SALT)), d.subarray(SALT, SALT + IV));
  dec.setAuthTag(d.subarray(SALT + IV, SALT + IV + TAG));
  let plain;
  try { plain = Buffer.concat([dec.update(d.subarray(SALT + IV + TAG)), dec.final()]); } catch {
    throw new Error(`Failed to decrypt owner key ${file} (wrong passphrase?)`);
  }
  const sk = fromLe(plain);
  plain.fill(0);
  return sk;
}

export function ownerPublicKey(file, passphrase, opts) {
  return RT.jubjubSchnorrVerifyingKey(loadSecret(file, passphrase, opts));
}

/** JSON argument convention: {"$bytes": "<hex>"} -> Uint8Array, {"$int": "<decimal>"} -> bigint,
 *  objects and arrays recursively; anything else is refused. */
export function decodeArg(v) {
  if (Array.isArray(v)) return v.map(decodeArg);
  if (v && typeof v === 'object') {
    if ('$bytes' in v) {
      if (!/^([0-9a-fA-F]{2})*$/.test(v.$bytes)) throw new Error(`bad $bytes: ${v.$bytes}`);
      return Uint8Array.from(Buffer.from(v.$bytes, 'hex'));
    }
    if ('$int' in v) {
      if (!/^[0-9]+$/.test(String(v.$int))) throw new Error(`bad $int: ${v.$int}`);
      return BigInt(v.$int);
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decodeArg(x)]));
  }
  throw new Error(`argument values must be {"$bytes"} / {"$int"} / objects / arrays, got ${JSON.stringify(v)}`);
}

export async function loadEbtModule(buildDir) {
  return import(pathToFileURL(path.join(buildDir, 'contract', 'index.js')).href);
}

/**
 * Signs an owner action.
 * @param mod compiled EBT module; @param circuit e.g. 'manualReissue';
 * @param args decoded circuit args WITHOUT the trailing ownerSig (and without
 *   authoritySig for manualReissue: the digest covers the owner-signed args only);
 * @param ebtAddressBytes 32 bytes; @param nonce the EBT's current _ownerNonce.
 */
export function signOwnerAction({ mod, keyFile, passphrase, circuit, args, ebtAddressBytes, nonce, checkMode }) {
  const digestFn = mod.pureCircuits[`ownerDigest_${circuit}`];
  if (!digestFn) throw new Error(`EBT has no owner digest for circuit ${circuit}`);
  const tag = new Uint8Array(32);
  tag.set(Buffer.from(circuit, 'utf8'));
  const msg = mod.pureCircuits.ownerActionMessage(ebtAddressBytes, tag, digestFn(...args), BigInt(nonce));
  return RT.jubjubSchnorrSign(MSG_TYPE, [msg], loadSecret(keyFile, passphrase, { checkMode }));
}

/**
 * Signs one Field (a contract's signerMessage / hatMessage etc.) with a Jubjub
 * key file in this format (validator, operator, meter authority). The secret
 * never leaves this function.
 */
export function signFieldWithKeyFile({ keyFile, passphrase, msg, checkMode }) {
  if (!passphrase) throw new Error(`a passphrase is required for ${keyFile}`);
  return RT.jubjubSchnorrSign(MSG_TYPE, [msg], loadSecret(keyFile, passphrase, { checkMode }));
}

export const sigToJson = (s) => ({ announcement: { x: s.announcement.x.toString(), y: s.announcement.y.toString() }, response: s.response.toString() });
