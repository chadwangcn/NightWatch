/**
 * NightWatch WP-06 — Field-level redaction (C11, §13.2/§13.3/§14)
 *
 * PII/credential redaction with a combination of three rule families,
 * applied BEFORE any byte reaches the run store (§13.3-5: request/response
 * must be sanitized before entering workspace/logs/artifacts):
 *
 *   1. field-name rules   — keys matching credential-shaped names
 *                           (authorization / token / secret / password /
 *                           api-key / cookie / credential / bearer)
 *   2. JSONPath rules     — exact paths ($.headers.authorization) and
 *                           recursive keys ($..client_secret)
 *   3. content regex rules — credential-shaped substrings inside any string
 *                           value (Bearer headers, JWTs, AWS keys, GitHub
 *                           tokens, OpenAI-style keys, Slack tokens,
 *                           PEM private-key blocks, credential assignments)
 *
 * The redaction report records WHERE (file + JSON path) and HOW OFTEN
 * redaction fired — never the original values (§5.2).
 *
 * Scope note: content rules operate on PLAIN TEXT. Encoded (e.g. base64)
 * payloads are the secret scanner's defense-in-depth responsibility
 * (lib/secret-scan.mjs), which decodes base64-shaped blobs before matching.
 */
export const REDACTION_POLICY_VERSION = "nw-redaction-default-v1";
export const REDACTED = "***REDACTED***";

export const DEFAULT_REDACTION_PROFILE = {
  version: REDACTION_POLICY_VERSION,
  replacement: REDACTED,
  field_name_patterns: [
    "authorization",
    "token",
    "secret",
    "password",
    "passwd",
    "api[-_]?key",
    "apikey",
    "cookie",
    "credential",
    "bearer",
  ],
  json_paths: ["$.headers.authorization", "$.headers['set-cookie']", "$..access_token", "$..refresh_token", "$..client_secret", "$..device_secret"],
  content_patterns: [
    ["bearer-credential", /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g],
    ["jwt", /eyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\./g],
    ["aws-access-key-id", /AKIA[0-9A-Z]{16}/g],
    ["aws-temp-access-key", /ASIA[0-9A-Z]{16}/g],
    ["github-token", /gh[pousr]_[A-Za-z0-9]{36}/g],
    ["openai-style-key", /sk-[A-Za-z0-9_-]{20,}/g],
    ["slack-token", /xox[baprs]-[0-9A-Za-z-]{10,}/g],
    ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
    // Generic credential assignment in free text (query strings, log lines).
    // '*' is excluded from the value charset so the replacement marker itself
    // can never re-trigger this rule.
    ["credential-assignment", /(?:password|passwd|secret|token|api_key|apikey)["']?\s*[:=]\s*["']?[^\s"'&,}*]{12,}/gi],
  ],
};

const compileProfile = (profile) => {
  const fieldRes = profile.field_name_patterns.map((p) => new RegExp(p, "i"));
  const jsonRules = profile.json_paths.map((p) => {
    if (p.startsWith("$..")) return { type: "recursive-key", key: p.slice(3), source: p };
    return { type: "exact-path", path: p, source: p };
  });
  const contentRes = profile.content_patterns.map(([label, re]) => [label, new RegExp(re.source, re.flags)]);
  return { fieldRes, jsonRules, contentRes, replacement: profile.replacement };
};

/** Normalize a JSON pointer-ish path array to a comparable string. */
const pathKey = (segments) => `$${segments.map((s) => (typeof s === "number" ? `[${s}]` : `['${s}']`)).join("")}`;
/** Dot display form for reports: $.headers.authorization */
const pathDisplay = (segments) =>
  `$${segments.map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("")}`.replace(".[", "[");

/**
 * Redact a string per content patterns (returns new string + hit count).
 * Single-pass replace with a counting callback: the count always equals the
 * number of replacements applied. `label` is the display path for the report.
 */
function redactStringInValue(text, compiled, report, label) {
  let out = text;
  let hits = 0;
  for (const [label_, re] of compiled.contentRes) {
    let count = 0;
    out = out.replace(re, () => {
      count += 1;
      return compiled.replacement;
    });
    if (count > 0) {
      report.push({ path: label, rule: `content:${label_}`, count });
      hits += count;
    }
  }
  return { text: out, hits };
}

/**
 * Deep-redact a JSON-able value. Returns a NEW value (input untouched).
 * `report` accumulates {path, rule, count} entries (no original values).
 */
