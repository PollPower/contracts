// Council alert channels (Garrett, 2026-11-24): a Telegram bot posting to the
// council group AND email to every council member. Each channel is delivered
// and retried on its own: a Telegram outage never holds back the emails, and
// an SMTP outage never holds back Telegram. Secrets come only from files with
// owner-only permissions, never from the repo, and never appear in errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { telegramSink, emailSinks, channelsFromEnv, readSecretFile, formatAlert } from '../watcher/alert-channels.mjs';
import { createWatcher } from '../watcher/settle-watcher-loop.mjs';

const TOKEN = '123456:AAFAKE-test-token-not-real';
const ALERT = {
  kind: 'settle-watcher-alert', eventId: 7, txId: 'ab'.repeat(32), problems: ['bad_chip_signature'],
  chipPubkey: 'cd'.repeat(32), sessionId: 'ef'.repeat(32), action: 'Council: verify, then 2-of-3 revokeChip.', at: '2026-11-24T00:00:00.000Z',
};
const CTX = { network: 'preprod', ebtAddress: '12'.repeat(32) };
const okFetch = (calls) => async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
const transport = (sent) => ({ sendMail: async (m) => { sent.push(m); } });
const MEMBERS = [{ member: 'garrett', address: 'g@example.org' }, { member: 'member1', address: 'm1@example.org' }, { member: 'member2', address: 'm2@example.org' }];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ac-'));

test('AC-1: Telegram posts the alert to the council group as plain text', async () => {
  const calls = [];
  await telegramSink({ token: TOKEN, chatId: '-1001234', fetchImpl: okFetch(calls), context: CTX }).send(ALERT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].body.chat_id, '-1001234');
  assert.equal(calls[0].body.parse_mode, undefined);
  for (const s of ['bad_chip_signature', ALERT.chipPubkey, ALERT.sessionId, ALERT.txId, 'preprod', CTX.ebtAddress, 'revokeChip']) assert.ok(calls[0].body.text.includes(s), s);
});

test('AC-2 (negative): a Telegram failure throws without ever showing the bot token', async () => {
  const leaky = async (url) => { throw new Error(`connect ECONNREFUSED ${url}`); };
  const notOk = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) });
  const apiErr = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, description: 'chat not found' }) });
  for (const f of [leaky, notOk, apiErr]) {
    const err = await telegramSink({ token: TOKEN, chatId: '-1', fetchImpl: f, context: CTX }).send(ALERT).then(() => null, (e) => e);
    assert.ok(err, 'must throw');
    assert.ok(!String(err.message).includes(TOKEN) && !String(err.message).includes('AAFAKE'), err.message);
  }
});

test('AC-3: one email per council member, each its own sink', async () => {
  const sent = [];
  const sinks = emailSinks({ transport: transport(sent), from: 'watcher@example.org', to: MEMBERS, context: CTX });
  assert.deepEqual(sinks.map((s) => s.member), ['email:garrett', 'email:member1', 'email:member2']);
  for (const s of sinks) await s.send(ALERT);
  assert.deepEqual(sent.map((m) => m.to), ['g@example.org', 'm1@example.org', 'm2@example.org']);
  assert.match(sent[0].subject, /ALERT.*bad_chip_signature/);
  assert.ok(sent[0].text.includes(ALERT.sessionId));
});

const watcherWith = (sinks, dir) => createWatcher({
  chipLookup: async () => null, sinks, stateFile: path.join(dir, 'w.json'), log: { warn() {}, error() {} },
});
// An event the watcher must alert on: a settleChip event that cannot be decoded.
const badEvent = (id) => ({ id, name: Buffer.from('pp:ebt:v9:settleChip').toString('hex'), payload: 'zz', transactionId: 'tx' });

test('AC-4: Telegram down -> all three emails still go out; Telegram alone is retried later, no duplicate email', async () => {
  const sent = [];
  let tgUp = false; const tgCalls = [];
  const tgFetch = async (url, init) => { if (!tgUp) throw new Error('ETIMEDOUT'); return okFetch(tgCalls)(url, init); };
  const sinks = [telegramSink({ token: TOKEN, chatId: '-1', fetchImpl: tgFetch, context: CTX }), ...emailSinks({ transport: transport(sent), from: 'w@x', to: MEMBERS, context: CTX })];
  const w = watcherWith(sinks, tmp());
  const r = await w.process([badEvent(1)]);
  assert.equal(r.alerts, 1);
  assert.equal(sent.length, 3, 'emails delivered while Telegram is down');
  assert.equal(w.state().pendingAlerts.length, 1);
  assert.deepEqual(w.state().pendingAlerts[0].deliveredTo.sort(), ['email:garrett', 'email:member1', 'email:member2']);
  tgUp = true;
  assert.equal(await w.retryPending(), 0);
  assert.equal(tgCalls.length, 1, 'Telegram delivered on retry');
  assert.equal(sent.length, 3, 'no duplicate emails');
});

