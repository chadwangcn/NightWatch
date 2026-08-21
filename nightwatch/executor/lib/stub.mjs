/**
 * NightWatch WP-05 — Golden Fault API local stub (WorkRequest §5.3).
 *
 * A deterministic LOCAL-ONLY node http server acting as the system under
 * test. It is a test fixture: it never connects to any external network and
 * only ever binds to 127.0.0.1 on an ephemeral port (dynamic; the verifier
 * starts and closes it in-process).
 *
 * Deterministic route table (fixed behaviour — same input, same output):
 *   GET  /healthz                → 200 {status:"ok"}
 *   GET  /v1/positive            → 200 {ok:true, value:42}
 *   GET  /v1/negative            → 400 {error:{code:"BAD_REQUEST",...}}
 *   POST /v1/widgets             → 201 {id:"wid-<n>", name, namespace}   (name
 *                                   required, else 400 VALIDATION_FAILED);
 *                                   mutable-state resource lifecycle (§5.3)
 *   GET  /v1/widgets/last        → 200 latest widget | 404 (stable alias so
 *                                   multi-step cases can read back what they
 *                                   created without templated path variables)
 *   GET  /v1/widgets/:id         → 200 | 404
 *   DELETE /v1/widgets/:id       → 204 first delete, 404 afterwards
 *                                   (IDEMPOTENT-delete semantics; ledger
 *                                   treats both as "cleaned")
 *   GET  /v1/edge/slow?ms=N      → 200 after N ms  (slow-response boundary)
 *   DELETE /v1/edge/slow?ms=N    → 204 after N ms  (slow DELETE: bounded-
 *                                   cleanup deadline boundary, §22.5.4)
 *   GET  /v1/edge/large          → 200 {count:1000, items:[...1000]} (large body)
 *   GET  /v1/edge/malformed      → 200 with a NON-JSON body (parser error path)
 *   GET  /v1/auth/protected      → 200 {authenticated:true,...} when the
 *                                   Authorization header carries a Bearer
 *                                   token with the synthetic- prefix; else 401
 *   ANY  /v1/error/500           → 500 (cleanup-failure injection)
 *
 * The server also counts every received request (per method+path template) so
 * the verifier can prove that a policy-DENIED execution sends ZERO traffic.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const LARGE_ITEMS = 1000;

const jsonReply = (res, status, body) => {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": payload.length });
  res.end(payload);
};

const textReply = (res, status, body, contentType = "text/plain") => {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": payload.length });
  res.end(payload);
};

/** Read the full request body (small synthetic payloads only). */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * Start the Golden Fault API stub on an ephemeral 127.0.0.1 port.
 * @returns {Promise<{server: import("node:http").Server, port: number, baseUrl: string,
 *                    requestCount: () => number, requestLog: () => Array<{method,path,status}>,
 *                    close: () => Promise<void>}>}
 */
