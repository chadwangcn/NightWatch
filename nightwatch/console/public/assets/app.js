/* NightWatch Console — Agent QA 黑盒测试平台前端 (原生 JS, 零依赖) */
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const isoNow = () => new Date().toISOString();
  const isoPlus = (ms) => new Date(Date.now() + ms).toISOString();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shortId = (id) => id ? id.slice(0, 14) + "…" : "—";

  const EVENT_NAMES = ["sessionStateChanged", "runStarted", "runStepRecorded", "runCompleted", "observationRecorded", "findingClassified", "issueDrafted", "issuePublished"];

  const COMMAND_TEMPLATES = {
    createSession: { workspace_id: "my-workspace", goal: "QA 目标描述", authorization_boundary: "仅本地合成替身" },
    startRun: { session_id: "session_…", environment: "lumi-local", scenario_id: "scen_…" },
    cancelRun: { run_id: "run_…", reason: "人工取消" },
    retryRun: { run_id: "run_…" },
    resumeSession: { session_id: "session_…" },
    publishIssue: { draft_id: "draft_…" },
    retestIssue: { issue_ref: "nw-synthetic/#…" },
  };

  const state = {
    token: localStorage.getItem("nw_console_token") || "",
    currentSessionId: null,
    sessions: [],
    view: null,
    cases: [],
    currentCaseId: null,
    findings: [],
    evidenceRuns: [],
    auditEvents: [],
    seenEvents: new Map(),
  };

  /* ---------------- API ---------------- */
  async function api(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (method === "POST" && state.token) headers["Authorization"] = `Bearer ${state.token}`;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }

  function appendError(kind, envelope) {
    const area = $("error-area");
    const div = document.createElement("div");
    div.className = "error-item" + (kind.includes("401") ? " warn" : "");
    const code = envelope?.code ?? "UNKNOWN";
    const message = envelope?.message ?? "";
    div.innerHTML = `<span class="err-code">${esc(kind)}</span> · <span class="err-code">${esc(code)}</span> ${esc(message)}`;
    area.prepend(div);
    setTimeout(() => div.remove(), 10000);
  }

  function showResponse(label, obj) {
    $("last-response").textContent = `${label}\n${JSON.stringify(obj, null, 2)}`;
    $("last-response").classList.remove("muted");
  }

  function handleResult(label, { status, json }) {
    showResponse(label, json);
    if (status === 401) appendError(`HTTP 401 · ${label}`, json?.error);
    else if (json && json.ok === false) appendError(label, json?.error);
    return json;
  }

  /* ---------------- Tab navigation ---------------- */
  function switchTab(tab) {
    document.querySelectorAll(".nav-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
    if (tab === "dashboard") loadDashboard();
    if (tab === "sessions") loadSessions();
    if (tab === "library") loadCases();
    if (tab === "findings") loadFindings();
    if (tab === "evidence") loadEvidence();
    if (tab === "audit") loadAudit();
  }

  /* ---------------- Dashboard ---------------- */
  async function loadDashboard() {
    const [sess, apis, cases, scens, finds, runs] = await Promise.all([
      api("GET", "/sessions"),
      api("GET", "/registry/apis"),
      api("GET", "/library/cases"),
      api("GET", "/library/scenarios"),
      api("GET", "/findings"),
      api("GET", "/evidence/runs"),
    ]);
    $("stat-sessions").querySelector(".stat-num").textContent = sess.json?.sessions?.length ?? 0;
    $("stat-apis").querySelector(".stat-num").textContent = apis.json?.apis?.length ?? 0;
    $("stat-cases").querySelector(".stat-num").textContent = cases.json?.cases?.length ?? 0;
    $("stat-scenarios").querySelector(".stat-num").textContent = scens.json?.scenarios?.length ?? 0;
    $("stat-findings").querySelector(".stat-num").textContent = finds.json?.findings?.length ?? 0;
    $("stat-runs").querySelector(".stat-num").textContent = runs.json?.run_ids?.length ?? 0;

    const recentSessions = (sess.json?.sessions ?? []).slice(-5).reverse();
    $("dash-sessions").innerHTML = recentSessions.map((s) =>
      `<div class="dash-item"><span class="state-badge ${esc(s.state)}">${esc(s.state)}</span> ${shortId(s.session_id)} — ${esc(s.goal)}</div>`
    ).join("") || '<p class="muted">暂无</p>';

    const recentFindings = (finds.json?.findings ?? []).slice(0, 5);
    $("dash-findings").innerHTML = recentFindings.map((f) =>
      `<div class="dash-item"><span class="badge-${esc(f.classification ?? 'unknown')}">${esc(f.classification ?? '—')}</span> ${shortId(f.finding_id)} — ${esc(f.method)} ${esc(f.path)}</div>`
    ).join("") || '<p class="muted">暂无</p>';
  }

  /* ---------------- Sessions ---------------- */
  async function loadSessions() {
    const { status, json } = await api("GET", "/sessions");
    handleResult("GET /sessions", { status, json });
    if (json?.ok) { state.sessions = json.sessions; renderSessionList(); }
  }

  function renderSessionList() {
    const ul = $("session-list");
    ul.innerHTML = "";
    $("session-list-empty").classList.toggle("hidden", state.sessions.length > 0);
    for (const s of state.sessions) {
      const li = document.createElement("li");
      li.dataset.sid = s.session_id;
      if (s.session_id === state.currentSessionId) li.classList.add("active");
      li.innerHTML = `<div class="sid">${shortId(s.session_id)}</div><div class="goal">${esc(s.goal)}</div><span class="state-badge ${esc(s.state)}">${esc(s.state)}</span>`;
      li.addEventListener("click", () => selectSession(s.session_id));
      ul.appendChild(li);
    }
  }

  async function selectSession(sid) {
    state.currentSessionId = sid;
    renderSessionList();
    await loadSessionView();
  }

  async function loadSessionView() {
    const sid = state.currentSessionId;
    if (!sid) return;
    const { status, json } = await api("GET", `/sessions/${encodeURIComponent(sid)}`);
    handleResult(`GET /sessions/${sid}`, { status, json });
    if (json?.ok) { state.view = json; renderSessionDetail(); }
  }

  function renderSessionDetail() {
    const v = state.view;
    if (!v) return;
    $("session-detail").classList.remove("hidden");
    $("detail-title").textContent = `会话 · ${shortId(v.session.session_id)}`;
    const s = v.session;
    $("detail-meta").innerHTML = `<div><strong>状态</strong>:<span class="state-badge ${esc(s.state)}">${esc(s.state)}</span>${s.blocked_reason ? ` blocked:${esc(s.blocked_reason)}` : ""}</div><div><strong>目标</strong>:${esc(s.goal)}</div>`;
    $("detail-runs").innerHTML = (v.runs ?? []).map((r) =>
      `<div class="run-item">${shortId(r.run_id)} · ${esc(r.scenario_id)} · outcome=<span class="${r.outcome === 'completed' ? 'ok-tag' : 'bad-tag'}">${esc(r.outcome ?? '-')}</span> · sealed=${r.sealed ? '✓' : '✗'}<div class="muted">findings:${esc((r.finding_ids ?? []).join(', ') || '-')}</div></div>`
    ).join("") || '<p class="muted">暂无 run</p>';
    $("detail-drafts").innerHTML = (v.drafts ?? []).map((d) =>
      `<div class="draft-item">${shortId(d.draft_id)} · finding:${shortId(d.finding_id)} · ${d.published ? '<span class="ok-tag">已发布</span>' : `<span class="bad-tag">未发布</span> <button type="button" class="tiny" data-scope="issue.publish:finding=${esc(d.finding_id)}">填入审批</button>`}</div>`
    ).join("") || '<p class="muted">暂无草稿</p>';
    $("detail-published").innerHTML = (v.published ?? []).map((p) =>
      `<div class="pub-item">${esc(p.issue_ref)} · ${shortId(p.receipt_id)}</div>`
    ).join("") || '<p class="muted">暂无发布</p>';
    renderTimeline();
  }

  function renderTimeline() {
    if (!state.currentSessionId) return;
    const entries = [...state.seenEvents.values()].filter(eventBelongsToCurrentSession).concat(state.view?.events ?? []);
    const dedup = new Map();
    for (const e of entries) dedup.set(e.event_id ?? e.event.event_id, e);
    const ordered = [...dedup.values()].sort((a, b) => (a.sequence ?? a.event.sequence) - (b.sequence ?? b.event.sequence));
    $("detail-events").innerHTML = ordered.map((e) => {
      const seq = e.sequence ?? e.event?.sequence ?? '?';
      const name = e.name ?? e.event?.name ?? '?';
      const oid = e.object_id ?? e.event?.object_id ?? '';
      const payload = e.payload ?? e.event?.payload ?? {};
      return `<div class="evt-item"><span class="evt-seq">#${seq}</span> <span class="evt-name">${esc(name)}</span> <span class="muted">${shortId(oid)}</span><div class="muted">${esc(JSON.stringify(payload).slice(0, 200))}</div></div>`;
    }).join("") || '<p class="muted">暂无事件</p>';
  }

  function eventBelongsToCurrentSession(entry) {
    if (!state.currentSessionId) return false;
    const e = entry.event ?? entry;
    const runs = new Set((state.view?.runs ?? []).map((r) => r.run_id));
    return e.object_id === state.currentSessionId || runs.has(e.object_id) || runs.has(e.payload?.run_id);
  }

  /* ---------------- Library ---------------- */
  async function loadCases() {
    const { json } = await api("GET", "/library/cases");
    if (json?.ok) { state.cases = json.cases; renderCaseList(); }
  }

  function renderCaseList() {
    const ul = $("case-list");
    ul.innerHTML = "";
    $("case-list-empty").classList.toggle("hidden", state.cases.length > 0);
    for (const c of state.cases) {
      const li = document.createElement("li");
      li.dataset.cid = c.case_id;
      if (c.case_id === state.currentCaseId) li.classList.add("active");
      li.innerHTML = `<div class="case-title">${esc(c.title ?? c.case_id)}</div><div class="muted">${esc(c.type ?? '—')} · ${esc(c.risk ?? '—')}</div><div class="sid">${shortId(c.case_id)}</div>`;
      li.addEventListener("click", () => selectCase(c.case_id));
      ul.appendChild(li);
    }
  }

  function selectCase(cid) {
    state.currentCaseId = cid;
    renderCaseList();
    const c = state.cases.find((x) => x.case_id === cid);
    if (c) $("case-detail-body").textContent = JSON.stringify(c, null, 2);
    $("case-detail-body").classList.remove("muted");
  }

  async function loadScenarios() {
    const { json } = await api("GET", "/library/scenarios");
    if (json?.ok) {
      $("scenario-list").innerHTML = (json.scenarios ?? []).map((sc) =>
        `<div class="scenario-card"><div class="scenario-name">${esc(sc.name)}</div><div class="muted">${esc(sc.description ?? '')}</div><div class="muted">cases:${sc.case_ids?.length ?? 0} · revision:${esc(sc.revision ?? '—')}</div></div>`
      ).join("") || '<p class="muted">暂无 Scenario</p>';
    }
  }

  /* ---------------- Findings ---------------- */
  async function loadFindings() {
    const { json } = await api("GET", "/findings");
    if (json?.ok) {
      state.findings = json.findings;
      const tbody = $("findings-table").querySelector("tbody");
      tbody.innerHTML = state.findings.map((f) => {
        const fp = f.fingerprint ?? {};
        const repro = f.reproduction_rate != null ? `${(f.reproduction_rate * 100).toFixed(0)}%` : '—';
        return `<tr><td class="mono">${shortId(f.finding_id)}</td><td><span class="badge-${esc(f.classification ?? 'unknown')}">${esc(f.classification ?? '—')}</span></td><td>${esc(fp.api_id ?? '—')}</td><td>${esc(fp.method ?? '—')}</td><td class="mono">${esc(fp.path ?? '—')}</td><td class="mono">${esc(f.fingerprint_hash?.slice(0, 12) ?? '—')}…</td><td>${repro}</td></tr>`;
      }).join("") || '<tr><td colspan="7" class="muted">暂无 Finding</td></tr>';
    }
  }

  /* ---------------- Evidence ---------------- */
  async function loadEvidence() {
    const { json } = await api("GET", "/evidence/runs");
    if (json?.ok) {
      state.evidenceRuns = json.run_ids;
      $("evidence-runs").innerHTML = json.run_ids.map((rid) =>
        `<div class="evidence-card"><div class="mono">${esc(rid)}</div></div>`
      ).join("") || '<p class="muted">暂无 Evidence Run</p>';
    }
  }

  /* ---------------- Audit ---------------- */
  async function loadAudit() {
    const { json } = await api("GET", "/audit");
    if (json?.ok) {
      state.auditEvents = json.events ?? [];
      const tbody = $("audit-table").querySelector("tbody");
      tbody.innerHTML = state.auditEvents.slice(-100).reverse().map((e) =>
        `<tr><td>${esc(e.sequence)}</td><td><span class="evt-name">${esc(e.name)}</span></td><td class="mono">${shortId(e.object_id)}</td><td class="muted">${esc(e.timestamp ?? '—')}</td><td class="muted">${esc(JSON.stringify(e.payload ?? {}).slice(0, 150))}</td></tr>`
      ).join("") || '<tr><td colspan="5" class="muted">暂无审计事件</td></tr>';
    }
  }

  /* ---------------- Command form ---------------- */
  let currentCommand = "createSession";
  const newCmdId = () => `cmd-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  function fillCommand(name) {
    currentCommand = name;
    document.querySelectorAll(".cmd-tab").forEach((b) => b.classList.toggle("active", b.dataset.cmd === name));
    $("cmd-id").value = newCmdId();
    $("cmd-issued").value = isoNow();
    $("cmd-deadline").value = isoPlus(10 * 60 * 1000);
    $("cmd-payload").value = JSON.stringify(COMMAND_TEMPLATES[name] ?? {}, null, 2);
  }

  async function submitCommand(ev) {
    ev.preventDefault();
    let payload;
    try { payload = JSON.parse($("cmd-payload").value); }
    catch { appendError("命令面板", { code: "CTL_VALIDATION_FAILED", message: "payload JSON 无效" }); return; }
    const body = { command_id: $("cmd-id").value.trim() || newCmdId(), issued_at: $("cmd-issued").value.trim() || isoNow(), deadline: $("cmd-deadline").value.trim() || isoPlus(600000), payload };
    const ret = handleResult(`POST /commands/${currentCommand}`, await api("POST", `/commands/${encodeURIComponent(currentCommand)}`, body));
    $("cmd-id").value = newCmdId();
    await loadSessions();
    await loadDashboard();
    if (ret?.ok && currentCommand === "createSession" && ret.result?.session_id) await selectSession(ret.result.session_id);
    else if (ret?.ok && state.currentSessionId) await loadSessionView();
  }

  /* ---------------- Approval ---------------- */
  function fillApprovalDefaults() { $("ap-approved-at").value = isoNow(); $("ap-expires-at").value = isoPlus(3600000); }

  async function submitApproval(ev) {
    ev.preventDefault();
    const body = { approver: $("ap-approver").value.trim(), decision: $("ap-decision").value, scope: $("ap-scope").value.trim(), approved_at: $("ap-approved-at").value.trim() || isoNow(), expires_at: $("ap-expires-at").value.trim() || isoPlus(3600000), reason: $("ap-reason").value.trim() };
    handleResult("POST /approvals", await api("POST", "/approvals", body));
    fillApprovalDefaults();
    if (state.currentSessionId) await loadSessionView();
  }

  /* ---------------- SSE ---------------- */
  function openEventStream() {
    const es = new EventSource("/events");
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (ev) => {
        try {
          const entry = JSON.parse(ev.data);
          if (!state.seenEvents.has(entry.event.event_id)) {
            state.seenEvents.set(entry.event.event_id, entry);
            if (state.currentSessionId && ["runCompleted", "issueDrafted", "issuePublished", "sessionStateChanged"].includes(name)) {
              loadSessionView().then(loadSessions).then(loadDashboard).catch(() => {});
            }
          }
        } catch {}
      });
    }
  }

  /* ---------------- Init ---------------- */
  function bind() {
    document.querySelectorAll(".nav-tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    $("token-save").addEventListener("click", () => { state.token = $("token-input").value.trim(); localStorage.setItem("nw_console_token", state.token); updateTokenState(); });
    $("token-input").value = state.token;
    updateTokenState();
    $("refresh-sessions").addEventListener("click", loadSessions);
    $("refresh-detail").addEventListener("click", loadSessionView);
    $("refresh-cases").addEventListener("click", loadCases);
    $("refresh-findings").addEventListener("click", loadFindings);
    $("refresh-evidence").addEventListener("click", loadEvidence);
    $("refresh-audit").addEventListener("click", loadAudit);
    document.querySelectorAll(".cmd-tab").forEach((b) => b.addEventListener("click", () => fillCommand(b.dataset.cmd)));
    $("cmd-regen").addEventListener("click", () => { $("cmd-id").value = newCmdId(); });
    $("command-form").addEventListener("submit", submitCommand);
    $("approval-form").addEventListener("submit", submitApproval);
    $("detail-drafts").addEventListener("click", (ev) => { const btn = ev.target.closest("button[data-scope]"); if (btn) { $("ap-scope").value = btn.dataset.scope; btn.scrollIntoView({ behavior: "smooth" }); } });
    fillCommand("createSession");
    fillApprovalDefaults();
  }

  function updateTokenState() {
    const el = $("token-state");
    if (state.token) { el.textContent = `已设置(${state.token.slice(0, 6)}…)`; el.classList.remove("muted"); }
    else { el.textContent = "未设置"; el.classList.add("muted"); }
  }

  bind();
  openEventStream();
  loadDashboard();
})();
