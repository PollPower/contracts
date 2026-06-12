# Community Poll

## v2 (Production) — deployed 2026-06-12

**Address (Midnight Preview):** `8fcb540d96f34ed18d37ab637f0393341cf4eba2759d09e1e07675fc4f4fea63`
**Status:** ✅ **PRODUCTION** — witness-bound ZK voting with real Sybil resistance

Community Poll v2 implements the privacy-preserving voting that v1's comments promised but its circuits didn't deliver.

### What v2 does that v1 didn't

| Property | v1 | v2 |
|---|---|---|
| One vote per person per poll | ❌ unlimited (no witness binding) | ✅ nullifier fixed by voter_secret |
| Vote increments the chosen option | ❌ forgeable tallyKey | ✅ tallyKey recomputed in-circuit |
| KYC actually gates voting | ❌ any observed commitment reusable | ✅ must know the secret behind the commitment |

### How it works

1. Voter's app derives `voter_secret` from their wallet seed (HKDF, info `"pollpower:vote:v2"`).
2. At KYC, the app computes `commitment = hash(voter_secret, identityProof)` and registers it on-chain.
3. To vote, the app provides `voter_secret` as a **witness** (never leaves the device). The circuit verifies:
   - `nullifier == hash(voter_secret, pollId)` — one nullifier per person per poll
   - `kycCommitment == hash(voter_secret, identityProof)` — same secret as the registered commitment
   - `tallyKey == hash(pollId, optionIndex)` — can't forge which option gets incremented
4. The circuit checks nullifier freshness and KYC registration, then records the vote.

### Known limitation

Per-transaction linkability: nullifier + tallyKey are public per vote tx. An observer can link an anonymous commitment to its chosen option. Privacy holds across voters, not per transaction. Full ballot privacy (homomorphic tally / batched epochs) is v3 research. See [V2-SPEC.md](./V2-SPEC.md).

### Source

- **v2:** [`community-poll-v2.compact`](./community-poll-v2.compact) — the production contract
- **v2 spec:** [`V2-SPEC.md`](./V2-SPEC.md) — design rationale and audit findings

---

## v1 (Research Preview) — DEPRECATED

**Address (Midnight Preview):** `a6a494880b3d646be22f31f891c1b1ba4df0142cbc7ddc008d9be6812f0b74be`
**Status:** ❌ **RESEARCH PREVIEW** — do not use for real votes

v1's `castVote()` has no witness function, no preimage check, and no real ZK guarantees. Despite comments claiming one-person-one-vote, the circuit allows unlimited Sybil voting against any observed KYC commitment, and the tally key is caller-forgeable.

**Audit finding C-2 (Critical):** See the [2026-06-10 audit summary](../README.md#audit-2026-06-10).

v1 remains deployed on chain as a historical artifact. It is not used by any production app path.
