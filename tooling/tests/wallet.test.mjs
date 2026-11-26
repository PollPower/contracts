// Deploy-wallet helpers. Throwaway seeds in temp dirs only; the generator CLI
// (new-deploy-wallet.mjs) is never run here: Garrett runs it himself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveAddresses, writeNewSeedFile, readSeedFile, fundingInstructions, gitWorkTreeOf } from '../wallet/wallet-lib.mjs';
import { parseArgs, fmtNight, fmtDust, progressLine } from '../wallet/wallet-status.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ppw-'));

test('W-1: offline addresses are deterministic Preprod bech32m addresses (matched against the wallet facade on the devnet, 2026-11-26)', () => {
  const seed = new Uint8Array(32).fill(7);
  const a = deriveAddresses(seed, 'preprod');
  assert.match(a.unshielded, /^mn_addr_preprod1/);
  assert.match(a.shielded, /^mn_shield-addr_preprod1/);
  assert.match(a.dust, /^mn_dust_preprod1/);
  assert.deepEqual(deriveAddresses(seed, 'preprod'), a);
  assert.notDeepEqual(deriveAddresses(new Uint8Array(32).fill(8), 'preprod'), a);
  assert.throws(() => deriveAddresses(new Uint8Array(31), 'preprod'), /32 bytes/);
});

test('W-2: the seed file is new, owner-only and outside every repo; never overwritten', () => {
  const d = tmp();
  const f = path.join(d, 'deploy.seed');
  const seed = writeNewSeedFile(f);
  assert.equal(seed.length, 32);
  assert.equal(fs.readFileSync(f, 'utf8').trim(), Buffer.from(seed).toString('hex'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.throws(() => writeNewSeedFile(f), /already exists/);
  assert.equal(fs.readFileSync(f, 'utf8').trim(), Buffer.from(seed).toString('hex'), 'untouched by the refused overwrite');
  assert.throws(() => writeNewSeedFile(path.join(process.cwd(), 'build', 'never.seed')), /inside a git checkout/);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'build', 'never.seed')), false);
  assert.throws(() => writeNewSeedFile(path.join(d, 'no-such-dir', 'x.seed')), /does not exist/);
  assert.equal(gitWorkTreeOf(d), null);
});

test('W-3: readSeedFile returns the seed; refuses a repo path or bad content without echoing it', () => {
  const d = tmp();
  const f = path.join(d, 's');
  fs.writeFileSync(f, `${'AB'.repeat(32)}\n`, { mode: 0o600 });
  assert.equal(readSeedFile(f), 'ab'.repeat(32));
  const bad = path.join(d, 'bad');
  fs.writeFileSync(bad, 'secret-looking-garbage', { mode: 0o600 });
  assert.throws(() => readSeedFile(bad), (e) => /32-byte hex seed/.test(e.message) && !e.message.includes('garbage'));
  assert.throws(() => readSeedFile(path.join(process.cwd(), 'package.json')), /inside a git checkout/);
});

test('W-4: the printed instructions carry the addresses and faucet/DUST steps, never the seed', () => {
  const d = tmp();
  const f = path.join(d, 'deploy.seed');
  const seed = writeNewSeedFile(f);
  const a = deriveAddresses(seed, 'preprod');
  const text = fundingInstructions(a, f);
  for (const v of Object.values(a)) assert.ok(text.includes(v));
  assert.match(text, /faucet\.preprod\.midnight\.network/);
  assert.match(text, /--register-dust/);
  assert.ok(!text.includes(Buffer.from(seed).toString('hex')), 'seed never printed');
});

test('W-5: wallet-status arguments and number formats', () => {
  assert.deepEqual(parseArgs(['--seed-file', 'x']), { seedFile: 'x', stateFile: path.resolve('x.wallet-state'), registerDust: false, watchDust: false });
  assert.equal(parseArgs(['--seed-file', 'x', '--register-dust']).registerDust, true);
  assert.equal(parseArgs(['--seed-file', 'x', '--register-dust', '--watch-dust']).watchDust, true);
  const p = { appliedIndex: 5n, highestRelevantWalletIndex: 9n, highestIndex: 10n };
  const st = { isSynced: false, shielded: { progress: p }, dust: { progress: p, balance: () => 2n * 10n ** 15n },
    unshielded: { progress: { appliedId: 3n, highestTransactionId: 4n }, balances: { ['0'.repeat(64)]: 5_000_000_000n } } };
  const line = progressLine(st, { 'h.example': { http: 7, wsOpen: 1, wsSent: 2, wsReceived: 3 } }, new Date(0));
  assert.match(line, /syncing: shielded 5\/9 \(chain 10\), dust 5\/9 \(chain 10\), unshielded 3\/4; NIGHT 5000\.000000, DUST 2\.0+ requests h\.example http 7 ws 1\/2\/3/);
  assert.ok(!progressLine(st, undefined).includes('requests'));
  assert.throws(() => parseArgs([]), /usage/);
  assert.equal(fmtNight(5_000_000_000n), '5000.000000');
  assert.equal(fmtDust(1_500_000_000_000_000n), '1.500000000000000');
});
