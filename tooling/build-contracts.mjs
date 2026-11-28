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
  'multisig-v8': 'multisig/multisig-v8-secp256k1.compact',
  'tangem-verify': 'tooling/tangem/tangem-verify.compact',
  'living-dividend-v3': 'living-dividend/living-dividend-v3.compact',
  // Test fixture (never deployed): calls EBT's dividend callees directly.
  'fixture-dividend-caller': 'tests/fixtures/dividend-caller.compact',
  'fixture-registry-anchor': 'tests/fixtures/registry-anchor-fake.compact',
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

// COMPACT_REMOTE=<ssh host>: compile on that host with `compact compile +0.36.1`
// (used while the dev workstation's WSL cannot start). All tracked .compact sources are sent
// so imports resolve; the output directory is streamed back.
function remoteCompile(host, src, outDir, zk) {
  const files = spawnSync('git', ['ls-files', '*.compact'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().split('\n');
  const tarIn = spawnSync('tar', ['cf', '-', ...files], { cwd: ROOT, maxBuffer: 1 << 30 });
  const script = [
    'set -e', 'export PATH="$HOME/.local/bin:$PATH"',
    'W=$(mktemp -d ~/wi16-work/build.XXXXXX)', 'cd "$W"', 'tar xf -',
    `compact compile +${EXPECTED.compiler} ${zk ? '' : '--skip-zk'} '${src}' out >&2`,
    'tar cf - -C out .', 'cd ~ && rm -rf -- "$W"',
  ].join('; ');
  // The ZK output (proving keys) is several GB: stream it to a file instead of
  // buffering it in memory (a maxBuffer overflow killed ssh and lost the build).
  fs.mkdirSync(outDir, { recursive: true });
  const tarName = 'remote-build.tar';
  const fd = fs.openSync(path.join(outDir, tarName), 'w');
  let r;
  try {
    r = spawnSync('ssh', ['-o', 'ConnectTimeout=15', host, `mkdir -p ~/wi16-work && bash -c '${script.replace(/'/g, "'\\''")}'`],
      { input: tarIn.stdout, stdio: ['pipe', fd, 'pipe'], maxBuffer: 1 << 26 });
  } finally { fs.closeSync(fd); }
  if (r.status !== 0) return { status: r.status ?? 1, out: `${r.error ?? ''}${r.stderr ?? ''}` };
  // cwd + relative name, not `-C <dir>`: Git-for-Windows tar reads "C:" in a path as a remote host.
  const x = spawnSync('tar', ['xmf', tarName], { cwd: outDir, maxBuffer: 1 << 26 });
  fs.rmSync(path.join(outDir, tarName), { force: true });
  return { status: x.status, out: String(r.stderr) + String(x.stderr) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const zk = process.argv.includes('--zk');
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const remote = process.env.COMPACT_REMOTE;
  const bin = remote ? null : compactBin();
  if (!remote) {
    const v = run(bin, ['compile', '--version']);
    if (!v.out.includes(EXPECTED.compiler)) {
      console.error(`compiler must be ${EXPECTED.compiler}, got: ${v.out.trim()}`);
      process.exit(1);
    }
  }
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  let failed = 0;
  for (const [name, src] of Object.entries(CONTRACTS)) {
    if (only.length && !only.includes(name)) continue;
    // Build into a staging directory; the previous build is replaced only on
    // success, so a failed build never leaves the tests without a contract.
    const out = path.join(BUILD_DIR, name);
    const staging = `${out}.staging`;
    fs.rmSync(staging, { recursive: true, force: true });
    const r = remote
      ? remoteCompile(remote, src, staging, zk)
      : run(bin, ['compile', ...(zk ? [] : ['--skip-zk']), src, staging]);
    if (r.status !== 0 || !fs.existsSync(path.join(staging, 'compiler', 'contract-info.json'))) {
      failed++; console.error(`FAIL ${name} (previous build kept)\n${r.out}`);
      fs.rmSync(staging, { recursive: true, force: true });
      continue;
    }
    fs.rmSync(out, { recursive: true, force: true });
    fs.renameSync(staging, out);
    const info = path.join(out, 'compiler', 'contract-info.json');
    const ci = JSON.parse(fs.readFileSync(info, 'utf8'));
    const ok = ci['compiler-version'] === EXPECTED.compiler && ci['language-version'] === EXPECTED.language && ci['runtime-version'] === EXPECTED.runtime;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} ${ci.circuits.length} circuits, compiler ${ci['compiler-version']}, runtime ${ci['runtime-version']}`);
  }
  process.exit(failed ? 1 : 0);
}
