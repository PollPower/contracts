// @ts-check
// WI-16 Tangem test, on-chain half: deploy tangem-verify.compact to the LOCAL
// devnet and call verifyAndRecord with a real proof, so the ring's signature is
// checked by the actual secp256k1EcdsaVerify circuit, not only the JS runtime.
//
// Usage (devnet endpoints in the environment, MIDNIGHT_NETWORK_ID=undeployed):
//   node tooling/tangem/tangem-verify-devnet.mjs --software      # stand-in key, proves the path
//   node tooling/tangem/tangem-verify-devnet.mjs <result.json>   # the ring's shared result
// Needs the full-ZK build: COMPACT_REMOTE=kenya node tooling/build-contracts.mjs --zk tangem-verify
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';
import { createProviders } from '../midnight-providers.mjs';
import { devnetMasterWallet } from '../devnet/devnet-wallet.mjs';
import { hexToBytes, parsePublicKey, parseSignature, normalizeS } from './ring-signature.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = path.join(ROOT, 'build', 'l9', 'tangem-verify');
const hex = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString('hex');

/** @param {boolean} highS flip S to n-S to test the in-circuit verifier's high-S handling */
function softwareResult(highS) {
  const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest();
  const hash = sha('PollPower WI-16 Tangem secp256k1 test 2026-11-24');
  const sk = sha('wi16 software stand-in for the Tangem ring (test key, not a secret)');
  const sig = secp256k1.sign(hash, sk, { prehash: false, lowS: true });
  if (highS) {
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = n - BigInt('0x' + hex(sig.slice(32)));
    sig.set(hexToBytes(s.toString(16).padStart(64, '0')), 32);
  }
  return { curve: 'secp256k1', source: `software stand-in${highS ? ' (high-S)' : ''}`,
    publicKey: hex(secp256k1.getPublicKey(sk, true)), signature: hex(sig), hash: hex(hash) };
}

const arg = process.argv[2];
if (!arg) { console.error('usage: tangem-verify-devnet.mjs --software | --software-high-s | <result.json>'); process.exit(2); }
const result = arg.startsWith('--software') ? softwareResult(arg === '--software-high-s') : JSON.parse(fs.readFileSync(arg, 'utf8'));

const net = loadNetworkConfig();
console.log(`[tangem] ${describeNetwork(net)}`);
if (!fs.existsSync(path.join(BUILD, 'keys', 'verifyAndRecord.prover'))) throw new Error('full-ZK build missing (see usage)');

const hash = hexToBytes(result.hash);
const pk = parsePublicKey(result.publicKey);
const sig = parseSignature(result.signature);
console.log(`[tangem] key ${pk.format}; signature ${sig.encoding}; S ${sig.s === normalizeS(sig.s) ? 'low' : 'HIGH'}`);

const ctx = await devnetMasterWallet(net);
const providers = await createProviders(ctx, net, {
  zkConfigDir: BUILD,
  privateStateStoreName: 'wi16-tangem-verify',
  privateStatePassword: process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? 'Local-Devnet-Only-1' // local devnet only; Midnight.js 5 needs 3 character classes,
});
const mod = await import(pathToFileURL(path.join(BUILD, 'contract', 'index.js')).href);
const compiled = CompiledContract.make('tangem-verify', mod.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(BUILD),
);

console.log('[tangem] deploying tangem-verify to the local devnet...');
// Midnight.js 5 requires `args` even for a constructor with no parameters.
/** @type {any} */
const deployed = await deployContract(/** @type {any} */ (providers), { compiledContract: /** @type {any} */ (compiled), args: [] });
console.log(`[tangem] deployed at ${deployed.deployTxData.public.contractAddress}`);

// Negative first: a different hash must not verify (fails before proving).
const wrong = createHash('sha256').update('not the signed message').digest();
let rejected = false;
try { await deployed.callTx.verifyAndRecord(new Uint8Array(wrong), { r: sig.r, s: sig.s }, pk.point); } catch { rejected = true; }
console.log(`[tangem] wrong hash rejected: ${rejected}`);

console.log('[tangem] proving and submitting verifyAndRecord with the signature as given...');
const tx = await deployed.callTx.verifyAndRecord(hash, { r: sig.r, s: sig.s }, pk.point);
console.log(`[tangem] ON-CHAIN VERIFIED: ${JSON.stringify({ source: result.source ?? 'ring', txId: tx.public?.txId, block: tx.public?.blockHeight })}`);
console.log(rejected ? '\nRESULT: PASS' : '\nRESULT: FAIL (wrong hash was not rejected)');
process.exit(rejected ? 0 : 1);
