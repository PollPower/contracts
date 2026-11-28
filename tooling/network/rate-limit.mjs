// @ts-check
// Client-side request limiter for a metered endpoint (Blockfrost bridge,
// gate G2c: pay-as-you-go, 1,000,000 requests; keep the client at about 8
// requests per second).
//
// One token bucket per process, shared by everything sent to the limited
// hosts: HTTP requests (global fetch) and outgoing WebSocket messages (the
// `ws` package and Node's native WebSocket). Sends are queued in order, never
// dropped. Not limited: opening a WebSocket (a handful per step) and the
// messages the server pushes on an open subscription.
import { WebSocket as WS } from 'ws';

/**
 * Token bucket: `rate` tokens per second, at most `burst` saved up.
 * take() resolves when a token is available; callers are served in order.
 * @param {{ rate: number, burst?: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} o
 */
export function tokenBucket({ rate, burst = rate, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!(rate > 0)) throw new Error('rate must be > 0');
  let tokens = burst;
  let last = now();
  let chain = Promise.resolve();
  const refill = () => { const t = now(); tokens = Math.min(burst, tokens + ((t - last) / 1000) * rate); last = t; };
  return {
    take() {
      const turn = chain.then(async () => {
        refill();
        while (tokens < 1) { await sleep(Math.ceil(((1 - tokens) / rate) * 1000)); refill(); }
        tokens -= 1;
      });
      chain = turn.catch(() => {});
      return turn;
    },
  };
}

/** Requests per second from MIDNIGHT_RATE_LIMIT_RPS (default 8). */
export function rateFromEnv(/** @type {Record<string, string | undefined>} */ env = process.env) {
  const raw = env.MIDNIGHT_RATE_LIMIT_RPS?.trim() || '8';
  const n = Number(raw);
  if (!(n > 0 && n <= 100)) throw new Error(`MIDNIGHT_RATE_LIMIT_RPS must be a number in (0, 100], got ${JSON.stringify(raw)}`);
  return n;
}

let installed = false;

/**
 * Limits everything sent to `hosts` (host names, e.g. midnight-preprod.blockfrost.io)
 * to `rate` per second. Idempotent per process.
 * @param {{ hosts: string[], rate: number }} o
 */
export function installRateLimit({ hosts, rate }) {
  if (installed) return;
  installed = true;
  const bucket = tokenBucket({ rate, burst: Math.max(1, Math.floor(rate)) });
  const limited = (/** @type {any} */ u) => {
    try { const h = new URL(String(u?.url ?? u)).hostname; return hosts.some((x) => h === x || h.endsWith(`.${x}`)); } catch { return false; }
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (/** @type {any} */ input, /** @type {any} */ init) => {
    if (limited(input)) await bucket.take();
    return origFetch(input, init);
  };

  // ws: queue outgoing messages in order behind the bucket.
  const proto = /** @type {any} */ (WS.prototype);
  const origSend = proto.send;
  /** @this {any} */
  proto.send = function (/** @type {any[]} */ ...a) {
    const self = this;
    if (!limited(self.url)) return origSend.apply(self, a);
    self._ppQueue = (self._ppQueue ?? Promise.resolve()).then(() => bucket.take()).then(() => {
      if (self.readyState === 1) origSend.apply(self, a);
    }).catch(() => {});
  };

  const Native = /** @type {any} */ (globalThis).WebSocket;
  if (Native && Native !== WS) {
    /** @type {any} */ (globalThis).WebSocket = class extends Native {
      send(/** @type {any} */ d) {
        const self = /** @type {any} */ (this);
        const sendNow = () => super.send(d);
        if (!limited(self.url)) return sendNow();
        self._ppQueue = (self._ppQueue ?? Promise.resolve()).then(() => bucket.take()).then(() => {
          if (self.readyState === 1) sendNow();
        }).catch(() => {});
      }
    };
  }
  return bucket;
}
