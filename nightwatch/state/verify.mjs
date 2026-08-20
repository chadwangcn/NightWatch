#!/usr/bin/env node
/**
 * NightWatch WP-03 — Acceptance Verifier (verify.mjs)
 *
 * Independently executable (no services, no HTTP, no network). Exercises every
 * acceptance condition of WorkRequest NW-WP-03 §8 against a clean runtime store
 * under nightwatch/state/.store/ (wiped at the start of each pass — the script
 * is safely re-runnable):
 *
 *   A1 audit_idempotent_replay         same idempotency key + same payload →
 *                                      idempotent_replay=true, no second record
 *   A2 audit_idempotency_conflict      same key + different payload →
 *                                      AUD_REPLAY_MISMATCH, nothing written
 *   A3 audit_crash_recovery            torn JSONL tail (simulated interrupted
 *                                      write) skipped AND recorded; complete
 *                                      lines preserved byte-for-byte
 *   A4 lock_expiry_and_conflict        born-expired acquire rejected; renewal of
 *                                      an expired lock rejected (never
 *                                      auto-extended); other-owner acquire →
 *                                      conflict; non-holder release rejected;
 *                                      valid locks survive reopen; expired locks
 *                                      swept and reacquirable
 *   A5 checkpoint_recovery             history preserved; latest resume; resume
 *                                      from a specified sequence; corrupt
 *                                      checkpoint rejected with fallback to the
 *                                      previous valid one (truncation AND
 *                                      integrity-tamper variants); non-monotonic
 *                                      and schema-invalid writes rejected
 *   A6 catalog_rebuild_deterministic   delete catalog → rebuild → byte-identical;
 *                                      object_type and id-prefix queries work
 *   A7 schema_validation_of_products   every persisted audit_event / lock /
 *                                      checkpoint validates against the FROZEN
 *                                      WP-00 schemas; every error envelope
 *                                      validates against error/v1.json and uses
 *                                      only registered codes
 *   A8 secret_scan                     0 credential-shaped hits across all
 *                                      runtime products; checkpoint credential
 *                                      fields carry reference NAMES only
 *   A9 determinism                     the full acceptance suite runs TWICE from
 *                                      a clean store in one process; the two
 *                                      `checks` objects are byte-identical
 *
 * Output: human-readable summary on stdout + machine receipt at
 * nightwatch/state/verify/receipt.json (structure aligned with WP-00:
 * ok / finished_at / verifier / task_fingerprint / checks / artifacts).
 * Exit code 0 iff receipt.ok === true.
 *
 * Usage: node nightwatch/state/verify.mjs   (from the repository root)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { AuditLog } from "./lib/audit.mjs";
import { LockManager } from "./lib/lock.mjs";
import { CheckpointStore } from "./lib/checkpoint.mjs";
import { buildCatalog, writeCatalog, deleteCatalog, query } from "./lib/catalog.mjs";
import { validate } from "./lib/schema.mjs";
import { isRegisteredCode } from "./lib/errors.mjs";
import { newSessionId } from "./lib/ids.mjs";

const STATE_ROOT = join(dirname(fileURLToPath(import.meta.url))); // .../nightwatch/state
const REPO_ROOT = join(STATE_ROOT, "..", "..");
const STORE_DIR = join(STATE_ROOT, ".store");
const RECEIPT_PATH = join(STATE_ROOT, "verify", "receipt.json");
const TASK_FINGERPRINT = "nw+p0+wp03+audit-checkpoint-catalog+impl+rev1+arch@v1.4+f2871c4";

/* Fixed synthetic clock (deterministic scenarios; the library clock is injectable). */
const T0 = Date.UTC(2026, 7, 20, 0, 0, 0); // 2026-08-20T00:00:00Z

/* WP-00 secret patterns (same shape as nightwatch/verify/verify.mjs). */
const SECRET_PATTERNS = [
  ["aws-access-key-id", /AKIA[0-9A-Z]{16}/],
  ["aws-temp-access-key", /ASIA[0-9A-Z]{16}/],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{36}/],
  ["openai-style-key", /sk-[A-Za-z0-9_-]{20,}/],
  ["slack-token", /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /eyJhbGciOi[A-Za-z0-9_-]{10,}\./],
];

const walkFiles = (dir, acc = []) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
};

