/**
 * NightWatch WP-03 — Audit JSONL append-only log (C14, §5.10 / §5.1 of the WorkRequest)
 *
 * Semantics:
 *   - append-only: existing bytes of events.jsonl are never modified or deleted;
 *     the only writes are byte appends at end-of-file;
 *   - every record is a standalone JSON line conforming to WP-00 audit_event/v1.json;
 *   - idempotent replay: same idempotency_key + identical submitted payload
 *     {actor, action, target, timestamp} → returns the previously recorded event
 *     with idempotent_replay=true and writes NO second record;
 *   - idempotency conflict: same idempotency_key + different payload →
 *     AUD_REPLAY_MISMATCH error envelope, nothing written;
 *   - crash safety: a torn (partial) last line — the classic interrupted-write
 *     footprint — is skipped and RECORDED in the replay report; complete lines are
 *     preserved. Before appending after a torn tail, a single "\n" boundary is
 *     appended so the new record becomes its own clean line (the torn fragment's
 *     bytes stay untouched on disk).
 *
 * The replay report (valid events + skipped lines) is persisted to
 * .store/audit/replay-report.json — content is a pure function of events.jsonl.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { newAuditId } from "./ids.mjs";
import { makeError, ERROR_CODES } from "./errors.mjs";
import { validate } from "./schema.mjs";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** Deep-sort object keys for a canonical JSON form (stable fingerprints). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint of the caller-submitted payload (audit_id is store-assigned). */
const payloadFingerprint = (event) =>
  sha256(canonicalJson({ actor: event.actor, action: event.action, target: event.target, timestamp: event.timestamp }));

export class AuditLog {
  /**
   * @param {string} storeDir runtime persistence root (e.g. nightwatch/state/.store)
   */
  constructor(storeDir) {
    if (typeof storeDir !== "string" || storeDir.length === 0) {
      throw new TypeError("storeDir is required");
    }
    this.dir = join(storeDir, "audit");
    this.eventsPath = join(this.dir, "events.jsonl");
    this.reportPath = join(this.dir, "replay-report.json");
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.eventsPath)) writeFileSync(this.eventsPath, "", { flag: "wx" });
  }

  /**
   * Replay the JSONL file. Skips torn/invalid lines, records them in the report.
   * @returns {{valid_events: number, total_lines: number, skipped_lines: Array<{line_no:number, reason:string, preview:string}>, index: Map<string, {event: object, line_no: number, fingerprint: string}>, keyToId: Map<string,string>}}
   */
  replay() {
    const text = readFileSync(this.eventsPath, "utf8");
    const lines = text.length === 0 ? [] : text.split("\n");
    // A trailing "" after the final "\n" is not a line; a non-empty last element
    // without trailing newline is a torn tail candidate handled below.
    const physical = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    const skipped = [];
    const entries = [];
    const keyToId = new Map();
    physical.forEach((line, i) => {
      if (line.trim().length === 0) {
        skipped.push({ line_no: i + 1, reason: "empty_line", preview: "" });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped.push({ line_no: i + 1, reason: "invalid_json", preview: line.slice(0, 80) });
        return;
      }
      const schemaResult = validate("audit_event", parsed);
      if (!schemaResult.ok) {
        skipped.push({ line_no: i + 1, reason: "schema_invalid", preview: line.slice(0, 80) });
        return;
      }
      if (keyToId.has(parsed.idempotency_key)) {
        skipped.push({ line_no: i + 1, reason: "duplicate_idempotency_key", preview: line.slice(0, 80) });
        return;
      }
      keyToId.set(parsed.idempotency_key, parsed.audit_id);
      entries.push({ event: parsed, line_no: i + 1, fingerprint: payloadFingerprint(parsed) });
    });
    const report = {
      valid_events: entries.length,
      total_lines: physical.length,
      skipped_lines: skipped,
    };
    writeFileSync(this.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return { ...report, entries, keyToId };
  }

  /**
   * Append an audit event (idempotent).
   * @param {object} event WP-00 audit_event fields (audit_id optional — assigned by the store)
   * @returns {{ok: true, idempotent_replay: boolean, audit_id: string, event: object} | {ok: false, error: object}}
   */
  append(event) {
    if (event === null || typeof event !== "object") {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "audit event must be an object", { reason: "not_an_object" }) };
    }
    const candidate = { ...event };
    if (candidate.audit_id === undefined) candidate.audit_id = newAuditId();
    const schemaResult = validate("audit_event", candidate);
    if (!schemaResult.ok) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.VALIDATION_FAILED, "audit event failed schema validation", {
          errors: schemaResult.errors,
        }),
      };
    }

    const { entries } = this.replay();
    const existingEntry = entries.find((e) => e.event.idempotency_key === candidate.idempotency_key);
    if (existingEntry) {
      if (existingEntry.fingerprint !== payloadFingerprint(candidate)) {
        return {
          ok: false,
          error: makeError(
            ERROR_CODES.AUDIT_REPLAY_MISMATCH,
            `audit replay mismatch for idempotency key "${candidate.idempotency_key}"`,
            { idempotency_key: candidate.idempotency_key, first_seen_audit_id: existingEntry.event.audit_id }
          ),
        };
      }
      return {
        ok: true,
        idempotent_replay: true,
        audit_id: existingEntry.event.audit_id,
        event: existingEntry.event,
      };
    }

    // Crash-safe append: if the file does not end with "\n" (torn tail), append a
    // newline boundary FIRST so the new record becomes its own clean line.
    const current = readFileSync(this.eventsPath, "utf8");
    if (current.length > 0 && !current.endsWith("\n")) {
      appendFileSync(this.eventsPath, "\n", "utf8");
    }
    const recorded = { ...candidate }; // audit_id was schema-required, hence caller- or store-provided
    appendFileSync(this.eventsPath, `${JSON.stringify(recorded)}\n`, "utf8");
    return { ok: true, idempotent_replay: false, audit_id: recorded.audit_id, event: recorded };
  }

  /**
   * Append with a store-assigned audit_id (convenience alias of `append`).
   */
  record(event) {
    return this.append(event);
  }

  /** All valid events (replayed), in file order. */
  list() {
    return this.replay().entries.map((e) => e.event);
  }

  /** Replay report (also persisted to .store/audit/replay-report.json). */
  report() {
    const r = this.replay();
    return { valid_events: r.valid_events, total_lines: r.total_lines, skipped_lines: r.skipped_lines };
  }
}
