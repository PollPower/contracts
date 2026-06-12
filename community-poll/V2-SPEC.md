# Community-Poll v2 — Design Specification

**Status:** DESIGN ONLY — no implementation in this document's session.
**Drafted:** 2026-06-12 (Joi, Fable 5 session, Track C)
**Audit ref:** 2026-06-10 Fable 5 review, tag v10.0, commit c06191e
**Findings addressed:** C-2 (Critical), M-3 (Medium), I-2 (Info)
**Current contract:** `community-poll/community-poll.compact` — marked
RESEARCH PREVIEW until this spec ships as v2.

---

## Why v2 exists

The v1 contract's comments promise ZK guarantees its circuits don't
deliver. The README claims one-person-one-vote; the circuit allows:

1. **Unlimited Sybil voting (C-2):** `castVote()` takes `nullifier` and
   `kycCommitment` as bare parameters with no witness binding. Any
   observer of one registered KYC commitment can vote arbitrarily many
   times by fabricating fresh nullifiers — the contract never checks
   that the nullifier derives from the same secret as the commitment.
2. **Tally forgery (C-2):** `tallyKey` is caller-supplied and trusted.
   A voter can pass option 0's bounds check but increment option 7's
   tally — or a key for a different poll entirely.
3. **KYC re-registration deadlock + count drift (M-3):**
   revoked commitments can never be re-activated, and double-revokes
   decrement `kycCount` twice.

v1 stays deployed as a research artifact. v2 is a fresh contract.

---

## C-2 fix: witness-based vote binding

### Witness

```compact
witness voter_secret(): Bytes<32>;
```

The voter's secret lives in their wallet/app. The prover supplies it
locally; it never appears on chain.

### castVote v2

```compact
export circuit castVote(
    pollId: Bytes<32>,
    optionIndex: Uint<8>,          // was Uint<128>; 10 options max fits Uint<8>
    nullifier: Bytes<32>,
    kycCommitment: Bytes<32>,
    tallyKey: Bytes<32>,
    identityProof: Bytes<32>
): [] {
    assert(_initialized, "Not initialized");

    // Poll must exist and be active (unchanged from v1)
    assert(pollOptionCounts.member(disclose(pollId)), "Poll not found");
    assert(pollActive.lookup(disclose(pollId)), "Poll closed");
    const numOptions = pollOptionCounts.lookup(disclose(pollId));
    assert((optionIndex as Uint<128>) < numOptions, "Invalid option");

    // ── NEW: witness binding ────────────────────────────────────────
    const secret = voter_secret();

    // 1. Nullifier must derive from (secret, pollId).
    //    Prevents fabricated nullifiers: a voter has exactly one valid
    //    nullifier per poll, fixed by their secret.
    const expectedNullifier = persistentHash<Vector<2, Bytes<32>>>([secret, pollId]);
    assert(disclose(nullifier == expectedNullifier), "bad nullifier");

    // 2. KYC commitment must derive from (secret, identityProof).
    //    Binds the SAME secret to a registered commitment. Together
    //    with (1), this enforces: one registered identity → one
    //    nullifier per poll → one vote per poll.
    const expectedCommitment = persistentHash<Vector<2, Bytes<32>>>([secret, identityProof]);
    assert(disclose(kycCommitment == expectedCommitment), "bad commitment");

    // 3. Tally key must derive from (pollId, optionIndex).
    //    Kills tally forgery: the incremented key is provably the one
    //    for the option that passed the bounds check.
    const optionBytes = ((optionIndex as Field) as Bytes<32>);
    const expectedTallyKey = persistentHash<Vector<2, Bytes<32>>>([pollId, optionBytes]);
    assert(disclose(tallyKey == expectedTallyKey), "bad tally key");
    // ────────────────────────────────────────────────────────────────

    // Registration + freshness checks (unchanged from v1)
    assert(kycCommitments.member(disclose(kycCommitment)), "KYC not registered");
    assert(kycCommitments.lookup(disclose(kycCommitment)), "KYC revoked");
    assert(!usedNullifiers.member(disclose(nullifier)), "Already voted");

    // State updates (unchanged from v1)
    usedNullifiers.insert(disclose(nullifier), disclose(true));
    const current = getVoteTally(tallyKey);
    const newCount = _safeAdd(current, 1);
    voteTallies.insert(disclose(tallyKey), disclose(newCount));
    totalVotes.increment(1);
}
```

### What the binding achieves

| Property | v1 | v2 |
|----------|----|----|
| One vote per person per poll | ❌ unlimited | ✅ nullifier fixed by secret |
| Vote increments the chosen option | ❌ forgeable | ✅ tallyKey recomputed |
| Voter identity hidden | ✅ (accidentally — nothing was checked) | ✅ (secret never disclosed; only equality results disclosed) |
| KYC actually gates voting | ❌ any observed commitment reusable | ✅ must know the secret behind the commitment |

### Disclosure design notes

- `disclose()` wraps the **comparison results**, not the secret. The
  secret itself stays in the witness. Disclosing `nullifier ==
  expectedNullifier` reveals one bit (valid/invalid), which is already
  implied by transaction success.
