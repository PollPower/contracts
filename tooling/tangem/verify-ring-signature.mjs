// Usage: node tooling/tangem/verify-ring-signature.mjs <result.json>
// <result.json> is the text the admin app's "Ring signature test" screen shares.
// Prints how the ring encodes its key and signature, and whether the compiled
// Compact stdlib secp256k1EcdsaVerify accepts it (offline). Build first:
// build/l9/tangem-verify (see docs/STATUS.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyse } from './ring-signature.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = process.argv[2];
if (!file) { console.error('usage: verify-ring-signature.mjs <result.json>'); process.exit(2); }
const result = JSON.parse(fs.readFileSync(file, 'utf8'));
const mod = await import(pathToFileURL(path.join(ROOT, 'build', 'l9', 'tangem-verify', 'contract', 'index.js')).href);
const report = analyse(mod, result);
console.log(JSON.stringify(report, null, 2));
const ok = report.circuit.asGiven === true || report.circuit.lowS === true;
console.log(ok
  ? `\nVERIFIES in the Compact circuit${report.circuit.asGiven === true ? '' : ' only after low-S normalisation'}.`
  : '\nDOES NOT VERIFY in the Compact circuit.');
process.exit(ok ? 0 : 1);
