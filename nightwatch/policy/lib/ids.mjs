/**
 * NightWatch WP-04 — ID generation (C04/C08)
 *
 * Prefixed ULID helpers matching WP-00 common.json id definitions
 * (^lease_<ULID26>$ / ^run_<ULID26>$). The ULID generator itself is the WP-03
 * public API (nightwatch/state/index.mjs → ulid) — consumed read-only, this
 * package never writes into nightwatch/state/.
 */
import { ulid } from "../../state/index.mjs";

export const newLeaseId = (nowMs) => `lease_${ulid(nowMs)}`;
export const newRunId = (nowMs) => `run_${ulid(nowMs)}`;

const ULID26 = "[0-9A-HJKMNP-TV-Z]{26}";
export const isLeaseId = (id) => new RegExp(`^lease_${ULID26}$`).test(id);
export const isRunId = (id) => new RegExp(`^run_${ULID26}$`).test(id);
