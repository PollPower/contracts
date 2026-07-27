# V2-SPLIT-ADDENDUM.md

Status: REQUIRED WI-15 addendum resolving pre-implementation design gaps.
Branch: eat/wi15-v2-split-impl
Base design: V2-SPLIT-DESIGN.md

## Scope

This addendum resolves the two gaps called out in the WI-15 dispatch brief before any .compact split-file implementation.

---

## §A1 Bootstrap design for AuditLog _auditWriterAuthority

Chosen design:

- 	ariff-audit.compact owns an explicit authority cell: export ledger _auditWriterAuthority: Bytes<32>.
- AuditLog constructor takes initialAuditWriterAuthority: Bytes<32> and writes _auditWriterAuthority = disclose(initialAuditWriterAuthority).
- commitAuditEntry verifies an Ed25519 signature under _auditWriterAuthority over a canonical tuple that binds:
  - kernel.self().bytes
  - sourceTag
  - localSeq
  - payloadHash
  - globalSeq
- This authority is independent from federation authority and governance root authority.

Why this resolves the bootstrap circularity:

- AuditLog is deployable first with a valid trust anchor available at constructor time.
- Governance does not need to exist yet for AuditLog to accept mirror-write commits.
- Governance can still coordinate policy around the authority after deployment, but AuditLog has a complete non-circular bootstrap path from tx-0.

Security posture:

- I-15-B mirror-root soundness is preserved because every append still requires a cryptographic signature tied to the exact tuple committed.
- No universal root key is introduced; this key can only authorize AuditLog append commitments.

---

## §A2 Constructor signature updates (AuditLog + Governance)

### AuditLog constructor

New signature:

`compact
constructor(
  initialAuditWriterAuthority: Bytes<32>
)
`

Writes:

- _auditWriterAuthority
- existing bootstrap fields (_actionLogClimb, _actionLogBootstrapCursor, _bootstrapComplete)
- _initialized

### Governance constructor

New signature:

`compact
constructor(
  auditContractAddress: ContractAddress,
  initialFederationAuthority: Bytes<32>,
  initialGovernanceRoot: Bytes<32>,
  initialRefRateFiatPerKwh: Uint<64>,
  initialAuditWriterAuthority: Bytes<32>
)
`

Writes:

- existing governance seed values
- export ledger _auditWriterAuthorityTarget: Bytes<32> initialized to initialAuditWriterAuthority

Purpose:

- Governance constructor records the intended AuditLog writer authority as policy state from genesis.
- Governance and AuditLog start aligned without requiring post-deploy circular bootstrapping.

---

## §A3 Rotation-circuit spec

### Circuit name


otateAuditWriterAuthority

### Contract

	ariff-audit.compact

### Signature

`compact
export circuit rotateAuditWriterAuthority(
  newAuditWriterAuthority: Bytes<32>,
  nextAuthorityEpoch: Uint<64>,
  rotationSignature: Bytes<64>,
  currentTime: Uint<64>
): []
`

### New supporting ledger cell

- export ledger _auditWriterAuthorityEpoch: Counter

### Canonical signed message

persistentHash<Vector<5, Bytes<32>>>([
  pad(32,  pp:tariff:v2:rotateAuditWriterAuthority),
  selfBytes(),
  disclose(newAuditWriterAuthority),
  (nextAuthorityEpoch as Field) as Bytes<32>,
  (currentTime as Field) as Bytes<32>,
])

Verification:

- Verify signature_valid(_auditWriterAuthority, rotationHash, rotationSignature).
- Enforce strict monotonicity: 
extAuthorityEpoch == _auditWriterAuthorityEpoch.read() + 1 using checked-cast equality.

State updates:

- _auditWriterAuthority = disclose(newAuditWriterAuthority)
- _auditWriterAuthorityEpoch.increment(1)

Invariants:

- Rotation authority is self-authenticating from the current authority.
- Replay of old signed rotations is prevented by epoch monotonicity.
- Rotation does not bypass or weaken commitAuditEntry tuple-binding.

