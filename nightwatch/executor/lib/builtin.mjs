/**
 * NightWatch WP-05 — Builtin black-box executor (C09, WorkRequest §5.2).
 *
 * The ACCEPTANCE MAIN PATH executor: executes the request sequence of WP-02
 * compiled artifacts (collection + source map) directly against the Golden
 * Fault API stub with node's builtin fetch, and judges per-case outcomes
 * (Pass/Fail/Error/Skipped) by evaluating the case's assertion DSL lines.
 *
 * Consumption shape (WorkRequest §5.2 "编译产物" path):
 *   compiled  — WP-02 compileScenario() output {collection, manifest, sourceMap}
 *   cases     — Map<case_id, test_case/v1> (the library's validated cases)
 *   datasets  — { "<ref>": object } body_ref resolution (library store datasets)
 *
 * Assertion semantics are INLINE here (grammar frozen verbatim from the WP-02
 * case DSL — status_code in/equals, response_time_ms below, header present,
 * json $.path present/is/equals/one_of, @N step binding): the executor only
 * READS compiled artifacts, so it deliberately carries its own evaluator and
 * never imports WP-02 internals.
 *
 * Time semantics (§22.5.4): duration is measured with the monotonic clock
 * (process.hrtime.bigint); timeouts and cancellation are INDEPENDENT terminal
 * markers (exit 124 / 130), never folded into a plain failure.
 *
 * Exit-code contract: 0 = all passed; 1 = any failed/error case; 124 = timed
 * out; 130 = cancelled.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BUILTIN_EXECUTOR_VERSION = "builtin-blackbox@1.0.0";

export const EXIT_CODES = { OK: 0, FAILURES: 1, TIMEOUT: 124, CANCELLED: 130 };

/**
 * Cancellation token: `cancel()` implements §22.5.4 order — stop NEW steps
 * (the between-step gate reads `cancelled`) and terminate the worker (every
 * in-flight request's AbortController is registered in `aborters` and aborted
 * here). The gateway/verifier holds the token and flips it from outside.
 */
export function makeCancelToken() {
  const token = { cancelled: false, aborters: new Set() };
  token.cancel = () => {
    token.cancelled = true;
    for (const controller of [...token.aborters]) {
      controller.abort(new Error("execution-interrupted"));
    }
  };
  return token;
}

/** Deterministic PRNG (mulberry32) — seed → reproducible nonce sequence. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Assertion DSL evaluator (grammar frozen from the WP-02 case DSL)  *
 * ------------------------------------------------------------------ */

const JSON_TYPES = new Set(["string", "number", "boolean", "array", "object"]);

const parseLiteral = (text) => {
  const t = text.trim();
  if (t === "true") return { value: true };
  if (t === "false") return { value: false };
  if (t === "null") return { value: null };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: Number(t) };
  if (/^".*"$/.test(t)) return { value: JSON.parse(t) };
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(t)) return { value: t };
  throw new Error(`unparseable literal: ${text}`);
};

function parseAssertion(line) {
  const raw = line;
  let text = line.trim();
  let step = null;
  const stepMatch = text.match(/^@(\d+)\s+(.*)$/);
  if (stepMatch) {
    step = Number(stepMatch[1]);
    if (step < 1) throw new Error(`assertion step binding must be >= 1: ${raw}`);
    text = stepMatch[2].trim();
  }
  let m = text.match(/^status_code in \[(\d+(,\s*\d+)*)\]$/);
  if (m) return { raw, step, kind: "status_code_in", codes: m[1].split(",").map((s) => Number(s.trim())) };
  m = text.match(/^status_code equals (\d{3})$/);
  if (m) return { raw, step, kind: "status_code_equals", code: Number(m[1]) };
  m = text.match(/^response_time_ms below (\d+)$/);
  if (m) return { raw, step, kind: "response_time_below", ms: Number(m[1]) };
  m = text.match(/^header ([A-Za-z0-9-]+) present$/);
  if (m) return { raw, step, kind: "header_present", header: m[1] };
  m = text.match(/^json (\$\.[A-Za-z0-9_.-]+|\$) (present|is [a-z]+|equals .+|one_of \[.+\])$/);
  if (m) {
    const jsonPath = m[1];
    if (!/^(\$(\.[A-Za-z_][A-Za-z0-9_]*)*)$/.test(jsonPath)) {
      throw new Error(`unsupported json path (dotted object paths only): ${jsonPath}`);
    }
    const property = jsonPath === "$" ? "" : jsonPath.slice(2);
    const op = m[2];
    if (op === "present") return { raw, step, kind: "json_present", property };
    if (op.startsWith("is ")) {
      const type = op.slice(3);
      if (!JSON_TYPES.has(type)) throw new Error(`unsupported json type: ${type}`);
      return { raw, step, kind: "json_type", property, jsonType: type };
    }
    if (op.startsWith("equals ")) return { raw, step, kind: "json_equals", property, literal: parseLiteral(op.slice(7)) };
    const items = op
      .slice("one_of ".length)
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((s) => parseLiteral(s));
    if (items.length === 0) throw new Error("one_of requires at least one value");
    return { raw, step, kind: "json_one_of", property, items };
  }
  throw new Error(`assertion outside the DSL grammar: ${raw}`);
}

