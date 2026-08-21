/**
 * NightWatch WP-05 — Fixture Coordinator + Resource Ledger (C10, §12.2).
 *
 * Lifecycle (§12.2): Plan → Allocate Namespace → Setup → Verify → Test →
 * Cleanup → Verify Cleanup. This coordinator implements that lifecycle
 * against the Golden Fault API stub THROUGH ITS PUBLIC HTTP API ONLY — it
 * never touches the stub's internals (C10 boundary: "仅通过公开 API
 * Setup/Verify/Cleanup").
 *
 * Resource Ledger (§12.2 / WorkRequest §5.5):
 *   - EVERY resource created through the public API (POST /v1/widgets) is
 *     recorded entry-by-entry in an append-only JSONL ledger file;
 *   - Cleanup uses IDEMPOTENT deletion (DELETE 204 or 404 both count as
 *     cleaned — repeated DELETE is safe);
 *   - Cleanup failures are NEVER hidden: failed/timed-out entries stay in the
 *     ledger as residuals and are reported in `cleanup_failures` (P0 records
 *     them on the ledger; the Finding object itself is owned by WP-06);
 *   - Interruption recovery: after a crash (coordinator discarded without
 *     cleanup), the NEXT run first inspects the persisted ledger — orphan
 *     resources (status "allocated") remain visible and cleanable.
 *
 * Ledger entry shape (internal record; append-only JSONL, one per line):
 *   { ledger_seq, resource_id, resource_type, namespace, method, path,
 *     created_at, status: "allocated"|"cleaned"|"failed",
 *     cleanup_path?, cleanup_attempts, last_error? }
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeError, ERROR_CODES } from "./errors.mjs";

const isoNow = () => new Date().toISOString();

/**
 * C10 Fixture Coordinator bound to one execution's ledger.
 */
export class FixtureCoordinator {
  /**
   * @param {object} options
   *   executionId — owning execution (ledger file scoping)
   *   ledgerDir   — directory for the append-only ledger JSONL files
   *   baseUrl     — Golden Fault API stub base URL (public API only)
   *   fetchImpl?  — fetch-like function (default global fetch)
   *   clock?      — () => epoch ms
   */
  constructor({ executionId, ledgerDir, baseUrl, fetchImpl = globalThis.fetch, clock = () => Date.now() }) {
    if (!executionId || !ledgerDir || !baseUrl) throw new TypeError("executionId, ledgerDir and baseUrl are required");
    this.executionId = executionId;
    this.ledgerDir = ledgerDir;
    this.baseUrl = baseUrl;
    this._fetch = fetchImpl;
    this._clock = clock;
    this._seq = 0;
    mkdirSync(ledgerDir, { recursive: true });
    this.ledgerPath = join(ledgerDir, `ledger-${executionId}.jsonl`);
    if (!existsSync(this.ledgerPath)) writeFileSync(this.ledgerPath, "", { flag: "wx" });
    // Resume the sequence over an existing (possibly interrupted) ledger so a
    // recovery coordinator never reuses ledger_seq values.
    for (const line of readFileSync(this.ledgerPath, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const seq = JSON.parse(line).ledger_seq;
        if (Number.isInteger(seq) && seq > this._seq) this._seq = seq;
      } catch {
        // torn tail from an interrupted run: ignored for seq purposes
      }
    }
    // Namespace allocation (§12.2 "Allocate Namespace"; environment
    // data_namespace template "nw-{{run_id}}" shape): namespaced synthetic data.
    this.namespace = `nw-${executionId}`;
  }

  /* ---------------- ledger ---------------- */

