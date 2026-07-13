# sortition-table — off-chain table builder + draw auditor (WI-15)

Reference implementation of the auditor procedure described in
[`multisig/SORTITION-DRAW-SPEC.md`](../../SORTITION-DRAW-SPEC.md) §6.

Two deterministic CLIs, both pure functions of their JSON inputs:

- **`build-table`** — takes an eligibility snapshot (a gate-filtered set of
  `{memberAddr, weight}` rows plus an `epoch`) and produces the canonical
  table (sorted, indexed, cumulative) together with the `membershipRoot`
  the council should bind on-chain.
- **`audit-draw`** — takes a canonical table, the revealed seed, and a
  claimed `incoming[5]`, replays the spec's draw byte-for-byte, and emits
  a `MATCH` / `MISMATCH` verdict. On `MISMATCH` it names the first index
  where the claim diverges from the correctly-derived selection.

Both tools are a **second, independent** implementation of the same spec
that `gen-draw-spec-vectors.mjs` implements — that is the whole point. Two
implementations produce byte-identical roots and identical `selected[5]`
from the same inputs (spec §8 invariant #1), and the tests in
[`tests/vectors.test.mjs`](./tests/vectors.test.mjs) enforce this by
loading every committed vector A–F and asserting agreement down to each
row's `leafHash` and each step of the `kSequence`.

Contract: pure JSON in, pure JSON out. No filesystem beyond the paths you
name, no network, no clock, no random source that isn't derived from
`(seed, k)` per §5.4. Deterministic across runs and platforms.

## Layout

```
sortition-table/
├── lib.mjs           — pure core (leaf/pad/node hashes, canonicalise, draw, audit)
├── cli.mjs           — unified dispatcher: `build-table` | `audit-draw`
├── build-table.mjs   — subcommand + direct entrypoint
├── audit-draw.mjs    — subcommand + direct entrypoint
├── io-util.mjs       — --in / --out / --pretty parsing + stdin plumbing
├── README.md         — this file
└── tests/
    ├── vectors.test.mjs   — every A–F vector, byte-for-byte
    └── property.test.mjs  — 1000 random tables × seeds, invariants
```

Node ≥ 18 (uses `node:crypto`, `node:test`, top-level `import`). No
dependencies, no build step. Windows and POSIX behave identically.

## Usage

Both subcommands read JSON from `--in <path>` or stdin (default), and
write JSON to `--out <path>` or stdout (default). `--pretty` selects
indented output. Exit codes:

| code | meaning |
|:---:|---|
| `0` | success (`build-table`) or verdict `MATCH` (`audit-draw`) |
| `2` | verdict `MISMATCH` (`audit-draw` only) |
| `1` | any other error (parse, precondition violation, spec disagreement) |

### `build-table`

Input snapshot schema:

```json
{
  "epoch": 7,
  "rows": [
    { "memberAddr": "0x11...a1", "weight": 1 },
    { "memberAddr": "0x22...b2", "weight": 1, "isFederationSeat": false },
    ...
  ]
}
```

- `memberAddr` is a 32-byte hex string (with or without `0x` prefix,
  case-insensitive). Duplicates are rejected. Rows are re-sorted into
  canonical order (§1.2, ascending by memberAddr bytes) before indices
  and cumulative sums are assigned.
- `weight` must be an integer ≥ 1 for every row. Padded/zero-weight
  slots are synthesised internally by the Merkle tree (spec §5.2) and
  MUST NOT appear in the input.
- `isFederationSeat` is informational; it round-trips into the output for
  downstream tooling but does not affect the leaf encoding (per spec §7
  invariant "structural equivalence of federation and personal seats").
- The tool enforces the design-note §7 precondition **n ≥ 5 distinct
  drawable rows** as a hard error.

Example:

```powershell
# vector A snapshot -> canonical table
node cli.mjs build-table --in snapshot.json --out table.json --pretty

# or with piping
Get-Content snapshot.json | node cli.mjs build-table --pretty > table.json
```

The output has this shape (per spec §5.3 for the root, §5.1 for each
`leafHash`):

```json
{
  "specVersion": "pp-sortition-draw-spec/v1",
  "hashPrimitive": "SHA-256",
  "epoch": 7,
  "n": 5,
  "paddedLeafCount": 8,
  "padSentinelLeafHash": "0x44f62bc3...",
  "rows": [
    { "index": 0, "memberAddr": "0x11...a1", "weight": 1, "cumulative": 1,
      "isFederationSeat": false, "leafHash": "0xfe90b564..." },
    ...
  ],
  "totalWeight": 5,
  "membershipRoot": "0x8407e8a6..."
}
```

For the vector-A snapshot this produces `membershipRoot =
0x8407e8a69e7c6c7a4a1665ebc9c397aca5bcfc207ae7088a1a51e70449b40070`
(spec §7.5), byte-for-byte matching the committed
[`draw-spec-vectors.json`](../draw-spec-vectors.json).

### `audit-draw`

Input schema:

```json
{
  "table": { ...output of build-table... },
  "seed": "0x5787a731...",
  "claimedIncoming": ["0x66...f6", "0x22...b2", "0x55...e5", "0x44...d4", "0x11...a1"]
}
```

For convenience, if `claimedIncoming` is absent but `expected.selected`
is present (matching the shape of `draw-spec-vectors.json` entries), the
tool treats that as the claim. This makes it trivial to run the tool
directly against a saved vector.

Example — audit vector F (deliberately wrong):

```powershell
# extract vector F into an audit-draw input
node -e "const v=require('../draw-spec-vectors.json').vectors.find(x=>x.id==='F'); const fs=require('fs'); fs.writeFileSync('audit-F.json', JSON.stringify({table:v.table, seed:v.seed, claimedIncoming:v.claimedIncoming}, null, 2));"

node cli.mjs audit-draw --in audit-F.json --pretty
# -> writes MISMATCH result to stdout, exits with code 2
```

MATCH output:

```json
{
  "verdict": "MATCH",
  "selected": ["0x66...f6", "0x22...b2", "0x55...e5", "0x44...d4", "0x11...a1"],
  "kConsumed": 13
}
```

MISMATCH output:

```json
{
  "verdict": "MISMATCH",
  "firstDivergenceIndex": 0,
  "correctSelected": ["0x66...f6", ...],
  "claimedIncoming":  ["0x22...b2", ...],
  "rejectionReason": "claimed incoming[0] = 0x22...b2 but spec §5.4 draw from (table, seed) yields 0x66...f6",
  "kConsumed": 13
}
```

## Tests

Both test files run under `node --test`; no framework needed.

```powershell
cd multisig\tooling\sortition-table
node --test tests\vectors.test.mjs
node --test tests\property.test.mjs

# or both files at once
node --test tests/vectors.test.mjs tests/property.test.mjs
```

- **`vectors.test.mjs`** — the acceptance gate. Loads every vector from
  `../draw-spec-vectors.json` and asserts:
  1. spec header (`specVersion`, `hashPrimitive`, domain tags, pad sentinel)
     matches;
  2. `build-table` output reproduces every row's `leafHash` and
     `membershipRoot` byte-for-byte;
  3. positive vectors (A, B, C, D, E): `runDraw` reproduces the exact
     `selected[5]` and full `kSequence`;
  4. `auditDraw` returns `MATCH` for the correct claim;
  5. vector F (deliberately wrong) is REJECTED with the correct
     `firstDivergenceIndex`;
  6. and — broader than F — a single-member substitution at ANY index is
     always caught with `firstDivergenceIndex == j`.
- **`property.test.mjs`** — 1000 random valid snapshots (n in [5..20],
  weights in [1..5], distinct 32-byte addresses) × random seeds.
  Deterministic PRNG so the run is reproducible. Asserts: determinism
  across two builds of the same snapshot; canonical order; strictly
  monotone cumulative ending at `totalWeight`; draw termination and
  exactly 5 distinct results drawn from the table; audit round-trip
  (`MATCH` for the draw, `MISMATCH` at index `j` for any single-slot
  substitution at position `j`). A second test exercises the n<5
  precondition path.

## Scope and boundaries

- This tool does **NOT** implement gate/eligibility logic. Its input is
  already a gate-filtered snapshot; that decision lives in WI-18.
- This tool does **NOT** implement anything on-chain. There is no
  Poseidon here, no ZK circuit, no `.compact` change. The spec version
  it implements is `pp-sortition-draw-spec/v1` (SHA-256, off-chain
  auditor path only, spec §3).
- Weights other than `weight = 1` are structurally supported (they flow
  through the cumulative axis and modulo pick), but the spec ships with
  the equal-weight gate as the recommended policy (design note §4).
  Any change to weighting **semantics** — a switch to concave weighting,
  say — is a policy change owned by that spec section, not this tool.

## When to escalate

Per the WI-15 brief, this tool STOPS AND ESCALATES rather than papering
over any of the following:

- A committed vector's `membershipRoot` cannot be reproduced.
- A byte-level detail in the spec is ambiguous (the spec is meant to be
  exhaustive; ambiguity is a real finding).
- An invariant (spec §8) cannot hold.
- Modification of `SORTITION-DRAW-SPEC.md`, the committed vectors, the
  reference generator, or any `.compact` file appears necessary.
