/**
 * NightWatch WP-09 — Console HTTP/SSE server (C01 transport, §13.3)
 *
 * Binds the WP-08 library-level Control API (seven commands + approval host
 * adapter + event stream + display DTOs) to a LOCAL-ONLY HTTP surface:
 *
 *   POST /commands/:name   seven WP-00 commands; body = command envelope
 *                          (command_id/issued_at/deadline/payload); the
 *                          ControlApi result is returned VERBATIM
 *   POST /approvals        body = approval fields → WP-04 makeApprovalRecord
 *                          → orchestrator.registerApproval + one WP-03 audit
 *                          event (idempotency key = scope + approved_at)
 *   GET  /sessions         listSessions display DTO
 *   GET  /sessions/:id     sessionView display DTO (unknown id → 404 JSON)
 *   GET  /events           SSE: history() replay first, then live
 *                          subscribe; optional ?object_id= filter (forObject
 *                          semantics)
 *   GET  / + /assets/*     static UI assets from nightwatch/console/public
 *                          (fixed whitelist — no path composition, no "..")
 *
 * Frozen error mapping (asserted by verify.mjs):
 *   - transport auth: missing/wrong Bearer token on a write → HTTP 401 with a
 *     CTL_UNAUTHORIZED envelope;
 *   - unknown route/method, unknown session id, path-shaped object ids →
 *     HTTP 404/405/400 with a CTL_VALIDATION_FAILED envelope;
 *   - EVERY business error from ControlApi / components (CTL_*, ISS_*,
 *     EXE_*, POL_* …) → HTTP 200 + {ok:false, error:{…}} passed through
 *     UNCHANGED (no rewriting, no swallowing).
 *
 * Security (§13.3 hard gates):
 *   - listens on 127.0.0.1 ONLY (listen() pins the host);
 *   - one-shot capability token generated at startup; all WRITE operations
 *     require Authorization: Bearer <token>;
 *   - object ids are never composed into file paths (sessions are looked up
 *     as object keys; static assets come from a fixed whitelist);
 *   - output-side secret scan on every JSON body and SSE frame (hits are
 *   redacted before the socket ever sees them).
 *
 * SSE frame format (frozen):
 *   event: <event_name>\n
 *   id: <event_id>\n
 *   data: {"name":"<event_name>","event":{…full WP-00 event envelope…}}\n
 *   \n
 * plus a ": keep-alive\n\n" comment frame every 15s.
 */
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { makeApprovalRecord } from "../../policy/lib/gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../nightwatch/console/lib
const CONSOLE_ROOT = join(HERE, "..");
export const PUBLIC_DIR = join(CONSOLE_ROOT, "public");

/** Static asset whitelist: route → [relative path inside public/, mime]. */
const ASSET_ROUTES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/assets/style.css", ["assets/style.css", "text/css; charset=utf-8"]],
  ["/assets/app.js", ["assets/app.js", "text/javascript; charset=utf-8"]],
]);

/** Session object ids are the ONLY shape ever reaching the session store. */
const SESSION_ID_RE = /^session_[0-9A-HJKMNP-TV-Z]{26}$/;

const MAX_BODY_BYTES = 1_000_000;

/* Output-side secret scan (same pattern family as the WP-00/WP-08 scanners;
 * hits are redacted in place — the socket never sees the secret). */
const SECRET_PATTERNS = [
  ["aws-access-key-id", /AKIA[0-9A-Z]{16}/g],
  ["aws-temp-access-key", /ASIA[0-9A-Z]{16}/g],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{36}/g],
  ["openai-style-key", /sk-[A-Za-z0-9_-]{20,}/g],
  ["slack-token", /xox[baprs]-[0-9A-Za-z-]{10,}/g],
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /eyJhbGciOi[A-Za-z0-9_-]{10,}\./g],
];
const redactSecrets = (text) => {
  let out = text;
  for (const [label, re] of SECRET_PATTERNS) out = out.replace(re, `[REDACTED:${label}]`);
  return out;
};

