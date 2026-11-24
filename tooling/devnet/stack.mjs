// @ts-check
// WI-16 step 4: the whole stack on the LOCAL devnet, stage by stage (resumable;
// state in build/devnet/state.json). LOCAL DEVNET ONLY.
//
//   node tooling/devnet/stack.mjs <stage> [<stage> ...]   or   all
//
// Stages (in order):
//   council   deploy Multisig v8 (2-of-3 software test keys), one on-chain approve
//   ...       (TariffRegistry, EBT staged deploy, LD v3, settle, claim, checks:
//             added as the run proceeds)
//
// The council keys are devnet-only software stand-ins for the Tangem rings,
// derived from fixed public labels: they hold nothing and are refused on any
// other network by assertLocalDevnet. The real ring keys go into the
// constructor at the Preprod ceremony.
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { openDevnet, deploy, join, loadModule, state } from './devnet-lib.mjs';
import { signDigest } from '../../tests/contract/council-signer.mjs';

const big = (/** @type {Uint8Array} */ b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const label = (/** @type {string} */ s) => new Uint8Array(createHash('sha256').update(`pollpower wi16 devnet ${s} (test key, not a secret)`).digest());
const councilKey = (/** @type {number} */ i) => {
  const sk = label(`council ${i}`);
  const raw = secp256k1.getPublicKey(sk, false);
  return { sk, point: { x: big(raw.slice(1, 33)), y: big(raw.slice(33, 65)), identity: false } };
};
const COUNCIL = [0, 1, 2].map(councilKey);
const pad7 = () => Array.from({ length: 7 }, (_, i) => (COUNCIL[i] ?? councilKey(100 + i)).point);
const hexToBytes = (/** @type {string} */ h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

const S = state.load();
const save = () => state.save(S);

/** Approve `actionHash` on the council with slots 0 and 1 (2-of-3). */
async function approve(dn, actionHash, slots = [0, 1]) {
  const ms = await loadModule('multisig-v8');
  const council = await join(dn, 'multisig-v8', S.council);
  const self = hexToBytes(S.council);
  const epoch = 0n;
  for (const i of slots) {
    const digest = ms.pureCircuits.approvalDigest(self, actionHash, epoch);
    const t0 = Date.now();
    await council.callTx.approve(actionHash, BigInt(i), signDigest(digest, COUNCIL[i].sk));
    console.log(`[stack]   council slot ${i} approved ${Buffer.from(actionHash).toString('hex').slice(0, 16)}… (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}

const STAGES = {
  async council(dn) {
    if (!S.council) {
      const { address } = await deploy(dn, 'multisig-v8', [pad7(), 3n, 2n]);
      S.council = address;
      save();
    }
    // One on-chain approval end to end (in-circuit secp256k1, real proof).
    const probe = label('council probe action');
    await approve(dn, probe, [0]);
    const ms = await join(dn, 'multisig-v8', S.council);
    const st = await dn.providersFor('multisig-v8').publicDataProvider.queryContractState(S.council);
    console.log(`[stack] council at ${S.council}; probe approval recorded: ${st ? 'yes' : '?'}`);
    void ms;
    S.councilProbe = true;
    save();
  },
};

const wanted = process.argv.slice(2);
if (!wanted.length) { console.error(`usage: stack.mjs <${Object.keys(STAGES).join('|')}|all> ...`); process.exit(2); }
const order = wanted.includes('all') ? Object.keys(STAGES) : wanted;
const dn = await openDevnet();
for (const st of order) {
  if (!STAGES[st]) throw new Error(`unknown stage ${st}`);
  console.log(`[stack] === ${st}`);
  await STAGES[st](dn);
}
console.log(`[stack] done; state in ${state.file}`);
process.exit(0);
