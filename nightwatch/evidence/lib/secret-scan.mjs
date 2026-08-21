/**
 * NightWatch WP-06 — Seal-time secret scan (C11, §5.2/§5.3)
 *
 * Defense-in-depth credential scan over the WHOLE bundle before Seal:
 * a hit BLOCKS the seal with EVD_SECRET_DETECTED and reports the location
 * (file + line + pattern label) — never the matched value (§5.2).
 *
 * Two passes per file:
 *   1. plain-text pass — credential-shaped patterns (superset of the
 *      redaction content rules, so anything redaction missed in plain text
 *      still blocks the seal);
 *   2. base64 decode pass — base64-shaped runs are decoded and, when the
 *      decoded bytes are printable text, re-scanned. This closes the real-
 *      world gap where redaction (plain-text oriented) cannot see through
 *      encoded payloads (e.g. a debug blob echoing credentials).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SECRET_SCAN_PATTERNS = [
  ["aws-access-key-id", /AKIA[0-9A-Z]{16}/],
  ["aws-temp-access-key", /ASIA[0-9A-Z]{16}/],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{36}/],
  ["openai-style-key", /sk-[A-Za-z0-9_-]{20,}/],
  ["slack-token", /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /eyJhbGciOi[A-Za-z0-9_-]{10,}\./],
  ["bearer-credential", /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/],
  // '*' excluded from the value charset so ***REDACTED*** can never self-match.
  ["credential-assignment", /(?:password|passwd|secret|token|api_key|apikey)["']?\s*[:=]\s*["']?[^\s"'&,}*]{12,}/i],
];

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

const walkFiles = (dir, acc = []) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
};

/** Line/column of a match index within a text (1-based). */
const lineCol = (text, index) => {
  const before = text.slice(0, index);
  const line = (before.match(/\n/g) || []).length + 1;
  const lastNl = before.lastIndexOf("\n");
  return { line, column: index - lastNl };
};

/**
 * Scan every file under `bundleDir` (or the provided file list) for
 * credential-shaped material.
 * @returns {{hits: Array<{file, pattern, pass, line, column}>, scanned_files: number}}
 *   Hits report LOCATION ONLY — the matched value is never included.
 */
export function scanSecrets(bundleDir, files = null) {
  const list = files ?? walkFiles(bundleDir);
  const hits = [];
  for (const p of list) {
    const rel = relative(bundleDir, p);
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue; // binary/unreadable files: plain scan skipped, not an error
    }
    // Pass 1: plain text
    for (const [label, re] of SECRET_SCAN_PATTERNS) {
      const m = text.match(re);
      if (m) {
        const { line, column } = lineCol(text, m.index);
        hits.push({ file: rel, pattern: label, pass: "plain", line, column });
      }
    }
    // Pass 2: base64-decoded blobs
    BASE64_RUN.lastIndex = 0;
    let run;
    while ((run = BASE64_RUN.exec(text)) !== null) {
      const blob = run[0];
      // Skip pure hex (checksums/ULID-shaped hex is not meaningful base64 payload)
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
        const m = decodedText.match(re);
        if (m) {
          const { line, column } = lineCol(text, run.index);
          hits.push({ file: rel, pattern: label, pass: "base64-decoded", line, column });
          break; // one report per blob is enough to block the seal
        }
      }
    }
  }
  return { hits, scanned_files: list.length };
}
