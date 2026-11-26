// @ts-check
// DEVNET DRY RUN ONLY: stands in for a council ring. Signs a pending approval's
// digest with one of the dry run's throwaway council keys (<inputs>.secrets.json,
// written by preprod-ceremony.mjs --devnet-dry-run --make-inputs) and writes a
// result in the Admin app's ring-result format, for council-approve.mjs submit.
// Also writes the dry run's council-keys file (--council-keys-out).
//
//   node tooling/council/dry-ring-sign.mjs --secrets <inputs.secrets.json> --slot <0|1|2> --pending <pending.json> --out <result.json>
//   node tooling/council/dry-ring-sign.mjs --secrets <inputs.secrets.json> --council-keys-out <file>
//
// Refuses a pending file that is not for the local devnet (undeployed) and a
// secrets file without the dry-run marker.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '../tangem/ring-signature.mjs';

const hx = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString('hex');

function drySecrets(/** @type {string} */ file) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/DEVNET DRY RUN ONLY/.test(String(s.note)) || !Array.isArray(s.council) || s.council.length !== 3) throw new Error(`${file} is not a dry-run secrets file`);
  return s;
}

export function councilKeysFile(/** @type {any} */ s) {
  return { threshold: 2, council: s.council.map((/** @type {string} */ sk, /** @type {number} */ slot) => ({ slot, curve: 'secp256k1', publicKey: hx(secp256k1.getPublicKey(hexToBytes(sk), true)) })) };
}

export function drySign(/** @type {any} */ s, /** @type {number} */ slot, /** @type {any} */ pending) {
  if (pending.network !== 'undeployed') throw new Error(`REFUSED: the pending file is for ${pending.network}; dry-ring-sign is for the local devnet only`);
  const sk = hexToBytes(s.council[slot]);
  const pub = hx(secp256k1.getPublicKey(sk, true));
  const sig = secp256k1.sign(hexToBytes(pending.digest), sk, { prehash: false, lowS: true });
  return { test: 'wi16-tangem-secp256k1', cardId: 'DRYRUN', curve: 'secp256k1', publicKey: pub, walletPublicKey: pub, hash: pending.digest, signature: hx(sig), signatureBytes: 64 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const arg = (/** @type {string} */ k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const s = drySecrets(String(arg('--secrets')));
    if (arg('--council-keys-out')) {
      fs.writeFileSync(String(arg('--council-keys-out')), JSON.stringify(councilKeysFile(s), null, 2), { flag: 'wx' });
    } else {
      const r = drySign(s, Number(arg('--slot')), JSON.parse(fs.readFileSync(String(arg('--pending')), 'utf8')));
      fs.writeFileSync(String(arg('--out')), JSON.stringify(r, null, 2), { flag: 'wx' });
    }
  } catch (e) {
    console.error(`[dry-ring-sign] ${String(/** @type {any} */ (e)?.message ?? e)}`);
    process.exit(1);
  }
}
