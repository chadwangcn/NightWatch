/**
 * NightWatch WP-07 — Local GitHub API Stub (C13, WorkRequest §5.4)
 *
 * ZERO real network: every GitHub interaction in P0 goes through this local
 * stub. It provides the exact client surface a real adapter would implement
 * (GITHUB_CLIENT_METHODS below) — a real networked adapter is deliberately
 * NOT implemented in P0 (WP-10 E2E stage is separately authorized) and would
 * be a drop-in replacement satisfying the same interface shape:
 *
 *   searchIssues({ state?, fingerprint_hash?, title_contains? }) → {ok, issues}
 *   getIssue(number)                                           → {ok, issue} | {ok:false, error}
 *   createIssue({ title, body, labels, fingerprint_hash })     → {ok, issue}          [WRITE]
 *   addComment({ issue_number, body })                         → {ok, comment}        [WRITE]
 *
 * Write-call accounting (the verify assertion surface):
 *   - every createIssue / addComment call is appended to an in-memory write
 *     log (op, issue number, title, body length + sha256 — never the body
 *     itself), enabling exact "zero writes / single write" assertions;
 *   - a preset issue list can be injected (fingerprint-dedup test cases).
 */
import { makeError, ERROR_CODES } from "./errors.mjs";
import { sha256hex } from "./secret-scan.mjs";

export const GITHUB_CLIENT_METHODS = ["searchIssues", "getIssue", "createIssue", "addComment"];

const SYNTHETIC_REPO = "synthetic-org/synthetic-repo";

export class GitHubStub {
  /**
   * @param {object} [options]
   *   issues  — preset issue list: [{number, title, body, labels, state,
   *             fingerprint_hash?, comments?}] (dedup fixtures)
   *   clock   — () => ISO string (deterministic in verify)
   */
  constructor({ issues = [], clock = () => new Date().toISOString() } = {}) {
    this._clock = clock;
    this._issues = new Map(); // number → issue
    this._writes = []; // every WRITE call, in order
    this._reads = 0;
    for (const preset of issues) {
      const number = Number(preset.number);
      this._issues.set(number, {
        number,
        title: preset.title,
        body: preset.body ?? "",
        labels: [...(preset.labels ?? [])],
        state: preset.state ?? "open",
        fingerprint_hash: preset.fingerprint_hash ?? null,
        created_at: preset.created_at ?? this._clock(),
        comments: [...(preset.comments ?? [])],
      });
    }
    this._nextNumber = this._issues.size > 0 ? Math.max(...this._issues.keys()) + 1 : 1;
  }

  /** READ: search issues (default: open issues). */
  searchIssues({ state = "open", fingerprint_hash = null, title_contains = null } = {}) {
    this._reads += 1;
    const issues = [...this._issues.values()]
      .filter((i) => i.state === state)
      .filter((i) => (fingerprint_hash === null ? true : i.fingerprint_hash === fingerprint_hash))
      .filter((i) => (title_contains === null ? true : i.title.includes(title_contains)))
      .sort((a, b) => a.number - b.number)
      .map((i) => this._copyIssue(i));
    return { ok: true, issues };
  }

  /** READ: fetch one issue by number. */
  getIssue(number) {
    this._reads += 1;
    const issue = this._issues.get(Number(number));
    if (!issue) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `issue #${number} not found in the local GitHub stub`, { reason: "issue_not_found", issue_number: Number(number) }) };
    }
    return { ok: true, issue: this._copyIssue(issue) };
  }

  /** WRITE: create an issue. */
  createIssue({ title, body, labels = [], fingerprint_hash = null }) {
    if (typeof title !== "string" || title.length === 0 || typeof body !== "string" || body.length === 0) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "createIssue requires a non-empty title and body", { reason: "invalid_issue_payload" }) };
    }
    const number = this._nextNumber;
    this._nextNumber += 1;
    const issue = {
      number,
      title,
      body,
      labels: [...labels],
      state: "open",
      fingerprint_hash: fingerprint_hash ?? null,
      created_at: this._clock(),
      comments: [],
    };
    this._issues.set(number, issue);
    this._writes.push({
      op: "createIssue",
      at: issue.created_at,
      issue_number: number,
      title,
      body_chars: body.length,
      body_sha256: sha256hex(body),
    });
    return { ok: true, issue: this._copyIssue(issue) };
  }

  /** WRITE: append a comment to an issue. */
  addComment({ issue_number, body }) {
    if (typeof body !== "string" || body.length === 0) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "addComment requires a non-empty body", { reason: "invalid_comment_payload" }) };
    }
    const issue = this._issues.get(Number(issue_number));
    if (!issue) {
      return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, `issue #${issue_number} not found in the local GitHub stub`, { reason: "issue_not_found", issue_number: Number(issue_number) }) };
    }
    const comment = { id: issue.comments.length + 1, body, created_at: this._clock() };
    issue.comments.push(comment);
    this._writes.push({
      op: "addComment",
      at: comment.created_at,
      issue_number: issue.number,
      body_chars: body.length,
      body_sha256: sha256hex(body),
    });
    return { ok: true, comment: { ...comment } };
  }

  _copyIssue(issue) {
    return { ...issue, labels: [...issue.labels], comments: issue.comments.map((c) => ({ ...c })) };
  }

  /** Ordered copy of every write call (verify assertion surface). */
  writeCalls() {
    return this._writes.map((w) => ({ ...w }));
  }

  /** Number of write calls, optionally filtered by op ("createIssue"|"addComment"). */
  writeCount(op = null) {
    return this._writes.filter((w) => (op === null ? true : w.op === op)).length;
  }

  /** Read-call count (searchIssues/getIssue; informational). */
  get readCount() {
    return this._reads;
  }

  /** External issue reference shape used in receipts (e.g. "synthetic-org/synthetic-repo#42"). */
  static issueRef(number) {
    return `${SYNTHETIC_REPO}#${number}`;
  }

  issueRef(number) {
    return GitHubStub.issueRef(number);
  }
}

/** Real-adapter interface shape documentation constant (see module header; P0: stub only). */
export const GITHUB_ADAPTER_INTERFACE = {
  methods: GITHUB_CLIENT_METHODS,
  network: false,
  note: "P0 implements the local stub only; a real networked adapter (WP-10 E2E authorization) must satisfy the same method surface and semantics.",
};
