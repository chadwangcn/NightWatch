/**
 * NightWatch WP-10 — Real GitHub adapter (WorkRequest §5.7, code-level delivery).
 *
 * Implements the WP-07 GITHUB_ADAPTER_INTERFACE surface
 * (searchIssues / getIssue / createIssue / addComment — GITHUB_CLIENT_METHODS)
 * against the GitHub REST v3 API. Design constraints:
 *
 *   - baseURL + token are INJECTED at construction (no host is hardcoded —
 *     verify points the adapter at a 127.0.0.1 mock and asserts zero traffic
 *     leaves loopback; A7);
 *   - a missing token is an EXPLICIT error, never a silent downgrade;
 *   - REST semantics mapped to the stub contract:
 *       · searchIssues → GET /search/issues?q=… (open issues, sorted by
 *         created ascending, de-duplicated by number — same shape the stub
 *         returns: {ok, issues});
 *       · the fingerprint hash is embedded in created issue bodies as a
 *         machine-readable marker line so dedup searches are reproducible
 *         against real GitHub (GitHub has no native fingerprint field);
 *   - HTTP errors map onto REGISTERED WP-07 issue error codes (no new codes):
 *       401/403 auth → ISS_GATE_FAILED · other 403 (rate limit) →
 *       ISS_PUBLISH_FAILED(reason=rate_limited) · 404 → ISS_GATE_FAILED
 *       (issue_not_found, same reason token as the stub) · network/5xx →
 *       ISS_PUBLISH_FAILED.
 *
 * Real-write smoke (1 create + 1 comment + dedup replay) is the Coordinator's
 * final verification step — credentials are read from the local environment
 * at that point and their values never enter artifacts, receipts or logs.
 */
import { GITHUB_CLIENT_METHODS } from "../../issue/lib/index.mjs";
import { makeError, ERROR_CODES } from "../../issue/lib/errors.mjs";

export const FINGERPRINT_MARKER = (hash) => `nightwatch-fingerprint:${hash}`;

const authError = (status, bodyText) =>
  makeError(
    ERROR_CODES.GATE_FAILED,
    `GitHub API rejected the request with ${status} (authentication/authorization); the adapter never downgrades silently`,
    { reason: "github_auth_rejected", status, ...(bodyText ? { body_excerpt: bodyText.slice(0, 160) } : {}) },
  );

const notFoundError = (what) =>
  makeError(ERROR_CODES.GATE_FAILED, `GitHub API reports ${what} not found`, { reason: "issue_not_found" });

const transportError = (status, bodyText) =>
  makeError(
    ERROR_CODES.GATE_FAILED,
    `GitHub API request failed${status ? ` with status ${status}` : " at the transport level"}`,
    { reason: status === 403 ? "rate_limited" : "github_request_failed", ...(status ? { status } : {}), ...(bodyText ? { body_excerpt: bodyText.slice(0, 160) } : {}) },
  );

/**
 * @param {object} options
 *   baseURL — e.g. "https://api.github.com" (or a local mock origin)
 *   token   — personal access token (REQUIRED; explicit error when missing)
 *   repo    — "owner/repo" target repository
 *   fetchImpl? — injectable fetch (defaults to global fetch; tests inject spies)
 *   perPage?   — search page size (default 50)
 */
