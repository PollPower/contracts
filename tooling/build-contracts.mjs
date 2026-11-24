// Compiles the WI-16 (ledger 9) contracts into build/l9/<name> for the parity
// tests. `--skip-zk` by default (the tests execute circuits, they don't prove);
// pass --zk for full keys.
//
// Compiler: COMPACT_BIN if set. Otherwise `compact` on PATH, except on Windows,
// where `compact` resolves to C:\Windows\system32\compact.exe (the NTFS tool),
// so the WSL shim at ~/bin/compact.cmd is required (see docs/STATUS.md).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONTRACTS = {
  'ebt-v8': 'ebt/ebt-v8.compact',
  'ebt-v8-ceremony': 'ebt/ebt-v8-ceremony.compact',
  'tariff-registry-v1': 'tariff-registry/tariff-registry-v1.compact',
  'tariff-registry-v1-ceremony': 'tariff-registry/tariff-registry-v1-ceremony.compact',
  'multisig-v6.2': 'multisig/multisig-v6.2-ed25519.compact',
  'tangem-verify': 'tooling/tangem/tangem-verify.compact',
};
export const BUILD_DIR = path.join(ROOT, 'build', 'l9');
const EXPECTED = { compiler: '0.36.1', language: '0.28.0', runtime: '0.21.0' };

function compactBin() {
  if (process.env.COMPACT_BIN) return process.env.COMPACT_BIN;
  if (process.platform === 'win32') {
    const shim = path.join(os.homedir(), 'bin', 'compact.cmd');
    if (fs.existsSync(shim)) return shim;
    throw new Error('On Windows set COMPACT_BIN (system32\\compact.exe is not the Midnight compiler).');
  }
  return 'compact';
}

function run(bin, args) {
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).filter((l) => !/Failed to translate/.test(l)).join('\n');
  return { status: r.status, out };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const zk = process.argv.includes('--zk');
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const bin = compactBin();
  const v = run(bin, ['compile', '--version']);
  if (!v.out.includes(EXPECTED.compiler)) {
    console.error(`compiler must be ${EXPECTED.compiler}, got: ${v.out.trim()}`);
    process.exit(1);
  }
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  let failed = 0;
  for (const [name, src] of Object.entries(CONTRACTS)) {
    if (only.length && !only.includes(name)) continue;
    const out = path.join(BUILD_DIR, name);
    fs.rmSync(out, { recursive: true, force: true });
    const r = run(bin, ['compile', ...(zk ? [] : ['--skip-zk']), src, out]);
    const info = path.join(out, 'compiler', 'contract-info.json');
    if (r.status !== 0 || !fs.existsSync(info)) { failed++; console.error(`FAIL ${name}\n${r.out}`); continue; }
    const ci = JSON.parse(fs.readFileSync(info, 'utf8'));
    const ok = ci['compiler-version'] === EXPECTED.compiler && ci['language-version'] === EXPECTED.language && ci['runtime-version'] === EXPECTED.runtime;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} ${ci.circuits.length} circuits, compiler ${ci['compiler-version']}, runtime ${ci['runtime-version']}`);
  }
  process.exit(failed ? 1 : 0);
}
