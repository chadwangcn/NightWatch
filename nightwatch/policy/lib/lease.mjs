/**
 * NightWatch WP-04 — Credential Injection Lease (C08, §13.1 rule 4 + WorkRequest §5.4)
 *
 * grant(run_id, allowlist, decision) issues one SHORT-LIVED, RUN-SCOPED lease
 * PER credential reference in the allowlist — but ONLY when the accompanying
 * policy decision is approved AND unexpired. A lease object (frozen contract
 * injection_lease/v1) carries metadata ONLY: lease_id, reference NAME, run_id,
 * issued_at, expires_at. No value ever lives in a lease.
 *
 * materialize(lease_id) returns the env key/value pair for the subprocess
 * spawn EXACTLY ONCE (one-shot). The returned value:
 *   - is never persisted, never logged, never audited, never in a receipt;
 *   - is denied after the lease expires (CRED_LEASE_EXPIRED, never auto-extended);
 *   - is denied after revoke (POL_DENIED);
 *   - is denied on a second materialize attempt (one-shot semantics).
 *
 * revoke(lease_id) revokes; expired / revoked / consumed leases always deny.
 *
 * spawnEnv(materializedEnvs, allowlist) is a PURE function producing the child
 * process env: ONLY declared allowlist keys survive. It never touches
 * process.env — a child spawned with {env: spawnEnv(...)} inherits nothing
 * from the parent environment (§13.1 rule 4 / §13.1.1).
 *
 * Lease lifecycle events are audited through WP-03 with idempotency keys
 * `<lease_id>:granted|revoked|materialized|expired`.
 */
import { validate } from "./schemas.mjs";
import { makeError, ERROR_CODES } from "./errors.mjs";
import { newLeaseId } from "./ids.mjs";
import { C08_ACTOR, LEASE_ACTIONS } from "./audit.mjs";

const REFERENCE_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const RUN_ID_RE = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;
const LEASE_ID_RE = /^lease_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_TTL_SECONDS = 300;

const toIso = (ms) => new Date(ms).toISOString();
const denied = (code, message, details) => ({ ok: false, error: makeError(code, message, details) });

export class InjectionLeaseManager {
  /**
   * @param {object} options
   *   broker               — CredentialBroker
   *   audit                — PolicyAuditSink (WP-03 integration)
   *   clock?               — () => epoch ms (injectable; default Date.now)
   *   default_ttl_seconds? — lease lifetime (default 300s; never auto-extended)
   */
  constructor({ broker, audit, clock = () => Date.now(), default_ttl_seconds = DEFAULT_TTL_SECONDS }) {
    if (!broker) throw new TypeError("InjectionLeaseManager requires a credential broker");
    if (!audit) throw new TypeError("InjectionLeaseManager requires an audit sink");
    this._broker = broker;
    this._audit = audit;
    this._clock = clock;
    this._defaultTtlSeconds = default_ttl_seconds;
    this._leases = new Map(); // lease_id → {lease, status: active|consumed|revoked}
  }

  /**
   * Issue one lease per allowlisted credential reference (only after an
   * approved, unexpired policy decision).
   * @param {object} request
   *   run_id        — run scope (run_<ULID>)
   *   allowlist     — credential reference NAMES to inject
   *   decision      — policy_decision object (must be approved + unexpired)
   *   lease_ids?    — deterministic lease ids (testing); one per allowlist entry
   *   ttl_seconds?  — lease lifetime override
   */
  grant({ run_id, allowlist, decision, lease_ids, ttl_seconds }) {
    if (decision === null || typeof decision !== "object") {
      return denied(ERROR_CODES.POL_DENIED, "grant requires an approved policy decision");
    }
    if (decision.decision !== "approved") {
      return denied(ERROR_CODES.POL_DENIED, "grant requires an APPROVED policy decision (denied decisions never yield leases)");
    }
    const nowMs = this._clock();
    if (Date.parse(decision.expires_at) <= nowMs) {
      return denied(ERROR_CODES.POL_DENIED, "policy decision has expired; expired decisions are rejected, never auto-extended (§22.5.4)");
    }
    if (typeof run_id !== "string" || !RUN_ID_RE.test(run_id)) {
      return denied(ERROR_CODES.CTL_VALIDATION_FAILED, "run_id must match run_<ULID26>");
    }
    if (!Array.isArray(allowlist) || allowlist.length === 0) {
      return denied(ERROR_CODES.CTL_VALIDATION_FAILED, "allowlist must be a non-empty array of credential reference names");
    }
    const seen = new Set();
    for (const reference of allowlist) {
      if (typeof reference !== "string" || !REFERENCE_NAME_RE.test(reference)) {
        return denied(ERROR_CODES.CTL_VALIDATION_FAILED, `allowlist entry "${reference}" is not a valid credential reference name`);
      }
      if (seen.has(reference)) {
        return denied(ERROR_CODES.CTL_VALIDATION_FAILED, `allowlist contains duplicate reference "${reference}"`);
      }
      seen.add(reference);
    }
    if (lease_ids !== undefined) {
      if (!Array.isArray(lease_ids) || lease_ids.length !== allowlist.length) {
        return denied(ERROR_CODES.CTL_VALIDATION_FAILED, "lease_ids must be an array with one entry per allowlist entry");
      }
      for (const id of lease_ids) {
        if (typeof id !== "string" || !LEASE_ID_RE.test(id)) {
          return denied(ERROR_CODES.CTL_VALIDATION_FAILED, `lease id "${id}" must match lease_<ULID26>`);
        }
      }
    }
    for (const reference of allowlist) {
      if (!this._broker.has(reference)) {
        return denied(ERROR_CODES.CRED_MISSING, `credential reference "${reference}" is not configured in the provider (name only, never a value)`, {
          reference_name: reference,
        });
      }
    }

    const ttlSeconds = ttl_seconds ?? this._defaultTtlSeconds;
    const issuedAt = toIso(nowMs);
    const expiresAt = toIso(nowMs + ttlSeconds * 1000);
    const leases = [];
    for (let i = 0; i < allowlist.length; i += 1) {
      const reference = allowlist[i];
      const leaseId = lease_ids ? lease_ids[i] : newLeaseId(nowMs);
      const lease = {
        lease_id: leaseId,
        credential_reference_name: reference,
        run_id,
        scope: "worker-subprocess-env",
        issued_at: issuedAt,
        expires_at: expiresAt,
      };
      const sr = validate("injection_lease", lease);
      if (!sr.ok) {
        return denied(ERROR_CODES.CTL_VALIDATION_FAILED, "injection lease failed schema validation", { errors: sr.errors });
      }
      this._leases.set(leaseId, { lease, status: "active" });
      const audited = this._audit.append({
        actor: C08_ACTOR,
        action: LEASE_ACTIONS.granted,
        object_type: "injection_lease",
        object_id: leaseId,
        timestamp: issuedAt,
        idempotency_key: `${leaseId}:granted`,
      });
      if (!audited.ok) {
        return { ok: false, error: audited.error };
      }
      leases.push(lease);
    }
    return { ok: true, leases };
  }

