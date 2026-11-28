// @ts-check
// Creates the Preprod deploy wallet. GARRETT RUNS THIS HIMSELF; no agent or
// script runs it.
//
//   node tooling/wallet/new-deploy-wallet.mjs --out <seed file outside every repo>
//
// Writes a fresh 32-byte seed to --out (owner-only; refuses a path inside a git
// checkout, refuses to overwrite an existing file), then prints ONLY the
// Preprod addresses and the faucet and DUST steps. The seed is never printed,
// logged or sent anywhere. No network access.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeNewSeedFile, deriveAddresses, fundingInstructions } from './wallet-lib.mjs';

/** @param {string[]} argv @param {{ log: (s: string) => void }} [out] */
export function main(argv, out = { log: (s) => console.log(s) }) {
  const i = argv.indexOf('--out');
  const file = i >= 0 ? argv[i + 1] : '';
  if (!file || file.startsWith('--')) throw new Error('usage: node tooling/wallet/new-deploy-wallet.mjs --out <seed file outside every repo>');
  const abs = path.resolve(file);
  const seed = writeNewSeedFile(abs);
  const addresses = deriveAddresses(seed, 'preprod');
  seed.fill(0);
  out.log(fundingInstructions(addresses, abs));
  return addresses;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(String(/** @type {any} */ (e)?.message ?? e));
    process.exit(1);
  }
}
