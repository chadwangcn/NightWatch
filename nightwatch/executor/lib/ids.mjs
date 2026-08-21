/**
 * NightWatch WP-05 — ID helpers (C09 Executor Gateway)
 *
 * Prefixed ULID object ids per WP-00 common.json: exec_<ULID26> / run_<ULID26>.
 * ULID entropy comes from the WP-03 public generator (read-only consumption).
 */
import { ulid, isPrefixedUlid } from "../../state/index.mjs";

export const newExecutionId = (nowMs) => `exec_${ulid(nowMs)}`;
export const newRunId = (nowMs) => `run_${ulid(nowMs)}`;

export const isExecutionId = (id) => isPrefixedUlid("exec", id);
export const isRunId = (id) => isPrefixedUlid("run", id);
