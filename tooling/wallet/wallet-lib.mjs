// @ts-check
// Deploy-wallet helpers (Preprod ceremony). Pure functions, no network:
//   - deriveAddresses(seed, networkId): the wallet's three addresses, derived
//     offline exactly as createWallet (../midnight-providers.mjs) derives the
//     keys (WalletSeeds.fromMasterSeed, account 0, index 0).
//   - writeNewSeedFile(path): a fresh 32-byte seed, written owner-only, never
//     inside a git checkout, never over an existing file. Returns the seed so
//     the caller can derive addresses; the caller must never print it.
//   - readSeedFile(path): for wallet-status and the ceremony (no echo).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  DustAddress, MidnightBech32m, ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey,
  WalletSeeds, createKeystore,
} from '@midnightntwrk/wallet-sdk';
import { DustSecretKey, ZswapSecretKeys } from '@midnightntwrk/ledger-v9';

const SEED_RE = /^[0-9a-f]{64}$/;

/**
 * @param {Uint8Array} masterSeed 32 bytes
 * @param {string} networkId preprod | preview | mainnet | undeployed
 * @returns {{ unshielded: string, shielded: string, dust: string }}
 */
export function deriveAddresses(masterSeed, networkId) {
  if (!(masterSeed instanceof Uint8Array) || masterSeed.length !== 32) throw new Error('seed must be 32 bytes');
  const seeds = WalletSeeds.fromMasterSeed(masterSeed);
  const unshielded = String(createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, networkId).getBech32Address().asString());
  const z = ZswapSecretKeys.fromSeed(seeds.shielded);
  const shieldedAddr = new ShieldedAddress(ShieldedCoinPublicKey.fromHexString(z.coinPublicKey), ShieldedEncryptionPublicKey.fromHexString(z.encryptionPublicKey));
  const shielded = MidnightBech32m.encode(networkId, shieldedAddr).asString();
  const d = DustSecretKey.fromSeed(seeds.dust);
  const dust = String(DustAddress.encodePublicKey(networkId, d.publicKey));
  z.clear(); d.clear();
  return { unshielded, shielded, dust };
}

/** The git work tree containing `p` (walking up), or null. */
export function gitWorkTreeOf(/** @type {string} */ p) {
  let d = path.resolve(p);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Restrict a file to its owner (POSIX mode 600; on Windows, an ACL for the current user only). */
export function ownerOnly(/** @type {string} */ file) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (!user) throw new Error('USERNAME not set: cannot restrict the seed file ACL');
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
  } else {
    fs.chmodSync(file, 0o600);
  }
}

/**
 * Creates the seed file. Refuses: a path inside any git checkout, an existing
 * file (exclusive create, no overwrite), a missing parent directory.
 * @param {string} file
 * @returns {Uint8Array} the new seed (caller derives addresses; never print it)
 */
export function writeNewSeedFile(file) {
  if (!file) throw new Error('seed file path required');
  const abs = path.resolve(file);
  const repo = gitWorkTreeOf(path.dirname(abs));
  if (repo) throw new Error(`REFUSING: ${abs} is inside a git checkout (${repo}); put the seed outside every repository`);
  if (!fs.existsSync(path.dirname(abs))) throw new Error(`REFUSING: directory ${path.dirname(abs)} does not exist`);
  const seed = new Uint8Array(randomBytes(32));
  let fd;
  try {
    fd = fs.openSync(abs, 'wx', 0o600);   // fails if the file exists: never overwrite a wallet
  } catch (e) {
    if (/** @type {any} */ (e).code === 'EEXIST') throw new Error(`REFUSING: ${abs} already exists; a deploy wallet is never overwritten`);
    throw e;
  }
  try {
    fs.writeSync(fd, `${Buffer.from(seed).toString('hex')}\n`);
  } finally {
    fs.closeSync(fd);
  }
  ownerOnly(abs);
  return seed;
}

/**
 * Reads a seed file written by writeNewSeedFile. The content is never echoed,
 * not even in errors.
 * @param {string} file
 * @returns {string} 64-hex seed
 */
export function readSeedFile(file) {
  if (!file) throw new Error('seed file path required');
  const abs = path.resolve(file);
  if (gitWorkTreeOf(path.dirname(abs))) throw new Error(`REFUSING: seed file ${abs} is inside a git checkout`);
  if (process.platform !== 'win32' && (fs.statSync(abs).mode & 0o077)) throw new Error(`REFUSING: ${abs} is readable by group/others (chmod 600)`);
  const s = fs.readFileSync(abs, 'utf8').trim().toLowerCase();
  if (!SEED_RE.test(s)) throw new Error(`${abs} does not hold a 32-byte hex seed`);
  return s;
}

const PREPROD_FAUCETS = ['https://faucet.preprod.midnight.network/', 'https://midnight-tmnight-preprod.nethermind.dev/'];

/** The text new-deploy-wallet prints: addresses and the funding steps, nothing secret. */
export function fundingInstructions(/** @type {{ unshielded: string, shielded: string, dust: string }} */ a, /** @type {string} */ seedFile) {
  return [
    'Preprod deploy wallet created.',
    `Seed file (owner-only, outside every repo): ${seedFile}`,
    'The seed is NOT shown. Back the file up offline; anyone with it controls the wallet.',
    '',
    'Addresses (Preprod):',
    `  unshielded (fund this): ${a.unshielded}`,
    `  shielded:               ${a.shielded}`,
    `  dust:                   ${a.dust}`,
    '',
    'Funding steps:',
    `  1. Open a Preprod faucet (${PREPROD_FAUCETS.join(' or ')}),`,
    '     paste the UNSHIELDED address above (mn_addr_preprod1...), request tNIGHT (5,000 per request; rate limited).',
    '  2. Wait for the NIGHT to arrive and the wallet to sync (a new wallet\'s first Preprod sync can take hours):',
    '       node tooling/wallet/wallet-status.mjs --seed-file <seed file>',
    '  3. Register the NIGHT for DUST generation (one Preprod transaction; it waits until the NIGHT has generated',
    '     enough DUST to pay its own fee):',
    '       node tooling/wallet/wallet-status.mjs --seed-file <seed file> --register-dust',
    '  4. Re-run wallet-status until DUST is positive. DUST accrues over time (cap about 5 DUST per NIGHT).',
    '',
    'Endpoints come from MIDNIGHT_NETWORK_ID=preprod, MIDNIGHT_INDEXER_URL, MIDNIGHT_NODE_URL, MIDNIGHT_PROOF_SERVER_URL.',
  ].join('\n');
}
