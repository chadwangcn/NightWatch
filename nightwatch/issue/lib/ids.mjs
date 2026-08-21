/**
 * NightWatch WP-07 — Deterministic ID generation (C13)
 *
 * draft_ / issue_ (publish receipt) prefixed IDs per the WP-00 §5.5 prefix
 * table. Reuses the WP-06 deterministic ULID generator (public API:
 * nightwatch/evidence/lib/index.mjs) so acceptance reruns produce
 * byte-identical registries and receipts — random-entropy IDs would break
 * the two-round determinism gate (WorkRequest §7 A10).
 */
import { deterministicUlidGenerator } from "../../evidence/lib/index.mjs";

/**
 * Create a deterministic, prefixed ID factory for the issue domain.
 * @param {() => number} [nowMs] clock returning epoch ms (fixed in verify)
 * @returns {{reset: () => void, draftId: () => string, receiptId: () => string}}
 */
export const makeIssueIdFactory = (nowMs = () => Date.now()) => {
  const gen = deterministicUlidGenerator(nowMs);
  return {
    reset: () => gen.reset(),
    draftId: () => `draft_${gen.next()}`,
    receiptId: () => `issue_${gen.next()}`,
  };
};