const appliesToStep = (parsed, stepIndex) => parsed.step === null || parsed.step === stepIndex;

/** Resolve a dotted JSON path ($.a.b → body.a.b; $ → body). */
function resolveJsonPath(body, property) {
  if (property === "") return { found: true, value: body };
  let current = body;
  for (const key of property.split(".")) {
    if (current === null || typeof current !== "object" || !(key in current)) return { found: false };
    current = current[key];
  }
  return { found: true, value: current };
}

/**
 * Evaluate parsed assertions against one response.
 * @returns {{passed: boolean, results: Array<{raw: string, passed: boolean}>, jsonParseError: boolean}}
 */
function evaluateAssertions(parsedAssertions, { status, headers, elapsedMs, body }) {
  const results = [];
  let jsonParseError = false;
  let parsedBody;
  let bodyNeeded = parsedAssertions.some((a) => a.kind.startsWith("json_"));
  if (bodyNeeded) {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      jsonParseError = true;
    }
  }
  for (const a of parsedAssertions) {
    let passed = false;
    switch (a.kind) {
      case "status_code_in":
        passed = a.codes.includes(status);
        break;
      case "status_code_equals":
        passed = status === a.code;
        break;
      case "response_time_below":
        passed = elapsedMs < a.ms;
        break;
      case "header_present": {
        const names = Object.keys(headers);
        passed = names.some((h) => h.toLowerCase() === a.header.toLowerCase());
        break;
      }
      case "json_present": {
        if (jsonParseError) break;
        passed = resolveJsonPath(parsedBody, a.property).found;
        break;
      }
      case "json_type": {
        if (jsonParseError) break;
        const r = resolveJsonPath(parsedBody, a.property);
        if (!r.found) break;
        const actual = Array.isArray(r.value) ? "array" : r.value === null ? "null" : typeof r.value;
        passed = a.jsonType === "object" ? typeof r.value === "object" && !Array.isArray(r.value) && r.value !== null : actual === a.jsonType;
        break;
      }
      case "json_equals": {
        if (jsonParseError) break;
        const r = resolveJsonPath(parsedBody, a.property);
        if (!r.found) break;
        passed = JSON.stringify(r.value) === JSON.stringify(a.literal.value);
        break;
      }
      case "json_one_of": {
        if (jsonParseError) break;
        const r = resolveJsonPath(parsedBody, a.property);
        if (!r.found) break;
        passed = a.items.some((lit) => JSON.stringify(r.value) === JSON.stringify(lit.value));
        break;
      }
      default:
        passed = false;
    }
    results.push({ raw: a.raw, passed });
  }
  return { passed: results.every((r) => r.passed), results, jsonParseError };
}

/* ------------------------------------------------------------------ *
 * Executor                                                          *
 * ------------------------------------------------------------------ */

/** Redact credential-carrying header values for artifacts (value NEVER included). */
function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /^authorization$/i.test(k) || /^x-nw-injected-/i.test(k) ? "<redacted>" : v;
  }
  return out;
}

