/**
 * NightWatch WP-03 — Session checkpoint store (C14, §7.2 / WorkRequest §5.3)
 *
 * Semantics (frozen):
 *   - every persisted checkpoint conforms to WP-00 checkpoint/v1.json
 *     (goal + authorization boundary, confirmed apis/environments/scenarios/
 *     executors, completed steps WITH output_checksum, pending tasks +
 *     blocking reasons, credential variable NAMES ONLY, next allowed actions,
 *     key decisions, idempotency key, created_at);
 *   - writes are sequence-monotonic: a new checkpoint must have a sequence
 *     strictly greater than every existing one for the session; old checkpoints
 *     are NEVER overwritten (full history is preserved on disk);
 *   - recovery: `resume()` returns the latest valid checkpoint by default, or
 *     the checkpoint addressed by `from_checkpoint_sequence` (an earlier one);
 *   - integrity: each write records the file's sha256 in a per-session
 *     manifest; recovery re-validates JSON parse + WP-00 schema + manifest
 *     checksum + per-step output_checksum presence. A corrupt checkpoint is
 *     REJECTED (never returned) and recovery falls back to the previous valid
 *     checkpoint (AUD_CHECKPOINT_INVALID semantics when nothing valid remains).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { makeError, ERROR_CODES } from "./errors.mjs";
import { validate } from "./schema.mjs";

const sha256Of = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const seqFile = (sequence) => `seq-${sequence}.json`;
const parseSeqFile = (name) => {
  const m = /^seq-(\d+)\.json$/.exec(name);
  return m ? Number.parseInt(m[1], 10) : null;
};

export class CheckpointStore {
  /**
   * @param {string} storeDir runtime persistence root
   */
  constructor(storeDir) {
    if (typeof storeDir !== "string" || storeDir.length === 0) {
      throw new TypeError("storeDir is required");
    }
    this.dir = join(storeDir, "checkpoints");
    mkdirSync(this.dir, { recursive: true });
  }

  #sessionDir(sessionId) {
    return join(this.dir, sessionId);
  }

  #manifestPath(sessionId) {
    return join(this.#sessionDir(sessionId), "manifest.json");
  }

  #readManifest(sessionId) {
    const p = this.#manifestPath(sessionId);
    if (!existsSync(p)) return [];
    try {
      const m = JSON.parse(readFileSync(p, "utf8"));
      return Array.isArray(m.entries) ? m.entries : [];
    } catch {
      return [];
    }
  }

  #writeManifest(sessionId, entries) {
    const dir = this.#sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const manifest = { session_id: sessionId, entries: [...entries].sort((a, b) => a.sequence - b.sequence) };
    const target = this.#manifestPath(sessionId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(tmp, target);
  }

  /** Existing sequences on disk (ascending). */
  sequences(sessionId) {
    const dir = this.#sessionDir(sessionId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map(parseSeqFile)
      .filter((n) => n !== null)
      .sort((a, b) => a - b);
  }

  /**
   * Write a checkpoint (sequence-monotonic, history-preserving).
   * @param {object} checkpoint WP-00 checkpoint/v1.json instance
   * @returns {{ok: true, sequence: number, checkpoint: object} | {ok: false, error: object}}
   */
  write(checkpoint) {
    if (checkpoint === null || typeof checkpoint !== "object") {
      return { ok: false, error: makeError(ERROR_CODES.CHECKPOINT_INVALID, "checkpoint must be an object", { reason: "not_an_object" }) };
    }
    const schemaResult = validate("checkpoint", checkpoint);
    if (!schemaResult.ok) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.CHECKPOINT_INVALID, "checkpoint failed WP-00 schema validation", {
          errors: schemaResult.errors,
        }),
      };
    }
    if (!Number.isInteger(checkpoint.sequence) || checkpoint.sequence < 1) {
      return { ok: false, error: makeError(ERROR_CODES.CHECKPOINT_INVALID, "checkpoint sequence must be an integer >= 1") };
    }
    const existing = this.sequences(checkpoint.session_id);
    if (existing.includes(checkpoint.sequence)) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.CHECKPOINT_INVALID, `checkpoint sequence ${checkpoint.sequence} already exists for session ${checkpoint.session_id} (history is never overwritten)`, {
          session_id: checkpoint.session_id,
          sequence: checkpoint.sequence,
        }),
      };
    }
    const maxSeq = existing.length === 0 ? 0 : existing[existing.length - 1];
    if (checkpoint.sequence <= maxSeq) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.CHECKPOINT_INVALID, `checkpoint sequence ${checkpoint.sequence} is not monotonic (session ${checkpoint.session_id} already has sequence ${maxSeq})`, {
          session_id: checkpoint.session_id,
          sequence: checkpoint.sequence,
          max_existing_sequence: maxSeq,
        }),
      };
    }

    const dir = this.#sessionDir(checkpoint.session_id);
    mkdirSync(dir, { recursive: true });
    const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`;
    const target = join(dir, seqFile(checkpoint.sequence));
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, serialized, "utf8");
    renameSync(tmp, target);

    const entries = this.#readManifest(checkpoint.session_id).filter((e) => e.sequence !== checkpoint.sequence);
    entries.push({ sequence: checkpoint.sequence, sha256: sha256Of(serialized) });
    this.#writeManifest(checkpoint.session_id, entries);
    return { ok: true, sequence: checkpoint.sequence, checkpoint };
  }

  /**
   * Validate every checkpoint of a session on disk.
   * @returns {{valid: Array<{sequence:number, checkpoint:object}>, corrupt: Array<{sequence:number, reason:string, errors?:string[]}>}}
   */
  inspect(sessionId) {
    const manifestEntries = new Map(this.#readManifest(sessionId).map((e) => [e.sequence, e.sha256]));
    const valid = [];
    const corrupt = [];
    for (const seq of this.sequences(sessionId)) {
      const filePath = join(this.#sessionDir(sessionId), seqFile(seq));
      const expectedHash = manifestEntries.get(seq);
      if (expectedHash === undefined) {
        corrupt.push({ sequence: seq, reason: "integrity_record_missing" });
        continue;
      }
      let text;
      try {
        text = readFileSync(filePath, "utf8");
      } catch {
        corrupt.push({ sequence: seq, reason: "unreadable_file" });
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        corrupt.push({ sequence: seq, reason: "invalid_json" });
        continue;
      }
      const schemaResult = validate("checkpoint", parsed);
      if (!schemaResult.ok) {
        corrupt.push({ sequence: seq, reason: "schema_invalid", errors: schemaResult.errors });
        continue;
      }
      const stepsOk = (parsed.completed_steps || []).every(
        (s) => typeof s.output_checksum === "string" && /^(sha256:)?[0-9a-f]{64}$/.test(s.output_checksum)
      );
      if (!stepsOk) {
        corrupt.push({ sequence: seq, reason: "step_output_checksum_missing" });
        continue;
      }
      if (sha256Of(text) !== expectedHash) {
        corrupt.push({ sequence: seq, reason: "integrity_checksum_mismatch" });
        continue;
      }
      valid.push({ sequence: seq, checkpoint: parsed });
    }
    return { valid, corrupt };
  }

  /**
   * Resume from a checkpoint.
   * @param {object} params {session_id, from_checkpoint_sequence?}
   * @returns {{ok: true, sequence: number, checkpoint: object, diagnostics: object} | {ok: false, error: object, diagnostics: object}}
   */
  resume({ session_id, from_checkpoint_sequence }) {
    if (typeof session_id !== "string" || session_id.length === 0) {
      return { ok: false, error: makeError(ERROR_CODES.CHECKPOINT_INVALID, "session_id is required"), diagnostics: { valid: [], corrupt: [] } };
    }
    if (from_checkpoint_sequence !== undefined && (!Number.isInteger(from_checkpoint_sequence) || from_checkpoint_sequence < 1)) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.CHECKPOINT_INVALID, "from_checkpoint_sequence must be an integer >= 1"),
        diagnostics: { valid: [], corrupt: [] },
      };
    }
    const { valid, corrupt } = this.inspect(session_id);
    const diagnostics = {
      valid_sequences: valid.map((v) => v.sequence),
      corrupt_sequences: corrupt,
    };
    if (valid.length === 0) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.CHECKPOINT_INVALID, `session ${session_id} has no valid checkpoint to resume from`, {
          session_id,
          corrupt_sequences: corrupt.map((c) => c.sequence),
        }),
        diagnostics,
      };
    }
    const ceiling = from_checkpoint_sequence === undefined ? Number.MAX_SAFE_INTEGER : from_checkpoint_sequence;
    const eligible = valid.filter((v) => v.sequence <= ceiling);
    if (eligible.length === 0) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.CHECKPOINT_INVALID, `no valid checkpoint with sequence <= ${from_checkpoint_sequence} for session ${session_id}`, {
          session_id,
          requested_sequence: from_checkpoint_sequence,
          valid_sequences: valid.map((v) => v.sequence),
        }),
        diagnostics,
      };
    }
    const chosen = eligible[eligible.length - 1];
    return {
      ok: true,
      sequence: chosen.sequence,
      checkpoint: chosen.checkpoint,
      diagnostics: {
        ...diagnostics,
        requested_sequence: from_checkpoint_sequence === undefined ? null : from_checkpoint_sequence,
        recovered_from_sequence: chosen.sequence,
        fell_back: chosen.sequence !== from_checkpoint_sequence && from_checkpoint_sequence !== undefined ? true : undefined,
      },
    };
  }

  /** Remove the ENTIRE checkpoint history of a session (test/maintenance helper). */
  clearSession(sessionId) {
    const dir = this.#sessionDir(sessionId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
