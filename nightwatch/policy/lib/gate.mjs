/**
 * NightWatch WP-04 — Policy and Approval Gate (C04, §12.3 + WorkRequest §5.2)
 *
 * decide(request) evaluates one requested action against:
 *   1. production identification (explicit classification OR resolved base URL
 *      hitting a production_url_pattern — §12.3 "re-check on production URL");
 *   2. the production denial matrix: production × {destructive, fuzzing, load,
 *      concurrent writes, batch delete} → DENIED, always (no approval can lift
 *      it); production × read-only smoke → APPROVED only when the environment
 *      definition explicitly allows it; production × non-destructive write →
 *      APPROVED only with an unexpired human approval record;
 *   3. the budget gate: plan requests/duration/parallelism vs environment
 *      limits (all environments) → POL_BUDGET_EXCEEDED;
 *   4. environment capability allowance (non-production): destructive/fuzzing/
 *      load must be granted by the environment definition capabilities.
 *
 * Properties:
 *   - Every decision is a frozen-contract policy_decision/v1 object with a
 *     MANDATORY expiry; expired decisions are rejected downstream and never
 *     auto-extended (§22.5.4).
 *   - Idempotent by decision_id: same key + same payload → the very same
 *     result object (replayed=true); same key + different payload →
 *     CTL_IDEMPOTENCY_CONFLICT; nothing is re-decided or re-audited on replay.
 *   - Every NEW decision is audited through WP-03 (idempotency key =
 *     decision_id). Audit payloads carry reference names/IDs only.
 *   - The engine can only ever NARROW: relaxations require a new environment
 *     definition file (input), never API parameters (§12.3).
 */
import { validate } from "./schemas.mjs";
import { makeError, ERROR_CODES } from "./errors.mjs";
import { validateEnvironmentDefinition, isProductionEnvironment } from "./environment.mjs";
import { C04_ACTOR, POLICY_DECISION_ACTION } from "./audit.mjs";

export const ACTION_CAPABILITY_KEYS = [
  "destructive",
  "fuzzing",
  "load",
  "write",
  "concurrent_writes",
  "batch_delete",
];

/** §12.3 production ban list — no approval can lift these. */
export const PRODUCTION_FORBIDDEN_CAPABILITIES = [
  "destructive",
  "fuzzing",
  "load",
  "concurrent_writes",
  "batch_delete",
];

const DEFAULT_DECISION_TTL_SECONDS = 300;
const RUN_ID_RE = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;

const toIso = (ms) => new Date(ms).toISOString();

/** Deep-sorted canonical JSON (stable fingerprints for idempotency). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const invalid = (message, details) => ({ ok: false, error: makeError(ERROR_CODES.CTL_VALIDATION_FAILED, message, details) });

/**
 * Build a frozen-contract approval_record (schema-validated).
 * Note: approval_record/v1 persists the DECIDED state (approved|denied);
 * the pending state is an approval-flow-internal notion and is not
 * representable in the frozen schema (see DeliveryNotice §已知限制).
 */
export function makeApprovalRecord({ approver, decision, scope, approved_at, expires_at, reason, evidence_refs, policy_decision_ref }) {
  const record = { approver, decision, scope, approved_at, expires_at };
  if (reason !== undefined) record.reason = reason;
  if (evidence_refs !== undefined) record.evidence_refs = evidence_refs;
  if (policy_decision_ref !== undefined) record.policy_decision_ref = policy_decision_ref;
  const sr = validate("approval_record", record);
  if (!sr.ok) {
    return { ok: false, error: makeError(ERROR_CODES.CTL_VALIDATION_FAILED, "approval record failed schema validation", { errors: sr.errors }) };
  }
  return { ok: true, approval: record };
}

/**
 * Find the effective approval for a scope.
 * @returns {{status: "valid"|"expired"|"denied"|"none", approval?: object}
 *   valid   — an approved, unexpired record matching the scope
 *   expired — an approved record matching the scope but past expires_at
 *   denied  — a denied record matching the scope
 *   none    — no record matches the scope
 */
export function findValidApproval(approvals, { scope, nowMs }) {
  const matching = (approvals || []).filter((a) => a && typeof a === "object" && a.scope === scope);
  if (matching.length === 0) return { status: "none" };
  for (const a of matching) {
    if (a.decision === "approved" && Date.parse(a.expires_at) > nowMs) return { status: "valid", approval: a };
  }
  for (const a of matching) {
    if (a.decision === "approved" && Date.parse(a.expires_at) <= nowMs) return { status: "expired", approval: a };
  }
  return { status: "denied", approval: matching[0] };
}

