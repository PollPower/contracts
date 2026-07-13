// multisig/tooling/sortition-table/io-util.mjs
// -----------------------------------------------------------------------------
// Small argv / stdin / stdout helpers shared by the build-table and audit-draw
// subcommands. Kept out of lib.mjs so the pure core stays free of I/O.
// -----------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';

/** Very small flag parser: --key value | --key=value | --flag (boolean). */
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new Error(`unrecognised positional argument: ${a}`);
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

/** Read stdin fully to a UTF-8 string. */
export async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** Read JSON from a file path, from stdin ('-' or missing), and parse. */
export async function readJsonInput(pathOrDash) {
  const src = (pathOrDash === undefined || pathOrDash === '-' || pathOrDash === true)
    ? await readStdin()
    : await readFile(pathOrDash, 'utf8');
  try {
    return JSON.parse(src);
  } catch (e) {
    throw new Error(`failed to parse JSON input${typeof pathOrDash === 'string' && pathOrDash !== '-' ? ` from ${pathOrDash}` : ' from stdin'}: ${e.message}`);
  }
}

/** Serialise to JSON and write to file path or stdout ('-' or missing). */
export async function writeJsonOutput(pathOrDash, obj, { pretty = false } = {}) {
  const body = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  const out = body + '\n';
  if (pathOrDash === undefined || pathOrDash === '-' || pathOrDash === true) {
    process.stdout.write(out);
  } else {
    await writeFile(pathOrDash, out, 'utf8');
  }
}
