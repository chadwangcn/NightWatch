/**
 * NightWatch WP-06 — Public API (C11 Evidence Pipeline & Immutable Run Store +
 * C12 Finding Service)
 *
 * Consumption surfaces:
 *   - C11: EvidenceStore / RunBundle (bundle ingest → redaction → seal),
 *     EvidenceStore.buildIndex() → index.json (the Evidence Index consumed by
 *     C13 Issue Gateway / WP-07: sealed flag, observation ids, bundle refs)
 *   - C12: FindingStore (fingerprint dedup + cross-run aggregation), the
 *     finding-index.json + relations.jsonl files, classifyFinding /
 *     assertClassificationLegal
 *
 * Usage:
 *   import { EvidenceStore, FindingStore, makeIdFactory } from "nightwatch/evidence/lib/index.mjs";
 */
export {
  RunBundle,
  EvidenceStore,
  assertSealedForConsumption,
  BUNDLE_TOP_FILES,
  BUNDLE_DIRS,
  TERMINAL_RUN_STATUSES,
  CLEANUP_STATUSES,
  CASE_RESULTS,
  PAYLOAD_DIGEST_VIRTUAL_PATH,
} from "./bundle.mjs";
export {
  FindingStore,
  buildFingerprint,
  normalizePath,
  fingerprintKey,
  fingerprintHash,
  classifyFinding,
  assertClassificationLegal,
  FINGERPRINT_FIELDS,
  DEFAULT_REPRODUCTION_GATE,
  ENVIRONMENTAL_ERROR_MARKERS,
} from "./finding.mjs";
export {
  DEFAULT_REDACTION_PROFILE,
  REDACTION_POLICY_VERSION,
  REDACTED,
  redactDeep,
  redactUrl,
  buildRedactionReport,
} from "./redaction.mjs";
export { scanSecrets, SECRET_SCAN_PATTERNS } from "./secret-scan.mjs";
export { DEFAULT_RETENTION_POLICY, evaluateRetention, retentionPolicyRecord } from "./retention.mjs";
export { makeAuditSink, LOCAL_FALLBACK_DIR } from "./audit.mjs";
export { makeIdFactory, deterministicUlidGenerator, isPrefixedUlid } from "./ids.mjs";
export { makeError, ERROR_CODES, isErrorEnvelope } from "./errors.mjs";
export { validate, validateRun, validateObservation, validateFinding, validateAuditEvent, validateErrorEnvelope } from "./schemas.mjs";