const normalizeCapabilities = (capabilities) => {
  const caps = {};
  for (const key of ACTION_CAPABILITY_KEYS) caps[key] = Boolean(capabilities && capabilities[key]);
  return caps;
};

export class PolicyGate {
  /**
   * @param {object} options
   *   audit                   — PolicyAuditSink (WP-03 integration)
   *   clock?                  — () => epoch ms (injectable; default Date.now)
   *   decided_by?             — actor id recorded on decisions
   *   decision_ttl_seconds?   — decision expiry (default 300s; never auto-extended)
   */
  constructor({ audit, clock = () => Date.now(), decided_by = C04_ACTOR, decision_ttl_seconds = DEFAULT_DECISION_TTL_SECONDS }) {
    if (!audit) throw new TypeError("PolicyGate requires an audit sink");
    this._audit = audit;
    this._clock = clock;
    this._decidedBy = decided_by;
    this._decisionTtlSeconds = decision_ttl_seconds;
    this._decisions = new Map(); // decision_id → {fingerprint, result}
  }

  /**
   * Evaluate one requested action.
   * @param {object} request
   *   decision_id        — idempotency key (required, 1..128 chars); audit key
   *   requested_action   — e.g. "run.execute:environment=production"
   *   environment        — validated environment definition (§12.1)
   *   environmentSet?    — full environment set (production URL re-check)
   *   resolved_base_url? — value resolved from base_url_env (never stored)
   *   plan?              — {requests?, duration_seconds?, parallelism?}
   *   capabilities?      — {destructive?,fuzzing?,load?,write?,concurrent_writes?,batch_delete?}
   *   approvals?         — approval_record[] (human approvals)
   * @returns {{ok:true, decision_id:string, replayed:boolean, decision:object, code?:string}
   *           | {ok:false, error:object}}
   */
  decide(request) {
    if (request === null || typeof request !== "object") {
      return invalid("decide request must be an object");
    }
    const {
      decision_id,
      requested_action,
      environment,
      environmentSet,
      resolved_base_url,
      plan,
      capabilities,
      approvals,
    } = request;

    if (typeof decision_id !== "string" || decision_id.length === 0 || decision_id.length > 128) {
      return invalid("decision_id is required (1..128 chars)");
    }
    if (typeof requested_action !== "string" || requested_action.length === 0) {
      return invalid("requested_action is required");
    }
    const envCheck = validateEnvironmentDefinition(environment);
    if (!envCheck.ok) {
      return invalid("environment definition failed validation", { errors: envCheck.errors });
    }

    const fingerprint = canonicalJson({
      requested_action,
      environment: environment.environment,
      resolved_base_url: resolved_base_url ?? null,
      plan: plan ?? null,
      capabilities: capabilities ?? null,
      approvals: approvals ?? null,
    });

    const cached = this._decisions.get(decision_id);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        return {
          ok: false,
          error: makeError(ERROR_CODES.CTL_IDEMPOTENCY_CONFLICT, `decision_id "${decision_id}" replayed with a different payload`, {
            decision_id,
          }),
        };
      }
      return { ok: true, replayed: true, ...cached.result };
    }

    const nowMs = this._clock();
    const nowIso = toIso(nowMs);
    const caps = normalizeCapabilities(capabilities);
    const limits = environment.limits;
    const budget = plan || {};

    const effectiveProduction = isProductionEnvironment(
      environmentSet || { environments: [environment] },
      environment,
      resolved_base_url,
    );

    let outcome = "approved";
    let reason = "";
    let code;

    // -- production denial matrix (§12.3; no approval can lift the ban) ----
    if (effectiveProduction) {
      const forbidden = PRODUCTION_FORBIDDEN_CAPABILITIES.filter((key) => caps[key]);
      if (forbidden.length > 0) {
        outcome = "denied";
        code = ERROR_CODES.POL_DENIED;
        reason = `production policy forbids: ${forbidden.join(", ")} (§12.3 production protection)`;
      }
    }

    // -- budget gate (all environments; §12.3 executor limits) -------------
    if (outcome === "approved") {
      if (budget.requests !== undefined && (!Number.isInteger(budget.requests) || budget.requests > limits.max_requests)) {
        outcome = "denied";
        code = ERROR_CODES.POL_BUDGET_EXCEEDED;
        reason = `plan requests ${budget.requests} exceed environment limit max_requests=${limits.max_requests}`;
      } else if (
        budget.duration_seconds !== undefined &&
        (!Number.isInteger(budget.duration_seconds) || budget.duration_seconds > limits.max_duration_seconds)
      ) {
        outcome = "denied";
        code = ERROR_CODES.POL_BUDGET_EXCEEDED;
        reason = `plan duration ${budget.duration_seconds}s exceeds environment limit max_duration_seconds=${limits.max_duration_seconds}`;
      } else if (
        budget.parallelism !== undefined &&
        (!Number.isInteger(budget.parallelism) || budget.parallelism > limits.max_parallelism)
      ) {
        outcome = "denied";
        code = ERROR_CODES.POL_BUDGET_EXCEEDED;
        reason = `plan parallelism ${budget.parallelism} exceeds environment limit max_parallelism=${limits.max_parallelism}`;
      }
    }

    // -- production approval / read-only smoke gates -------------------------
    if (outcome === "approved" && effectiveProduction) {
      if (caps.write) {
        const approvalStatus = findValidApproval(approvals || [], { scope: requested_action, nowMs });
        if (approvalStatus.status === "none") {
          outcome = "denied";
          code = ERROR_CODES.POL_DENIED;
          reason = "production write requires an unexpired human approval record (approval_record scope must match the requested action)";
        } else if (approvalStatus.status === "expired") {
          outcome = "denied";
          code = ERROR_CODES.POL_APPROVAL_EXPIRED;
          reason = "required approval record has expired; expired approvals are rejected, never auto-extended (§22.5.4)";
        } else if (approvalStatus.status === "denied") {
          outcome = "denied";
          code = ERROR_CODES.POL_DENIED;
          reason = "required approval record was denied by the approver";
        }
      } else if (environment.allow_readonly_smoke !== true) {
        outcome = "denied";
        code = ERROR_CODES.POL_DENIED;
        reason = "production read-only smoke requires an explicit allow_readonly_smoke allowance in the environment definition";
      }
    }

    // -- environment capability allowance (non-production, §12.1) -----------
    if (outcome === "approved" && !effectiveProduction) {
      const notGranted = ["destructive", "fuzzing", "load"].filter((key) => caps[key] && !environment.capabilities[key]);
      if (notGranted.length > 0) {
        outcome = "denied";
        code = ERROR_CODES.POL_DENIED;
        reason = `environment "${environment.environment}" does not grant capabilities: ${notGranted.join(", ")}`;
      }
    }

    if (outcome === "approved") {
      if (effectiveProduction) {
        reason = caps.write
          ? "production write approved by an unexpired human approval record, within budget"
          : "read-only smoke within budget; production environment explicitly allows read-only smoke";
      } else {
        reason = "action within environment capabilities and budget";
      }
    }

    const decisionObject = {
      decision: outcome,
      reason,
      requested_action,
      decided_by: this._decidedBy,
      decided_at: nowIso,
      expires_at: toIso(nowMs + this._decisionTtlSeconds * 1000),
    };
    if (outcome === "approved") {
      decisionObject.conditions = [
        `max_requests=${limits.max_requests}`,
        `max_duration_seconds=${limits.max_duration_seconds}`,
        `max_parallelism=${limits.max_parallelism}`,
      ];
    }

    const sr = validate("policy_decision", decisionObject);
    if (!sr.ok) {
      return { ok: false, error: makeError(ERROR_CODES.CTL_VALIDATION_FAILED, "policy decision failed schema validation", { errors: sr.errors }) };
    }

    const result = { decision_id, decision: decisionObject };
    if (code !== undefined) result.code = code;

    const audited = this._audit.append({
      actor: C04_ACTOR,
      action: POLICY_DECISION_ACTION,
      object_type: "policy_decision",
      object_id: decision_id,
      timestamp: nowIso,
      idempotency_key: decision_id,
    });
    if (!audited.ok) {
      return { ok: false, error: audited.error };
    }

    this._decisions.set(decision_id, { fingerprint, result });
    return { ok: true, replayed: false, ...result };
  }
}

export { RUN_ID_RE };
