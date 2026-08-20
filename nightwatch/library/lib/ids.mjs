/**
 * NightWatch WP-02 — Deterministic object IDs.
 *
 * All library object IDs (plan_/scen_/case_) are DERIVED from the canonical
 * content seed of the object, NOT from the wall clock. This is what makes
 * regeneration idempotent (same input ⇒ same case_id ⇒ incremental
 * preservation can match identities across spec versions) and what makes
 * two full verification runs byte-identical (A7/A10).
 *
 * Format complies with common.json#/$defs/ulid: 26 chars Crockford Base32
 * (excludes I, L, O, U), prefixed per the §5.5 prefix table.
 */
import { createHash } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32

/** Stable stringify: object keys sorted recursively (canonical JSON seed). */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256Buf = (text) => createHash("sha256").update(text, "utf8").digest();

/** Encode the first 130 bits of a buffer as 26 Crockford-Base32 chars. */
function toBase32(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes.subarray(0, 17)).toString("hex")}`);
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/**
 * Derive a deterministic prefixed ULID-format id from a seed object.
 * @param {"plan"|"scen"|"case"} prefix
 * @param {object} seed canonical seed (content-derived, NEVER wall-clock)
 */
export function deriveId(prefix, seed) {
  return `${prefix}_${toBase32(sha256Buf(stableStringify(seed)))}`;
}

/** sha256 hex over stable-stringified content (used for signatures/checksums). */
export const contentChecksum = (seed) =>
  `sha256:${createHash("sha256").update(stableStringify(seed), "utf8").digest("hex")}`;

/** sha256 hex over raw bytes (compile artifacts use byte-level identity). */
export const bytesChecksum = (buf) => `sha256:${createHash("sha256").update(buf).digest("hex")}`;