  /**
   * One-shot env materialization for subprocess spawn. The returned value
   * MUST NOT be persisted, logged, audited or included in any receipt.
   */
  materialize(lease_id) {
    const entry = this._leases.get(lease_id);
    if (!entry) {
      return denied(ERROR_CODES.POL_DENIED, "unknown lease");
    }
    if (entry.status === "revoked") {
      return denied(ERROR_CODES.POL_DENIED, "lease has been revoked");
    }
    const nowMs = this._clock();
    if (Date.parse(entry.lease.expires_at) <= nowMs) {
      const audited = this._audit.append({
        actor: C08_ACTOR,
        action: LEASE_ACTIONS.expired,
        object_type: "injection_lease",
        object_id: lease_id,
        timestamp: toIso(nowMs),
        idempotency_key: `${lease_id}:expired`,
      });
      if (!audited.ok) {
        return { ok: false, error: audited.error };
      }
      return denied(ERROR_CODES.CRED_LEASE_EXPIRED, "injection lease has expired; expired leases are rejected, never auto-extended (§22.5.4)");
    }
    if (entry.status === "consumed") {
      return denied(ERROR_CODES.POL_DENIED, "lease already materialized (leases are one-shot)");
    }
    const reference = entry.lease.credential_reference_name;
    const value = this._broker._resolve(reference);
    if (value === undefined) {
      return denied(ERROR_CODES.CRED_MISSING, `credential reference "${reference}" is not configured in the provider`, {
        reference_name: reference,
      });
    }
    entry.status = "consumed";
    const audited = this._audit.append({
      actor: C08_ACTOR,
      action: LEASE_ACTIONS.materialized,
      object_type: "injection_lease",
      object_id: lease_id,
      timestamp: toIso(nowMs),
      idempotency_key: `${lease_id}:materialized`,
    });
    if (!audited.ok) {
      return { ok: false, error: audited.error };
    }
    return { ok: true, env: { [reference]: value } };
  }

  /** Revoke a lease; subsequent materialize attempts are denied. */
  revoke(lease_id) {
    const entry = this._leases.get(lease_id);
    if (!entry) {
      return denied(ERROR_CODES.POL_DENIED, "unknown lease");
    }
    const wasRevoked = entry.status === "revoked";
    entry.status = "revoked";
    const nowMs = this._clock();
    const audited = this._audit.append({
      actor: C08_ACTOR,
      action: LEASE_ACTIONS.revoked,
      object_type: "injection_lease",
      object_id: lease_id,
      timestamp: toIso(nowMs),
      idempotency_key: `${lease_id}:revoked`,
    });
    if (!audited.ok) {
      return { ok: false, error: audited.error };
    }
    return { ok: true, already_revoked: wasRevoked };
  }

  /** Lease metadata (metadata only — a lease never carries a value). */
  getLease(lease_id) {
    const entry = this._leases.get(lease_id);
    if (!entry) {
      return denied(ERROR_CODES.POL_DENIED, "unknown lease");
    }
    return { ok: true, lease: entry.lease, status: entry.status };
  }
}

/**
 * PURE allowlist filter for subprocess env construction (§13.1 rule 4).
 * Output contains ONLY declared allowlist keys that actually exist in the
 * materialized inputs. process.env is never read or merged here — a child
 * spawned with {env: spawnEnv(...)} inherits NOTHING from the parent.
 *
 * @param {object|object[]} materializedEnvs — materialize() output(s)
 * @param {string[]} allowlist — declared env keys the child may receive
 */
export function spawnEnv(materializedEnvs, allowlist) {
  const sources = Array.isArray(materializedEnvs) ? materializedEnvs : [materializedEnvs];
  const merged = {};
  for (const source of sources) {
    if (source === null || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      merged[key] = value;
    }
  }
  const out = {};
  for (const key of Array.isArray(allowlist) ? allowlist : []) {
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      out[key] = merged[key];
    }
  }
  return out;
}
