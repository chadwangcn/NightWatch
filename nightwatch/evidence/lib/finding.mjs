/**
 * NightWatch WP-06 — Finding Service (C12, §5.8/§15)
 *
 * Chain: Execution Failure → Observation → Reproduction → Finding.
 *
 *   - Fingerprint (§15, six components):
 *       api_id + normalized_method_path + assertion_class
 *       + normalized_status_or_error + response_signature + scenario_state
 *   - Dedup: same fingerprint in the SAME run merges (one finding aggregates
 *     repeated responses); across runs the SAME finding aggregates the
 *     reproduction history (attempts/failures/rate updated, never a new
 *     object) and the submission is classified `duplicate`;
 *   - Substantive behavior change (same api/method/assertion/scenario_state
 *     but different status/response signature ⇒ different fingerprint)
 *     creates a NEW finding RELATED to the prior one (relation recorded in
 *     the store index — the WP-00 finding object itself has no relation
 *     field, so links live beside, not inside, the schema-validated object);
 *   - Six-way classification (§5.8): confirmed / flaky / environmental /
 *     spec-ambiguity / inconclusive / duplicate;
 *   - hypothesis firewall (§14.1): machine pipeline NEVER writes hypothesis;
 *     it defaults to "" and can only be set through an explicit
 *     `setHypothesis` call, always separated from confirmed external symptoms.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { makeError, ERROR_CODES } from "./errors.mjs";
import { validateFinding } from "./schemas.mjs";

const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const defaultClock = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export const FINGERPRINT_FIELDS = [
  "api_id",
  "normalized_method_path",
  "assertion_class",
  "normalized_status_or_error",
  "response_signature",
  "scenario_state",
];

/** Reproduction gate for `confirmed` (WorkRequest §5.4: attempts/failures/rate thresholds). */
export const DEFAULT_REPRODUCTION_GATE = { min_attempts: 3 };

/** Transport/environment error markers that constitute environmental evidence. */
export const ENVIRONMENTAL_ERROR_MARKERS = [
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "socket hang up",
  "getaddrinfo",
  "certificate",
  "self-signed",
  "tls",
];

/** Normalize a request path: UUID/ULID/numeric segments collapse to {id}. */
export function normalizePath(path) {
  return String(path)
    .split("?")[0]
    .split("/")
    .map((seg) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "{uuid}";
      if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(seg)) return "{ulid}";
      if (/^\d+$/.test(seg)) return "{id}";
      return seg;
    })
    .join("/");
}

/**
 * Build the six-component fingerprint from raw observation facts.
 * All six components are mandatory (§15).
 */
export function buildFingerprint({ api_id, method, path, assertion_class, status_or_error, response_signature, scenario_state }) {
  return {
    api_id: String(api_id),
    normalized_method_path: `${String(method).toUpperCase()} ${normalizePath(path)}`,
    assertion_class: String(assertion_class),
    normalized_status_or_error: String(status_or_error).trim(),
    response_signature: String(response_signature),
    scenario_state: String(scenario_state),
  };
}

/** Canonical fingerprint key (stable across processes; used for index maps). */
export const fingerprintKey = (parts) =>
  `{${FINGERPRINT_FIELDS.map((f) => `${JSON.stringify(f)}:${JSON.stringify(parts[f])}`).join(",")}}`;

export const fingerprintHash = (parts) => sha256hex(fingerprintKey(parts));

const ENV_SIGNAL_CLASS = new Set(["transport", "credential-injection", "environment"]);

/**
 * Classify a finding candidate from external evidence only (§5.8 order):
 *   environmental → spec-ambiguity → reproduction gate
 *     · attempts ≥ min && failures === attempts  → confirmed
 *     · attempts ≥ min && 0 < failures < attempts → flaky (intermittent, same
 *       input and environment)
 *     · attempts < min (or nothing failed)        → inconclusive (not publishable)
 * `duplicate` is produced by the store's dedup path, not by this function.
 */
