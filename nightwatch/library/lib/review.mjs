/**
 * NightWatch WP-02 — Reviewer (static review stage, architecture §5.4 item 8).
 *
 * Static checks applied to every case BEFORE it enters the library:
 *   1. WP-00 test_case/v1 schema validation;
 *   2. assertion DSL syntax (every assertion machine-parseable);
 *   3. @N step bindings within range;
 *   4. content constraint (§10): mandatory assertions must be black-box —
 *      database-read assertions are rejected with LIB_CASE_INVALID;
 *   5. duplicate identity / duplicate content fingerprint (LIB_DUPLICATE_CASE);
 *   6. executability: steps non-empty, method/path present, referenced
 *      datasets provided.
 *
 * Cases that fail are REJECTED (reported with reasons, never persisted).
 * This is the "Reviewer Agent" slot of the pipeline; Dry Run & Case Repair
 * are WP-05 territory and intentionally not performed here (WorkRequest §5.2).
 */
import { validateTestCase } from "./schemas.mjs";
import { parseAssertion } from "./dsl.mjs";
import { contentChecksum } from "./ids.mjs";

const DB_READ_PATTERN = /(read|query|count|select)[^.]*\b(database|db|sql|table rows?)\b|\bselect\s+.+\s+from\s+/i;

/** Review a batch of candidate cases (generation output + manual inputs). */
export function reviewCases(candidates) {
  const accepted = [];
  const rejected = [];
  const seenIds = new Set();
  const seenFingerprints = new Map(); // fingerprint → case_id

  for (const cand of candidates) {
    const oneCase = cand.case;
    const reasons = [];

    // 1. Frozen schema.
    const schemaResult = validateTestCase(oneCase);
    if (!schemaResult.ok) reasons.push({ code: "LIB_CASE_INVALID", message: "case violates test_case/v1.json", details: { errors: schemaResult.errors } });

    // 2. Assertion DSL syntax.
    for (const line of oneCase.assertions || []) {
      try {
        parseAssertion(line);
      } catch (e) {
        reasons.push({ code: "LIB_CASE_INVALID", message: `assertion outside the DSL grammar: ${line}`, details: { error: e.message } });
      }
    }

    // 3. Step bindings in range.
    const stepCount = (oneCase.steps || []).length;
    for (const line of oneCase.assertions || []) {
      const m = typeof line === "string" ? line.trim().match(/^@(\d+)\s+/) : null;
      if (m && Number(m[1]) > stepCount) {
        reasons.push({ code: "LIB_CASE_INVALID", message: `assertion bound to step ${m[1]} but the case has ${stepCount} steps: ${line}` });
      }
    }

    // 4. Black-box content constraint (§10): no DB-read mandatory assertions.
    for (const line of oneCase.assertions || []) {
      if (typeof line === "string" && DB_READ_PATTERN.test(line)) {
        reasons.push({ code: "LIB_CASE_INVALID", message: `mandatory assertion requires reading the database (forbidden by §10): ${line}` });
      }
    }

    // 5a. Duplicate case_id.
    if (seenIds.has(oneCase.case_id)) {
      reasons.push({ code: "LIB_DUPLICATE_CASE", message: `duplicate case_id: ${oneCase.case_id}` });
    }
    // 5b. Duplicate content fingerprint (same steps+assertions+title).
    const fingerprint = contentChecksum({
      title: oneCase.title,
      api_id: oneCase.api_id,
      steps: oneCase.steps,
      assertions: oneCase.assertions,
    });
    if (seenFingerprints.has(fingerprint)) {
      reasons.push({
        code: "LIB_DUPLICATE_CASE",
        message: `duplicate case content (same title/steps/assertions as ${seenFingerprints.get(fingerprint)})`,
      });
    }

    // 6. Executability.
    if (!Array.isArray(oneCase.steps) || oneCase.steps.length === 0) {
      reasons.push({ code: "LIB_CASE_INVALID", message: "case has no steps" });
    } else {
      oneCase.steps.forEach((s, i) => {
        if (!s.request || !s.request.method || !s.request.path) {
          reasons.push({ code: "LIB_CASE_INVALID", message: `step ${i + 1} lacks request.method/request.path` });
        }
        if (s.request && s.request.body_ref && (!cand.dataset || cand.dataset.content === undefined)) {
          reasons.push({ code: "LIB_CASE_INVALID", message: `step ${i + 1} references dataset "${s.request.body_ref}" but no dataset content is provided` });
        }
      });
    }

    if (reasons.length > 0) {
      rejected.push({ case_id: oneCase.case_id, title: oneCase.title, reasons });
      continue;
    }
    seenIds.add(oneCase.case_id);
    seenFingerprints.set(fingerprint, oneCase.case_id);
    accepted.push(cand);
  }
  return { accepted, rejected };
}
