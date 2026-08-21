/**
 * NightWatch WP-07 — Issue body / comment rendering (C13, §14.1 / §16)
 *
 * Renders a WP-00 issue_draft into the GitHub issue title and body sections
 * mirroring the §16 template. HYPOTHESIS FIREWALL (§14.1):
 *   - `draft.hypothesis` may ONLY appear inside a dedicated, final section
 *     titled "Hypothesis (suspected — NOT a confirmed root cause)";
 *   - the section is preceded by an explicit disclaimer stating that the
 *     content is an unverified hypothesis and must not be read as fact;
 *   - the section is omitted entirely when the hypothesis is empty;
 *   - no other section ever contains the hypothesis text (single-occurrence
 *     guarantee, asserted by verify A9);
 *   - the renderer never promotes hypothesis content into Summary/Actual.
 */
export const HYPOTHESIS_SECTION_TITLE = "## Hypothesis (suspected — NOT a confirmed root cause)";
export const HYPOTHESIS_DISCLAIMER = "> The following is an unverified hypothesis. It must not be read as a statement of fact; root cause remains unknown.";

const bullets = (items) => items.map((s) => `- ${s}`).join("\n");
const numbered = (items) => items.map((s, i) => `${i + 1}. ${s}`).join("\n");

/** Deterministic issue title (no secrets — derived from the finding fingerprint). */
export function renderIssueTitle(finding) {
  const fp = finding.fingerprint;
  return `[NightWatch] ${fp.api_id} ${fp.normalized_method_path} → ${fp.normalized_status_or_error} (${fp.assertion_class})`;
}

/**
 * Render the full GitHub issue body for a draft (§16 template order).
 * The hypothesis section is appended last, only when non-empty.
 */
export function renderIssueBody(draft) {
  const parts = [];
  parts.push(`## Summary\n${draft.summary}`);
  parts.push(
    `## Environment\n${bullets([
      `API: ${draft.environment.api_id}`,
      `Environment: ${draft.environment.environment_name}`,
      `Spec revision: ${draft.environment.spec_revision}`,
      `First observed: ${draft.environment.first_observed_at}`,
    ])}`
  );
  parts.push(`## Preconditions\n${bullets(draft.preconditions)}`);
  parts.push(`## Minimal Reproduction\n${numbered(draft.minimal_reproduction)}`);
  parts.push(`## Expected\n${draft.expected}`);
  parts.push(`## Actual\n${draft.actual}`);
  parts.push(
    `## Reproducibility\n${bullets([
      `Attempts: ${draft.reproducibility.attempts}`,
      `Failures: ${draft.reproducibility.failures}`,
      `Rate: ${draft.reproducibility.rate}`,
    ])}`
  );
  parts.push(`## Timing\n${draft.timing}`);
  parts.push(`## Sanitized Evidence\n${bullets(draft.sanitized_evidence)}\n\n(Evidence references point into sealed run bundles; raw request/response payloads are never embedded.)`);
  parts.push(`## Artifacts\n${bullets(draft.artifacts.map((a) => `${a.kind}: ${a.ref}`))}`);
  parts.push(`## Scope Boundary\n${draft.scope_boundary}`);
  if (typeof draft.hypothesis === "string" && draft.hypothesis.length > 0) {
    parts.push(`${HYPOTHESIS_SECTION_TITLE}\n${HYPOTHESIS_DISCLAIMER}\n\n${draft.hypothesis}`);
  }
  return parts.join("\n\n");
}

/**
 * Render the dedup comment appended when a fingerprint matches an existing
 * open issue (§5.11: new reproduction info is appended, never a new issue).
 */
export function renderDedupComment({ draft, finding }) {
  return [
    "### New reproduction detected (NightWatch fingerprint dedup)",
    `- Fingerprint matched this open issue; **no new issue created** (ISS_DUPLICATE).`,
    `- Finding: ${finding.finding_id} (classification ${finding.classification})`,
    `- Draft: ${draft.draft_id}`,
    `- Reproducibility: attempts=${finding.reproduction.attempts}, failures=${finding.reproduction.failures}, rate=${finding.reproduction.rate}`,
    `- New sanitized evidence:`,
    ...draft.sanitized_evidence.map((s) => `  - ${s}`),
  ].join("\n");
}

/**
 * Render the retest comment (§5.5): new run evidence + retest conclusion
 * appended to the EXISTING issue; this channel never creates a new issue.
 */
export function renderRetestComment({ finding, new_evidence, conclusion, at }) {
  return [
    `### Retest report (${at})`,
    `- Finding: ${finding.finding_id} — classification after retest: ${finding.classification}`,
    `- Reproducibility after retest: attempts=${finding.reproduction.attempts}, failures=${finding.reproduction.failures}, rate=${finding.reproduction.rate}`,
    `- New evidence (sealed run references):`,
    ...new_evidence.flatMap((e) => [
      `  - run ${e.run_id}${e.summary ? ` — ${e.summary}` : ""}`,
      ...(e.evidence_refs ?? []).map((r) => `    - ${r}`),
    ]),
    `- Retest conclusion: ${conclusion}`,
    "",
    "Evidence appended to the existing issue; no new issue created (retest channel).",
  ].join("\n");
}