test('AC-5: SMTP down -> Telegram still goes out; emails are retried later, Telegram not repeated', async () => {
  const sent = []; const tgCalls = [];
  const smtp = { up: false, sendMail: async (m) => { if (!smtp.up) throw new Error('SMTP 421'); sent.push(m); } };
  const sinks = [telegramSink({ token: TOKEN, chatId: '-1', fetchImpl: okFetch(tgCalls), context: CTX }), ...emailSinks({ transport: smtp, from: 'w@x', to: MEMBERS, context: CTX })];
  const w = watcherWith(sinks, tmp());
  await w.process([badEvent(1)]);
  assert.equal(tgCalls.length, 1, 'Telegram delivered while SMTP is down');
  assert.equal(sent.length, 0);
  smtp.up = true;
  assert.equal(await w.retryPending(), 0);
  assert.equal(sent.length, 3);
  assert.equal(tgCalls.length, 1, 'Telegram not repeated');
});

test('AC-6 (negative): secret files must exist, be non-empty and (POSIX) owner-only', { skip: process.platform === 'win32' ? 'POSIX permissions' : false }, () => {
  const d = tmp();
  const f = path.join(d, 'token');
  fs.writeFileSync(f, `${TOKEN}\n`, { mode: 0o600 });
  assert.equal(readSecretFile(f, 'token'), TOKEN);
  fs.chmodSync(f, 0o640);
  assert.throws(() => readSecretFile(f, 'token'), /permissions/);
  fs.chmodSync(f, 0o604);
  assert.throws(() => readSecretFile(f, 'token'), /permissions/);
  const empty = path.join(d, 'empty'); fs.writeFileSync(empty, '\n', { mode: 0o600 });
  assert.throws(() => readSecretFile(empty, 'token'), /empty/);
  assert.throws(() => readSecretFile(path.join(d, 'missing'), 'token'), /token file/);
});

test('AC-6b (negative): a secret file inside a git working tree is refused', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.git'));
  fs.mkdirSync(path.join(d, 'sub'));
  const f = path.join(d, 'sub', 'token');
  fs.writeFileSync(f, TOKEN, { mode: 0o600 });
  assert.throws(() => readSecretFile(f, 'token'), /git working tree/);
});

test('AC-7 (negative): the service needs BOTH channels and all three members; no secret in the environment itself', () => {
  const d = tmp();
  const tok = path.join(d, 'tg'); fs.writeFileSync(tok, TOKEN, { mode: 0o600 });
  const pw = path.join(d, 'smtp'); fs.writeFileSync(pw, 'app-password', { mode: 0o600 });
  const env = {
    WATCHER_TELEGRAM_TOKEN_FILE: tok, WATCHER_TELEGRAM_CHAT_ID: '-1001234',
    WATCHER_EMAIL_TO: 'garrett:g@example.org,member1:m1@example.org,member2:m2@example.org', WATCHER_EMAIL_FROM: 'watcher@example.org',
    WATCHER_SMTP_HOST: 'smtp.example.org', WATCHER_SMTP_PORT: '465', WATCHER_SMTP_USER: 'watcher@example.org', WATCHER_SMTP_PASSWORD_FILE: pw,
  };
  const made = [];
  const deps = { fetchImpl: okFetch([]), createTransport: (o) => { made.push(o); return transport([]); }, context: CTX };
  const sinks = channelsFromEnv(env, deps);
  assert.deepEqual(sinks.map((s) => s.member), ['telegram:-1001234', 'email:garrett', 'email:member1', 'email:member2']);
  assert.equal(made[0].auth.pass, 'app-password');
  assert.equal(made[0].secure, true);
  for (const k of ['WATCHER_TELEGRAM_TOKEN_FILE', 'WATCHER_TELEGRAM_CHAT_ID', 'WATCHER_EMAIL_TO', 'WATCHER_SMTP_HOST', 'WATCHER_SMTP_PASSWORD_FILE']) {
    const e = { ...env }; delete e[k];
    assert.throws(() => channelsFromEnv(e, deps), new RegExp(k));
  }
  assert.throws(() => channelsFromEnv({ ...env, WATCHER_EMAIL_TO: 'garrett:g@example.org,member1:m1@example.org' }, deps), /three council members/);
  assert.throws(() => channelsFromEnv({ ...env, WATCHER_TELEGRAM_TOKEN: TOKEN }, deps), /WATCHER_TELEGRAM_TOKEN.*file/);
});

test('AC-8: formatAlert names the network, the contract, every problem and the council action', () => {
  const { subject, text } = formatAlert({ ...ALERT, problems: ['bad_chip_signature', 'chip_revoked'] }, CTX);
  assert.match(subject, /\[PollPower ALERT\] preprod settle watcher: bad_chip_signature, chip_revoked/);
  for (const s of [CTX.ebtAddress, ALERT.chipPubkey, ALERT.sessionId, ALERT.txId, 'revokeChip', 'event 7']) assert.ok(text.includes(s), s);
});
