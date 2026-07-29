# tariff-registry (WI-13)

**Status:** DEV DRAFT — not deployed, not audited.
**Contract:** `tariff-registry-v1.compact`
**Design:** [`V1-DESIGN.md`](./V1-DESIGN.md)
**Tests:** [`tests/`](./tests/) — 15/15 pass as of 2026-07-14.
**Toolchain:** compactc 0.30.0, language 0.22.0, runtime 0.15.0 (per
Garrett's 2026-07-14 22:57 JST written call; plan §0.2's 0.31.0 pin is
deferred to WI-13.1 — see V1-DESIGN.md §11).
**Blocks:** WI-14 (EBT vNext settlement resolves splits against this
registry).

## What this is

The on-chain source of truth for **tariff schedules** —
epoch-versioned, chartered-node only, federation-vetted at registration.
Six state-mutating circuits (five federation-gated branch ops + one
leaf op), four read-only views, zero value primitives (I-F).

- **Companies price** → `retuneClass` (leaf op, permissionless within
  floors — F-6).
- **Members bound** → `registerSchedule`, `retireSchedule`, `advanceEpoch`,
  `setNationalContext`, `setFederationAuthority` (branch ops,
  federation-gated via the shared `multisig_signature_valid` witness).
- **The mint pays** → NOTHING HERE. WI-14 consumes `resolvePath` /
  `resolveCurrent`. Registry has zero mint/burn/transfer/recipient
  surface.

## Layout

```
tariff-registry/
├── README.md                    ← this file
├── V1-DESIGN.md                 ← full circuit + ledger design
├── tariff-registry-v1.compact   ← contract source (Compact 0.30.0)
└── tests/
    ├── README.md                ← test map: what each test covers
    ├── lib.mjs                  ← offline JS mirror of the contract
    └── registry.test.mjs        ← T1..T7 + T3.5 + F-4 + F-7a/b + R-A/B/C
```

## Not this file's job

- Deploy — separate ceremony (plan §5.1); WI-13 ends at DEV DRAFT +
  review-ready PR.
- WI-14 (EBT vNext) — different work item, different BIG session, no
  shared context (plan §5.1 💰 two-pass rule).
- 0.31.0 upgrade — WI-13.1 follow-up (V1-DESIGN.md §11).

See PR #31 for the review discussion.

## Preview deploy

Preview deploy tooling and kenya handoff steps are documented in
[`PREVIEW-DEPLOY.md`](./PREVIEW-DEPLOY.md).

For WI-15.7 pilot smoke, `deploy-tariff-registry-preview.ts` accepts optional
`--seat-signatures <path>` to load a pre-signed `advanceEpoch` approval bundle
from disk. Schema: `{ actionHash, epoch, signatures[] }`, where each signature
entry is `{ seatId, signature, publicKey }` with hex-encoded Ed25519 bytes.
Security tradeoff: this path avoids storing seat secret keys on operator disks,
but the caller must ensure the file's `actionHash` matches the expected
operation preimage for the current deployment before broadcasting.