export function redactDeep(value, profile = DEFAULT_REDACTION_PROFILE, report = [], segments = []) {
  const compiled = compileProfile(profile);
  const walk = (node, segs) => {
    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, [...segs, i]));
    }
    if (node !== null && typeof node === "object") {
      const out = {};
      for (const [key, val] of Object.entries(node)) {
        const keySegs = [...segs, key];
        const fieldNameHit = compiled.fieldRes.some((re) => re.test(key));
        const jsonHit = compiled.jsonRules.some((rule) => {
          if (rule.type === "recursive-key") return rule.key === key;
          return rule.path === pathKey(keySegs);
        });
        if ((fieldNameHit || jsonHit) && (typeof val === "string" || typeof val === "number" || typeof val === "boolean")) {
          const ruleName = fieldNameHit
            ? `field-name:${compiled.fieldRes.find((re) => re.test(key))?.source ?? key}`
            : `jsonpath:${compiled.jsonRules.find((r) => (r.type === "recursive-key" ? r.key === key : r.path === pathKey(keySegs)))?.source ?? pathKey(keySegs)}`;
          report.push({ path: pathDisplay(keySegs), rule: ruleName, count: 1 });
          out[key] = compiled.replacement;
          continue;
        }
        if ((fieldNameHit || jsonHit) && val !== null && typeof val === "object") {
          // Credential-shaped containers: redact every leaf inside.
          out[key] = redactContainer(val, compiled, report, keySegs);
          continue;
        }
        out[key] = walk(val, keySegs);
      }
      return out;
    }
    if (typeof node === "string") {
      let text = node;
      const display = pathDisplay(segs);
      if (/^https?:\/\//i.test(text)) {
        // URL-shaped strings get userinfo + credential-query-param handling first
        text = redactUrl(text, profile, report, display);
      }
      const { text: out } = redactStringInValue(text, compiled, report, display);
      return out;
    }
    return node;
  };
  return walk(value, segments);
}

/** Redact every leaf inside a credential-shaped container (objects/arrays). */
function redactContainer(node, compiled, report, segs) {
  if (Array.isArray(node)) {
    return node.map((item, i) => redactContainer(item, compiled, report, [...segs, i]));
  }
  if (node !== null && typeof node === "object") {
    const out = {};
    for (const [key, val] of Object.entries(node)) {
      out[key] = redactContainer(val, compiled, report, [...segs, key]);
    }
    return out;
  }
  report.push({ path: pathDisplay(segs), rule: "field-name:container-leaf", count: 1 });
  return typeof node === "string" ? compiled.replacement : node;
}

/**
 * Sanitize a URL string: userinfo, credential-shaped query parameters and
 * embedded credential patterns (e.g. access_token=... in a query string).
 */
export function redactUrl(url, profile = DEFAULT_REDACTION_PROFILE, report = [], path = "$.url") {
  const compiled = compileProfile(profile);
  let out = url;
  // userinfo: https://user:pass@host -> https://***REDACTED***@host
  const userinfo = /^([a-z][a-z0-9+.-]*:\/\/)([^/@:]+):([^/@]+)@/i;
  if (userinfo.test(out)) {
    out = out.replace(userinfo, `$1${compiled.replacement}@`);
    report.push({ path, rule: "url:userinfo", count: 1 });
  }
  // credential-shaped query parameters by name
  const credParam = /([?&])([A-Za-z0-9_]*(?:token|secret|password|passwd|key|credential)[A-Za-z0-9_]*)=([^&#]*)/gi;
  let paramMatch;
  let paramCount = 0;
  while ((paramMatch = credParam.exec(out)) !== null) {
    if (paramMatch[3] !== compiled.replacement) paramCount += 1;
  }
  if (paramCount > 0) {
    out = out.replace(credParam, `$1$2=${compiled.replacement}`);
    report.push({ path, rule: "url:credential-query-param", count: paramCount });
  }
  // remaining content patterns (JWT in fragment, etc.)
  const { text } = redactStringInValue(out, compiled, report, path);
  return text;
}

/** Aggregate a raw redaction report into {policy_version, total_count, redactions[]} with stable ordering. */
export function buildRedactionReport(entries, profile = DEFAULT_REDACTION_PROFILE) {
  const merged = new Map();
  for (const e of entries) {
    const key = `${e.file ?? ""}|${e.path}|${e.rule}`;
    const cur = merged.get(key) ?? { file: e.file ?? "", path: e.path, rule: e.rule, count: 0 };
    cur.count += e.count;
    merged.set(key, cur);
  }
  const redactions = [...merged.values()].sort((a, b) => (a.file + a.path + a.rule).localeCompare(b.file + b.path + b.rule));
  return {
    policy_version: profile.version,
    total_count: redactions.reduce((acc, r) => acc + r.count, 0),
    note: "positions and counts only; original values are never recorded",
    redactions,
  };
}
