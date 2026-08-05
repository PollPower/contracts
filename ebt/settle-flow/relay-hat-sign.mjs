// Relay-side HAT signer for EBT v8 settle. Loads the meter-authority key
// (encrypted at rest), verifies pubkey == bf043807..., signs a raw 32-byte
// payloadHash handed on argv. Key never leaves the relay.
//
// Usage: AUTHORITY_KEY_PASSPHRASE=... node relay-hat-sign.mjs <payloadHashHex32>
//   (or with no arg: just prints the pubkey for verification)
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
ed.hashes.sha512 = sha512;

const KEY_PATH = '/home/pollpower/meter-authority-service/data/authority-key.enc';
const EXPECT_PK = 'bf043807ba0112048d1ba073a47128bb094b3710036fe3da898fcd957fa6f09a';
const SALT=16, IV=16, TAG=16, ITERS=200000, KEYLEN=32, DIGEST='sha256';

async function loadKey(passphrase) {
  const data = fs.readFileSync(KEY_PATH);
  const salt = data.subarray(0, SALT);
  const iv = data.subarray(SALT, SALT+IV);
  const tag = data.subarray(SALT+IV, SALT+IV+TAG);
  const ct = data.subarray(SALT+IV+TAG);
  const aesKey = crypto.pbkdf2Sync(passphrase, salt, ITERS, KEYLEN, DIGEST);
  const dec = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  dec.setAuthTag(tag);
  const sk = Buffer.concat([dec.update(ct), dec.final()]);
  if (sk.length !== 32) throw new Error(`bad sk len ${sk.length}`);
  const pk = await ed.getPublicKeyAsync(new Uint8Array(sk));
  return { sk: new Uint8Array(sk), pk: new Uint8Array(pk) };
}

const passphrase = process.env.AUTHORITY_KEY_PASSPHRASE;
if (!passphrase) { console.error('need AUTHORITY_KEY_PASSPHRASE'); process.exit(2); }
const { sk, pk } = await loadKey(passphrase);
const pkHex = Buffer.from(pk).toString('hex');
if (pkHex !== EXPECT_PK) { console.error(`PUBKEY MISMATCH got=${pkHex} want=${EXPECT_PK}`); process.exit(3); }

const arg = process.argv[2];
if (!arg) { console.log('PUBKEY_OK', pkHex); process.exit(0); }
const msg = new Uint8Array(Buffer.from(arg.replace(/^0x/,''), 'hex'));
if (msg.length !== 32) { console.error(`payloadHash must be 32 bytes, got ${msg.length}`); process.exit(4); }
const sig = await ed.signAsync(msg, sk);
const ok = await ed.verifyAsync(sig, msg, pk);
console.log('HATSIG', Buffer.from(sig).toString('hex'));
console.log('VERIFY', ok);
console.log('PUBKEY', pkHex);
process.exit(0);
