// Ledger 9 port of midnightntwrk/servicedesk runbooks/contract-batched-deploy-runbook/
// scripts/measure-deploy-cost.mjs: prices a deploy carrying a chosen set of verifier keys
// with the ledger's own cost model. Offline; nothing is signed with a real key or submitted.
//
// usage: node measure-deploy-cost-l9.mjs <compiled-dir> [--only a,b,c] [--headroom 0.6]
//   --only  restrict the deploy to these circuits (e.g. the ceremony KEEP set)
// Changes from the ledger 8 original: @midnightntwrk/ledger-v9 1.0.2, verifier key version 'v4',
// prints per-circuit verifier and prover key sizes.
import fs from 'node:fs';
import path from 'node:path';
import * as L from '@midnightntwrk/ledger-v9';

const BLOCK = { readTime: 2_000_000_000_000n, computeTime: 2_000_000_000_000n, blockUsage: 1_000_000n, bytesWritten: 50_000n, bytesChurned: 50_000_000n };
const TX_BYTE_LIMIT = 1_048_576n;

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
const headroom = Number(opt('--headroom', '0.6'));
const only = opt('--only', undefined)?.split(',').filter(Boolean);
const dir = args[0];
const keysDir = path.join(dir, 'keys');

let vks = fs.readdirSync(keysDir).filter((f) => f.endsWith('.verifier')).map((f) => {
  const id = f.slice(0, -'.verifier'.length);
  const prover = path.join(keysDir, `${id}.prover`);
  return { id, vk: new Uint8Array(fs.readFileSync(path.join(keysDir, f))), proverBytes: fs.existsSync(prover) ? fs.statSync(prover).size : 0 };
});
if (only) vks = vks.filter((v) => only.includes(v.id));
vks.sort((a, b) => b.vk.length - a.vk.length);

const params = L.LedgerParameters.initialParameters();
const ttl = () => new Date(Date.now() + 3_600_000);
const deployTx = (subset) => {
  const state = new L.ContractState();
  for (const { id, vk } of subset) { const op = new L.ContractOperation(); op.verifierKey = vk; state.setOperation(id, op); }
  state.maintenanceAuthority = new L.ContractMaintenanceAuthority([L.signatureVerifyingKey(L.sampleSigningKey())], 1, 0n);
  return L.Transaction.fromParts('undeployed', undefined, undefined, L.Intent.new(ttl()).addDeploy(new L.ContractDeploy(state)));
};
const insertTx = (one) => {
  const sk = L.sampleSigningKey();
  let mu = new L.MaintenanceUpdate(L.sampleContractAddress(), [new L.VerifierKeyInsert(one.id, new L.ContractOperationVersionedVerifierKey('v4', one.vk))], 0n);
  mu = mu.addSignature(0n, L.signData(sk, mu.dataToSign));
  return L.Transaction.fromParts('undeployed', undefined, undefined, L.Intent.new(ttl()).addMaintenanceUpdate(mu));
};
const measure = (tx) => ({ bytes: BigInt(tx.serialize().length), cost: tx.cost(params) });
const pctOf = (v, lim) => (Number((v * 10000n) / lim) / 100).toFixed(1);

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
console.log(`circuits: ${vks.length}${only ? ' (--only)' : ''}`);
console.log('circuit'.padEnd(30), 'verifier', 'prover');
for (const v of vks) console.log(v.id.padEnd(30), String(v.vk.length).padStart(8), kb(v.proverBytes).padStart(12));
const vkTotal = vks.reduce((a, v) => a + v.vk.length, 0);
const pkTotal = vks.reduce((a, v) => a + v.proverBytes, 0);
console.log(`total verifier bytes: ${vkTotal}; total prover keys: ${kb(pkTotal)} (prover keys stay local, never on chain)`);

const full = measure(deployTx(vks));
console.log(`\ndeploy with these ${vks.length} verifier keys:`);
console.log(`  tx bytes      ${full.bytes} (${pctOf(full.bytes, TX_BYTE_LIMIT)}% of tx limit)`);
console.log(`  bytesWritten  ${full.cost.bytesWritten} (${pctOf(full.cost.bytesWritten, BLOCK.bytesWritten)}% of block; single-tx ceiling ~${headroom * 100}%)`);
const fits = Object.entries(BLOCK).every(([k, lim]) => full.cost[k] * 1000n <= lim * BigInt(Math.round(headroom * 1000)));
console.log(`  RESULT: ${fits ? 'FITS in one deploy tx' : 'DOES NOT FIT in one tx at this headroom: needs fencing/batching'}`);
if (vks.length) {
  const ins = measure(insertTx(vks[0]));
  console.log(`  one vk-insert maintenance tx: bytesWritten ${ins.cost.bytesWritten} (${pctOf(ins.cost.bytesWritten, BLOCK.bytesWritten)}% of block)`);
}
