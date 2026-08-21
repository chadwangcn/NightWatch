/**
 * NightWatch WP-08 — Control API (C02, WorkRequest §5.1)
 *
 * Library-level command surface (P0 shape — NO HTTP server; WP-09 Console
 * wraps this):
 *
 *   execute(name, envelope)
 *     1. envelope validated against the FROZEN WP-00 command schema
 *        (command_id / issued_at / deadline / payload) → CTL_VALIDATION_FAILED;
 *     2. deadline gate → CTL_COMMAND_TIMEOUT before any routing;
 *     3. command idempotency: same command_id + same payload → replay of the
 *        recorded result (idempotent_replay: true); same command_id with a
 *        DIFFERENT payload → CTL_IDEMPOTENCY_CONFLICT;
 *     4. route to the C03 Orchestrator method owning the command.
 *
 *   Display DTOs (read-only aggregation for a Console):
 *     listSessions() / sessionView(session_id) — session + runs + findings +
 *     drafts + published receipts, assembled from the orchestrator's stores.
 *
 * The Control API never rewrites component verdicts: orchestrator results and
 * error envelopes pass through unchanged (§5.5).
 */
import { validateCommand } from "./schemas.mjs";
import { makeError, ERROR_CODES } from "./errors.mjs";

const ROUTES = {
  createSession: "createSession",
  startRun: "startRun",
  cancelRun: "cancelRun",
  retryRun: "retryRun",
  resumeSession: "resumeSession",
  publishIssue: "publishIssue",
  retestIssue: "retestIssue",
};

/** Deterministic fingerprint of the routed payload (idempotency compare). */
const payloadFingerprint = (name, payload) => `${name}:${JSON.stringify(payload ?? null)}`;

export class ControlApi {
  /**
   * @param {object} options
   *   orchestrator — the C03 Orchestrator instance (real public API)
   *   nowMs        — () => epoch ms used for the deadline gate (injectable;
   *                  verify pins it; default wall clock)
   */
  constructor({ orchestrator, nowMs = () => Date.now() }) {
    if (!orchestrator) throw new TypeError("ControlApi requires an orchestrator");
    this.orchestrator = orchestrator;
    this.nowMs = nowMs;
    this.commands = new Map(); // command_id → { fingerprint, name, result }
  }

  /**
   * Validate, gate and route ONE command envelope.
   * @param {string} name — one of the seven WP-00 command names
   * @param {{command_id: string, issued_at: string, deadline: string, payload: object}} envelope
   * @returns {Promise<{ok: boolean, idempotent_replay?: boolean, command_id: string,
   *                     result?: object, error?: object}>}
   *   `result`/`error` mirror the orchestrator outcome; routing failures carry
   *   CTL_* envelopes produced here, component envelopes passed through.
   */
  async execute(name, envelope) {
    if (!Object.prototype.hasOwnProperty.call(ROUTES, name)) {
      return {
        ok: false,
        command_id: envelope?.command_id ?? null,
        error: makeError(ERROR_CODES.VALIDATION_FAILED, `unknown command "${name}" (the seven WP-00 commands only)`, { reason: "unknown_command" }),
      };
    }
    const schemaCheck = validateCommand(name, envelope);
    if (!schemaCheck.ok) {
      return {
        ok: false,
        command_id: envelope?.command_id ?? null,
        error: makeError(ERROR_CODES.VALIDATION_FAILED, `command ${name} failed the WP-00 envelope schema`, {
          reason: "command_schema",
          errors: schemaCheck.errors,
        }),
      };
    }
    const { command_id, deadline, payload } = envelope;
    if (Date.parse(deadline) <= this.nowMs()) {
      return {
        ok: false,
        command_id,
        error: makeError(ERROR_CODES.COMMAND_TIMEOUT, `command ${name} deadline ${deadline} has passed before routing`, {
          reason: "deadline_exceeded",
          deadline,
        }),
      };
    }
    const fingerprint = payloadFingerprint(name, payload);
    const recorded = this.commands.get(command_id);
    if (recorded) {
      if (recorded.fingerprint !== fingerprint) {
        return {
          ok: false,
          command_id,
          error: makeError(ERROR_CODES.IDEMPOTENCY_CONFLICT, `command_id "${command_id}" replayed with a different payload`, {
            reason: "command_payload_mismatch",
            command: name,
          }),
        };
      }
      return { ok: recorded.result.ok, idempotent_replay: true, command_id, ...(recorded.result.ok ? { result: recorded.result.value } : { error: recorded.result.error }) };
    }
    const routed = await this.#route(name, payload);
    // Orchestrator methods return {ok, ...fields}; everything besides `ok`
    // IS the command result (run / session / receipt / comment / ...).
    const value = { ...routed };
    delete value.ok;
    delete value.error;
    this.commands.set(command_id, {
      fingerprint,
      name,
      result: routed.ok ? { ok: true, value } : { ok: false, error: routed.error },
    });
    return { ok: routed.ok, command_id, ...(routed.ok ? { result: value } : { error: routed.error }) };
  }

  async #route(name, payload) {
    const orch = this.orchestrator;
    switch (name) {
      case "createSession":
        return orch.createSession(payload);
      case "startRun":
        return orch.startRun(payload);
      case "cancelRun":
        return orch.cancelRun(payload);
      case "retryRun":
        return orch.retryRun(payload);
      case "resumeSession":
        return orch.resumeSession(payload);
      case "publishIssue":
        return orch.publishIssue(payload);
      case "retestIssue":
        return orch.retestIssue(payload);
      default:
        return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `unroutable command "${name}"`, { reason: "unknown_command" }) };
    }
  }

  /* --------------------------------------------------------------- */
  /* Display DTOs (read-only aggregation; §5.1 展示 DTO)              */
  /* --------------------------------------------------------------- */

  listSessions() {
    return this.orchestrator.sessions.list().map((session) => ({
      session_id: session.session_id,
      workspace_id: session.workspace_id,
      goal: session.goal,
      state: session.state,
      ...(session.blocked_reason ? { blocked_reason: session.blocked_reason } : {}),
      created_at: session.created_at,
      updated_at: session.updated_at,
    }));
  }

  sessionView(sessionId) {
    const orch = this.orchestrator;
    const session = orch.sessions.load(sessionId);
    if (!session) return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `session ${sessionId} not found`, { reason: "session_not_found" }) };
    const pipeline = orch.pipelineOf(sessionId);
    const published = orch.publishedDrafts().filter((p) => pipeline?.runs.some((r) => (r.finding_ids ?? []).includes(p.finding_id)));
    const drafts = orch
      .allDrafts()
      .filter((d) => pipeline?.runs.some((r) => (r.finding_ids ?? []).includes(d.finding_id)))
      .map((d) => ({ draft_id: d.draft_id, finding_id: d.finding_id, published: published.some((p) => p.draft_id === d.draft_id) }));
    return {
      ok: true,
      session,
      runs: (pipeline?.runs ?? []).map((r) => ({
        run_id: r.run_id,
        scenario_id: r.scenario_id,
        environment: r.environment,
        status: r.status,
        outcome: r.outcome,
        case_summary: r.case_summary,
        sealed: Boolean(r.sealed),
        finding_ids: r.finding_ids ?? [],
        supersedes_run_id: r.supersedes_run_id,
      })),
      drafts,
      published: published.map((p) => ({ draft_id: p.draft_id, issue_ref: p.issue_ref, receipt_id: p.receipt.receipt_id, published_at: p.published_at })),
      events: orch.events.forObject(sessionId),
    };
  }
}