export function startGoldenFaultStub() {
  return new Promise((resolve) => {
    const widgets = new Map(); // id → widget (insertion-ordered; last alias = most recent)
    let widgetSeq = 0;
    let totalRequests = 0;
    const log = [];

    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;
      const method = req.method;
      totalRequests += 1;

      let status = 500;
      try {
        if (path === "/healthz" && method === "GET") {
          status = 200;
          jsonReply(res, 200, { status: "ok" });
          return;
        }
        if (path === "/v1/positive" && method === "GET") {
          status = 200;
          jsonReply(res, 200, { ok: true, value: 42 });
          return;
        }
        if (path === "/v1/negative" && method === "GET") {
          status = 400;
          jsonReply(res, 400, { error: { code: "BAD_REQUEST", message: "synthetic negative response" } });
          return;
        }
        if (path === "/v1/widgets" && method === "POST") {
          const raw = await readBody(req);
          let parsed = null;
          try {
            parsed = raw.length > 0 ? JSON.parse(raw) : {};
          } catch {
            status = 400;
            jsonReply(res, 400, { error: { code: "VALIDATION_FAILED", message: "body is not valid JSON" } });
            return;
          }
          if (typeof parsed.name !== "string" || parsed.name.length === 0) {
            status = 400;
            jsonReply(res, 400, { error: { code: "VALIDATION_FAILED", message: "field 'name' is required" } });
            return;
          }
          widgetSeq += 1;
          const id = `wid-${String(widgetSeq).padStart(4, "0")}`;
          const widget = { id, name: parsed.name, namespace: typeof parsed.namespace === "string" ? parsed.namespace : "default" };
          widgets.set(id, widget);
          status = 201;
          jsonReply(res, 201, widget);
          return;
        }
        if (path === "/v1/widgets/last" && (method === "GET" || method === "DELETE")) {
          // Stable alias: "last" always resolves to the most recently created
          // widget, so multi-step cases can read AND delete what they created
          // without templated path variables. Without this, DELETE would fall
          // through to the :id route with a literal "last" id and always 404.
          const lastKey = [...widgets.keys()].pop();
          if (lastKey === undefined) {
            status = 404;
            jsonReply(res, 404, { error: { code: "NOT_FOUND", message: "no widget has been created" } });
            return;
          }
          if (method === "GET") {
            status = 200;
            jsonReply(res, 200, widgets.get(lastKey));
            return;
          }
          widgets.delete(lastKey);
          status = 204;
          res.writeHead(204).end();
          return;
        }
        const widgetMatch = path.match(/^\/v1\/widgets\/([A-Za-z0-9_-]+)$/);
        if (widgetMatch) {
          const id = widgetMatch[1];
          if (method === "GET") {
            if (!widgets.has(id)) {
              status = 404;
              jsonReply(res, 404, { error: { code: "NOT_FOUND", message: `widget ${id} does not exist` } });
              return;
            }
            status = 200;
            jsonReply(res, 200, widgets.get(id));
            return;
          }
          if (method === "DELETE") {
            // Idempotent delete: first call 204, subsequent calls 404 (§12.2 —
            // repeated DELETE is SAFE; the ledger treats 204/404 as cleaned).
            if (!widgets.has(id)) {
              status = 404;
              jsonReply(res, 404, { error: { code: "NOT_FOUND", message: `widget ${id} already deleted or never existed` } });
              return;
            }
            widgets.delete(id);
            status = 204;
            res.writeHead(204).end();
            return;
          }
        }
        if (path === "/v1/edge/slow" && (method === "GET" || method === "DELETE")) {
          const ms = Math.min(Number(url.searchParams.get("ms") || "100"), 30_000);
          // DELETE also honours the delay (204 after N ms): bounded-cleanup
          // scenarios override a resource's cleanup_path to this route so a
          // slow DELETE exercises the cleanup deadline (§22.5.4) instead of
          // falling through to the 404 no-route (which idempotent-delete
          // semantics would wrongly count as "cleaned").
          if (method === "DELETE") {
            status = 204;
            setTimeout(() => res.writeHead(204).end(), ms);
          } else {
            status = 200;
            setTimeout(() => jsonReply(res, 200, { ok: true, delayed_ms: ms }), ms);
          }
          return;
        }
        if (path === "/v1/edge/large" && method === "GET") {
          const items = [];
          for (let i = 0; i < LARGE_ITEMS; i += 1) items.push({ seq: i, tag: `item-${i}` });
          status = 200;
          jsonReply(res, 200, { count: LARGE_ITEMS, items, digest: createHash("sha256").update(JSON.stringify(items)).digest("hex") });
          return;
        }
        if (path === "/v1/edge/malformed" && method === "GET") {
          status = 200;
          textReply(res, 200, "<html>not-json{{malformed-boundary", "text/html");
          return;
        }
        if (path === "/v1/auth/protected" && method === "GET") {
          const auth = req.headers.authorization || "";
          const match = auth.match(/^Bearer (.+)$/);
          if (!match || !match[1].startsWith("synthetic-")) {
            status = 401;
            jsonReply(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or non-synthetic bearer token" } });
            return;
          }
          status = 200;
          jsonReply(res, 200, { authenticated: true, principal: "tested-api", token_fingerprint: createHash("sha256").update(match[1]).digest("hex").slice(0, 8) });
          return;
        }
        if (path === "/v1/error/500") {
          status = 500;
          jsonReply(res, 500, { error: { code: "INTERNAL", message: "synthetic cleanup failure" } });
          return;
        }
        status = 404;
        jsonReply(res, 404, { error: { code: "NOT_FOUND", message: `no route: ${method} ${path}` } });
      } finally {
        log.push({ method, path, status });
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        requestCount: () => totalRequests,
        requestLog: () => [...log],
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