  /** All ledger entries (replayed from the append-only file, in order). */
  entries() {
    const text = readFileSync(this.ledgerPath, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  }

  /**
   * Effective entries: per resource_id, the LAST appended entry wins (an
   * append-only ledger where later records supersede earlier ones — cleanup
   * outcomes, cleanup-path overrides and failure notes are all later records).
   */
  _effectiveEntries() {
    const byId = new Map();
    for (const e of this.entries()) byId.set(e.resource_id, e);
    return [...byId.values()];
  }

  /** Append one ledger entry (append-only; existing bytes never modified). */
  _append(entry) {
    this._seq += 1;
    const record = { ...entry, ledger_seq: this._seq };
    appendFileSync(this.ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  /** Orphan resources: resources whose effective status is still "allocated". */
  orphanResources() {
    return this._effectiveEntries().filter((e) => e.status === "allocated");
  }

  /**
   * Override the cleanup path of an allocated resource (used by bounded-
   * cleanup scenarios; recorded as a superseding ledger entry, never a
   * rewrite — the audit trail keeps both lines).
   */
  overrideCleanupPath(resourceId, cleanupPath, note = "verifier-injected cleanup path") {
    const last = this._effectiveEntries().find((e) => e.resource_id === resourceId);
    if (!last) throw new Error(`no ledger entry for resource ${resourceId}`);
    return this._append({ ...last, cleanup_path: cleanupPath, note });
  }

  /**
   * Record an already-created resource into the ledger (used by setup and by
   * the verifier's interruption injection / cleanup-path overrides).
   * @param {{resource_id: string, resource_type?: string, namespace?: string,
   *          method?: string, path?: string, cleanup_path?: string}} input
   */
  recordResource({ resource_id, resource_type = "widget", namespace = this.namespace, method = "POST", path = "/v1/widgets", cleanup_path }) {
    return this._append({
      resource_id,
      resource_type,
      namespace,
      method,
      path,
      created_at: isoNow(),
      status: "allocated",
      cleanup_path: cleanup_path ?? `/v1/widgets/${resource_id}`,
      cleanup_attempts: 0,
    });
  }

  /* ---------------- lifecycle ---------------- */

  /**
   * Allocate Namespace + Setup: create `count` resources through the PUBLIC
   * API (POST /v1/widgets with the run namespace) and record each in the
   * ledger. Returns a FIX_SETUP_FAILED envelope without throwing on failure.
   * @param {{count?: number}} [options]
   */
  async setup({ count = 1 } = {}) {
    const created = [];
    for (let i = 0; i < count; i += 1) {
      let response;
      try {
        response = await this._fetch(`${this.baseUrl}/v1/widgets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `nw-fixture-widget-${i + 1}`, namespace: this.namespace }),
        });
      } catch (e) {
        return { ok: false, error: makeError(ERROR_CODES.FIX_SETUP_FAILED, `fixture setup request failed: ${e.message}`, { step: i + 1 }), created };
      }
      if (response.status !== 201) {
        return {
          ok: false,
          error: makeError(ERROR_CODES.FIX_SETUP_FAILED, `fixture setup through public API returned ${response.status}`, { step: i + 1, status: response.status }),
          created,
        };
      }
      const widget = await response.json();
      created.push(this.recordResource({ resource_id: widget.id }));
    }
    return { ok: true, created };
  }

  /**
   * Verify (post-setup): every allocated ledger resource must be readable
   * through the public API. Returns the list of missing resources.
   */
  async verifySetup() {
    const missing = [];
    for (const entry of this.orphanResources()) {
      try {
        const response = await this._fetch(`${this.baseUrl}${entry.cleanup_path}`, { method: "GET" });
        if (response.status !== 200) missing.push(entry.resource_id);
      } catch {
        missing.push(entry.resource_id);
      }
    }
    return { ok: missing.length === 0, missing };
  }

  /**
   * Cleanup with an OVERALL BOUNDED deadline (§22.5.4: cleanup carries its own
   * timeout; a cleanup timeout is preserved as an INDEPENDENT result, never
   * swallowed). Idempotent: 204 and 404 both mark the resource cleaned.
   *
   * @param {{timeout_ms?: number}} [options]
   * @returns {{status: "completed"|"failed"|"timed_out"|"skipped",
   *            residual_resources: string[], cleanup_failures: Array<Object>,
   *            attempts: number}}
   */
  async cleanup({ timeout_ms = 5000 } = {}) {
    const deadline = this._clock() + timeout_ms;
    const orphans = this.orphanResources();
    if (orphans.length === 0) return { status: "skipped", residual_resources: [], cleanup_failures: [], attempts: 0 };

    const failures = [];
    let timedOut = false;
    let attempts = 0;

    for (const entry of orphans) {
      if (this._clock() >= deadline) {
        timedOut = true;
        break; // remaining entries stay "allocated" → residual
      }
      attempts += 1;
      const perAttemptDeadline = deadline - this._clock();
      let status = -1;
      let errText = null;
      try {
        const response = await this._fetch(`${this.baseUrl}${entry.cleanup_path}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(Math.max(perAttemptDeadline, 1)),
        });
        status = response.status;
        if (status !== 204 && status !== 404) {
          errText = `DELETE returned ${status}`;
        }
      } catch (e) {
        errText = e.name === "TimeoutError" || e.name === "AbortError" ? "DELETE timed out" : `DELETE failed: ${e.message}`;
      }

      if (errText === null) {
        // Idempotent delete confirmed (204 first delete / 404 already deleted).
        this._append({ ...entry, status: "cleaned", cleanup_attempts: entry.cleanup_attempts + 1 });
      } else {
        const timedOutThisEntry = errText === "DELETE timed out";
        this._append({
          ...entry,
          status: "failed",
          cleanup_attempts: entry.cleanup_attempts + 1,
          last_error: errText,
        });
        failures.push({ resource_id: entry.resource_id, resource_type: entry.resource_type, error: errText });
        if (timedOutThisEntry) timedOut = true;
      }
    }

    // Residual = every effective entry still not cleaned — "failed" cleanup
    // attempts AND entries the deadline never reached both stay visible,
    // never hidden (§12.2).
    const residual = this._effectiveEntries()
      .filter((e) => e.status !== "cleaned")
      .map((e) => `${e.resource_type}/${e.resource_id}`);
    const status = timedOut ? "timed_out" : failures.length > 0 ? "failed" : "completed";
    return { status, residual_resources: residual, cleanup_failures: failures, attempts };
  }
}
