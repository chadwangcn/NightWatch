/**
 * NightWatch WP-07 — Draft/comment secret scan (C13, §5.9 gate 2)
 *
 * Reuses the WP-06 public secret-scan pattern set
 * (SECRET_SCAN_PATTERNS from nightwatch/evidence/lib/index.mjs) and applies
 * it to IN-MEMORY text: the full serialized issue draft (every field,
 * including evidence summaries) and every generated GitHub comment body.
 *
 * Two passes over each string value, mirroring WP-06's file scanner:
 *   1. plain-text pass — credential-shaped patterns;
 *   2. base64 decode pass — base64-shaped runs are decoded and re-scanned
 *      (closes the encoded-credential gap).
 *
 * Hits report LOCATION ONLY (field path / pattern label) — never the matched
 * value (§5.2). Any hit blocks the publish with ISS_GATE_FAILED.
 */
import { createHash } from "node:crypto";
import { SECRET_SCAN_PATTERNS } from "../../evidence/lib/index.mjs";

const BASE64_RUN = /[A-Za-z0-9+/]{24,}={0,2}/g;
const CORE_DECODE_PATTERNS = SECRET_SCAN_PATTERNS.filter(([label]) =>
  ["aws-access-key-id", "aws-temp-access-key", "github-token", "openai-style-key", "slack-token", "private-key-block", "jwt"].includes(label)
);

const printableRatio = (buf) => {
  if (buf.length === 0) return 0;
  let printable = 0;
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) printable += 1;
  }
  return printable / buf.length;
};

/** Scan one string with both passes; returns hit descriptors (no values). */
const scanString = (text, fieldPath, hits) => {
  for (const [label, re] of SECRET_SCAN_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ field: fieldPath, pattern: label, pass: "plain" });
  }
  BASE64_RUN.lastIndex = 0;
  let run;
  while ((run = BASE64_RUN.exec(text)) !== null) {
    const blob = run[0];
    // Skip pure hex (checksums/ULID-shaped hex is not meaningful base64 payload).
    if (/^[0-9a-f]+$/.test(blob) || /^[0-9A-F]+$/.test(blob)) continue;
    let decoded;
    try {
      decoded = Buffer.from(blob, "base64");
    } catch {
      continue;
    }
    if (decoded.length < 16 || printableRatio(decoded) < 0.9) continue;
    const decodedText = decoded.toString("utf8");
    for (const [label, re] of CORE_DECODE_PATTERNS) {
      if (decodedText.match(re)) {
        hits.push({ field: fieldPath, pattern: label, pass: "base64-decoded" });
        break; // one report per blob is enough to block the publish
      }
    }
  }
};

/** Walk an arbitrary JSON value, scanning every string under its field path. */
const walk = (value, path, hits) => {
  if (typeof value === "string") {
    scanString(value, path, hits);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, hits));
  } else if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) walk(val, path === "" ? key : `${path}.${key}`, hits);
  }
};

/**
 * Scan a whole issue draft (or comment payload object) for credential-shaped
 * material.
 * @param {object} value draft object / comment payload / any JSON value
 * @returns {{hits: Array<{field, pattern, pass}>, scanned_strings: number}}
 */
export function scanDraftSecrets(value) {
  const hits = [];
  let scannedStrings = 0;
  const countAndWalk = (v, path) => {
    if (typeof v === "string") scannedStrings += 1;
    walk(v, path, hits);
  };
  countAndWalk(value, "");
  return { hits, scanned_strings: scannedStrings };
}

/** Scan a plain text (e.g. a rendered issue body or comment body). */
export function scanTextSecrets(text, label = "$body") {
  const hits = [];
  scanString(String(text), label, hits);
  return { hits, scanned_strings: 1 };
}

/** Stable content digest used by the GitHub stub write log (never the body itself). */
export const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
