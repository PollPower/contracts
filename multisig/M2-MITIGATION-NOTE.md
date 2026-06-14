# M-2 Mitigation Note — Domain Separation at the actionHash Layer

**Finding:** M-2 (Medium) — "Ed25519 signed messages lack contract/chain domain separation."
**Audit:** 2026-06-10 Fable 5 review.
**Status:** MITIGATED at the off-chain actionHash-construction layer. v6.1's
in-circuit `contractTag` is NOT required and is NOT deployed for production.
**Decision date:** 2026-06-14.

---

## The finding, restated

The 2026-06-10 audit observed that multisig v6 and ProducerRegistry v1 share
the same admin key set (the same Tangem rings). It reasoned that if an admin
signed a bare `actionHash`, that signature could be replayed against the other
contract — because both contracts' `approve()` verify a ring signature over
`actionHash` and check the signer is in `_admins`, and the admin set is shared.

The proposed fix (M-2) was v6.1: verify the signature over
`persistentHash([contractTag, actionHash])` so a per-deployment `contractTag`
makes each contract's signed message unique.

## Why the finding does not apply to the actual signing flow

The audit's premise — "an admin signs a bare actionHash" — is not what the
admin app does. The admin app (`apps/admin/services/actionHash.ts`) constructs
the actionHash as:

```
actionHash = SHA-256(
  "PollPowerMultiSig.v5"   |   // domain separator (version)
  "chain=" + chainId        |   // chain domain separator
  "contract=" + contractAddress |  // CONTRACT domain separator
  "op=" + operationSelector  |
  "params=" + canonicalParams |
  "nonce=" + nonce
)
```

The contract address is already bound into the preimage of every actionHash.
A signature produced for the ProducerRegistry's actionHash cannot be valid for
the multisig contract, because the multisig's actionHash for the "same" logical
action has `contract=<multisig address>` in its preimage, producing a different
SHA-256 output, and therefore a signature over a different 32-byte value.

The exact cross-contract replay M-2 worried about is structurally impossible
in this flow: there is no shared bare `actionHash` between the two contracts.
Each contract's actions hash to distinct values because the contract address
is part of the hash.

## Verification (2026-06-14)

Confirmed in `apps/admin`:

1. `services/actionHash.ts` — `computeActionHash()` includes
   `'contract=' + params.contractAddress.toLowerCase()` in the signed preimage
   for ALL operation types (the function is operation-agnostic; every caller
   passes the target contract address).

2. `app/proposal/[hash].tsx` — before the ring signs, the app re-derives the
   actionHash locally from `proposal.contractAddress` (line ~73-77) and only
   enables signing when the re-derived hash matches the on-chain hash
   (`verifyStatus === 'verified'`). An admin cannot sign a hash whose preimage
   doesn't include the correct contract address.

3. The ring signs the actionHash directly (`tangemService.signActionHash`),
   and `approve()` verifies the signature over that same actionHash. No bare
   cross-contract-replayable value exists anywhere in the path.

## Why NOT deploy v6.1's in-circuit contractTag

1. **Redundant.** Domain separation is already achieved in the signed preimage.
   Adding `persistentHash([contractTag, actionHash])` in-circuit separates a
   value that is already separated.

2. **Forces a Poseidon dependency into the mobile app.** v6.1's `signedHash`
   uses `persistentHash` (Poseidon). For the ring to sign the correct value,
   the admin app would need to compute Poseidon on-device. That requires
   `@midnight-ntwrk/compact-runtime` (WASM-heavy, painful in React Native
   Hermes) — which is precisely why the app uses SHA-256 for actionHash in the
   first place. The cost is real; the benefit is nil.

3. **Same reasoning as ProducerRegistry v1.1.** v1.1 (the registry's M-2
   variant) also did not deploy — it blew the Preview block-size limit. The
   pattern holds: the in-circuit domain separator is not worth its cost when
   the off-chain construction already provides the guarantee.

## What domain separation requires, formally

Domain separation requires only that the signed preimage be unique per
(contract, chain, version, action, nonce). It does NOT require that the
separation happen in-circuit. It can happen anywhere in the preimage the ring
signs. In PollPower's flow, it happens in `actionHash.ts`. The guarantee is
the same; the implementation is cheaper and doesn't break the mobile app.

## Conclusion

- **Production multisig: v6** (`f7192a504e186e6a418bcb3f42291ee1a3c032b8c0724c4fab54cc3f62745c3a`).
- **Production registry: v1** (`c6730596dd7770dd69bd5051a769e8c42d34dc99c47228f751cae38f00b2ff1d`).
- **v6.1 / registry-v1.1 (contractTag variants): NOT deployed.** Retained in
  the repo as design artifacts documenting the in-circuit approach, but
  superseded by the actionHash-layer mitigation described here.
- **M-2: CLOSED.** Mitigated at the actionHash-construction layer, verified
  2026-06-14.
