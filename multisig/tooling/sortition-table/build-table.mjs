#!/usr/bin/env node
// multisig/tooling/sortition-table/build-table.mjs
// -----------------------------------------------------------------------------
// build-table subcommand.
//
// Input snapshot JSON:
//   {
//     "epoch": <number>,
//     "rows": [
//       { "memberAddr": "0x<64hex>", "weight": <int>, "isFederationSeat"?: <bool> },
//       ...
//     ]
//   }
//
// Output: canonical table + membershipRoot per SORTITION-DRAW-SPEC §1.2, §5.1,
// §5.2, §5.3. Deterministic; no side effects beyond stdout/file.
// -----------------------------------------------------------------------------

import { buildCanonicalTable, COUNCIL_SIZE } from './lib.mjs';
import { parseFlags, readJsonInput, writeJsonOutput } from './io-util.mjs';

export async function runBuildTable(argv) {
  const flags = parseFlags(argv);
  const snapshot = await readJsonInput(flags.in);
  const table = buildCanonicalTable(snapshot);

  // Design-note §7 precondition #1: n >= 5 distinct drawable rows.
  // Enforced as a hard error (invariant #4 in the WI-15 brief). We surface
  // this at the tool boundary because a table that can never be drawn from
  // is not worth publishing.
  if (table.n < COUNCIL_SIZE) {
    throw new Error(
      `build-table: precondition violated — need at least ${COUNCIL_SIZE} distinct drawable rows to run a fixed-${COUNCIL_SIZE} council draw; got n=${table.n}`,
    );
  }
  await writeJsonOutput(flags.out, table, { pretty: Boolean(flags.pretty) });
  return 0;
}

// Also runnable directly (node build-table.mjs ...). Comparison uses the
// Node-provided argv[1] resolved to a file URL so it works on Windows +
// POSIX identically.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBuildTable(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`ERROR: ${err?.stack || err?.message || String(err)}\n`);
      process.exit(1);
    });
}
