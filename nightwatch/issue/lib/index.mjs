/**
 * NightWatch WP-07 — Public API (C13 Issue Gateway)
 *
 * Consumption surfaces (for WP-08 Orchestrator):
 *   - IssueGateway: buildDraft / publish (six §5.9 gates + policy gate +
 *     idempotency) / attachRetest (§5.5 retest linkage)
 *   - GitHubStub: local GitHub client (searchIssues/getIssue/createIssue/
 *     addComment) with full write-call accounting; zero real network
 *   - makeAuditSink: C13 audit events via the WP-03 public API
 *   - makeIssueIdFactory: deterministic draft_/issue_ prefixed IDs
 *   - render*: §16 issue body / dedup comment / retest comment rendering
 *     (hypothesis firewall, §14.1)
 *
 * Usage:
 *   import { IssueGateway, GitHubStub, makeAuditSink, makeIssueIdFactory } from "nightwatch/issue/lib/index.mjs";
 */
export { IssueGateway, PUBLISH_GATES, MIN_REPRODUCE_RATE, canonicalJson, makePolicyDecision } from "./gateway.mjs";
export { makeApprovalRecord } from "./gateway.mjs";
export { buildDraft, PUBLISHABLE_CLASSIFICATION } from "./draft.mjs";
export {
  renderIssueTitle,
  renderIssueBody,
  renderDedupComment,
  renderRetestComment,
  HYPOTHESIS_SECTION_TITLE,
  HYPOTHESIS_DISCLAIMER,
} from "./render.mjs";
export { GitHubStub, GITHUB_CLIENT_METHODS, GITHUB_ADAPTER_INTERFACE } from "./github-stub.mjs";
export { scanDraftSecrets, scanTextSecrets } from "./secret-scan.mjs";
export { makeAuditSink, C13_ACTOR, ISSUE_ACTIONS, LOCAL_FALLBACK_DIR } from "./audit.mjs";
export { makeIssueIdFactory } from "./ids.mjs";
export { makeError, ERROR_CODES, isErrorEnvelope } from "./errors.mjs";
export {
  validate,
  validateIssueDraft,
  validatePublishReceipt,
  validateApprovalRecord,
  validatePolicyDecision,
  validateErrorEnvelope,
} from "./schemas.mjs";
