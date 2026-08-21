/**
 * NightWatch WP-08 — Public API (C02 Control API + C03 QA Orchestrator)
 *
 * Consumption surfaces (for WP-09 Console and the acceptance verifier):
 *   - ControlApi: execute(name, envelope) — schema-validated, deadline-gated,
 *     idempotent command routing over the seven WP-00 commands; listSessions /
 *     sessionView display DTOs;
 *   - Orchestrator: createSession / startRun / publishIssue / retestIssue /
 *     cancelRun / retryRun / resumeSession (§5.11-3 ordering only — component
 *     verdicts are never rewritten); injectFault / scheduleInterrupt fixture
 *     surfaces for §5.5 fault-isolation and §7.3 recovery acceptance;
 *   - SessionStore + LEGAL_TRANSITIONS: the §7.2 state machine (illegal
 *     transitions rejected with the session state unchanged);
 *   - EventBus: the eight WP-00 events, in-process subscription + JSONL log;
 *   - makeControlIdFactory: deterministic session_/run_/evt_/exec_ IDs.
 *
 * Usage:
 *   import { ControlApi, Orchestrator, EventBus, SessionStore, makeControlIdFactory } from "nightwatch/control/lib/index.mjs";
 */
export { ControlApi } from "./controlapi.mjs";
export { Orchestrator, OrchestrationInterrupted } from "./orchestrator.mjs";
export { SessionStore, LEGAL_TRANSITIONS, isLegalTransition } from "./statemachine.mjs";
export { EventBus } from "./events.mjs";
export { makeControlIdFactory } from "./ids.mjs";
export { COMMANDS, EVENTS, validate, validateCommand, validateEvent, validateSession, validateCheckpoint, validateError } from "./schemas.mjs";
export { makeError, ERROR_CODES, isRegisteredCode, isErrorEnvelope } from "./errors.mjs";