export function classifyFinding(candidate, { gate = DEFAULT_REPRODUCTION_GATE } = {}) {
  const { parts, reproduction, environmental_signals = [], spec_ambiguity = null } = candidate;
  const markers = ENVIRONMENTAL_ERROR_MARKERS.filter((m) => parts.normalized_status_or_error.toUpperCase().includes(m.toUpperCase()));
  const signals = [...new Set(environmental_signals)];
  const envFromClass = ENV_SIGNAL_CLASS.has(parts.assertion_class);
  if (signals.length > 0 || markers.length > 0 || envFromClass) {
    return {
      classification: "environmental",
      rationale: `evidence points to network/credential/test-data/environment (signals=${signals.join("|") || "-"}, markers=${markers.join("|") || "-"}${envFromClass ? ", assertion_class=environment-scoped" : ""})`,
    };
  }
  if (spec_ambiguity) {
    return { classification: "spec-ambiguity", rationale: `behavior deviates from the spec/scenario in an ambiguous way: ${String(spec_ambiguity)}` };
  }
  const { attempts, failures } = reproduction;
  if (attempts >= gate.min_attempts && failures === attempts && failures > 0) {
    return { classification: "confirmed", rationale: `reproduction gate met: attempts=${attempts}, failures=${failures}, rate=1` };
  }
  if (attempts >= gate.min_attempts && failures > 0 && failures < attempts) {
    return { classification: "flaky", rationale: `intermittent under same input and environment: attempts=${attempts}, failures=${failures}` };
  }
  if (failures === 0) {
    return { classification: "inconclusive", rationale: "no failure recorded for this fingerprint" };
  }
  return { classification: "inconclusive", rationale: `reproduction evidence below gate (attempts=${attempts} < ${gate.min_attempts}); not publishable` };
}

/**
 * Assert that a REQUESTED classification is legally derivable from the
 * evidence. Forcing `confirmed` below the gate yields FND_CLASSIFICATION_INVALID.
 */
export function assertClassificationLegal(candidate, requested, { gate = DEFAULT_REPRODUCTION_GATE } = {}) {
  if (candidate.reproduction.attempts === 0) {
    return { ok: false, error: makeError(ERROR_CODES.INSUFFICIENT_EVIDENCE, "no reproduction attempts recorded; classification refused", { reason: "insufficient_evidence" }) };
  }
  const actual = classifyFinding(candidate, { gate }).classification;
  if (requested !== actual) {
    return {
      ok: false,
      error: makeError(ERROR_CODES.CLASSIFICATION_INVALID, `requested classification "${requested}" is not legal for this evidence (derives as "${actual}")`, {
        reason: "classification_not_derivable",
        derived: actual,
        requested,
      }),
    };
  }
  return { ok: true };
}

