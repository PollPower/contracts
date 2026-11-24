# WI-16 ledger 9 status

Branch `wi16-ledger9`. Updated at the end of each task.
Last update: 2026-11-24 (kenya full-ZK compile still running).

## Goal: Nov 30 Buildathon, Wave 3

Deploy the PollPower contract stack on **Midnight Preprod (ledger 9)**:

- Multisig v6.2 (H-3 hardening; Tangem admin swap done manually by Garrett)
- TariffRegistry monolith (ceremony-fenced deploy + vk-insert rollout)
- EBT v8 (ceremony-fenced deploy + vk-insert rollout)
- New Living Dividend: user-initiated claims via a ledger 9 cross-contract
  call; unshielded; no re-entry into the caller

Community Poll comes after Nov 30. Deploys are manual ceremonies that
Garrett green-lights; nothing in this branch deploys.

## Blocking: authorization model (see docs/findings-status.md)

| ID | Severity | Summary | State |
|---|---|---|---|
| WI16-C-1 | Critical | Every signature/council check in all four contracts is a prover-supplied witness; anyone can pass them | Confirmed by runtime PoC on Multisig v6.2; by source elsewhere |
| WI16-C-2 | Critical | EBT v8 owner gate uses `ownPublicKey()` (a witness) | Confirmed by source |
| WI16-H-1 | High | EBT v8 `initialize` is front-runnable | Confirmed by source |

Together, C-1 and C-2 allow an unprivileged mint on EBT v8. **`settle()` is
not safe in v8**, even though EBT-H-1 (the payload binding) is fixed.

## Results so far

### Network checks

| Network | Node | Ledger | Height | Notes |
|---|---|---|---|---|
| Preview | 2.1.101 | 9 (`1.0.1`) | ~239k | Relaunched 2026-11-07; **all 19 old PollPower addresses are gone** (indexer returns null; positive control passes) |
| Preprod | 2.1.101-913ec011 | `crate-ledger-9.1.0.1`, protocol 2001100 | 3,546,567 | Upgraded in place 2026-11-09 at block 3,348,434. Official endpoints are Blockfrost (token required). `rpc.preprod.midnight.network` still answers despite the docs saying it was shut down; don't build on it. |

### Toolchain

| Where | Compact devtools | Compiler | Notes |
|---|---|---|---|
| throne (Windows, via WSL Ubuntu 24.04) | 0.5.3 | **0.36.1** default | `compact` shims in `~/bin` (Git Bash) and the PowerShell profile alias, so Windows' `compact.exe` no longer shadows it. 0.30.0 was removed by `compact clean --cache`. |
| kenya | 0.5.3 | 0.36.1 installed, **0.30.0 still default** | Builds use `compact compile +0.36.1` explicitly |

No GitHub token is stored in WSL: it was passed via `WSLENV` to one process
and cleared.

### Contract compile pass (Compact 0.36.1, language 0.28.0, runtime 0.21.0)

| Contract | `--skip-zk` | Circuits | Change needed | Committed |
|---|---|---|---|---|
| EBT v8 | ✅ | 18 | pragma only | ✅ `c4a5240` (pinned to `0.28`) |
| EBT v8 ceremony | ✅ | 8 | pragma only | ✅ `c4a5240` |
| Multisig v6.2 | ✅ | 12 | pragma only | no (held until the C-1 fix decision) |
| TariffRegistry v1 | ✅ | 18 | pragma only | no |
| TariffRegistry v1 ceremony | ✅ | 18 (11 stubs) | pragma only | no |

No warnings; `compact fixup` wants whitespace only.

### Full ZK compile on kenya (EBT v8, EBT v8 ceremony)

Pending — running from `~/wi16-ledger9-build/c4a5240/` with
`compact compile +0.36.1`. Proving-key sizes vs the block limit go here.

## kenya stack (read-only audit, 2026-11-24)

**kenya is not a Midnight Preprod stack.** Its Cardano side follows
**Cardano preview** and stalled in May; its Midnight node is on the
decommissioned `testnet-02` and never synced.

| Component | Running? | Version | Network | Sync | Ledger 9 Preprod needs | Gap |
|---|---|---|---|---|---|---|
| cardano-node (container) | up 2 months | 10.5.3 | **preview** | tip block 4,260,191; `networkSynchronization` 0.904; **0 peers** | Cardano **preprod** | Wrong network; stalled |
| cardano-db-sync | up | 13.6.0.5 | **preview** | last block **2026-05-07** | preprod, reachable over **TLS** | Wrong network; 6.5 months stale |
| db-sync Postgres (container, :5433) | up, healthy | 15.3 | — | — | TLS on (node 2.1.101 exits without it) | `ssl=off` |
| midnight-node | up, "healthy" | **0.12.0** | `CFG_PRESET=testnet-02`, `CARDANO_SECURITY_PARAMETER=432` | block **#0**, 0 peers | 2.1.101, `CFG_PRESET=preprod`, `CARDANO_SECURITY_PARAMETER=2160` | Wrong version and network; never synced. **Nothing depends on it** (no connections; no config references `:9944` or `testnet-02`) |
| Indexer | **none running** (`mn-dev-indexer` 4.0.1 exited 3 months ago) | — | — | — | 4.4.101 serving `/api/v4/graphql` | Missing |
| Proof server | up, :6300 | **8.0.3** | — | — | 9.0.2 | Old. Referenced by both mirror-daemon configs (daemons stopped) and a consumer app build (LAN IP) |
| ogmios | up, healthy | v6.11.0 | preview | — | not required by the node | Follows preview |
| `mn-dev-node` / `mn-dev-proof-server` | exited 3 months ago | 0.22.3 / 8.0.3 | — | — | — | Stale |
| Host Postgres 16 (127.0.0.1:5432) | running | 16 | — | — | — | Unknown purpose (needs sudo to inspect) |

