# Community Poll

**Address (Midnight Preview):** `a6a494880b3d646be22f31f891c1b1ba4df0142cbc7ddc008d9be6812f0b74be`
**Deployed:** 2026-04-10
**Status:** ✅ **PRODUCTION** — used by PollPower's mobile apps for KYC'd, Sybil-resistant community voting

## What it does

A privacy-preserving voting contract for the PollPower network.

Every voter must complete Smile ID KYC and register an anonymous on-chain commitment derived from their KYC binding. Voting uses zero-knowledge proofs anchored to the commitment, enforcing **one identity, one vote per poll** via nullifiers — without revealing which commitment cast which vote.

Properties:

- **Sybil-resistant**: KYC binding required to register a commitment
- **Anonymous**: votes cannot be traced back to specific commitments
- **One-per-identity**: nullifier prevents double-voting per poll
- **On-chain auditable**: vote counts, poll lifecycle, and nullifier set are all public

## How it integrates with the apps

Both the consumer and producer mobile apps embed flows that:

1. Display open polls and their options
2. Generate the ZK voting proof on-device
3. Submit the proof to the chain via the poll bridge

Vote counts update in real time as proofs land on chain. Poll outcomes are determined by reading contract state directly — no off-chain tallying.

## Use cases (current)

- Cooperative governance decisions (where each cooperative member has one vote)
- Network-wide community polls (where each KYC'd network user has one vote)
- Future: cooperative cap-table changes, parameter votes, council-action ratification

## Limitations

The current contract supports binary and small-multi-option polls. More complex governance primitives (ranked-choice, quadratic voting, time-locked proposals, multi-stage proposals) are on the roadmap but not in this version.