export class FindingStore {
  /**
   * @param {string} dir store directory (findings.jsonl + finding-index.json + relations.jsonl)
   * @param {object} [options] {ids, clock, auditSink}
   */
  constructor(dir, { ids, clock = defaultClock, auditSink = null } = {}) {
    this.dir = dir;
    this.ids = ids;
    this.clock = clock;
    this.auditSink = auditSink;
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "findings.jsonl"))) writeFileSync(join(dir, "findings.jsonl"), "", { flag: "wx" });
    if (!existsSync(join(dir, "relations.jsonl"))) writeFileSync(join(dir, "relations.jsonl"), "", { flag: "wx" });
    this.#reload();
  }

  #reload() {
    this.snapshots = readFileSync(join(this.dir, "findings.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
    this.latest = new Map(); // finding_id → snapshot
    this.byFp = new Map(); // fingerprint key → finding_id (latest)
    for (const snap of this.snapshots) {
      this.latest.set(snap.finding_id, snap);
      this.byFp.set(fingerprintKey(snap.fingerprint), snap.finding_id);
    }
    this.relations = readFileSync(join(this.dir, "relations.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  }

  #persistIndex() {
    const byFp = {};
    for (const [key, id] of [...this.byFp.entries()].sort((a, b) => a[1].localeCompare(b[1]))) byFp[key] = id;
    writeFileSync(
      join(this.dir, "finding-index.json"),
      `${JSON.stringify({ store_version: "nw-finding-index-v1", updated_at: this.clock(), by_fingerprint: byFp, finding_count: this.latest.size }, null, 2)}\n`,
      "utf8"
    );
  }

  #appendSnapshot(finding) {
    appendFileSync(join(this.dir, "findings.jsonl"), `${JSON.stringify(finding)}\n`, "utf8");
    this.latest.set(finding.finding_id, finding);
    this.byFp.set(fingerprintKey(finding.fingerprint), finding.finding_id);
    this.#persistIndex();
  }

  #audit(action, findingId, keySuffix) {
    if (!this.auditSink) return;
    this.auditSink.record({
      actor: "C12-finding-service",
      action,
      objectType: "finding",
      objectId: findingId,
      timestamp: this.clock(),
      idempotencyKey: `${findingId}:${keySuffix}`,
    });
  }

  /**
   * Submit one per-run reproduction group (all case events of one fingerprint
   * within one run, with their observations). Handles same-run merge,
   * cross-run aggregation, duplicate classification and behavior-change
   * relations.
   *
   * @param {object} input
   *   parts            six-component fingerprint (buildFingerprint output)
   *   attempts         total attempts observed in this group
   *   failures         total failures observed in this group
   *   observations     WP-00 observation objects (≥1 when failures > 0)
   *   environmental_signals  evidence signals from the executor/environment
   *   spec_ambiguity   ambiguity note (string) when behavior vs spec is ambiguous
   */
  submit({ parts, attempts, failures, observations = [], environmental_signals = [], spec_ambiguity = null }) {
    for (const field of FINGERPRINT_FIELDS) {
      if (typeof parts?.[field] !== "string" || parts[field].length === 0) {
        return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `fingerprint component "${field}" is mandatory (§15 six-component fingerprint)`, { reason: "fingerprint_incomplete", field }) };
      }
    }
    if (!Number.isInteger(attempts) || attempts < 0 || !Number.isInteger(failures) || failures < 0 || failures > attempts) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "reproduction counters must satisfy 0 ≤ failures ≤ attempts", { reason: "invalid_reproduction" }) };
    }
    if (attempts === 0) {
      return { ok: false, error: makeError(ERROR_CODES.INSUFFICIENT_EVIDENCE, "a finding requires at least one reproduction attempt", { reason: "insufficient_evidence" }) };
    }
    if (failures > 0 && observations.length === 0) {
      return { ok: false, error: makeError(ERROR_CODES.INSUFFICIENT_EVIDENCE, "failures require at least one observation", { reason: "insufficient_evidence" }) };
    }
    const observationIds = observations.map((o) => o.observation_id);
    const times = observations.map((o) => o.occurred_at).sort();

    const key = fingerprintKey(parts);
    const existingId = this.byFp.get(key);

    if (existingId === undefined) {
      const reproduction = { attempts, failures, rate: failures / attempts };
      const { classification, rationale } = classifyFinding({ parts, reproduction, environmental_signals, spec_ambiguity });
      const finding = {
        finding_id: this.ids.findingId(),
        fingerprint: parts,
        classification,
        reproduction,
        hypothesis: "",
        observation_ids: observationIds,
        issue_refs: [],
        first_observed_at: times[0] ?? this.clock(),
        last_observed_at: times[times.length - 1] ?? this.clock(),
      };
      const schemaCheck = validateFinding(finding);
      if (!schemaCheck.ok) {
        return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "finding failed WP-00 schema validation", { reason: "finding_schema", errors: schemaCheck.errors }) };
      }
      // Behavior-change relation: prior finding with same api/method/assertion/
      // scenario_state but a different status/response signature (§15).
      const prior = this.#findBehaviorRelative(parts);
      let relation = undefined;
      if (prior) {
        relation = {
          finding_id: finding.finding_id,
          prior_finding_id: prior.finding_id,
          relation: "behavior_changed_from",
          detected_at: this.clock(),
        };
        appendFileSync(join(this.dir, "relations.jsonl"), `${JSON.stringify(relation)}\n`, "utf8");
        this.relations.push(relation);
      }
      this.#appendSnapshot(finding);
      // In-memory re-evaluation context (never persisted inside the finding object).
      this.latest.set(finding.finding_id, { ...finding, environmental_signals_snapshot: environmental_signals, spec_ambiguity_snapshot: spec_ambiguity });
      this.#audit("finding.classified", finding.finding_id, `classified:${classification}`);
      return { ok: true, status: "created", classification, rationale, finding, ...(relation ? { relation } : {}) };
    }

    // Cross-run aggregation (§15): update attempts/failures/rate on the SAME
    // finding; the incoming submission is classified `duplicate` and never
    // becomes a new finding object.
    const existing = this.latest.get(existingId);
    const mergedRepro = {
      attempts: existing.reproduction.attempts + attempts,
      failures: existing.reproduction.failures + failures,
    };
    mergedRepro.rate = mergedRepro.failures / mergedRepro.attempts;
    const mergedSignals = [...new Set([...(existing.environmental_signals_snapshot ?? []), ...environmental_signals])];
    const mergedAmbiguity = existing.spec_ambiguity_snapshot ?? spec_ambiguity;
    const { classification, rationale } = classifyFinding(
      { parts, reproduction: mergedRepro, environmental_signals: mergedSignals, spec_ambiguity: mergedAmbiguity },
    );
    const mergedIds = [...new Set([...existing.observation_ids, ...observationIds])];
    const updated = {
      ...existing,
      classification,
      reproduction: mergedRepro,
      observation_ids: mergedIds,
      first_observed_at: existing.first_observed_at,
      last_observed_at: [existing.last_observed_at, times[times.length - 1] ?? existing.last_observed_at].sort().pop(),
    };
    // Non-schema sidecar state (signals/ambiguity for future re-evaluation)
    // lives only in memory + this snapshot bookkeeping field, stripped before
    // schema validation/persistence via the pick below.
    const schemaCheck = validateFinding(this.#stripInternal(updated));
    if (!schemaCheck.ok) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "aggregated finding failed WP-00 schema validation", { reason: "finding_schema", errors: schemaCheck.errors }) };
    }
    this.#appendSnapshot(this.#stripInternal(updated));
    this.latest.set(updated.finding_id, { ...updated, environmental_signals_snapshot: mergedSignals, spec_ambiguity_snapshot: mergedAmbiguity });
    for (const obsId of observationIds) this.#audit("finding.reproduced", updated.finding_id, `reproduced:${obsId}`);
    return { ok: true, status: "merged", classification: "duplicate", duplicate_of: updated.finding_id, rationale, finding: this.#stripInternal(updated) };
  }

  #stripInternal(f) {
    const { environmental_signals_snapshot, spec_ambiguity_snapshot, ...clean } = f;
    return clean;
  }

  #findBehaviorRelative(parts) {
    const quartet = (fp) => [fp.api_id, fp.normalized_method_path, fp.assertion_class, fp.scenario_state].join("|");
    const mine = quartet(parts);
    let best = undefined;
    for (const snap of this.latest.values()) {
      if (quartet(snap.fingerprint) !== mine) continue;
      if (snap.fingerprint.normalized_status_or_error === parts.normalized_status_or_error && snap.fingerprint.response_signature === parts.response_signature) continue;
      if (!best || snap.last_observed_at > best.last_observed_at) best = snap;
    }
    return best;
  }

  /**
   * Explicitly attach a hypothesis (human/explicit action ONLY — the machine
   * pipeline never calls this; §14.1 hypothesis firewall).
   */
  setHypothesis(findingId, hypothesisText) {
    const existing = this.latest.get(findingId);
    if (!existing) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `finding ${findingId} not found`, { reason: "finding_not_found" }) };
    }
    const updated = this.#stripInternal({ ...existing, hypothesis: String(hypothesisText) });
    const schemaCheck = validateFinding(updated);
    if (!schemaCheck.ok) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "hypothesis update failed schema validation", { reason: "finding_schema", errors: schemaCheck.errors }) };
    }
    this.#appendSnapshot(updated);
    this.latest.set(findingId, { ...updated, environmental_signals_snapshot: existing.environmental_signals_snapshot, spec_ambiguity_snapshot: existing.spec_ambiguity_snapshot });
    return { ok: true, finding: updated };
  }

  list() {
    return [...this.latest.values()].map((f) => this.#stripInternal(f)).sort((a, b) => a.finding_id.localeCompare(b.finding_id));
  }

  findByFingerprint(parts) {
    const id = this.byFp.get(fingerprintKey(parts));
    return id === undefined ? null : this.#stripInternal(this.latest.get(id));
  }

  relationsFor(findingId) {
    return this.relations.filter((r) => r.finding_id === findingId || r.prior_finding_id === findingId);
  }
}