/** Substitute {{REFERENCE}} templates in header values from the memory-only worker env. */
function templateHeaders(headers, workerEnv) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = String(v).replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (m, ref) => (workerEnv && ref in workerEnv ? workerEnv[ref] : m));
  }
  return out;
}

/**
 * Run one execution on the builtin black-box path.
 *
 * @param {object} input
 *   request      — execution_request (already schema-validated by the gateway)
 *   compiled     — {collection, manifest, sourceMap} (WP-02 compile output)
 *   cases        — Map<case_id, test_case>
 *   datasets     — { [ref]: object }
 *   baseUrl      — Golden Fault API stub base URL ({{base_url}} target)
 *   workerEnv?   — memory-only injected env ({ REF: value }); values reach ONLY
 *                  request headers, never logs/artifacts/receipts
 *   cancelToken? — { cancelled: boolean } polled between steps (gateway cancel)
 *   stateDir?    — artifact root (full-on-failure policy writes here)
 *   leasesMeta?  — { references: string[], lease_ids: string[] } for the
 *                  sanitized command summary (names + lease ids only)
 *   now?         — () => epoch ms
 * @returns {Promise<{result: object, details: Array<object>}>}
 */
export async function runBuiltinExecution(input) {
  const {
    request,
    compiled,
    cases,
    datasets,
    baseUrl,
    workerEnv = {},
    cancelToken = { cancelled: false },
    stateDir,
    leasesMeta = { references: [], lease_ids: [] },
    now = () => Date.now(),
  } = input;

  const startedWall = new Date(now()).toISOString();
  const startedMono = process.hrtime.bigint();
  const deadlineMs = Number(startedMono / 1_000_000n) + request.timeout_seconds * 1000;

  // Sequence: collection items in compiled order → (case_id, step) via source map.
  // A multi-step case compiles to one item PER STEP; the executor runs each
  // CASE once (all its steps, in compiled order), so dedupe to first-occurrence
  // case order — item order within a case still defines step order.
  const byItemName = new Map(compiled.sourceMap.requests.map((r) => [r.item_name, r]));
  const seenCases = new Set();
  const sequence = [];
  for (const item of compiled.collection.item) {
    const sm = byItemName.get(item.name);
    if (!sm) throw new Error(`source map has no reverse resolution for item "${item.name}"`);
    if (!seenCases.has(sm.case_id)) {
      seenCases.add(sm.case_id);
      sequence.push({ itemName: item.name, caseId: sm.case_id, stepIndex: sm.step_index });
    }
  }

  const rand = mulberry32(request.seed);
  const artifactsDir = stateDir ? join(stateDir, "artifacts", request.execution_id) : null;
  if (artifactsDir) mkdirSync(artifactsDir, { recursive: true });

  // Terminal-state markers for the whole execution.
  let timedOut = false;
  let cancelled = false;
  let interruptionReason = null; // "timeout" | "cancel" | null

  const caseResults = [];
  const details = [];
  const nonces = [];

  outerLoop: for (let rep = 1; rep <= request.repetitions; rep += 1) {
    for (const seqEntry of sequence) {
      const oneCase = cases.get(seqEntry.caseId);
      if (!oneCase) throw new Error(`case ${seqEntry.caseId} referenced by the compiled artifact is not supplied`);

      // Between-step cancel/timeout gate: a cancelled/timed-out execution stops
      // starting NEW steps immediately (§22.5.4); remaining cases are skipped.
      const nowMonoMs = Number(process.hrtime.bigint() / 1_000_000n);
      if (cancelToken.cancelled) {
        cancelled = true;
        interruptionReason = "cancel";
        break outerLoop;
      }
      if (nowMonoMs >= deadlineMs) {
        timedOut = true;
        interruptionReason = "timeout";
        break outerLoop;
      }

      const nonce = `n${rand().toString(36).slice(2, 10).padEnd(8, "0")}`;
      nonces.push(`${seqEntry.caseId}#${rep}:${nonce}`);

      const stepEvidence = [];
      let caseStatus = "passed";
      let caseError = null;
      let interruptedThisCase = false;

      for (let s = 0; s < oneCase.steps.length; s += 1) {
        const step = oneCase.steps[s];
        const req = step.request;
        const headers = { ...templateHeaders(req.headers || {}, workerEnv), "X-NW-Nonce": nonce };
        let body = null;
        if (req.body_ref) {
          const ref = req.body_ref === "__SELF__" ? `${oneCase.case_id}.json` : req.body_ref;
          const dataset = datasets[ref];
          if (dataset === undefined) {
            caseStatus = "error";
            caseError = `dataset not found for body_ref "${req.body_ref}"`;
            stepEvidence.push({ step: s + 1, method: req.method, path: req.path, error: caseError });
            break;
          }
          body = JSON.stringify(dataset);
          if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
        }

        // Per-request abort: bounded by BOTH the case per-request timeout and
        // the remaining execution budget. Whichever bound is tighter becomes
        // the abort reason, so an execution-budget expiry is distinguishable
        // from a per-request timeout (independent terminal semantics, §22.5.4).
        const perRequestMs = oneCase.timing?.per_request_timeout_ms ?? 30_000;
        const remainingBudget = deadlineMs - Number(process.hrtime.bigint() / 1_000_000n);
        const budgetIsExecution = remainingBudget <= perRequestMs;
        const budgetMs = Math.min(perRequestMs, Math.max(remainingBudget, 1));
        const requestAbort = new AbortController();
        const timer = setTimeout(
          () => requestAbort.abort(new Error(budgetIsExecution ? "execution-interrupted" : "per-request-timeout")),
          budgetMs,
        );
        // Register with the cancel token so an external cancel terminates this
        // in-flight request (§22.5.4 "终止执行 Worker").
        if (cancelToken.aborters instanceof Set) {
          cancelToken.aborters.add(requestAbort);
        }

        let response = null;
        let fetchError = null;
        const stepStart = process.hrtime.bigint();
        try {
          response = await fetch(`${baseUrl}${req.path}`, {
            method: req.method,
            headers,
            ...(body !== null ? { body } : {}),
            signal: requestAbort.signal,
          });
        } catch (e) {
          fetchError = e;
        }
        clearTimeout(timer);
        if (cancelToken.aborters instanceof Set) {
          cancelToken.aborters.delete(requestAbort);
        }
        const elapsedMs = Number(process.hrtime.bigint() - stepStart) / 1_000_000;

        if (fetchError) {
          const aborted = fetchError.name === "AbortError";
          const reason = aborted && fetchError.cause ? String(fetchError.cause.message) : String(fetchError.message || fetchError);
          if (reason.includes("execution-interrupted")) {
            // The execution-level interrupt (timeout or cancel) cut this step.
            if (cancelToken.cancelled) {
              cancelled = true;
              interruptionReason = "cancel";
            } else {
              timedOut = true;
              interruptionReason = "timeout";
            }
            caseStatus = "error";
            caseError = `interrupted (${interruptionReason}) mid-step`;
            stepEvidence.push({ step: s + 1, method: req.method, path: req.path, error: caseError });
            // Record this case (as error) BELOW before leaving the loops —
            // `break outerLoop` alone would skip the entry/details push and
            // the interrupted case would wrongly surface as "skipped".
            interruptedThisCase = true;
            break;
          }
          caseStatus = "error";
          caseError = reason.includes("per-request-timeout") ? "per-request timeout" : `request failed: ${reason}`;
          stepEvidence.push({ step: s + 1, method: req.method, path: req.path, error: caseError });
          break; // next step of this case is meaningless after a request error
        }

        const responseText = await response.text();
        const parsedForCase = oneCase.assertions
          .map((line) => {
            try {
              return parseAssertion(line);
            } catch (e) {
              caseStatus = "error";
              caseError = `assertion unparseable: ${e.message}`;
              return null;
            }
          })
          .filter((a) => a !== null && appliesToStep(a, s + 1));

        if (caseStatus === "error") break;

        const evaluation = evaluateAssertions(parsedForCase, {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          elapsedMs,
          body: responseText,
        });

        if (evaluation.jsonParseError) {
          caseStatus = "error";
          caseError = "response body is not valid JSON (json assertions cannot be evaluated)";
          stepEvidence.push({
            step: s + 1,
            method: req.method,
            path: req.path,
            status_code: response.status,
            request_headers: redactHeaders(headers),
            assertions: evaluation.results,
            error: caseError,
          });
          break;
        }
        if (!evaluation.passed) caseStatus = "failed";
        stepEvidence.push({
          step: s + 1,
          method: req.method,
          path: req.path,
          status_code: response.status,
          request_headers: redactHeaders(headers),
          elapsed_ms: Math.round(elapsedMs),
          assertions: evaluation.results,
        });
      }

      const entry = {
        case_id: oneCase.case_id,
        status: caseStatus,
        request_summary: { method: oneCase.steps[0].request.method, path: oneCase.steps[0].request.path },
      };
      const lastStatus = [...stepEvidence].reverse().find((e) => e.status_code !== undefined);
      if (lastStatus) entry.response_summary = { status_code: lastStatus.status_code };

      // Artifact policy "full-on-failure": persist sanitized evidence for
      // failed/error cases (Authorization values redacted to length markers).
      if (artifactsDir && (caseStatus === "failed" || caseStatus === "error")) {
        const artifactPath = join(artifactsDir, `${oneCase.case_id}-rep${rep}.json`);
        writeFileSync(
          artifactPath,
          JSON.stringify(
            {
              execution_id: request.execution_id,
              case_id: oneCase.case_id,
              repetition: rep,
              status: caseStatus,
              error: caseError,
              steps: stepEvidence,
            },
            null,
            2,
          ) + "\n",
        );
        entry.artifact_path = artifactPath;
      }

      caseResults.push(entry);
      details.push({ case_id: oneCase.case_id, repetition: rep, status: caseStatus, error: caseError, evidence: stepEvidence });
      if (interruptedThisCase) break outerLoop;
    }
  }

  // Everything never started because of the interrupt is VISIBLE as skipped.
  if (interruptionReason) {
    const executed = new Set(details.map((d) => `${d.case_id}|${d.repetition}`));
    for (let rep = 1; rep <= request.repetitions; rep += 1) {
      for (const seqEntry of sequence) {
        if (!executed.has(`${seqEntry.caseId}|${rep}`)) {
          caseResults.push({
            case_id: seqEntry.caseId,
            status: "skipped",
            request_summary: { method: cases.get(seqEntry.caseId).steps[0].request.method, path: cases.get(seqEntry.caseId).steps[0].request.path },
          });
        }
      }
    }
  }

  const finishedWall = new Date(now()).toISOString();
  const durationMs = Number(process.hrtime.bigint() - startedMono) / 1_000_000;
  const failures = caseResults.filter((r) => r.status === "failed" || r.status === "error").length;

  const exitCode = cancelled ? EXIT_CODES.CANCELLED : timedOut ? EXIT_CODES.TIMEOUT : failures > 0 ? EXIT_CODES.FAILURES : EXIT_CODES.OK;

  const sanitizedCommand = [
    BUILTIN_EXECUTOR_VERSION,
    "run",
    "--scenario",
    request.scenario_ref,
    "--environment",
    request.environment,
    "--seed",
    String(request.seed),
    "--repetitions",
    String(request.repetitions),
    "--base-url",
    "{{base_url}}",
    ...(leasesMeta.references.length > 0
      ? ["--credentials", leasesMeta.references.map((r, i) => `${r}(lease:${leasesMeta.lease_ids[i] ?? "?"})`).join(",")]
      : []),
  ];

  const result = {
    execution_id: request.execution_id,
    run_id: request.run_id,
    executor: request.executor,
    executor_version: BUILTIN_EXECUTOR_VERSION,
    started_at: startedWall,
    finished_at: finishedWall,
    duration_ms: Math.round(durationMs),
    sanitized_command: sanitizedCommand,
    exit_code: exitCode,
    timed_out: timedOut,
    cancelled: cancelled,
    signal: null,
    case_results: caseResults,
    seed: request.seed,
    repetitions: request.repetitions,
    failures,
    cleanup: { status: "skipped", residual_resources: [] }, // gateway merges the real cleanup outcome
  };

  return { result, details, nonces, interruptionReason };
}