### Required tests

- Happy path: current authority rotates to new authority at epoch+1.
- Fail: bad signature.
- Fail: stale 
extAuthorityEpoch.
- Fail: zero/new==current no-op (explicitly rejected).
- Post-rotation: old key can no longer sign commitAuditEntry.

---

## §A4 Deploy-sequence updates

Deploy sequence is amended to include explicit audit-writer authority provisioning:

1. Generate deploy-scoped uditWriter keypair offline.
2. Deploy AuditLog with initialAuditWriterAuthority = auditWriter.pubkey.
3. Deploy Governance with matching initialAuditWriterAuthority field.
4. Deploy Schedule, Lane, Views with constructor addresses.
5. Run AuditLog bootstrap shards: (8), (16), (24).
6. Seed Governance epoch via dvanceEpoch(1, ...).
7. Start mirror-writer daemon using uditWriter private key for commitAuditEntry signing.
8. Optional ceremony: rotate audit writer immediately to operational key via 
otateAuditWriterAuthority.

Operational note:

- This is not a universal root key; compromise impacts AuditLog append authorization only.

---

## §A5 Chosen (sourceTag, localSeq) ↔ globalSeq mapping

Chosen shape: **(a) AuditLog global index map**.

Implementation:

- Add struct:

`compact
struct GlobalActionRef {
  sourceTag: Bytes<32>,
  localSeq: Uint<64>,
}
`

- Add ledger map in AuditLog:

`compact
export ledger _globalSeqIndex: Map<Uint<64>, GlobalActionRef>;
`

On successful commitAuditEntry:

- Insert _globalSeqIndex.insert(globalSeq, GlobalActionRef { sourceTag, localSeq }).

Consumer path:

- 
esolveGlobalSeq(globalSeq) -> GlobalActionRef
- Consumer then queries corresponding sibling-local action entry by localSeq.

Why this shape:

- Race-free under concurrent daemon workers because globalSeq allocation and map insert happen atomically in the same circuit that increments global seq.
- Does not rely on speculative pre-commit predictions.

---

## §A6 commitAuditEntry signature update

commitAuditEntry signature is updated to carry all fields needed for sound indexing and signed binding:

`compact
export circuit commitAuditEntry(
  sourceTag: Bytes<32>,
  localSeq: Uint<64>,
  payloadHash: Bytes<32>,
  globalSeq: Uint<64>,
  writerSignature: Bytes<64>,
  currentTime: Uint<64>
): []
`

Notes:

- sourceTag + localSeq are now canonical public inputs for deterministic index insertion.
- Signed tuple includes both for non-malleability.
- currentTime is included in signed material to tighten operational anti-replay semantics (pairs with monotone globalSeq).

---

## §A7 New invariant: I-15-D lookup soundness

I-15-D (lookup soundness):

> For every committed audit leaf at globalSeq, AuditLog stores exactly one authoritative mapping entry _globalSeqIndex[globalSeq] = (sourceTag, localSeq), and that mapping is written atomically in the same state transition as root fold + global-seq increment.

Enforcement mechanism:

- commitAuditEntry enforces:
  - globalSeq == _actionSeq.read() prior to increment.
  - _globalSeqIndex.insert(globalSeq, ref) before _actionSeq.increment(1).
- Because globalSeq is unique and monotone, each index slot is single-writer, append-only.

Required tests:

- Happy path: 
esolveGlobalSeq(seq) returns expected (sourceTag, localSeq).
- Fail: duplicate/stale globalSeq submission.
- Soundness: returned pair points to sibling entry with matching payload hash.

---

## Compatibility note

This addendum intentionally narrows and clarifies V2 split behavior where the draft design was ambiguous. It does not relax WI-13 / WI-13.1 / WI-13.3 invariants and adds explicit enforcement hooks for deploy bootstrap and sequence lookup correctness.