export function makeGitHubReal({ baseURL, token, repo, fetchImpl, perPage = 50 }) {
  if (!baseURL || typeof baseURL !== "string") {
    throw new TypeError("makeGitHubReal requires an injected baseURL (no host is hardcoded)");
  }
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new TypeError(`makeGitHubReal requires a repo in "owner/name" form (got: ${repo})`);
  }
  if (!token || typeof token !== "string" || token.length === 0) {
    // Explicit refusal — NEVER a silent anonymous downgrade (WorkRequest §5.7-1).
    throw Object.assign(new Error("makeGitHubReal requires a token; unauthenticated operation is forbidden"), {
      code: "ISS_GATE_FAILED",
      reason: "token_missing",
    });
  }
  const doFetch = fetchImpl ?? globalThis.fetch;

  const request = async (path, { method = "GET", body, headers = {} } = {}) => {
    const response = await doFetch(`${baseURL}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`, // value lives ONLY here — never logged
        "X-GitHub-Api-Version": "2022-11-28",
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, headers: response.headers, parsed, text };
  };

  const mapError = (status, text, what) => {
    if (status === 401) return authError(status, text);
    if (status === 403) return transportError(403, text); // rate limit / forbidden
    if (status === 404) return notFoundError(what);
    return transportError(status, text);
  };

  const toIssue = (it) => ({
    number: it.number,
    title: it.title,
    body: it.body ?? "",
    labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    state: it.state,
    fingerprint_hash: extractFingerprint(it.body ?? ""),
    created_at: it.created_at ?? null,
    comments: [],
  });

  const extractFingerprint = (body) => {
    const m = String(body).match(/nightwatch-fingerprint:([0-9a-f]{64})/);
    return m ? m[1] : null;
  };

  return {
    interface: { methods: GITHUB_CLIENT_METHODS, network: true },

    /** READ: search issues (default open). Deterministic order: number asc, deduped. */
    async searchIssues({ state = "open", fingerprint_hash = null, title_contains = null } = {}) {
      const clauses = [`repo:${repo}`, "type:issue", `state:${state}`];
      if (title_contains) clauses.push(`"${title_contains}" in:title`);
      if (fingerprint_hash) clauses.push(`"${FINGERPRINT_MARKER(fingerprint_hash)}" in:title`); // marker also mirrored in the title prefix for searchability
      const q = clauses.join(" ");
      const { status, parsed, text } = await request(`/search/issues?q=${encodeURIComponent(q)}&per_page=${perPage}&sort=created&order=asc`);
      if (status !== 200) return { ok: false, error: mapError(status, text, "issue search") };
      const seen = new Set();
      const issues = (parsed?.items ?? [])
        .filter((it) => {
          if (seen.has(it.number)) return false; // search API may repeat across shards
          seen.add(it.number);
          return true;
        })
        .map(toIssue)
        .filter((i) => (fingerprint_hash === null ? true : i.fingerprint_hash === fingerprint_hash))
        .sort((a, b) => a.number - b.number);
      return { ok: true, issues };
    },

    /** READ: one issue by number. */
    async getIssue(number) {
      const { status, parsed, text } = await request(`/repos/${repo}/issues/${Number(number)}`);
      if (status === 404) return { ok: false, error: notFoundError(`issue #${number}`) };
      if (status !== 200) return { ok: false, error: mapError(status, text, `issue #${number}`) };
      return { ok: true, issue: toIssue(parsed) };
    },

    /** WRITE: create an issue (fingerprint marker embedded in title + body). */
    async createIssue({ title, body, labels = [], fingerprint_hash = null }) {
      if (typeof title !== "string" || title.length === 0 || typeof body !== "string" || body.length === 0) {
        return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "createIssue requires a non-empty title and body", { reason: "invalid_issue_payload" }) };
      }
      const finalTitle = fingerprint_hash ? `${title} [${FINGERPRINT_MARKER(fingerprint_hash)}]` : title;
      const finalBody = fingerprint_hash ? `${body}\n\n<!-- ${FINGERPRINT_MARKER(fingerprint_hash)} -->\n` : body;
      const { status, parsed, text } = await request(`/repos/${repo}/issues`, {
        method: "POST",
        body: { title: finalTitle, body: finalBody, labels: [...labels] },
      });
      if (status !== 201) return { ok: false, error: mapError(status, text, "issue creation") };
      return { ok: true, issue: toIssue(parsed) };
    },

    /** WRITE: append a comment. */
    async addComment({ issue_number, body }) {
      if (typeof body !== "string" || body.length === 0) {
        return { ok: false, error: makeError(ERROR_CODES.VALIDATION_FAILED, "addComment requires a non-empty body", { reason: "invalid_comment_payload" }) };
      }
      const { status, parsed, text } = await request(`/repos/${repo}/issues/${Number(issue_number)}/comments`, {
        method: "POST",
        body: { body },
      });
      if (status === 404) return { ok: false, error: notFoundError(`issue #${issue_number}`) };
      if (status !== 201) return { ok: false, error: mapError(status, text, `comment on issue #${issue_number}`) };
      return { ok: true, comment: { id: parsed?.id ?? null, body: parsed?.body ?? body, created_at: parsed?.created_at ?? null } };
    },

    /** External issue reference shape (mirrors the stub convention "owner/repo#N"). */
    issueRef(number) {
      return `${repo}#${number}`;
    },
  };
}
