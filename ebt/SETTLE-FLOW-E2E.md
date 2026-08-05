# EBT v8 Settle-Flow E2E (Preview) — Ceremony Runbook

**Status:** ✅ Completed end-to-end on Preview, 2026-08-05.
**Scope:** the full `retune → mirror → attest → settle → revoke` money-path
lifecycle against the live pilot contracts, exercising a **real HAT signature**
from the meter authority and a **coherent, settleable tariff class**.

This document is the reproducible runbook for that flow, plus the hard-won
operational gotchas. It complements:
- `VNEXT-DESIGN.md` (§5 settle, §7 mirror-write circuits)
- `V8-CEREMONY-FENCE.md` (ceremony deploy + vk-insert rollout)
- `WI-14-CEREMONY-SKELETON.md` (steady-state ceremony)

---

## 1. Why this was needed

After the mirror-daemon E2E (settlement-api PR #10), the pilot registry held a
schedule + 4 lanes but **no `retuneClass` (kind-2) event**, so the EBT's
`_classStatutoryTotalBpsMirror` was empty. `settle` step 6 asserts
`_classStatutoryTotalBpsMirror.member(classKey)` → any settle attempt hard-failed
`CLASS_NOT_LIVE`. The Aug-1 pilot data was placeholder to exercise the mirror
pipeline, not a coherent settleable tariff.

Making settle real required mutating the live pilot registry with a coherent
`retuneClass`, mirroring it, then settling.

## 2. Contract topology (Preview)

| role | address | notes |
|------|---------|-------|
| EBT v8 | `c9ee61713d07c6d6e6f3c0bbe119d281307c643caaaf8d785813a9fb52f036e3` | ceremony variant, all 18 circuits rolled in |
| Registry (monolith-ceremony) | `556fe46f8dfd5234e97974bfd8b455ef4ea8c785641d80a4d7c12530a3776dd9` | 7 keep + 11 vk-inserted (incl. `retuneClass`) |
| Meter authority pubkey | `bf043807ba0112048d1ba073a47128bb094b3710036fe3da898fcd957fa6f09a` | `_meterAuthorityPubkey`; key on relay |
| Schedule | `0a0ca2e41632da85802a34207c58883f54cc2a1375ca77887c7b8dc682df101a` | operatorPubkey = audit-writer `3e64530c…`, refRate 28, effectiveEpoch 2 |
| Charter node (leviedBy) | `96a0e3b3020797f3e5ffd0687834564427b88f084c5b3e424526b492a66a0d0c` | levier for all 4 lanes |

Network: **Preview** (`testnet-02` retired). Public RPC
`https://rpc.preview.midnight.network`, indexer
`https://indexer.preview.midnight.network/api/v3/graphql`, local proof server
`http://127.0.0.1:6300`.

## 3. The coherent split (design)

The 4 pilot lanes are producer(4643)/ops(1643)/dividend(1929)/statutory(1785) bps
= 10000. `settle` requires `statutorySum == statutoryTotalBps` (step 11) where
`statutorySum` is the sum of the **enumerated** live lanes' bpsShares, and
`operatorMarginBps + opsBps + ldBps + daoBps + statutoryTotalBps == 10000` (step 12).

To leave room for the non-statutory slices, we enumerate **only the statutory
lane** (kind 3, bps 1785) and set `statutoryTotalBps = 1785`:

| field | retuneClass `SplitShares` | settle keeper bps | settle amount slice (amount=100000) |
|-------|---------------------------|-------------------|-------------------------------------|
| producer | producerShareBps 4643 | operatorMarginBps 4643 | 46430 |
| ops | opsShareBps 2000 (≥ OPS_FLOOR 2000) | opsBps 2000 | 20000 |
| living-dividend | ldShareBps 1572 (≥ LD_FLOOR 200) | ldBps 1572 | 15720 |
| dao | daoShareBps 0 | daoBps 0 | 0 |
| operatorMargin | operatorMarginBps 0 | — | — |
| statutory | statutoryTotalBps 1785 | (lane, kind 3) | 17850 |
| **sum** | **10000** | **10000** | **100000** |

`amount = 100000` is a multiple of 10000 so every slice is exact
(`assertSliceOnPolicy` is satisfied with zero rounding drift). rate stays 28
(in the ±20% sanity band [22.4, 33.6]). classPath is free (settle keys lanes
classPath-independently; only the class-total lookup uses `classKey`); we used
`c1a55a7400000000000000000000000000000000000000000000000000000001`.

## 4. Step order (MANDATORY)

`verifyEventProof` / `mirrorClassStatutoryTotal` check the reconstructed action-log
root against the **current** `_registryActionLogRootMirror`; `mirrorActionLogRoot`
checks against the **new** root it installs. So the mirror advance must come first:

1. **`retuneClass`** (registry) — emits kind-2 event, advances `_actionSeq` and
   populates `_classEntries`.
2. **`mirrorActionLogRoot`** (EBT, owner) — advance mirror root to the new registry root.
3. **`mirrorClassStatutoryTotal`** (EBT, owner) — mirror the kind-2 event's
   `statutoryTotalBps` into `_classStatutoryTotalBpsMirror`.
4. **`mirrorActionLogHead`** (EBT, owner) — advance the freshness head to the new head seq.
5. **`settle`** (EBT) — HAT-signed, mints the coherent split.
6. **`revokeProducerOwnership`** (EBT, owner) — lifecycle bookend.

(`attestProducerOwnership` was done in the prior session; the attestation must be
`active` at settle time.)

## 5. HAT signing (key stays on relay)

`settle` step 2 builds a **6-field** payload hash and asserts
`signature_valid(hatPubkey, payloadHash, hatSig)` (a **witness** — the JS side
verifies ed25519), with `hatPubkey == _meterAuthorityPubkey`:

```
payloadHash = persistentHash<Vector<6, Bytes<32>>>([
  pad(32, "pollpower:ebt:v8:epoch1"),
  sessionID,
  hatPubkey,
  convertFieldToBytes(32, amount),   // (amount as Field) as Bytes<32>
  producerKey,
  producerAddr.bytes,
])
```

The meter-authority private key lives **encrypted at rest on the relay**
(`meter-authority-service/data/authority-key.enc`; salt16|iv16|tag16|ct,
PBKDF2-SHA256 200k, AES-256-GCM, ed25519). It never moves. The flow:

1. Kenya computes `payloadHash` — `node ceremony.mjs settle hash-only`.
2. The relay signs that raw 32-byte hash — `relay-hat-sign.mjs <payloadHashHex>`
   (loads the key, asserts pubkey == `bf043807…`, ed25519-signs, self-verifies).
3. Kenya runs `settle` with the signature supplied via `HAT_SIG` env.

The `signature_valid` witness (a) asserts the runtime's in-circuit messageHash
equals the precomputed `payloadHash` (so a stale sig can't be used), then
(b) ed25519-verifies. Observed at submit: `matchesPrecomputed=true`, `verify=true`.

## 6. Operational gotchas (add to L-list)

1. **`retuneClass` is NOT in the ceremony registry build.** The ceremony build
   (`ebt/registry-build/ceremony`) is the 7-KEEP-circuit fenced subset; its
   compiled `contract/index.js` has no `retuneClass` impureCircuit — copying keys
   is useless. Use the **full monolith build** (`tariff-registry/build/`), which
   defines all 18 circuits and whose shared-circuit verifier bytes are byte-
   identical to the ceremony build (so it decodes the same on-chain state and the
   deployed `retuneClass` verifier matches).
2. **Realm unification.** The full build's `contract/index.js` resolves
   `@midnight-ntwrk/*` from `tariff-registry/node_modules` — a DIFFERENT realm
   than the wallet/provider stack (settlement-api realm) → `expected instance of
   ChargedState` at the WASM `_assertClass` boundary. **Fix:** stage the full
   build's `contract/ + keys/ + zkir/` under a run dir whose `node_modules`
   symlinks to the settlement-api realm, and run from there.
3. **Run under plain `node`, from a clean cwd.** `tsx` duplicates the
   onchain-runtime WASM (same ChargedState failure). A stale `midnight-level-db`
   in cwd fails decryption ("Unsupported state or unable to authenticate data")
   → use a fresh run dir per invocation.
4. **level-db password policy tightened:** the private-state store password now
   requires ≥3 of {uppercase, lowercase, digit, special}.
5. **Witnesses, not vacant.** EBT v8 needs `signature_valid` +
   `multisig_signature_valid` witness fns (not `withVacantWitnesses`).
   `retuneClass` uses `signature_valid(operatorId, …)` only (no multisig approval
   bundle). `divLo`/`divHi` are **positional** `DivResult` args
   (`{quotient, remainder}`), not witnesses — `checkedDivide(28*2000, 10000)` =
   `{5, 6000}`.
6. **PowerShell → SSH:** write `.sh`/`.mjs`, `scp`, run over `ssh`. Never inline
   shell-special chars or `&&` chains; don't `git show | <PS cmdlet>` for byte audits.

## 7. Scripts in this directory

- `settle-flow/retune.mjs` — emits `retuneClass` (staged full-build run dir pattern).
- `settle-flow/ceremony.mjs` — orchestrator:
  `head | attest | revoke | mirror-root | mirror-class | settle` (+ `settle hash-only`).
- `settle-flow/state-dump.mjs` — read-only registry + EBT state dump.
- `settle-flow/relay-hat-sign.mjs` — relay-side HAT signer (key stays on relay).

Seeds/passphrases are supplied via env (`OWNER_SEED`, `HAT_SIG`,
`AUTHORITY_KEY_PASSPHRASE`); **no secrets are committed**.

## 8. On-chain tx ledger (all landed, Preview)

See `ceremony-artifacts/settle-flow-e2e-preview.json`.

| step | circuit | contract | txHash |
|------|---------|----------|--------|
| A | retuneClass | registry | `8c3187b042dae344726a93a53e0cca8fff12312d979610e13579be7a8a4c4c48` |
| B1 | mirrorActionLogRoot | EBT | `95419628ce8a63cc86361b60c7f13653ff0cd93af2feae7e5e6faac3b628a45e` |
| B2 | mirrorClassStatutoryTotal | EBT | `b4ab6f9e4b1bcaf9bd42200f5263ce68ac44b979d692f0e963897d38fd8de62a` |
| B3 | mirrorActionLogHead | EBT | `7983790beee66d2ae37c0db8f8f9ec9b642fbe115bd734ee92c1ffee9593d97b` |
| C | settle (real HAT sig) | EBT | `16f160947b7302cb377e77ba610b20fe892b1fd0fa7eba2cfa5d8125724eb020` |
| D | revokeProducerOwnership | EBT | `fed5b31edbb14695a1a87fb5e3e2e1009470c91cb8fd2403b243260d83fd39d7` |

Final state: registry `_actionSeq=6` root `5d3713d8…`; EBT mirror head=5,
`_classStatutoryTotalBpsMirror=1`, **`_totalSupply=100000`**, producer
attestation `active=false`.