const CREDENTIAL_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/* ------------------------------------------------------------------ */
/* One full acceptance pass (clean store → all scenarios → checks)     */
/* ------------------------------------------------------------------ */
function runPass() {
  const errorEnvelopes = [];
  const note = (envelope) => {
    errorEnvelopes.push(envelope);
    return envelope;
  };

  // Clean slate — the acceptance script supports clean re-runs.
  if (existsSync(STORE_DIR)) rmSync(STORE_DIR, { recursive: true, force: true });

  /* ---------------- A1: audit idempotent replay ------------------- */
  const audit = new AuditLog(STORE_DIR);
  const e1 = {
    actor: "C13-issue-gateway",
    action: "issue.publish",
    target: { object_type: "publish_receipt", object_id: "issue_synthetic-0001" },
    timestamp: "2026-08-20T05:00:00Z",
    idempotency_key: "wp03-verify-audit-key-001",
  };
  const r1 = audit.append(e1);
  const r1replay = audit.append({ ...e1 }); // identical payload, fresh store-assigned audit_id
  const a1Events = audit.list();
  const a1 = {
    ok:
      r1.ok === true &&
      r1.idempotent_replay === false &&
      r1replay.ok === true &&
      r1replay.idempotent_replay === true &&
      r1replay.audit_id === r1.audit_id &&
      a1Events.length === 1,
    first_append_ok: r1.ok === true,
    replay_flag: r1replay.ok === true && r1replay.idempotent_replay === true,
    replay_returns_recorded_event: r1replay.ok === true && r1replay.audit_id === r1.audit_id,
    no_second_record: a1Events.length === 1,
    valid_events: a1Events.length,
  };

  /* ---------------- A2: audit idempotency conflict ---------------- */
  const e2 = {
    actor: "C04-policy-gate",
    action: "policy.decide",
    target: { object_type: "run", object_id: "run_synthetic-0001" },
    timestamp: "2026-08-20T05:01:00Z",
    idempotency_key: "wp03-verify-audit-key-002",
  };
  const r2 = audit.append(e2);
  const r2conflict = audit.append({ ...e2, action: "policy.override" }); // same key, different payload
  if (!r2conflict.ok) note(r2conflict.error);
  const a2Events = audit.list();
  const a2 = {
    ok:
      r2.ok === true &&
      r2conflict.ok === false &&
      r2conflict.error.code === "AUD_REPLAY_MISMATCH" &&
      r2conflict.error.retryable === false &&
      r2conflict.error.idempotent_replay === false &&
      a2Events.length === 2,
    error_code: r2conflict.ok ? null : r2conflict.error.code,
    retryable: r2conflict.ok ? null : r2conflict.error.retryable,
    idempotent_replay_flag: r2conflict.ok ? null : r2conflict.error.idempotent_replay,
    no_new_record: a2Events.length === 2,
    valid_events: a2Events.length,
  };

  /* ---------------- A3: crash recovery (torn JSONL tail) ---------- */
  const e3 = {
    actor: "C02-control-api",
    action: "run.cancel",
    target: { object_type: "run", object_id: "run_synthetic-0002" },
    timestamp: "2026-08-20T05:02:00Z",
    idempotency_key: "wp03-verify-audit-key-003",
  };
  const r3 = audit.append(e3);
  const eventsPath = audit.eventsPath;
  const fullText = readFileSync(eventsPath, "utf8");
  const truncatedText = fullText.slice(0, fullText.length - 20); // simulate interrupted write
  writeFileSync(eventsPath, truncatedText, "utf8");
  const tornFragment = truncatedText.slice(-60); // bytes that must survive untouched

  const reopened = new AuditLog(STORE_DIR); // replay from a fresh instance (post-crash reopen)
  const crashReport = reopened.report();
  const preservedEvents = reopened.list();
  const completePreserved =
    preservedEvents.length === 2 &&
    preservedEvents.every((ev) => ["wp03-verify-audit-key-001", "wp03-verify-audit-key-002"].includes(ev.idempotency_key));

  const e4 = {
    actor: "C12-finding-service",
    action: "finding.classify",
    target: { object_type: "finding", object_id: "find_synthetic-0001" },
    timestamp: "2026-08-20T05:03:00Z",
    idempotency_key: "wp03-verify-audit-key-004",
  };
  const r4append = reopened.append(e4); // append AFTER a torn tail
  const afterRecovery = reopened.report();
  const finalText = readFileSync(eventsPath, "utf8");
  const a3 = {
    ok:
      r3.ok === true &&
      crashReport.valid_events === 2 &&
      crashReport.skipped_lines.length === 1 &&
      crashReport.skipped_lines[0].reason === "invalid_json" &&
      completePreserved &&
      r4append.ok === true &&
      r4append.idempotent_replay === false &&
      afterRecovery.valid_events === 3 &&
      afterRecovery.skipped_lines.length === 1 &&
      finalText.includes(tornFragment),
    torn_line_skipped: crashReport.skipped_lines.length === 1,
    skipped_reason: crashReport.skipped_lines.length === 1 ? crashReport.skipped_lines[0].reason : null,
    skipped_recorded_in_report: crashReport.skipped_lines.length === 1 && typeof crashReport.skipped_lines[0].preview === "string",
    complete_lines_preserved: completePreserved,
    valid_events_after_truncation: crashReport.valid_events,
    valid_events_after_recovery_append: afterRecovery.valid_events,
    torn_fragment_bytes_preserved: finalText.includes(tornFragment),
    append_after_torn_tail_ok: r4append.ok === true && r4append.idempotent_replay === false,
  };

  /* ---------------- A4: lock expiry / conflict / release ---------- */
  const locks = new LockManager(STORE_DIR);
  const ownerA = "session_wp03-owner-a";
  const ownerB = "session_wp03-owner-b";
  const R1 = "shared-account:wp03-verify-account-01";
  const R2 = "shared-account:wp03-verify-account-02";
  const R3 = "shared-account:wp03-verify-account-03";

  // Born-expired acquisition (ttl <= 0) → rejected, never auto-extended to validity.
  const bornExpired = locks.acquire({ resource: R1, owner: ownerA, ttl_ms: 0, now: T0 });
  if (!bornExpired.ok) note(bornExpired.error);

  const acqR1 = locks.acquire({ resource: R1, owner: ownerA, purpose: "wp03 verify concurrency", ttl_ms: 300000, now: T0 });

  // Persistence: a fresh manager instance (simulated restart) still respects the lock.
  const locksReopened = new LockManager(STORE_DIR);
  const r1AfterReopen = locksReopened.getLock(R1, { now: T0 + 1000 });

  // Other owner within validity → conflict.
  const conflictR1 = locks.acquire({ resource: R1, owner: ownerB, ttl_ms: 60000, now: T0 + 2000 });
  if (!conflictR1.ok) note(conflictR1.error);

  // Same owner re-acquire while valid → idempotent (existing lock returned).
  const reacquireR1 = locks.acquire({ resource: R1, owner: ownerA, ttl_ms: 60000, now: T0 + 3000 });

  // Expired lock: renewal rejected, expires_at NOT auto-extended.
  const acqR2 = locks.acquire({ resource: R2, owner: ownerA, ttl_ms: 60000, now: T0 });
  const renewExpired = locks.renew({ resource: R2, owner: ownerA, ttl_ms: 60000, now: T0 + 120000 });
  if (!renewExpired.ok) note(renewExpired.error);
  const r2RecordAfterRenew = new LockManager(STORE_DIR).peek(R2); // raw record — no sweeping
  const expiryUntouched =
    r2RecordAfterRenew !== null &&
    r2RecordAfterRenew.expires_at === "2026-08-20T00:01:00Z" &&
    r2RecordAfterRenew.lock_id === acqR2.lock.lock_id;

  // Expired lock swept; resource reacquirable by another owner.
  const reacquireR2 = locks.acquire({ resource: R2, owner: ownerB, ttl_ms: 60000, now: T0 + 120000 });

  // Non-holder release rejected; holder release succeeds; resource free afterwards.
  const acqR3 = locks.acquire({ resource: R3, owner: ownerA, ttl_ms: 60000, now: T0 });
  const releaseByNonHolder = locks.release({ resource: R3, owner: ownerB, now: T0 + 1000 });
  if (!releaseByNonHolder.ok) note(releaseByNonHolder.error);
  const stillHeld = locks.getLock(R3, { now: T0 + 2000 });
  const releaseByHolder = locks.release({ resource: R3, owner: ownerA, now: T0 + 3000 });
  const r3Free = locks.getLock(R3, { now: T0 + 4000 }) === null;
  const reacquireR3 = locks.acquire({ resource: R3, owner: ownerB, ttl_ms: 60000, now: T0 + 5000 });

  const a4 = {
    ok:
      bornExpired.ok === false &&
      bornExpired.error.code === "CTL_LOCK_EXPIRED" &&
      acqR1.ok === true &&
      r1AfterReopen !== null &&
      r1AfterReopen.lock_id === acqR1.lock.lock_id &&
      conflictR1.ok === false &&
      conflictR1.error.code === "FIX_RESOURCE_LOCKED" &&
      conflictR1.error.details.held_by === ownerA &&
      reacquireR1.ok === true &&
      reacquireR1.already_held === true &&
      reacquireR1.lock.lock_id === acqR1.lock.lock_id &&
      renewExpired.ok === false &&
      renewExpired.error.code === "CTL_LOCK_EXPIRED" &&
      expiryUntouched &&
      reacquireR2.ok === true &&
      reacquireR2.lock.owner === ownerB &&
      releaseByNonHolder.ok === false &&
      releaseByNonHolder.error.code === "CTL_UNAUTHORIZED" &&
      stillHeld !== null &&
      releaseByHolder.ok === true &&
      r3Free &&
      reacquireR3.ok === true,
    born_expired_acquire_rejected: bornExpired.ok === false && bornExpired.error.code === "CTL_LOCK_EXPIRED",
    conflict_error_code: conflictR1.ok ? null : conflictR1.error.code,
    nonholder_release_error_code: releaseByNonHolder.ok ? null : releaseByNonHolder.error.code,
    expired_renew_error_code: renewExpired.ok ? null : renewExpired.error.code,
    expiry_not_auto_extended: expiryUntouched,
    expired_lock_swept_and_reacquired: reacquireR2.ok === true && reacquireR2.lock.owner === ownerB,
    holder_release_ok: releaseByHolder.ok === true && r3Free,
    valid_lock_survives_reopen: r1AfterReopen !== null && r1AfterReopen.lock_id === acqR1.lock.lock_id,
    same_owner_reacquire_idempotent: reacquireR1.ok === true && reacquireR1.already_held === true,
  };

  /* ---------------- A5: checkpoint recovery ----------------------- */
  const cs = new CheckpointStore(STORE_DIR);
  const sessionId = newSessionId(); // synthetic session id (id_session: prefix + 26-char Crockford ULID)

  const mkCheckpoint = (sequence, steps) => ({
    session_id: sessionId,
    sequence,
    goal: "Verify order idempotency on synthetic staging (WP-03 acceptance)",
    authorization_boundary: "synthetic staging only; no production writes",
    confirmed: {
      apis: ["synthetic-order-api"],
      environments: ["synthetic-staging"],
      scenarios: ["scenarios/order/idempotency.yaml"],
      executors: ["newman"],
    },
    completed_steps: steps,
    pending_tasks: [{ task: "run regression suite", blocking_reason: "" }],
    credential_variables_used: ["SYNTHETIC_ORDER_API_TOKEN", "SYNTHETIC_STAGING_BASE_URL"],
    next_allowed_actions: ["startRun", "cancelRun"],
    key_decisions: [{ decision: "Use newman as executor", rationale: "P0 executor for Postman-compatible collections" }],
    idempotency_key: `wp03-verify-checkpoint-key-${String(sequence).padStart(3, "0")}`,
    created_at: `2026-08-20T06:0${sequence - 1}:00Z`,
  });
  const step = (n) => ({
    step: `step-${n}`,
    output_checksum: String(n).repeat(64), // 64 lowercase hex chars — checksum pattern
  });

  const cp1 = mkCheckpoint(1, [step(1)]);
  const cp2 = mkCheckpoint(2, [step(1), step(2)]);
  const cp3 = mkCheckpoint(3, [step(1), step(2), step(3)]);
  const w1 = cs.write(cp1);
  const w2 = cs.write(cp2);
  const w3 = cs.write(cp3);
  const history = cs.sequences(sessionId);

  const latest = cs.resume({ session_id: sessionId });
  const specified = cs.resume({ session_id: sessionId, from_checkpoint_sequence: 2 });

  // Corruption variant 1: truncated JSON (interrupted write).
  const seq3Path = join(STORE_DIR, "checkpoints", sessionId, "seq-3.json");
  const seq3Original = readFileSync(seq3Path, "utf8");
  writeFileSync(seq3Path, seq3Original.slice(0, seq3Original.length - 15), "utf8");
  const truncatedResume = cs.resume({ session_id: sessionId });
  const truncatedCorrupt = truncatedResume.diagnostics.corrupt_sequences.find((c) => c.sequence === 3);

  // Restore, then corruption variant 2: schema-valid content tamper (integrity mismatch).
  writeFileSync(seq3Path, seq3Original, "utf8");
  const restoredResume = cs.resume({ session_id: sessionId });
  const tampered = JSON.parse(seq3Original);
  tampered.goal = "TAMPERED goal — integrity checksum must catch this";
  writeFileSync(seq3Path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  const tamperedResume = cs.resume({ session_id: sessionId });
  const tamperedCorrupt = tamperedResume.diagnostics.corrupt_sequences.find((c) => c.sequence === 3);

  // Non-monotonic / duplicate writes rejected.
  const duplicateWrite = cs.write(mkCheckpoint(2, [step(1), step(2)]));
  if (!duplicateWrite.ok) note(duplicateWrite.error);
  const schemaInvalidWrite = cs.write({ ...mkCheckpoint(4, [step(4)]), credential_variables_used: ["order_api_token"] });
  if (!schemaInvalidWrite.ok) note(schemaInvalidWrite.error);
  const seq4Exists = cs.sequences(sessionId).includes(4);

  const a5 = {
    ok:
      w1.ok === true &&
      w2.ok === true &&
      w3.ok === true &&
      history.length === 3 &&
      history.join(",") === "1,2,3" &&
      latest.ok === true &&
      latest.sequence === 3 &&
      latest.checkpoint.sequence === 3 &&
      specified.ok === true &&
      specified.sequence === 2 &&
      truncatedResume.ok === true &&
      truncatedResume.sequence === 2 &&
      truncatedCorrupt !== undefined &&
      truncatedCorrupt.reason === "invalid_json" &&
      restoredResume.ok === true &&
      restoredResume.sequence === 3 &&
      tamperedResume.ok === true &&
      tamperedResume.sequence === 2 &&
      tamperedCorrupt !== undefined &&
      tamperedCorrupt.reason === "integrity_checksum_mismatch" &&
      duplicateWrite.ok === false &&
      duplicateWrite.error.code === "AUD_CHECKPOINT_INVALID" &&
      schemaInvalidWrite.ok === false &&
      schemaInvalidWrite.error.code === "AUD_CHECKPOINT_INVALID" &&
      !seq4Exists,
    history_preserved_count: history.length,
    latest_resume_sequence: latest.sequence,
    specified_resume_sequence: specified.sequence,
    corrupt_truncated_fallback_sequence: truncatedResume.sequence,
    corrupt_reason_truncated: truncatedCorrupt ? truncatedCorrupt.reason : null,
    tampered_integrity_fallback_sequence: tamperedResume.sequence,
    corrupt_reason_tampered: tamperedCorrupt ? tamperedCorrupt.reason : null,
    non_monotonic_write_rejected: duplicateWrite.ok === false && duplicateWrite.error.code === "AUD_CHECKPOINT_INVALID",
    schema_invalid_write_rejected: schemaInvalidWrite.ok === false && schemaInvalidWrite.error.code === "AUD_CHECKPOINT_INVALID" && !seq4Exists,
  };

  /* ---------------- A6: catalog rebuild determinism --------------- */
  const build1 = writeCatalog({ storeDir: STORE_DIR });
  const deleted = deleteCatalog({ storeDir: STORE_DIR });
  const build2 = writeCatalog({ storeDir: STORE_DIR });
  const catalogFileText = readFileSync(build2.path, "utf8");

  const schemaEntries = query(build2.catalog, { object_type: "schema" });
  const fixtureEntries = query(build2.catalog, { object_type: "fixture" });
  const registryEntries = query(build2.catalog, { object_type: "registry_file" });
  const auditEntries = query(build2.catalog, { object_type: "audit_event", id_prefix: "audit_" });
  const lockEntries = query(build2.catalog, { object_type: "lock", id_prefix: "lock_" });
  const checkpointEntries = query(build2.catalog, { object_type: "checkpoint", id_prefix: "session_" });
  const schemaEntryForAuditEvent = schemaEntries.find((e) => e.object_id === "audit_event");

  const a6 = {
    ok:
      deleted === true &&
      build1.bytes === build2.bytes &&
      catalogFileText === build1.bytes &&
      build2.catalog.counts.total === build2.catalog.entries.length &&
      schemaEntries.length >= 36 &&
      schemaEntryForAuditEvent !== undefined &&
      fixtureEntries.length >= 30 &&
      registryEntries.length >= 1 &&
      auditEntries.length === 3 &&
      lockEntries.length === 3 &&
      checkpointEntries.length === 3,
    byte_identical_rebuild: build1.bytes === build2.bytes && catalogFileText === build1.bytes,
    catalog_self_consistent: build2.catalog.counts.total === build2.catalog.entries.length,
    schema_entries: schemaEntries.length,
    fixture_entries: fixtureEntries.length,
    registry_entries_present: registryEntries.length >= 1,
    audit_event_entries: auditEntries.length,
    lock_entries: lockEntries.length,
    checkpoint_entries: checkpointEntries.length,
    query_by_object_type_works: lockEntries.length === 3 && schemaEntryForAuditEvent !== undefined,
    query_by_id_prefix_works: auditEntries.length === 3 && checkpointEntries.length === 3,
  };

  /* ---------------- A7: WP-00 schema validation of products ------- */
  const validAuditEvents = reopened.list();
  const auditValid = validAuditEvents.filter((ev) => validate("audit_event", ev).ok);

  const lockFiles = walkFiles(join(STORE_DIR, "locks"));
  const lockRecords = lockFiles.map((p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  });
  const lockValid = lockRecords.filter((l) => l !== null && validate("lock", l).ok);

  const checkpointFiles = walkFiles(join(STORE_DIR, "checkpoints")).filter((p) => /seq-\d+\.json$/.test(p));
  const checkpointParsed = checkpointFiles.map((p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  });
  const checkpointValid = checkpointParsed.filter((c) => c !== null && validate("checkpoint", c).ok);

  const envelopesValid = errorEnvelopes.filter((e) => validate("error", e).ok && isRegisteredCode(e.code));

  const a7 = {
    ok:
      auditValid.length === validAuditEvents.length &&
      validAuditEvents.length === 3 &&
      lockValid.length === lockRecords.length &&
      lockRecords.length === 3 &&
      checkpointValid.length === checkpointParsed.length &&
      checkpointParsed.length === 3 &&
      envelopesValid.length === errorEnvelopes.length &&
      errorEnvelopes.length >= 6,
    audit_events: { total: validAuditEvents.length, valid: auditValid.length },
    lock_records: { total: lockRecords.length, valid: lockValid.length },
    checkpoint_files: { total: checkpointParsed.length, valid: checkpointValid.length },
    error_envelopes: { total: errorEnvelopes.length, valid: envelopesValid.length },
    all_error_codes_registered: errorEnvelopes.every((e) => isRegisteredCode(e.code)),
  };

  /* ---------------- A8: secret scan over runtime products --------- */
  const storeFiles = walkFiles(STORE_DIR);
  const secretHits = [];
  for (const p of storeFiles) {
    const text = readFileSync(p, "utf8");
    for (const [label, re] of SECRET_PATTERNS) {
      if (re.test(text)) secretHits.push({ file: relative(REPO_ROOT, p), pattern: label });
    }
  }
  const allCheckpoints = checkpointParsed.filter((c) => c !== null);
  const credentialNamesOnly = allCheckpoints.every((c) =>
    (c.credential_variables_used || []).every((n) => typeof n === "string" && CREDENTIAL_NAME_RE.test(n))
  );

  const a8 = {
    ok: secretHits.length === 0 && credentialNamesOnly && schemaInvalidWrite.ok === false,
    hits: secretHits.length,
    findings: secretHits,
    scanned_files: storeFiles.length,
    patterns_checked: SECRET_PATTERNS.length,
    credential_names_only: credentialNamesOnly,
    credential_name_pattern_enforced: schemaInvalidWrite.ok === false,
  };

  /* ---------------- A10: parallel race regression (rev1) --------- */
  // Reproduces the Coordinator's rejection scenario inside a fully sandboxed
  // nightwatch tree under the component's own store (write boundary
  // nightwatch/state/** respected — the REAL registry/.state/ is never
  // touched): while buildCatalog runs, a simulated parallel lane (WP-01
  // verifier shape) churns registry/.state/ files, and enumerated files are
  // deleted between enumeration and read. The build must survive, record the
  // ENOENT skips, and keep every `.state/` path out of the catalog product.
  const sandboxNw = join(STORE_DIR, "a10-race-sandbox", "nw");
  const sandboxStore = join(sandboxNw, "state", ".store");
  const sandboxRegState = join(sandboxNw, "registry", ".state");
  mkdirSync(join(sandboxRegState, "run-a", "entries"), { recursive: true });
  mkdirSync(join(sandboxRegState, "run-b", "locks"), { recursive: true });
  writeFileSync(join(sandboxRegState, "run-a", "entries", "lumi-device-platform.json"), '{"entry":"wp01-runtime-fact"}\n', "utf8");
  writeFileSync(join(sandboxRegState, "run-b", "locks", "lock-race.json"), '{"lock":"wp01-runtime-lock"}\n', "utf8");
  writeFileSync(join(sandboxNw, "registry", "stable-entry.json"), '{"api":"stable-registry-fact"}\n', "utf8");
  const raceVictimRegistry = join(sandboxNw, "registry", "ephemeral-race.json");
  writeFileSync(raceVictimRegistry, '{"api":"ephemeral-registry-fact"}\n', "utf8");
  mkdirSync(join(sandboxStore, "locks"), { recursive: true });
  writeFileSync(join(sandboxStore, "locks", "lock_wp03-race-kept.json"), '{"lock_id":"lock_wp03-race-kept","scope":"shared-account:wp03-race"}\n', "utf8");
  const raceVictimStore = join(sandboxStore, "locks", "lock_wp03-race-victim.json");
  writeFileSync(raceVictimStore, '{"lock_id":"lock_wp03-race-victim","scope":"shared-account:wp03-race"}\n', "utf8");

  let hookCalls = 0;
  let churnCreated = 0;
  let churnRemoved = 0;
  let churnPath = null;
  const injected = { registry: false, store: false };
  let racedBuild = null;
  let raceCrash = null;
  try {
    racedBuild = buildCatalog({
      nightwatchRoot: sandboxNw,
      storeDir: sandboxStore,
      onEnumeratedFile: (abs) => {
        hookCalls += 1;
        // Simulated WP-01 verifier churning registry/.state/ mid-build:
        // create a runtime file, remove the previous one.
        const next = join(sandboxRegState, `churn-${hookCalls}.json`);
        writeFileSync(next, `{"churn":${hookCalls}}\n`, "utf8");
        churnCreated += 1;
        if (churnPath !== null) {
          try {
            rmSync(churnPath);
            churnRemoved += 1;
          } catch {
            /* already gone — a real parallel lane may have removed it first */
          }
        }
        churnPath = next;
        // Rejection-defect injection: enumerated file deleted before its read.
        if (abs === raceVictimRegistry) {
          rmSync(abs);
          injected.registry = true;
        }
        if (abs === raceVictimStore) {
          rmSync(abs);
          injected.store = true;
        }
      },
    });
  } catch (err) {
    raceCrash = err;
  }

  let rebuildAfterChurn = null;
  let rebuildCrash = null;
  try {
    rebuildAfterChurn = buildCatalog({ nightwatchRoot: sandboxNw, storeDir: sandboxStore });
  } catch (err) {
    rebuildCrash = err;
  }

  const racedEntries = racedBuild ? racedBuild.catalog.entries : [];
  const dotStateEntries = racedEntries.filter((e) => typeof e.file === "string" && e.file.includes(".state/"));
  const victimEntries = racedEntries.filter((e) => typeof e.file === "string" && (e.file.endsWith("ephemeral-race.json") || e.file.endsWith("lock_wp03-race-victim.json")));
  const stableEntryIndexed = racedEntries.some((e) => e.file === "registry/stable-entry.json");
  const keptLockIndexed = racedEntries.some((e) => e.object_type === "lock" && e.object_id === "lock_wp03-race-kept");
  const enoentRecorded =
    racedBuild !== null &&
    racedBuild.skipped.length === 2 &&
    racedBuild.skipped.every((s) => s.reason === "vanished_before_read" && typeof s.file === "string");

  const a10 = {
    ok:
      raceCrash === null &&
      racedBuild !== null &&
      injected.registry === true &&
      injected.store === true &&
      enoentRecorded &&
      dotStateEntries.length === 0 &&
      victimEntries.length === 0 &&
      stableEntryIndexed &&
      keptLockIndexed &&
      rebuildCrash === null &&
      rebuildAfterChurn !== null &&
      rebuildAfterChurn.skipped.length === 0 &&
      rebuildAfterChurn.bytes === racedBuild.bytes,
    build_survived_parallel_churn: raceCrash === null,
    race_injections_fired: { registry_victim: injected.registry, store_victim: injected.store },
    enoent_tolerated_and_recorded: enoentRecorded,
    skipped_files: racedBuild ? racedBuild.skipped : [{ file: null, reason: `crashed:${raceCrash && raceCrash.code ? raceCrash.code : "unknown"}` }],
    dot_state_entries: dotStateEntries.length,
    victim_entries_excluded: victimEntries.length === 0,
    stable_entry_indexed: stableEntryIndexed,
    kept_lock_indexed: keptLockIndexed,
    state_churn: { hook_calls: hookCalls, files_created: churnCreated, files_removed: churnRemoved },
    rebuild_after_churn_stable:
      rebuildCrash === null && rebuildAfterChurn !== null && rebuildAfterChurn.skipped.length === 0 && rebuildAfterChurn.bytes === racedBuild.bytes,
  };

  return {
    audit_idempotent_replay: a1,
    audit_idempotency_conflict: a2,
    audit_crash_recovery: a3,
    lock_expiry_and_conflict: a4,
    checkpoint_recovery: a5,
    catalog_rebuild_deterministic: a6,
    schema_validation_of_products: a7,
    secret_scan: a8,
    parallel_race_regression: a10,
  };
}

/* ------------------------------------------------------------------ */
/* A9: determinism — two full passes, byte-identical checks            */
/* ------------------------------------------------------------------ */
function main() {
  const pass1 = runPass();
  const pass2 = runPass();
  const identical = JSON.stringify(pass1) === JSON.stringify(pass2);
  const determinism = {
    ok: identical,
    strategy: "two full acceptance passes from a clean store in one process",
    passes_compared: 2,
    checks_byte_identical: identical,
  };
  const checks = { ...pass2, determinism };

  const allOk = Object.values(checks).every((c) => c && c.ok === true);
  const receipt = {
    ok: allOk,
    finished_at: new Date().toISOString(),
    verifier: "nightwatch/state/verify.mjs",
    task_fingerprint: TASK_FINGERPRINT,
    checks,
    artifacts: [
      "nightwatch/state/index.mjs",
      "nightwatch/state/lib/ids.mjs",
      "nightwatch/state/lib/errors.mjs",
      "nightwatch/state/lib/schema.mjs",
      "nightwatch/state/lib/audit.mjs",
      "nightwatch/state/lib/lock.mjs",
      "nightwatch/state/lib/checkpoint.mjs",
      "nightwatch/state/lib/catalog.mjs",
      "nightwatch/state/verify.mjs",
      "nightwatch/state/verify/receipt.json",
    ],
  };

  mkdirSync(dirname(RECEIPT_PATH), { recursive: true });
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  const line = (s) => process.stdout.write(`${s}\n`);
  line("=== NightWatch WP-03 Audit / Checkpoint / Catalog Verification ===");
  line(`A1 audit_idempotent_replay        : ${checks.audit_idempotent_replay.ok ? "ok" : "FAILED"} (replay=${checks.audit_idempotent_replay.replay_flag}, records=${checks.audit_idempotent_replay.valid_events})`);
  line(`A2 audit_idempotency_conflict     : ${checks.audit_idempotency_conflict.ok ? "ok" : "FAILED"} (code=${checks.audit_idempotency_conflict.error_code})`);
  line(
    `A3 audit_crash_recovery           : ${checks.audit_crash_recovery.ok ? "ok" : "FAILED"} (skipped=${checks.audit_crash_recovery.torn_line_skipped}, valid=${checks.audit_crash_recovery.valid_events_after_recovery_append})`
  );
  line(
    `A4 lock_expiry_and_conflict       : ${checks.lock_expiry_and_conflict.ok ? "ok" : "FAILED"} (expired=${checks.lock_expiry_and_conflict.expired_renew_error_code}, conflict=${checks.lock_expiry_and_conflict.conflict_error_code}, non-holder=${checks.lock_expiry_and_conflict.nonholder_release_error_code})`
  );
  line(
    `A5 checkpoint_recovery            : ${checks.checkpoint_recovery.ok ? "ok" : "FAILED"} (latest=${checks.checkpoint_recovery.latest_resume_sequence}, specified=${checks.checkpoint_recovery.specified_resume_sequence}, fallback=${checks.checkpoint_recovery.corrupt_truncated_fallback_sequence})`
  );
  line(
    `A6 catalog_rebuild_deterministic  : ${checks.catalog_rebuild_deterministic.ok ? "ok" : "FAILED"} (byte-identical=${checks.catalog_rebuild_deterministic.byte_identical_rebuild}, schemas=${checks.catalog_rebuild_deterministic.schema_entries}, fixtures=${checks.catalog_rebuild_deterministic.fixture_entries})`
  );
  line(
    `A7 schema_validation_of_products  : ${checks.schema_validation_of_products.ok ? "ok" : "FAILED"} (audit=${checks.schema_validation_of_products.audit_events.valid}/${checks.schema_validation_of_products.audit_events.total}, lock=${checks.schema_validation_of_products.lock_records.valid}/${checks.schema_validation_of_products.lock_records.total}, checkpoint=${checks.schema_validation_of_products.checkpoint_files.valid}/${checks.schema_validation_of_products.checkpoint_files.total}, errors=${checks.schema_validation_of_products.error_envelopes.valid}/${checks.schema_validation_of_products.error_envelopes.total})`
  );
  line(`A8 secret_scan                    : ${checks.secret_scan.ok ? "ok" : "FAILED"} (${checks.secret_scan.hits} hits across ${checks.secret_scan.scanned_files} files)`);
  line(`A9 determinism                    : ${checks.determinism.ok ? "ok" : "FAILED"} (${checks.determinism.strategy})`);
  line(
    `A10 parallel_race_regression      : ${checks.parallel_race_regression.ok ? "ok" : "FAILED"} (survived=${checks.parallel_race_regression.build_survived_parallel_churn}, enoent_recorded=${checks.parallel_race_regression.enoent_tolerated_and_recorded}, dot_state_entries=${checks.parallel_race_regression.dot_state_entries}, churn=${checks.parallel_race_regression.state_churn.files_created} created/${checks.parallel_race_regression.state_churn.files_removed} removed)`
  );
  line("");
  for (const [name, c] of Object.entries(checks)) {
    if (c && c.ok !== true) line(`FAILED detail — ${name}: ${JSON.stringify(c, null, 2)}`);
  }
  line(`receipt: ${relative(REPO_ROOT, RECEIPT_PATH)}`);
  line(allOk ? "RESULT: OK (exit 0)" : "RESULT: FAILED (exit 1)");
  process.exit(allOk ? 0 : 1);
}

main();