Also on kenya: `pp-settle-service` is still online (Tailscale :7250), serving
the old Preview pilot whose contracts no longer exist. The relay's
`mint-worker` can't resolve `pollpower-kenya.tailc9c94b.ts.net`.

### Hardware vs Preprod requirements (docs: 4 cores, 16 GB RAM, 40 GB NVMe minimum, 30k IOPS)

| | kenya | Verdict |
|---|---|---|
| CPU | 4 cores | meets the minimum; no headroom alongside other services |
| RAM | 31 GB (13 GB available under current load) | meets |
| Disk | 512 GB **SATA** SSD, 149 GB free | capacity OK (Preprod Cardano stack is ~30 GB before Midnight node + indexer); not NVMe, IOPS unmeasured |
| OS / GLIBC | Ubuntu 24.04.4, GLIBC 2.39 | meets |

Docker volumes that look reclaimable: `midnight-node-docker_postgres-data`
28.6 GB (preview db-sync), `midnight-node-docker_db-sync-data` 3.5 GB.
Others (`hydra_*`, `pawacoin*`, `pollpower-kupo-data`, `pollpower-cardano-data`,
`nostr-relay*`) may belong to other projects and are not touched by this plan.

### kenya upgrade plan (proposed; nothing changed yet)

Recommended for Nov 30: **use Blockfrost for Preprod node RPC and indexer,
and run only the proof server on kenya.** A self-hosted Preprod indexer
can't catch up in time (below).

| # | Change | Resync? | Rough time | Needs Garrett's OK |
|---|---|---|---|---|
| 1 | Proof server 8.0.3 → **9.0.2** (pin by digest), same port | No | minutes + first ZK-params download | Yes (change on kenya). Ledger 8 clients that still use it are already broken against ledger 9. |
| 2 | Stop and remove `midnight-node` 0.12.0 and the exited `mn-dev-*` containers. Snapshot the `midnight-data-testnet` volume (2.3 MB) first. | No | minutes | **Yes — deletes data** |
| 3 | *(after Nov 30)* New Cardano **preprod** node in a fresh volume, bootstrapped from a Mithril snapshot. Keep preview volumes until it's confirmed. | Full sync (new network) | hours with Mithril (~12 GB chain); much longer without | Yes |
| 4 | *(after Nov 30)* db-sync 13.6.0.5 for **preprod** + Postgres with **TLS enabled** | Full sync | ~1–2 days from scratch on this disk (estimate; IOG snapshot restore is faster) | Yes |
| 5 | *(after Nov 30)* Midnight node **2.1.101**, `CFG_PRESET=preprod`, `CARDANO_SECURITY_PARAMETER=2160`, fresh data dir, `separate` storage, `--rpc-methods Safe` | Full sync from genesis (3.55M blocks) | days (no published figure) | Yes |
| 6 | *(after Nov 30)* Indexer **4.4.101**, cloud topology (Postgres + NATS) pointed at the local node | Full index from genesis | ~12 days at the measured 3.4 blocks/s; standalone (0.2 blocks/s) would take months | Yes |
| 7 | Delete the old preview volumes (~32 GB) once steps 3–4 are healthy | — | minutes | **Yes — deletes data** |

The "snapshot before upgrading" rule for node 2.1.101 doesn't strictly apply
to step 5: kenya has no existing Preprod data directory to upgrade (the 0.12.0
data belongs to a different, dead chain). Step 2 snapshots it anyway.

## Open decisions

1. **C-1 / C-2 / H-1 fix approach, and whether Nov 30 ships without it.**
   Options are in docs/findings-status.md. The cross-contract-call option
   lines up with the new LD design, but changes all four contracts six days
   before the deadline.
2. **kenya for Nov 30:** Blockfrost + local proof server (recommended), or
   self-hosting (not feasible by Nov 30).
3. **Blockfrost Midnight Preprod project token**: needed before any Preprod
   tooling runs.
4. **kenya changes needing approval:** steps 1, 2 and 7 above.
5. **`pp-settle-service` on kenya:** stop it, or leave it running against
   contracts that no longer exist?
6. **Commit the multisig v6.2 / TariffRegistry pragma pins now**, or fold
   them into the C-1 fix commits.