- `identityProof` is a public parameter; it's the KYC-provider-issued
  proof value, already semi-public between user and PollPower. If we
  want it private too, it can move into a second witness — decide at
  implementation time after checking proving-cost impact.

### Open implementation questions (resolve before coding)

1. **Witness disclosure mechanics:** confirm whether
   `assert(disclose(a == b))` compiles cleanly under 0.22 semantics for
   witness-derived values, or whether each comparison needs an
   intermediate `const ok = disclose(a == b); assert(ok, ...)`. (The
   EBT v5.1/v5.2 pattern uses the intermediate-const form — follow that.)
2. **Proving cost:** three persistentHash calls + map ops in one
   circuit. EBT v5.2's settle() with 2 hashes + 2 witness calls + BPS
   math produced a 46KB ZKIR (fine). castVote v2 should land well under
   Preview's block budget, but verify with --skip-zk size check first,
   full compile second.
3. **Secret lifecycle:** where does `voter_secret` live in the consumer
   app? Proposal: derive from the wallet seed via HKDF with a dedicated
   info string ("pollpower:vote:v2"), so it's recoverable from seed
   backup and never stored separately. Needs app-team signoff.
4. **KYC issuance flow:** registration now requires the user to compute
   `commitment = hash(secret, identityProof)` client-side and submit it
   through the authority. The authority never learns `secret`. Update
   the KYC API contract accordingly.

---

## M-3 fix: KYC re-registration accounting

Branch on **value**, not membership:

```compact
export circuit registerKycCommitment(commitment: Bytes<32>): [] {
    assert(_initialized, "Not initialized");
    const caller = left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
    assert(caller == owner || caller == pollAuthority, "Not authorized");

    if (kycCommitments.member(disclose(commitment))) {
        const wasActive = kycCommitments.lookup(disclose(commitment));
        if (!wasActive) {
            // Re-activate a previously revoked commitment.
            kycCommitments.insert(disclose(commitment), disclose(true));
            kycCount.increment(1);
        }
        // already-active: idempotent no-op
    } else {
        kycCommitments.insert(disclose(commitment), disclose(true));
        kycCount.increment(1);
    }
}

export circuit revokeKycCommitment(commitment: Bytes<32>): [] {
    assert(_initialized, "Not initialized");
    const caller = left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
    assert(caller == owner, "Only owner");

    if (kycCommitments.member(disclose(commitment))) {
        const wasActive = kycCommitments.lookup(disclose(commitment));
        if (wasActive) {
            kycCommitments.insert(disclose(commitment), disclose(false));
            assert(!kycCount.lessThan(1), "No commitments to remove");
            kycCount.decrement(1);
        }
        // already-revoked: no-op (prevents double-decrement)
    }
}
```

Invariant restored: `kycCount == |{c : kycCommitments[c] == true}|`.

---

## I-2 fix: pin pragma upper bound

```compact
pragma language_version >= 0.22.0 && <= 0.22;
```

Note: the other contracts in the repo pin `>= 0.16 && <= 0.22`. v1 of
community-poll used `left<...>()` constructors and other 0.22-isms, so
the lower bound stays 0.22. Match the repo's upper bound (0.22) rather
than inventing a new one. When the repo migrates to 0.23+, bump all
contracts together.

---

## Additional v2 changes (carried from v1 review, not in audit)

These came up while writing this spec — flagged per session rule 5
(no silent findings). Neither is a vulnerability in v1's research-
preview context; both should be fixed in v2 while we're in the file:

1. **transferOwnership lacks `.is_left` guard** — same L-1 pattern as
   EBT v5. Transferring to a ContractAddress bricks `owner ==` checks.
   Fix identically: `assert(newOwner.is_left, ...)`.
2. **`getTotalPolls`/`getTotalVotes` return `Field`** from
   `Counter.read()` which returns `Uint<64>` — v1 may be silently
   widening. Harmonize return types to `Uint<64>` in v2.

## Out of scope for v2

- **On-chain poll deadlines** (blockTime-based auto-close): nice-to-have,
  not security. Defer to v2.1.
- **Weighted voting / delegation:** explicitly out — one person one vote
  is the design center.
- **Merkle-tree anonymity sets** (hiding *which* commitment voted):
  v2 still reveals which commitment cast a vote (not what they voted —
  the tallyKey reveals the option though!). NOTE: since both nullifier
  and tallyKey are public per-transaction, an observer CAN link "this
  anonymous registered voter chose option 3". Full ballot privacy needs
  the vote to be aggregated differently (e.g., homomorphic tally or
  batched epochs). **This is an honest limitation to document in v2's
  README — vote-choice privacy holds only across voters, not per
  transaction.** Defer the stronger model to v3 research.

## Release path

1. Implement v2 per this spec in `community-poll/community-poll-v2.compact`
2. Compile --skip-zk on Kenya (0.30.0), check ZKIR sizes
3. Full compile, deploy to Preview
4. Wire consumer-app secret derivation + KYC API change
5. Internal vote test with 3+ test identities (verify Sybil rejection:
   same secret, two nullifiers for one poll must fail)
6. Update README: v1 → RESEARCH PREVIEW (already done per audit),
   v2 → production-candidate with the per-transaction-linkability
   limitation documented
