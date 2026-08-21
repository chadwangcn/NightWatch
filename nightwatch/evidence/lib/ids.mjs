/**
 * NightWatch WP-06 — Deterministic ID generation (C11/C12)
 *
 * ULID per WP-00 common.json: 26 chars, Crockford Base32 (alphabet excludes
 * I, L, O, U), lexicographically sortable. Unlike WP-03's random-entropy
 * generator, this one is DETERMINISTIC (time from an injectable clock +
 * monotonic counter as entropy) so that acceptance reruns produce
 * byte-identical stores and receipts (WorkRequest §7 A10).
 *
 * Pure Node built-ins only.
 */
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

/**
 * Create a deterministic, monotonic ULID generator.
 * @param {() => number} [nowMs] clock returning epoch ms (deterministic in verify)
 * @returns {{ next: () => string, reset: () => void }}
 */
export function deterministicUlidGenerator(nowMs = () => Date.now()) {
  let counter = 0n;
  const gen = {
    next() {
      const id = encodeBigInt(BigInt(nowMs()), 10) + encodeBigInt(counter, 16);
      counter += 1n;
      return id;
    },
    reset() {
      counter = 0n;
    },
  };
  return gen;
}

/** Prefixed object ID helpers matching WP-00 common.json id definitions. */
export const makeIdFactory = (nowMs) => {
  const gen = deterministicUlidGenerator(nowMs);
  return {
    reset: () => gen.reset(),
    observationId: () => `obs_${gen.next()}`,
    findingId: () => `find_${gen.next()}`,
    auditId: () => `audit_${gen.next()}`,
  };
};

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Structural check for a `<prefix>_<ULID>` object id (WP-00 §5.5 prefix table). */
export const isPrefixedUlid = (prefix, id) =>
  typeof id === "string" && id.startsWith(`${prefix}_`) && ULID_RE.test(id.slice(prefix.length + 1));