/* ------------------------------------------------------------------ */
/* Error envelopes (registered CTL_* codes only — never invented)      */
/* ------------------------------------------------------------------ */
const envelope = (code, message, details) => ({ code, message, retryable: false, idempotent_replay: false, ...(details ? { details } : {}) });
const unauthorized = (reason) => envelope("CTL_UNAUTHORIZED", `write operations require a valid Bearer capability token (${reason})`, { reason });
const notFoundRoute = (path) => envelope("CTL_VALIDATION_FAILED", `route not found: ${path}`, { reason: "route_not_found" });
const methodNotAllowed = (method, path) => envelope("CTL_VALIDATION_FAILED", `method ${method} not allowed on ${path}`, { reason: "method_not_allowed" });

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */
function sendJson(res, status, obj) {
  const body = redactSecrets(JSON.stringify(obj));
  const buf = Buffer.from(body, "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length });
  res.end(buf);
}

/** Read (and length-cap) one request body as text. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */
function writeEventFrame(res, { name, event }) {
  const data = redactSecrets(JSON.stringify({ name, event }));
  res.write(`event: ${name}\nid: ${event.event_id}\ndata: ${data}\n\n`, "utf8");
}

function handleEvents(req, res, events, sseConnections) {
  const url = new URL(req.url, "http://127.0.0.1");
  const objectId = url.searchParams.get("object_id"); // null ⇒ unfiltered
  const matches = (entry) => objectId === null || entry.event.object_id === objectId;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  sseConnections.add(res);
  let replayDone = false;
  const pending = [];
  const off = events.subscribe((entry) => {
    if (!matches(entry)) return;
    if (replayDone) writeEventFrame(res, entry);
    else pending.push(entry);
  });
  // History replay happens synchronously right after subscribe(): the Node
  // event loop cannot interleave an emit here, so replay-then-live is exact.
  for (const entry of events.history()) {
    if (matches(entry)) writeEventFrame(res, entry);
  }
  replayDone = true;
  for (const entry of pending.splice(0)) writeEventFrame(res, entry);
  res.write(": stream-open\n\n", "utf8");
  const ping = setInterval(() => {
    try {
      res.write(": keep-alive\n\n", "utf8");
    } catch {
      /* connection gone — cleaned up by the close handler */
    }
  }, 15_000);
  res.on("close", () => {
    clearInterval(ping);
    off();
    sseConnections.delete(res);
  });
}

/* ------------------------------------------------------------------ */
/* Console server                                                      */
/* ------------------------------------------------------------------ */

/**
 * Build the console HTTP server over one deployment.
 *
 * @param {object} options
 *   deployment — from buildDeployment() (real components, WP-08 surfaces)
 *   token?     — capability token (generated when omitted)
 *   publicDir? — static UI root (defaults to nightwatch/console/public)
 * @returns {{server, token, listen, close}}
 */
export function buildConsoleServer({ deployment, token, publicDir = PUBLIC_DIR }) {
  if (!deployment?.api || !deployment?.orchestrator || !deployment?.events) {
    throw new TypeError("buildConsoleServer requires a full deployment (api/orchestrator/events)");
  }
  const capabilityToken = token ?? randomBytes(24).toString("hex");
  const sseConnections = new Set();
  const { api, orchestrator, events, registry, library, evidence, findings } = deployment;

  const bearerOk = (header) => {
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const supplied = header.slice("Bearer ".length);
    const a = Buffer.from(supplied, "utf8");
    const b = Buffer.from(capabilityToken, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname;
      const method = req.method;

      /* ---------------- static UI (whitelist only) ------------------ */
      if (method === "GET" || method === "HEAD") {
        const asset = ASSET_ROUTES.get(pathname);
        if (asset) {
          const [rel, mime] = asset;
          const buf = readFileSync(join(publicDir, rel)); // fixed whitelist — never user input
          res.writeHead(200, { "Content-Type": mime, "Content-Length": buf.length, "Cache-Control": "no-store" });
          res.end(method === "HEAD" ? undefined : buf);
          return;
        }
      }

      /* ---------------- SSE event stream ---------------------------- */
      if (pathname === "/events") {
        if (method !== "GET") return sendJson(res, 405, { ok: false, error: methodNotAllowed(method, "/events") });
        return handleEvents(req, res, events, sseConnections);
      }

      /* ---------------- write auth boundary ------------------------- */
      const isWrite = (method === "POST" && pathname === "/approvals") || (method === "POST" && pathname.startsWith("/commands/"));
      if (isWrite && !bearerOk(req.headers.authorization)) {
        const reason = typeof req.headers.authorization === "string" ? "invalid_token" : "missing_bearer_token";
        return sendJson(res, 401, { ok: false, error: unauthorized(reason) });
      }

      /* ---------------- commands (seven WP-00 commands) ------------- */
      if (pathname.startsWith("/commands/")) {
        if (method !== "POST") return sendJson(res, 405, { ok: false, error: methodNotAllowed(method, pathname) });
        const name = decodeURIComponent(pathname.slice("/commands/".length));
        const raw = await readBody(req);
        let envelopeBody;
        try {
          envelopeBody = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { ok: false, error: envelope("CTL_VALIDATION_FAILED", "request body is not valid JSON", { reason: "invalid_json" }) });
        }
        // ControlApi owns validation/deadline/idempotency/routing — its
        // verdict (including CTL_* envelopes) is passed through VERBATIM.
        const result = await api.execute(name, envelopeBody);
        return sendJson(res, 200, result);
      }

      /* ---------------- approvals (host adapter) -------------------- */
      if (pathname === "/approvals") {
        if (method !== "POST") return sendJson(res, 405, { ok: false, error: methodNotAllowed(method, "/approvals") });
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { ok: false, error: envelope("CTL_VALIDATION_FAILED", "request body is not valid JSON", { reason: "invalid_json" }) });
        }
        const built = makeApprovalRecord(body);
        if (!built.ok) return sendJson(res, 200, { ok: false, error: built.error });
        const record = built.approval;
        orchestrator.registerApproval(record);
        // WP-03 audit (idempotent): key = scope + approved_at; the timestamp
        // comes from the record itself, so an identical retry replays exactly.
        const audited = deployment.passState.audit.record({
          actor: "C01-console",
          action: "approval.register",
          target: { object_type: "approval_record", object_id: record.scope },
          timestamp: record.approved_at,
          idempotency_key: `${record.scope}:${record.approved_at}`,
        });
        if (!audited.ok) return sendJson(res, 200, { ok: false, error: audited.error });
        return sendJson(res, 200, { ok: true, registered: record.scope, idempotent_replay: audited.idempotent_replay === true });
      }

      /* ---------------- display DTOs -------------------------------- */
      if (pathname === "/sessions") {
        if (method !== "GET") return sendJson(res, 405, { ok: false, error: methodNotAllowed(method, "/sessions") });
        return sendJson(res, 200, { ok: true, sessions: api.listSessions() });
      }

      /* ---------------- registry / catalog ------------------------- */
      if (pathname === "/registry/apis" && method === "GET") {
        return sendJson(res, 200, { ok: true, apis: registry.listApis() });
      }
      if (pathname.startsWith("/registry/apis/") && method === "GET") {
        const apiId = decodeURIComponent(pathname.slice("/registry/apis/".length));
        const inv = registry.getInventory(apiId);
        if (!inv) return sendJson(res, 404, { ok: false, error: notFoundRoute(pathname) });
        return sendJson(res, 200, { ok: true, inventory: inv });
      }

      /* ---------------- library ------------------------------------ */
      if (pathname === "/library/cases" && method === "GET") {
        const caseIds = library.listCaseIds();
        const cases = caseIds.map((id) => library.getCase(id)).filter(Boolean);
        return sendJson(res, 200, { ok: true, cases });
      }
      if (pathname.startsWith("/library/cases/") && method === "GET") {
        const caseId = decodeURIComponent(pathname.slice("/library/cases/".length));
        const c = library.getCase(caseId);
        if (!c) return sendJson(res, 404, { ok: false, error: notFoundRoute(pathname) });
        return sendJson(res, 200, { ok: true, case: c });
      }
      if (pathname === "/library/scenarios" && method === "GET") {
        const scenDir = join(library.rootDir, "scenarios");
        let scenarioIds = [];
        try { scenarioIds = readdirSync(scenDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort(); } catch { /* dir not yet created */ }
        const scenarios = scenarioIds.map((id) => library.getScenario(id)).filter(Boolean);
        return sendJson(res, 200, { ok: true, scenarios });
      }

      /* ---------------- evidence / findings ------------------------- */
      if (pathname === "/evidence/runs" && method === "GET") {
        const runsDir = join(evidence.rootDir, "runs");
        let runIds = [];
        try { runIds = readdirSync(runsDir).filter((d) => !d.startsWith(".")).sort(); } catch { /* dir not yet created */ }
        return sendJson(res, 200, { ok: true, run_ids: runIds });
      }
      if (pathname === "/findings" && method === "GET") {
        return sendJson(res, 200, { ok: true, findings: findings.list() });
      }

      /* ---------------- audit log ---------------------------------- */
      if (pathname === "/audit" && method === "GET") {
        const events_ = events.history();
        return sendJson(res, 200, { ok: true, events: events_.map((e) => ({ event_id: e.event.event_id, sequence: e.event.sequence, name: e.name, object_id: e.event.object_id, timestamp: e.event.timestamp, payload: e.event.payload })) });
      }
      if (pathname.startsWith("/sessions/")) {
        if (method !== "GET") return sendJson(res, 405, { ok: false, error: methodNotAllowed(method, "/sessions/:id") });
        let id;
        try {
          id = decodeURIComponent(pathname.slice("/sessions/".length));
        } catch {
          return sendJson(res, 404, { ok: false, error: envelope("CTL_VALIDATION_FAILED", "malformed session id", { reason: "invalid_session_id" }) });
        }
        // Object ids are never file paths: anything not shaped like a session
        // id (including "..", absolute paths, traversal forms) is rejected
        // BEFORE any store lookup — zero filesystem side effects.
        if (!SESSION_ID_RE.test(id)) {
          return sendJson(res, 404, { ok: false, error: envelope("CTL_VALIDATION_FAILED", `session ${id} not found`, { reason: "session_not_found" }) });
        }
        const view = api.sessionView(id);
        if (!view.ok) return sendJson(res, 404, { ok: false, error: view.error });
        return sendJson(res, 200, view);
      }

      return sendJson(res, 404, { ok: false, error: notFoundRoute(pathname) });
    } catch (err) {
      if (err?.message === "body_too_large") {
        return sendJson(res, 400, { ok: false, error: envelope("CTL_VALIDATION_FAILED", "request body exceeds the 1MB limit", { reason: "body_too_large" }) });
      }
      return sendJson(res, 400, { ok: false, error: envelope("CTL_VALIDATION_FAILED", "malformed request", { reason: "bad_request" }) });
    }
  });

  /** Listen on the loopback interface ONLY (§13.3-1; the host is pinned). */
  const listen = (port = 0) =>
    new Promise((resolve) => {
      server.listen(port, "127.0.0.1", () => resolve(server.address()));
    });

  /** Force-close: destroy live SSE/keep-alive sockets, then the listener. */
  const close = async () => {
    for (const res of sseConnections) {
      try {
        res.destroy();
      } catch {
        /* already gone */
      }
    }
    sseConnections.clear();
    await new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
  };

  return { server, token: capabilityToken, listen, close };
}
