/**
 * NightWatch WP-10 — Local GitHub REST semantic mock (WorkRequest §5.7-2).
 *
 * A 127.0.0.1 node:http service implementing the GitHub REST v3 API semantic
 * subset needed by the real adapter (github-real.mjs) for verify. The mock
 * exercises the SAME adapter code path that would hit api.github.com — the
 * only difference is the baseURL pointing here. This proves:
 *
 *   - searchIssues → GET /search/issues?q=… (sorted by number asc, deduped)
 *   - createIssue  → POST /repos/:owner/:repo/issues (fingerprint marker
 *                     in title enables dedup search)
 *   - addComment   → POST /repos/:owner/:repo/issues/:number/comments
 *   - getIssue     → GET /repos/:owner/:repo/issues/:number
 *   - 401 / 403 / 404 error semantics matching the adapter's mapping
 *
 * Every request is logged for the zero-external-traffic assertion (A7):
 * verify checks that ALL traffic went to 127.0.0.1.
 *
 * Determinism: no wall clock in any response payload; created_at /
 * updated_at use the injected clock; issue numbers are sequential from 1.
 * Same createIssue call → same issue number (idempotent marker dedup).
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
};

/**
 * Start the GitHub REST mock on an ephemeral 127.0.0.1 port.
 *
 * @param {object} options
 *   clock — () => ISO string (deterministic; verify pins it)
 *   failMode — if set to "401" / "403" / "404" / "5xx", every request
 *              returns that status (for adapter error-mapping tests)
 * @returns {Promise<{server, port, baseUrl, requestLog, close}>}
 *   requestLog — array of {method, path, status} for traffic assertions
 */
export function startGitHubMock({ clock = () => new Date(0).toISOString(), failMode = null } = {}) {
  const issues = [];
  let nextNumber = 1;
  const requestLog = [];

  function route(req, res, path, url, bodyText) {
    if (failMode === "401") { json(res, 401, { message: "Bad credentials" }); return 401; }
    if (failMode === "403") { json(res, 403, { message: "API rate limit exceeded" }); return 403; }
    if (failMode === "404") { json(res, 404, { message: "Not Found" }); return 404; }
    if (failMode === "5xx") { json(res, 503, { message: "Server Error" }); return 503; }

    if (req.method === "GET" && path === "/search/issues") {
      return searchIssues(res, url);
    }

    const repoMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!repoMatch) {
      json(res, 404, { message: "Not Found" });
      return 404;
    }

    const [, , , sub] = repoMatch;

    const issueMatch = sub?.match(/^\/issues\/(\d+)$/);
    if (issueMatch && req.method === "GET") {
      return getIssue(res, Number(issueMatch[1]));
    }
    if (sub === "/issues" && req.method === "POST") {
      return createIssue(res, bodyText);
    }
    const commentMatch = sub?.match(/^\/issues\/(\d+)\/comments$/);
    if (commentMatch && req.method === "POST") {
      return addComment(res, Number(commentMatch[1]), bodyText);
    }

    json(res, 404, { message: "Not Found" });
    return 404;
  }

  function searchIssues(res, url) {
    const q = url.searchParams.get("q") || "";
    const stateMatch = q.match(/state:(\w+)/);
    const state = stateMatch ? stateMatch[1] : "open";
    const fingerprintMatch = q.match(/nightwatch-fingerprint:([0-9a-f]{64})/);

    let filtered = issues.filter((it) => {
      if (state !== "all" && it.state !== state) return false;
      if (fingerprintMatch) {
        return it.title.includes(`nightwatch-fingerprint:${fingerprintMatch[1]}`);
      }
      return true;
    });

    const seen = new Set();
    filtered = filtered
      .sort((a, b) => a.number - b.number)
      .filter((it) => {
        if (seen.has(it.number)) return false;
        seen.add(it.number);
        return true;
      });

    json(res, 200, {
      total_count: filtered.length,
      incomplete_results: false,
      items: filtered.map(toGitHubIssueShape),
    });
    return 200;
  }

  function createIssue(res, bodyText) {
    let payload;
    try { payload = JSON.parse(bodyText); } catch { json(res, 422, { message: "Invalid body" }); return 422; }

    const title = payload.title || "";
    const body = payload.body || "";
    const labels = payload.labels || [];

    const fingerprintInTitle = title.match(/nightwatch-fingerprint:([0-9a-f]{64})/);
    if (fingerprintInTitle) {
      const existing = issues.find(
        (it) => it.state === "open" && it.title.includes(`nightwatch-fingerprint:${fingerprintInTitle[1]}`),
      );
      if (existing) {
        json(res, 201, toGitHubIssueShape(existing));
        return 201;
      }
    }

    const issue = {
      number: nextNumber++,
      title,
      body,
      labels: labels.map((l) => ({ name: l })),
      state: "open",
      created_at: clock(),
      updated_at: clock(),
      comments: [],
    };
    issues.push(issue);
    json(res, 201, toGitHubIssueShape(issue));
    return 201;
  }

  function getIssue(res, number) {
    const issue = issues.find((it) => it.number === number);
    if (!issue) {
      json(res, 404, { message: "Not Found" });
      return 404;
    }
    json(res, 200, toGitHubIssueShape(issue));
    return 200;
  }

  function addComment(res, number, bodyText) {
    const issue = issues.find((it) => it.number === number);
    if (!issue) {
      json(res, 404, { message: "Not Found" });
      return 404;
    }
    let payload;
    try { payload = JSON.parse(bodyText); } catch { json(res, 422, { message: "Invalid body" }); return 422; }
    const comment = {
      id: createHash("sha256").update(`${number}:${issue.comments.length}`).digest().readUInt32BE(0),
      body: payload.body || "",
      created_at: clock(),
    };
    issue.comments.push(comment);
    json(res, 201, comment);
    return 201;
  }

  function toGitHubIssueShape(issue) {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      state: issue.state,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      comments: issue.comments.length,
    };
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let status = 500;
      try {
        status = route(req, res, path, url, body);
      } catch {
        status = res.statusCode || 500;
      } finally {
        requestLog.push({ method: req.method, path: req.url, status });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        requestLog,
        issues,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
