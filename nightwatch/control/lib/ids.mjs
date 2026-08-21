/**
 * NightWatch WP-08 — Deterministic ID generation (C02/C03)
 *
 * session_ / run_ / evt_ prefixed IDs per the WP-00 common.json id table.
 * Like WP-06/WP-07, this generator is DETERMINISTIC (time from an injectable
 * clock + monotonic counter as entropy — NOT WP-03's random entropy) so that
 * acceptance reruns produce byte-identical stores and receipts
 * (WorkRequest §7 A10). It reuses the WP-06 public generator unchanged.
 */
import { deterministicUlidGenerator } from "../../evidence/lib/index.mjs";

/**
 * Create a deterministic, prefixed ID factory.
 * @param {() => number} [nowMs] clock returning epoch ms (fixed in verify)
 * @returns {{reset: () => void, sessionId: () => string, runId: () => string,
 *            eventId: () => string, executionRef: () => string}}
 */
export function makeControlIdFactory(nowMs = () => Date.now()) {
  const gen = deterministicUlidGenerator(nowMs);
  return {
    reset: () => gen.reset(),
    sessionId: () => `session_${gen.next()}`,
    runId: () => `run_${gen.next()}`,
    eventId: () => `evt_${gen.next()}`,
    executionRef: () => `exec_${gen.next()}`,
  };
}
