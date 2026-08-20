/**
 * NightWatch WP-01 — Prompt Injection protection (architecture §9.2).
 *
 * Every textual field that originates from an imported spec (description, summary,
 * example, external docs) is untrusted. This module:
 *   1. marks such text as UNTRUSTED_API_DATA;
 *   2. detects embedded instruction patterns (policy override / file & env access /
 *      command execution / exfiltration / tool-poisoning prefixes) and flags them;
 *   3. produces the Agent-visible sanitized view (quarantined text is replaced by a
 *      placeholder — the instruction is never executed, only recorded);
 *   4. enforces the external $ref policy (domain allowlist, default empty = deny all).
 */

export const UNTRUSTED_MARK = "UNTRUSTED_API_DATA";

/** Instruction patterns that must be flagged and quarantined (never executed). */
export const INJECTION_PATTERNS = [
  {
    id: "instr-ignore-previous-instructions",
    re: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|preceding)\s+instructions?\b/i,
  },
  {
    id: "instr-disregard-override-policy",
    re: /\b(?:disregard|override|bypass|deactivate)\b[^.\n]{0,80}\b(?:instruction|policy|policies|rule|rules|guardrail|restriction)\b/i,
  },
  {
    id: "instr-system-mode-override",
    re: /\b(?:system|developer)\s+(?:prompt|mode|instructions?)\s*(?:override|ignor\w+)?\b|\byou are now in\s+(?:developer|god|admin|unrestricted)\s+mode\b/i,
  },
  {
    id: "instr-access-file-env-secret",
    re: /\b(?:read|cat|open|access|print|reveal|show|dump|exfiltrate|leak|send|upload|post)\b[^.\n]{0,100}\b(?:file|\/etc\/|environment\s+variable|env\s+variable|\.env\b|secret|secrets|credential|credentials|api[_\- ]?key|token|password)\b/i,
  },
  {
    id: "instr-execute-command",
    re: /\b(?:execute|run|eval|evaluate|invoke|spawn)\b[^.\n]{0,80}\b(?:command|shell|bash|script|subprocess|terminal|curl|wget)\b/i,
  },
  {
    id: "instr-network-exfiltration",
    re: /\b(?:send|post|upload|transmit|exfiltrate|forward)\b[^.\n]{0,120}\b(?:https?:\/\/|webhook|attacker|evil\.)\b/i,
  },
  {
    id: "instr-tool-poisoning-prefix",
    re: /\b(?:IMPORTANT|SYSTEM|SYSTEM\s+OVERRIDE|NOTE\s+TO\s+(?:AI|AGENT|LLM|MODEL)|OVERRIDE)\s*[:!]/i,
  },
];

/** Scan one piece of untrusted text for instruction patterns. Returns pattern ids. */
export function scanInjection(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(text)) hits.push(p.id);
  }
  return hits;
}

/**
 * Wrap untrusted spec text with the trust marker and injection flags.
 * The original value is preserved for audit; the Agent-visible view is `sanitize()`.
 */
export function markUntrusted(text) {
  if (text === null || text === undefined) return null;
  const value = String(text);
  const injection_flags = scanInjection(value);
  return {
    trust: UNTRUSTED_MARK,
    value,
    injection_flags,
    quarantined: injection_flags.length > 0,
  };
}

/**
 * Agent-visible rendering of a marked field: quarantined text is replaced by a
 * placeholder that keeps the pattern ids but never the instruction payload.
 */
export function sanitizeForAgent(marked) {
  if (!marked) return null;
  if (!marked.quarantined) return marked.value;
  return `[QUARANTINED_BY_INJECTION_SCAN: ${marked.injection_flags.join(",")}]`;
}

/**
 * External $ref policy (§9.2: restrict domain / depth / size / hops).
 * Default allowlist is EMPTY: every external ref is denied and recorded.
 */
export function makeRefPolicy({ allowDomains = [], maxDepth = 8, maxBytes = 5 * 1024 * 1024, maxHops = 4 } = {}) {
  return {
    allowDomains: [...allowDomains],
    maxDepth,
    maxBytes,
    maxHops,
    /** Returns true when the ref target is permitted. */
    allows(ref) {
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)/.exec(ref);
      if (!m) return false; // non-URL external reference (e.g. file paths) — denied
      return this.allowDomains.includes(m[2].toLowerCase());
    },
  };
}

/**
 * Collect every $ref anywhere in a parsed spec whose target is external
 * (does not start with "#"). Returns [{ref, location}] with stable ordering.
 */
export function findExternalRefs(spec) {
  const found = [];
  const seen = new Set();
  const walk = (node, location) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${location}/${i}`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref" && typeof v === "string" && !v.startsWith("#")) {
          const entry = { ref: v, location: location || "/" };
          const key = `${entry.location} ${entry.ref}`;
          if (!seen.has(key)) {
            seen.add(key);
            found.push(entry);
          }
        } else {
          walk(v, location ? `${location}/${k}` : k);
        }
      }
    }
  };
  walk(spec, "");
  return found;
}
