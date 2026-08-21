/**
 * NightWatch WP-05 — OPTIONAL Newman CLI integration (WorkRequest §5.2).
 *
 * Newman is NOT the acceptance main path (builtin-blackbox is). This adapter:
 *   - detects `NEWMAN_BIN`, then `newman` on PATH, then the repo-local
 *     `node_modules/.bin/newman`;
 *   - when available, runs ONE real pass of a WP-02 compiled collection
 *     against the local Golden Fault API stub (--env-var base_url=...);
 *   - when unavailable, reports `skipped: newman-not-available` — this is
 *     NOT an acceptance failure (no new npm dependency is introduced).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Detect an available Newman binary (NEWMAN_BIN → PATH → repo-local .bin). */
export function detectNewman() {
  if (process.env.NEWMAN_BIN && existsSync(process.env.NEWMAN_BIN)) {
    return { available: true, bin: process.env.NEWMAN_BIN, source: "NEWMAN_BIN" };
  }
  const which = spawnSync("which", ["newman"], { encoding: "utf8" });
  if (which.status === 0 && typeof which.stdout === "string" && which.stdout.trim().length > 0) {
    return { available: true, bin: which.stdout.trim(), source: "PATH" };
  }
  const local = join(REPO_ROOT, "node_modules", ".bin", "newman");
  if (existsSync(local)) {
    return { available: true, bin: local, source: "repo-local" };
  }
  return { available: false, bin: null, source: null };
}

/**
 * Run one real Newman pass of a compiled collection against the stub.
 * Newman exit 0 = all tests green, 1 = test failures — both prove the
 * integration path executed; anything else is an adapter-level error.
 *
 * @param {{collectionPath: string, baseUrl: string, timeoutMs?: number}} input
 * @returns {{status: "executed"|"failed", exit_code: number, stdout_tail: string}}
 */
export function runNewmanOnce({ collectionPath, baseUrl, timeoutMs = 120_000 }) {
  const run = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules", "newman", "bin", "newman.js"),
      "run",
      collectionPath,
      "--env-var",
      `base_url=${baseUrl}`,
      "--reporters",
      "cli",
      "--reporter-cli-no-summary",
      "--insecure",
      "--timeout-request",
      "10000",
    ],
    { encoding: "utf8", timeout: timeoutMs, cwd: REPO_ROOT },
  );
  return {
    status: run.status === 0 || run.status === 1 ? "executed" : "failed",
    exit_code: run.status ?? -1,
    stdout_tail: ((run.stdout || "") + (run.stderr || "")).slice(-2000),
  };
}
