/**
 * NightWatch WP-03 — ID generation (C14 Audit, Checkpoint and Catalog Index)
 *
 * ULID per WP-00 common.json `ulid` definition: 26 chars, Crockford Base32
 * (alphabet excludes I, L, O, U), lexicographically sortable, monotonic
 * within a single generator instance.
 *
 * Pure Node built-ins only. No network, no persistence.
 */
import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // 32 chars, no I/L/O/U

/** Encode a BigInt into `len` Crockford Base32 chars (zero-padded). */
function encodeBigInt(value, len) {
  let v = BigInt(value);
  const out = new Array(len).fill("0");
  for (let i = len - 1; i >= 0; i -= 1) {
    out[i] = CROCKFORD[Number(v & 0x1fn)];
    v >>= 5n;
  }
  return out.join("");
}

/** Random 80-bit entropy as BigInt. */
function randomEntropy() {
  const buf = randomBytes(10); // 80 bits
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  return v;
}

/**
 * Create a monotonic ULID generator.
 * @returns {{ next: (nowMs?: number) => string }}
 */
export function ulidGenerator() {
  let lastTime = -1;
  let lastEntropy = 0n;
  return {
    next(nowMs = Date.now()) {
      if (!Number.isInteger(nowMs) || nowMs < 0) {
        throw new TypeError("nowMs must be a non-negative integer (epoch ms)");
      }
      let entropy = randomEntropy();
      if (nowMs === lastTime && entropy <= lastEntropy) {
        entropy = lastEntropy + 1n;
        if (entropy >= 1n << 80n) entropy = randomEntropy(); // astronomically unlikely
      }
      lastTime = nowMs;
      lastEntropy = entropy;
      return encodeBigInt(BigInt(nowMs), 10) + encodeBigInt(entropy, 16);
    },
  };
}

const defaultGenerator = ulidGenerator();

/** Generate a single ULID (26 chars, Crockford Base32). */
export function ulid(nowMs) {
  return defaultGenerator.next(nowMs);
}

/** Prefixed object ID helpers matching WP-00 common.json id definitions. */
export const newAuditId = (nowMs) => `audit_${ulid(nowMs)}`;
export const newLockId = (nowMs) => `lock_${ulid(nowMs)}`;
export const newSessionId = (nowMs) => `session_${ulid(nowMs)}`;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Structural check for a `<prefix>_<ULID>` object id (WP-00 §5.5 prefix table). */
export const isPrefixedUlid = (prefix, id) =>
  typeof id === "string" && id.startsWith(`${prefix}_`) && ULID_RE.test(id.slice(prefix.length + 1));
