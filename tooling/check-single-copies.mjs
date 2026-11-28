// Fails if any WASM protocol package is installed more than once. Two copies
// break `instanceof` at run time ("expected instance of StateValue") and give
// TS2345 at type-check time (Midnight.js 5 migration guide, Step 1).
// Usage: node tooling/check-single-copies.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUST_BE_SINGLE = [
  '@midnightntwrk/ledger-v9',
  '@midnightntwrk/onchain-runtime-v4',
  '@midnight-ntwrk/platform-js',
  '@midnight-ntwrk/compact-runtime',
];
const REPORT_ONLY = ['@midnightntwrk/ledger-v8', '@midnight-ntwrk/onchain-runtime-v3', 'effect'];

const found = new Map();
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.name.startsWith('@')) { walk(full); continue; }
    const pj = path.join(full, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const { name, version } = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (name) {
          if (!found.has(name)) found.set(name, []);
          found.get(name).push({ version, at: path.relative(ROOT, full) });
        }
      } catch { /* not a package */ }
      walk(path.join(full, 'node_modules'));
    }
  }
}
walk(path.join(ROOT, 'node_modules'));
for (const ws of ['tariff-registry', 'ebt/settle-flow']) walk(path.join(ROOT, ws, 'node_modules'));

// Midnight.js 5 installs the ledger 8 runtime (0.16.x) under the npm alias
// `compact-runtime-ledger8` on purpose; it is not a second copy of 0.21.0.
const isLedger8Alias = (c) => path.basename(c.at) === 'compact-runtime-ledger8';

let bad = 0;
for (const name of [...MUST_BE_SINGLE, ...REPORT_ONLY]) {
  const copies = (found.get(name) ?? []).filter((c) => !isLedger8Alias(c));
  const must = MUST_BE_SINGLE.includes(name);
  const ok = !must || copies.length === 1;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(36)} ${copies.length} cop${copies.length === 1 ? 'y' : 'ies'}: ${copies.map((c) => `${c.version} (${c.at})`).join(', ') || '-'}`);
}
for (const c of found.get('@midnight-ntwrk/compact-runtime') ?? []) {
  if (isLedger8Alias(c)) console.log(`info @midnight-ntwrk/compact-runtime ${c.version} via the ledger 8 alias at ${c.at} (expected)`);
}
process.exit(bad ? 1 : 0);
