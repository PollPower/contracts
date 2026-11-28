// @ts-check
// Privacy check for this PUBLIC repo (Garrett, 2026-11-25). The contracts
// stay public on purpose; operational and council details do not belong here.
// Fails on:
//   council-name      a council member's (or the standby's) name
//   ring-holder       the founder's name on the same line as a ring/card/slot/holder
//   card-id           a Tangem card ID (16 uppercase hex chars with letters and digits)
//   tailscale-ip      an address in Tailscale's 100.64.0.0/10
//   internal-host     an internal hostname (lowercase host use; "Kenya" the country is fine)
//   secp256k1-pubkey  a full secp256k1 public key (on the curve), outside test fixtures
// Names and hostnames are stored as salted SHA-256 hashes so this file does
// not publish them itself. (Short words can still be guessed from a hash; the
// point is not to list them, not to keep them secret.)
//
// Existing findings are recorded in tooling/privacy/baseline.json (they shrink
// as operational files move to the private ops repo); only NEW or INCREASED
// findings fail. Output names the file, line and rule, never the match.
//
//   node tooling/privacy/check-private-details.mjs              # all tracked files (CI)
//   node tooling/privacy/check-private-details.mjs --staged     # staged files (pre-commit)
//   node tooling/privacy/check-private-details.mjs --update-baseline
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const h = (/** @type {string} */ w) => createHash('sha256').update(`pp-privacy:${w}`).digest('hex');
/** Council members and the standby (lowercase first names). */
const NAME_HASHES = new Set([
  '6bafbae26045ffe994d35e9a0e4f126bd8167e3dbbf29883c9c5fa7dc9ebf5a8',
  'fb12d10e762c16d8c23924f6c9edb3dd56e6438f5035ff67e3bd5e3c6a42bdc4',
  '82fee56e4a6cae48722f51415a0abbebb398288d54ff24eed2b5d88e12c56779',
]);
/** Internal hosts (lowercase). */
const HOST_HASHES = new Set([
  'd1abc07a74fae8e032804163e1c5dc7549a7f252a53f7bb49e1b14572eb240fa',
  '53cac07d454e11d56374554d8b2a98ed2ec0116730569f91caf92d0c12995805',
  '14fc069370293949e3cdd7931dfd8045df908d82cc6bb57af1f93246f2d4c98c',
  'cee88429635eb2fd1d449f902f5b7af51265cb50c323f90ddfe31ccf9cb6c166',
]);

const FIXTURE = /(^|\/)(tests?|fixtures|__fixtures__)\//;
const TAILSCALE = /(?<![\d.])100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d])/;
const CARD = /(?<![0-9A-Za-z])(?=[0-9A-F ]*[A-F])(?=[0-9A-F ]*\d)(?:[0-9A-F]{16}|[0-9A-F]{4}(?: [0-9A-F]{4}){3})(?![0-9A-Za-z])/;
const PUBKEY = /(?<![0-9a-fA-F])(?:0x)?(0[23][0-9a-fA-F]{64}|04[0-9a-fA-F]{128})(?![0-9a-fA-F])/g;
const FOUNDER = /\bgarrett\b/i;
const RINGISH = /\b(ring|rings|card|cards|cardid|slot|holder|holders)\b/i;

const onCurve = (/** @type {string} */ hex) => { try { secp256k1.Point.fromHex(hex); return true; } catch { return false; } };

/** Findings for one file's text: [{ rule, line }]. */
export function scanText(/** @type {string} */ text, /** @type {string} */ file) {
  const out = /** @type {{ rule: string, line: number }[]} */ ([]);
  const fixture = FIXTURE.test(file.replace(/\\/g, '/'));
  text.split(/\r?\n/).forEach((l, i) => {
    const line = i + 1;
    const add = (/** @type {string} */ rule) => out.push({ rule, line });
    if ((l.match(/[A-Za-z]+/g) ?? []).some((w) => NAME_HASHES.has(h(w.toLowerCase())))) add('council-name');
    if (FOUNDER.test(l) && RINGISH.test(l)) add('ring-holder');
    if (CARD.test(l)) add('card-id');
    if (TAILSCALE.test(l)) add('tailscale-ip');
    if ((l.match(/[a-z0-9][a-z0-9-]*/g) ?? []).some((t) => HOST_HASHES.has(h(t)) || t.split('-').some((p) => HOST_HASHES.has(h(p))))) add('internal-host');
    if (!fixture) for (const m of l.matchAll(PUBKEY)) if (onCurve(m[1])) { add('secp256k1-pubkey'); break; }
  });
  return out;
}

/** Per-file rule counts. */
export function countFindings(/** @type {{ rule: string }[]} */ findings) {
  /** @type {Record<string, number>} */
  const c = {};
  for (const f of findings) c[f.rule] = (c[f.rule] ?? 0) + 1;
  return c;
}

/** New or increased (file, rule) counts relative to the baseline. */
export function compareToBaseline(/** @type {Record<string, Record<string, number>>} */ now, /** @type {Record<string, Record<string, number>>} */ base) {
  const bad = [];
  for (const [file, rules] of Object.entries(now)) {
    for (const [rule, n] of Object.entries(rules)) {
      const allowed = base[file]?.[rule] ?? 0;
      if (n > allowed) bad.push({ file, rule, count: n, allowed });
    }
  }
  return bad;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = path.join(ROOT, 'tooling', 'privacy', 'baseline.json');
const git = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
const SKIP = new Set(['tooling/privacy/baseline.json']);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const staged = process.argv.includes('--staged');
  const update = process.argv.includes('--update-baseline');
  const files = (staged
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    : git(['ls-files', '-z'])).split('\0').filter((f) => f && !SKIP.has(f));
  /** @type {Record<string, Record<string, number>>} */
  const now = {};
  /** @type {Record<string, { rule: string, line: number }[]>} */
  const detail = {};
  for (const f of files) {
    let buf;
    try { buf = staged ? execFileSync('git', ['show', `:${f}`], { cwd: ROOT, maxBuffer: 1 << 28 }) : fs.readFileSync(path.join(ROOT, f)); } catch { continue; }
    if (buf.length > 4 << 20 || buf.includes(0)) continue;
    const found = scanText(buf.toString('utf8'), f);
    if (found.length) { now[f] = countFindings(found); detail[f] = found; }
  }
  if (update) {
    const sorted = Object.fromEntries(Object.entries(now).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 1)}\n`);
    console.log(`[privacy] baseline written: ${Object.keys(sorted).length} file(s) with existing findings`);
    process.exit(0);
  }
  const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
  const bad = compareToBaseline(now, base);
  if (!bad.length) { console.log(`[privacy] OK: ${files.length} file(s) checked, no new findings`); process.exit(0); }
  console.error('[privacy] FAIL: council/ops details in a public repo (the matched text is not shown):');
  for (const b of bad) {
    const lines = (detail[b.file] ?? []).filter((d) => d.rule === b.rule).map((d) => d.line);
    console.error(`  ${b.file}: ${b.rule} x${b.count} (baseline ${b.allowed}) at line(s) ${lines.join(', ')}`);
  }
  console.error('Use roles instead of names, placeholders instead of hosts/addresses, and keep real keys and card IDs off-repo.');
  process.exit(1);
}
