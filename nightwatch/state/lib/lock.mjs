/**
 * NightWatch WP-03 — Lock manager (C14, §7.3 / §22.5.4 / WorkRequest §5.2)
 *
 * Semantics (frozen):
 *   - every persisted lock record conforms to WP-00 lock/v1.json
 *     {lock_id, resource, owner, purpose?, acquired_at, expires_at};
 *   - expired locks are REJECTED, never auto-extended (§22.5.4):
 *       * renewing an expired lock → CTL_LOCK_EXPIRED, expires_at untouched;
 *       * acquiring with ttl <= 0 (a lock born expired) → CTL_LOCK_EXPIRED;
 *   - acquisition: no valid lock in scope → granted; a valid lock held by
 *     ANOTHER owner → FIX_RESOURCE_LOCKED conflict; a valid lock held by the
 *     SAME owner → idempotent re-acquire of the existing lock (no new record);
 *   - an expired record is swept (cleaned up) when encountered, after which the
 *     resource is freely acquirable again ("同 scope 无有效锁 → 获取成功");
 *   - release: only the holder may release; a non-holder release → CTL_UNAUTHORIZED;
 *     releasing an expired lock → CTL_LOCK_EXPIRED;
 *   - lock records persist on disk (.store/locks/<resource>.json), so a valid
 *     lock survives process restarts.
 *
 * The clock is injectable (`now` param: epoch ms or ISO string) for
 * deterministic testing; it defaults to the real wall clock.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { newLockId } from "./ids.mjs";
import { makeError, ERROR_CODES } from "./errors.mjs";
import { validate } from "./schema.mjs";

const toMs = (now) => {
  if (typeof now === "number") return now;
  if (typeof now === "string") return Date.parse(now);
  if (now instanceof Date) return now.getTime();
  return Date.now();
};

const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const resourceFile = (resource) =>
  `${resource.replace(/[^A-Za-z0-9._-]/g, "_")}-${createHash("sha256").update(resource, "utf8").digest("hex").slice(0, 12)}.json`;

export class LockManager {
  /**
   * @param {string} storeDir runtime persistence root
   */
  constructor(storeDir) {
    if (typeof storeDir !== "string" || storeDir.length === 0) {
      throw new TypeError("storeDir is required");
    }
    this.dir = join(storeDir, "locks");
    mkdirSync(this.dir, { recursive: true });
  }

  #path(resource) {
    return join(this.dir, resourceFile(resource));
  }

  /** Read the raw lock record for a resource (no expiry interpretation). */
  #readRaw(resource) {
    const p = this.#path(resource);
    if (!existsSync(p)) return null;
    try {
      return { lock: JSON.parse(readFileSync(p, "utf8")), path: p };
    } catch {
      return { lock: null, path: p, corrupt: true };
    }
  }

  #sweep(resource) {
    const p = this.#path(resource);
    if (existsSync(p)) rmSync(p);
  }

  /** Atomic write (tmp file + rename) — crash-safe persistence. */
  #write(resource, lock) {
    const schemaResult = validate("lock", lock);
    if (!schemaResult.ok) {
      return makeError(ERROR_CODES.VALIDATION_FAILED, "lock record failed schema validation", { errors: schemaResult.errors });
    }
    const target = this.#path(resource);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    renameSync(tmp, target);
    return null;
  }

  /**
   * Acquire a lock on a resource.
   * @param {object} params {resource, owner, purpose?, ttl_ms, now?}
   * @returns {{ok: true, lock: object, already_held: boolean} | {ok: false, error: object}}
   */
  acquire({ resource, owner, purpose, ttl_ms, now }) {
    if (typeof resource !== "string" || resource.length === 0 || typeof owner !== "string" || owner.length === 0) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "resource and owner must be non-empty strings") };
    }
    if (!Number.isInteger(ttl_ms)) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "ttl_ms must be an integer (milliseconds)") };
    }
    if (ttl_ms <= 0) {
      // A lock that would be born expired — rejected, and never auto-extended to validity.
      return { ok: false, error: makeError(ERROR_CODES.LOCK_EXPIRED, `lock request for resource "${resource}" is expired at or before acquisition (ttl_ms=${ttl_ms})`) };
    }
    const nowMs = toMs(now);
    const raw = this.#readRaw(resource);
    if (raw && raw.lock) {
      const expiresAtMs = Date.parse(raw.lock.expires_at);
      if (nowMs < expiresAtMs) {
        if (raw.lock.owner === owner) {
          return { ok: true, lock: raw.lock, already_held: true };
        }
        return {
          ok: false,
          error: makeError(ERROR_CODES.RESOURCE_LOCKED, `resource "${resource}" is held by another owner until ${raw.lock.expires_at}`, {
            resource,
            held_by: raw.lock.owner,
            lock_id: raw.lock.lock_id,
            expires_at: raw.lock.expires_at,
          }),
        };
      }
      this.#sweep(resource); // expired record → cleaned up, resource becomes acquirable
    }
    const lock = {
      lock_id: newLockId(nowMs),
      resource,
      owner,
      ...(purpose !== undefined ? { purpose } : {}),
      acquired_at: isoUtc(nowMs),
      expires_at: isoUtc(nowMs + ttl_ms),
    };
    const writeError = this.#write(resource, lock);
    if (writeError) return { ok: false, error: writeError };
    return { ok: true, lock, already_held: false };
  }

  /**
   * Renew (extend) a still-valid lock held by `owner`. Expired locks are rejected
   * and their expires_at is left untouched (never auto-extended).
   * @param {object} params {resource, owner, ttl_ms, now?}
   */
  renew({ resource, owner, ttl_ms, now }) {
    if (!Number.isInteger(ttl_ms) || ttl_ms <= 0) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "ttl_ms must be a positive integer (milliseconds)") };
    }
    const nowMs = toMs(now);
    const raw = this.#readRaw(resource);
    if (!raw || !raw.lock) {
      return { ok: false, error: makeError(ERROR_CODES.UNAUTHORIZED, `no lock record for resource "${resource}"`) };
    }
    const expiresAtMs = Date.parse(raw.lock.expires_at);
    if (nowMs >= expiresAtMs) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.LOCK_EXPIRED, `lock "${raw.lock.lock_id}" on resource "${resource}" expired at ${raw.lock.expires_at}; renewal rejected and never auto-extended`, {
          lock_id: raw.lock.lock_id,
          expires_at: raw.lock.expires_at,
        }),
      };
    }
    if (raw.lock.owner !== owner) {
      return { ok: false, error: makeError(ERROR_CODES.UNAUTHORIZED, `lock "${raw.lock.lock_id}" is held by ${raw.lock.owner}`) };
    }
    const updated = { ...raw.lock, expires_at: isoUtc(nowMs + ttl_ms) };
    const writeError = this.#write(resource, updated);
    if (writeError) return { ok: false, error: writeError };
    return { ok: true, lock: updated };
  }

  /**
   * Release a lock. Only the holder may release; expired locks are rejected.
   * @param {object} params {resource, owner, now?}
   */
  release({ resource, owner, now }) {
    if (typeof resource !== "string" || resource.length === 0 || typeof owner !== "string" || owner.length === 0) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "resource and owner must be non-empty strings") };
    }
    const nowMs = toMs(now);
    const raw = this.#readRaw(resource);
    if (!raw || !raw.lock) {
      return { ok: false, error: makeError(ERROR_CODES.UNAUTHORIZED, `no lock record for resource "${resource}"`) };
    }
    const expiresAtMs = Date.parse(raw.lock.expires_at);
    if (nowMs >= expiresAtMs) {
      this.#sweep(resource); // expired → cleaned up on encounter
      return {
        ok: false,
        error: makeError(ERROR_CODES.LOCK_EXPIRED, `lock "${raw.lock.lock_id}" on resource "${resource}" expired at ${raw.lock.expires_at}; release rejected`, {
          lock_id: raw.lock.lock_id,
          expires_at: raw.lock.expires_at,
        }),
      };
    }
    if (raw.lock.owner !== owner) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.UNAUTHORIZED, `lock "${raw.lock.lock_id}" on resource "${resource}" is held by ${raw.lock.owner}; release by non-holder rejected`, {
          lock_id: raw.lock.lock_id,
          held_by: raw.lock.owner,
        }),
      };
    }
    this.#sweep(resource);
    return { ok: true, lock_id: raw.lock.lock_id };
  }

  /**
   * Read the ACTIVE (valid, unexpired) lock for a resource, or null.
   * Expired records encountered here are swept.
   */
  getLock(resource, { now } = {}) {
    const nowMs = toMs(now);
    const raw = this.#readRaw(resource);
    if (!raw || !raw.lock) return null;
    if (nowMs >= Date.parse(raw.lock.expires_at)) {
      this.#sweep(resource);
      return null;
    }
    return raw.lock;
  }

  /**
   * Read the RAW lock record for a resource without any expiry interpretation
   * or sweeping (inspection/testing aid — proves expires_at is never mutated).
   */
  peek(resource) {
    const raw = this.#readRaw(resource);
    return raw && raw.lock ? raw.lock : null;
  }
}
