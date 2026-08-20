/**
 * NightWatch WP-03 — Public API (C14 Audit, Checkpoint and Catalog Index)
 *
 * Shared state service for WP-04 (Policy), WP-05 (Executor), WP-06 (Evidence)
 * and WP-08 (Orchestrator): audit append, lock contention, checkpoint recovery
 * and catalog queries — all as pure local-file operations (no network, no HTTP,
 * no npm dependencies beyond the pinned repo-wide ajv).
 *
 * Usage:
 *   import { openState } from "nightwatch/state/index.mjs";
 *   const state = openState(); // default store: nightwatch/state/.store
 *   state.audit.record({ actor, action, target, timestamp, idempotency_key });
 *   state.locks.acquire({ resource, owner, ttl_ms });
 *   state.checkpoints.write(checkpoint);
 *   state.checkpoints.resume({ session_id });
 *   const { catalog } = buildCatalog();
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "./lib/audit.mjs";
import { LockManager } from "./lib/lock.mjs";
import { CheckpointStore } from "./lib/checkpoint.mjs";
import { buildCatalog, writeCatalog, loadCatalog, deleteCatalog, query } from "./lib/catalog.mjs";
import { makeError, ERROR_CODES, isRegisteredCode } from "./lib/errors.mjs";
import { ulid, ulidGenerator, newAuditId, newLockId, newSessionId, isPrefixedUlid } from "./lib/ids.mjs";
import { validate } from "./lib/schema.mjs";

const STATE_ROOT = join(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_STORE_DIR = join(STATE_ROOT, ".store");

/**
 * Open the shared state service.
 * @param {object} [options] {storeDir?} — defaults to nightwatch/state/.store
 */
export function openState(options = {}) {
  const storeDir = options.storeDir ?? DEFAULT_STORE_DIR;
  return {
    storeDir,
    audit: new AuditLog(storeDir),
    locks: new LockManager(storeDir),
    checkpoints: new CheckpointStore(storeDir),
  };
}

export {
  AuditLog,
  LockManager,
  CheckpointStore,
  buildCatalog,
  writeCatalog,
  loadCatalog,
  deleteCatalog,
  query,
  makeError,
  ERROR_CODES,
  isRegisteredCode,
  validate,
  ulid,
  ulidGenerator,
  newAuditId,
  newLockId,
  newSessionId,
  isPrefixedUlid,
};
