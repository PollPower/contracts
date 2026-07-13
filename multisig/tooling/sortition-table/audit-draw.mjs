#!/usr/bin/env node
// multisig/tooling/sortition-table/audit-draw.mjs
// -----------------------------------------------------------------------------
// audit-draw subcommand.
//
// Input JSON (either form accepted):
//   {
//     "table": <build-table output>,
//     "seed": "0x<64hex>",
//     "claimedIncoming": ["0x<64hex>", "0x<64hex>", "0x<64hex>", "0x<64hex>", "0x<64hex>"]
//   }
//
// or, for convenience alongside how vectors are shaped:
//   {
//     "table": ..., "seed": ...,
//     "expected": { "selected": [...] }         // treated as claimedIncoming if
//                                               //   claimedIncoming is absent
//   }
//
// Output JSON:
//   MATCH:    { "verdict": "MATCH",    "selected": [...],           "kConsumed": <n> }
//   MISMATCH: { "verdict": "MISMATCH", "firstDivergenceIndex": <j>, "correctSelected": [...], "claimedIncoming": [...], "rejectionReason": <string>, "kConsumed": <n> }
//
// Exit code: 0 on MATCH, 2 on MISMATCH, 1 on any error.
// -----------------------------------------------------------------------------

import { pathToFileURL } from 'node:url';
import { auditDraw } from './lib.mjs';
import { parseFlags, readJsonInput, writeJsonOutput } from './io-util.mjs';

export async function runAuditDraw(argv) {
  const flags = parseFlags(argv);
  const input = await readJsonInput(flags.in);
  if (!input || typeof input !== 'object') {
    throw new Error('audit-draw: input must be an object with { table, seed, claimedIncoming }');
  }
  const { table, seed } = input;
  const claimedIncoming = input.claimedIncoming
    ?? input.claimed_incoming
    ?? input.incoming
    ?? input?.expected?.selected;
  if (!table) throw new Error('audit-draw: input.table is required');
  if (!seed) throw new Error('audit-draw: input.seed is required');
  if (!claimedIncoming) throw new Error('audit-draw: input.claimedIncoming (or input.expected.selected) is required');

  const result = auditDraw({ table, seed, claimedIncoming });
  await writeJsonOutput(flags.out, result, { pretty: Boolean(flags.pretty) });
  return result.verdict === 'MATCH' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAuditDraw(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`ERROR: ${err?.stack || err?.message || String(err)}\n`);
      process.exit(1);
    });
}
