// @ts-check
// The private-state password (encrypts the contracts' private-state LevelDB)
// for Preprod: MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE (an owner-only file outside
// every repo; preferred) or MIDNIGHT_PRIVATE_STATE_PASSWORD, never both. The
// value is never printed, logged, or included in an error. A UTF-8 BOM and the
// trailing newline (PowerShell writes both) are stripped; the rest must be one
// line and pass Midnight.js's own password rules.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { gitWorkTreeOf } from './wallet-lib.mjs';

/** Windows: exactly one ACL entry (the current user), nothing inherited. */
function assertOwnerOnly(/** @type {string} */ file) {
  if (process.platform !== 'win32') {
    if (fs.statSync(file).mode & 0o077) throw new Error(`REFUSING: ${file} is readable by group/others (chmod 600)`);
    return;
  }
  const acl = execFileSync('icacls', [file], { encoding: 'utf8' });
  const grants = acl.split(/\r?\n/).map((l) => l.replace(file, '').trim()).filter((l) => /:\(/.test(l));
  const me = (String.fromCharCode(92) + `${process.env.USERNAME}:`).toLowerCase();
  if (grants.length !== 1 || !grants[0].toLowerCase().includes(me) || /\(I\)/.test(acl)) {
    throw new Error(`REFUSING: ${file} is not owner-only (expected one ACL entry for ${process.env.USERNAME}, nothing inherited)`);
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ devnetDefault?: string }} [o] the local devnet's default when nothing is set (dry runs only)
 * @returns {string}
 */
export function privateStatePassword(env = process.env, { devnetDefault } = {}) {
  const file = env.MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE, raw = env.MIDNIGHT_PRIVATE_STATE_PASSWORD;
  if (file && raw) throw new Error('set MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE or MIDNIGHT_PRIVATE_STATE_PASSWORD, not both');
  let pw;
  if (file) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`private-state password file not found: ${abs}`);
    if (gitWorkTreeOf(path.dirname(abs))) throw new Error(`REFUSING: ${abs} is inside a git checkout`);
    assertOwnerOnly(abs);
    pw = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '').replace(/\r?\n$/, '');
    if (!pw) throw new Error(`private-state password file ${abs} is empty`);
    if (/[\r\n]/.test(pw)) throw new Error(`private-state password file ${abs} must hold one line`);
  } else if (raw) {
    pw = raw;
  } else if (devnetDefault) {
    return devnetDefault;
  } else {
    throw new Error('MIDNIGHT_PRIVATE_STATE_PASSWORD_FILE (owner-only file) is required');
  }
  try { validatePassword(pw); } catch (e) {
    const msg = String(/** @type {any} */ (e)?.message ?? e).split(pw).join('<redacted>');
    throw new Error(`the private-state password does not meet Midnight.js's rules: ${msg}`);
  }
  return pw;
}
