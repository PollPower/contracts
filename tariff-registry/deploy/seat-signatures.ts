import { readFileSync } from 'node:fs';
import { Buffer } from 'buffer';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

(ed as any).hashes.sha512 = sha512;

export const PILOT_THRESHOLD = 3;

export type ApprovalBundle = {
  seatPubkeys: Uint8Array[];
  signatures: Uint8Array[];
  threshold: number;
};

type SeatSignatureRecord = {
  seatId: number;
  signature: string;
  publicKey: string;
};

type SeatSignaturesFile = {
  actionHash: string;
  epoch: number;
  signatures: SeatSignatureRecord[];
};

function parseHexExact(input: string, expectedBytes: number, label: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]+$/.test(input)) {
    throw new Error(`${label} must be a 0x-prefixed hex string`);
  }
  const hex = input.slice(2);
  if (hex.length !== expectedBytes * 2) {
    throw new Error(`invalid ${label} length`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function parseSeatSignaturesJson(path: string): SeatSignaturesFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`seat-signatures parse error: ${String(error)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('seat-signatures schema mismatch: top-level JSON object required');
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.actionHash !== 'string') {
    throw new Error('seat-signatures schema mismatch: actionHash must be a string');
  }
  if (!Number.isInteger(obj.epoch) || Number(obj.epoch) < 0) {
    throw new Error('seat-signatures schema mismatch: epoch must be a non-negative integer');
  }
  if (!Array.isArray(obj.signatures)) {
    throw new Error('seat-signatures schema mismatch: signatures must be an array');
  }

  const signatures: SeatSignatureRecord[] = obj.signatures.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`seat-signatures schema mismatch: signatures[${index}] must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    if (!Number.isInteger(rec.seatId)) {
      throw new Error(`seat-signatures schema mismatch: signatures[${index}].seatId must be an integer`);
    }
    const seatId = Number(rec.seatId);
    if (seatId < 0 || seatId > 4) {
      throw new Error(`seat-signatures schema mismatch: signatures[${index}].seatId must be 0..4`);
    }
    if (typeof rec.signature !== 'string') {
      throw new Error(`seat-signatures schema mismatch: signatures[${index}].signature must be a string`);
    }
    if (typeof rec.publicKey !== 'string') {
      throw new Error(`seat-signatures schema mismatch: signatures[${index}].publicKey must be a string`);
    }
    return {
      seatId,
      signature: rec.signature,
      publicKey: rec.publicKey,
    };
  });

  return {
    actionHash: obj.actionHash,
    epoch: Number(obj.epoch),
    signatures,
  };
}

/**
 * Security invariants:
 * - The loader NEVER touches Ed25519 secret material.
 * - The loader is fail-closed: any parse error, any signature verification failure, any threshold shortfall -> throw.
 * - The loader does NOT verify bundle.actionHash against any expected action hash. That is the CALLER's responsibility.
 */
export function loadSeatSignatures(path: string): ApprovalBundle {
  const parsed = parseSeatSignaturesJson(path);
  const actionHash = parseHexExact(parsed.actionHash, 32, 'actionHash');

  if (parsed.signatures.length < PILOT_THRESHOLD) {
    throw new Error('threshold not met');
  }

  const signatures: Uint8Array[] = [];
  const seatPubkeys: Uint8Array[] = [];
  for (const rec of parsed.signatures) {
    const signature = parseHexExact(rec.signature, 64, 'signature');
    if (signature.length !== 64) {
      throw new Error('invalid signature length');
    }
    const publicKey = parseHexExact(rec.publicKey, 32, 'publicKey');
    if (publicKey.length !== 32) {
      throw new Error('invalid publicKey length');
    }
    let ok = false;
    try {
      ok = ed.verify(signature, actionHash, publicKey);
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new Error(`signature verification failed for seatId ${rec.seatId}`);
    }
    signatures.push(signature);
    seatPubkeys.push(publicKey);
  }

  return {
    seatPubkeys,
    signatures,
    threshold: PILOT_THRESHOLD,
  };
}
