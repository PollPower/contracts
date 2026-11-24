// @ts-check
// Council alert channels for the settle watcher (Garrett, 2026-11-24):
//   - a Telegram bot posting to the council group (Garrett, Jonathan, Timothy);
//   - email to each of the three council members, as the backup.
// Every channel (the Telegram group, and each member's email) is its own sink
// in the watcher loop, so each is delivered and retried independently: a
// Telegram outage never holds back the emails, an SMTP outage never holds
// back Telegram, and nothing already delivered is sent twice.
//
// Secrets (the bot token, the SMTP password) are read only from files that
// are owner-only (POSIX mode 0600 or stricter) and outside any git working
// tree; never from the environment directly, never logged, never in errors.
//
// Env (see docs/runbooks/hat-settle-watcher.md):
//   WATCHER_TELEGRAM_TOKEN_FILE, WATCHER_TELEGRAM_CHAT_ID
//   WATCHER_EMAIL_TO = "garrett:addr,jonathan:addr,timothy:addr", WATCHER_EMAIL_FROM
//   WATCHER_SMTP_HOST, WATCHER_SMTP_PORT (465 = TLS), WATCHER_SMTP_USER, WATCHER_SMTP_PASSWORD_FILE
import fs from 'node:fs';
import path from 'node:path';

/** Reads a secret from an owner-only file outside any git working tree. */
export function readSecretFile(/** @type {string} */ file, /** @type {string} */ what) {
  let st;
  try { st = fs.statSync(file); } catch { throw new Error(`${what} file not found: ${file}`); }
  if (!st.isFile()) throw new Error(`${what} file is not a regular file: ${file}`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new Error(`${what} file ${file} has permissions ${(st.mode & 0o777).toString(8)}; must be owner-only (chmod 600)`);
  }
  for (let d = path.dirname(path.resolve(file)); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) throw new Error(`${what} file ${file} is inside a git working tree (${d}); keep secrets out of repos`);
    if (path.dirname(d) === d) break;
  }
  const v = fs.readFileSync(file, 'utf8').trim();
  if (!v) throw new Error(`${what} file ${file} is empty`);
  return v;
}

/** Subject + plain-text body for one alert. */
export function formatAlert(/** @type {any} */ a, /** @type {{ network: string, ebtAddress: string }} */ ctx) {
  const problems = (a.problems ?? []).join(', ');
  const subject = `[PollPower ALERT] ${ctx.network} settle watcher: ${problems}`;
  const text = [
    `PollPower settle watcher ALERT (${ctx.network})`,
    `Problems: ${problems}`,
    `EBT: ${ctx.ebtAddress}`,
    `Chip: ${a.chipPubkey ?? '(undecodable)'}`,
    `Session: ${a.sessionId ?? '(undecodable)'}`,
    `Tx: ${a.txId ?? '-'} (indexer event ${a.eventId})`,
    `Detected: ${a.at}`,
    '',
    a.action,
  ].join('\n');
  return { subject, text };
}

/** Posts plain text to a Telegram chat; errors never contain the bot token. */
export async function telegramPost(/** @type {{ token: string, chatId: string, fetchImpl?: typeof fetch }} */ o, /** @type {string} */ text) {
  const doFetch = o.fetchImpl ?? fetch;
  const scrub = (/** @type {string} */ s) => s.split(o.token).join('<token>').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>');
  let res;
  try {
    res = await doFetch(`https://api.telegram.org/bot${o.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: o.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`telegram: ${scrub(String(/** @type {any} */ (e)?.message ?? e))}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`telegram: HTTP ${res.status} ${scrub(String(body.description ?? ''))}`.trim());
}

/** Telegram bot -> council group. One sink ("telegram:<chatId>"). */
export function telegramSink(/** @type {{ token: string, chatId: string, fetchImpl?: typeof fetch, context: any }} */ o) {
  return {
    member: `telegram:${o.chatId}`,
    async send(/** @type {any} */ alert) {
      await telegramPost(o, formatAlert(alert, o.context).text);
    },
  };
}

/** Email, one sink per council member ("email:<member>"), over one SMTP transport. */
export function emailSinks(/** @type {{ transport: { sendMail: (m: any) => Promise<any> }, from: string, to: { member: string, address: string }[], context: any }} */ o) {
  return o.to.map(({ member, address }) => ({
    member: `email:${member}`,
    async send(/** @type {any} */ alert) {
      const { subject, text } = formatAlert(alert, o.context);
      await o.transport.sendMail({ from: o.from, to: address, subject, text });
    },
  }));
}

/**
 * Both channels from the environment; refuses unless Telegram AND email to all
 * three council members are configured.
 * @param {Record<string, string | undefined>} env
 * @param {{ fetchImpl?: typeof fetch, createTransport: (o: any) => any, context: { network: string, ebtAddress: string } }} deps
 */
export function channelsFromEnv(env, deps) {
  for (const k of ['WATCHER_TELEGRAM_TOKEN', 'WATCHER_SMTP_PASSWORD']) {
    if (env[k]) throw new Error(`${k} must not be set: put the secret in a file and set ${k}_FILE`);
  }
  const need = (/** @type {string} */ k) => { const v = env[k]; if (!v) throw new Error(`${k} is required (alerts go to Telegram AND email)`); return v; };
  const tg = telegramSink({
    token: readSecretFile(need('WATCHER_TELEGRAM_TOKEN_FILE'), 'Telegram bot token'),
    chatId: need('WATCHER_TELEGRAM_CHAT_ID'), fetchImpl: deps.fetchImpl, context: deps.context,
  });
  const to = need('WATCHER_EMAIL_TO').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^([a-z0-9_-]+):([^\s@:]+@[^\s@:]+)$/i.exec(x);
    if (!m) throw new Error(`WATCHER_EMAIL_TO entry "${x}" must be member:address`);
    return { member: m[1].toLowerCase(), address: m[2] };
  });
  if (new Set(to.map((t) => t.member)).size < 3) throw new Error('WATCHER_EMAIL_TO must name all three council members');
  const port = Number(env.WATCHER_SMTP_PORT ?? 465);
  const transport = deps.createTransport({
    host: need('WATCHER_SMTP_HOST'), port, secure: port === 465, requireTLS: port !== 465,
    auth: { user: need('WATCHER_SMTP_USER'), pass: readSecretFile(need('WATCHER_SMTP_PASSWORD_FILE'), 'SMTP password') },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
  return [tg, ...emailSinks({ transport, from: need('WATCHER_EMAIL_FROM'), to, context: deps.context })];
}
