// @ts-check
// Request counter, loaded with `node --import ./tooling/network/count-requests.mjs <script>`.
// Counts HTTP requests (global fetch) and WebSocket connections and messages
// (the `ws` package, which the SDKs use in Node) per host, and prints the
// totals to stderr at exit. Used to size the ceremony's load on a hosted
// endpoint (Blockfrost plan) from a devnet dry run of the same script.
// Hosts only, never URLs (query strings can carry tokens).
import { WebSocket as WS } from 'ws';

/** @type {Record<string, { http: number, wsOpen: number, wsSent: number, wsReceived: number }>} */
const counts = {};
// Readable while running (wallet-status prints it with its progress lines).
/** @type {any} */ (globalThis).__ppRequestCounts = counts;
const at = (/** @type {any} */ u) => {
  let host = '?';
  try { host = new URL(String(u?.url ?? u)).host; } catch { /* not a URL */ }
  return (counts[host] ??= { http: 0, wsOpen: 0, wsSent: 0, wsReceived: 0 });
};

const origFetch = globalThis.fetch;
globalThis.fetch = (/** @type {any} */ input, /** @type {any} */ init) => { at(input).http++; return origFetch(input, init); };

const proto = /** @type {any} */ (WS.prototype);
const origSend = proto.send;
proto.send = function (/** @type {any[]} */ ...a) { at(this.url).wsSent++; return origSend.apply(this, a); };
const origEmit = proto.emit;
proto.emit = function (/** @type {string} */ ev, /** @type {any[]} */ ...a) {
  if (ev === 'open') at(this.url).wsOpen++;
  if (ev === 'message') at(this.url).wsReceived++;
  return origEmit.call(this, ev, ...a);
};

// Node 22+ also has a native global WebSocket (used when nothing replaces it).
const Native = /** @type {any} */ (globalThis).WebSocket;
if (Native && Native !== WS) {
  /** @type {any} */ (globalThis).WebSocket = class extends Native {
    constructor(/** @type {any} */ url, /** @type {any} */ protocols) {
      super(url, protocols);
      const c = at(url);
      this.addEventListener('open', () => { c.wsOpen++; });
      this.addEventListener('message', () => { c.wsReceived++; });
    }
    send(/** @type {any} */ d) { at(this.url).wsSent++; return super.send(d); }
  };
}

process.on('exit', () => {
  process.stderr.write(`[count-requests] ${JSON.stringify(counts)}\n`);
});
