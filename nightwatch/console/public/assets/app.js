/* NightWatch WP-09 Console — 前端逻辑(原生 JS,零依赖零外链,仅 fetch 本地 API) */
"use strict";

(() => {
  /* ---------------- 基础工具 ---------------- */
  const $ = (id) => document.getElementById(id);
  const isoNow = () => new Date().toISOString();
  const isoPlus = (ms) => new Date(Date.now() + ms).toISOString();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const EVENT_NAMES = [
    "sessionStateChanged", "runStarted", "runStepRecorded", "runCompleted",
    "observationRecorded", "findingClassified", "issueDrafted", "issuePublished",
  ];

  const COMMAND_TEMPLATES = {
    createSession: { workspace_id: "my-workspace", goal: "描述本次 QA 目标", authorization_boundary: "仅本地合成替身,无生产系统" },
    startRun: { session_id: "session_...", environment: "lumi-local", scenario_id: "scen_01J00000000000000000000RC1" },
    cancelRun: { run_id: "run_...", reason: "人工取消" },
    retryRun: { run_id: "run_..." },
    resumeSession: { session_id: "session_..." },
    publishIssue: { draft_id: "draft_..." },
    retestIssue: { issue_ref: "nw-synthetic/#..." },
  };

  /* ---------------- 全局状态 ---------------- */
  const state = {
    token: localStorage.getItem("nw_console_token") || "",
    currentSessionId: null,
    sessions: [],
    view: null,          // 当前 sessionView DTO
    seenEvents: new Map(), // event_id → {name, event}(SSE 去重,断线重连后靠它跳过 history 重放)
  };

  /* ---------------- API 封装 ---------------- */
  async function api(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (method === "POST" && state.token) headers["Authorization"] = `Bearer ${state.token}`;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON 响应按空处理 */ }
    return { status: res.status, json };
  }

  /* ---------------- 错误与权限状态区 ---------------- */
  function appendError(kind, envelope) {
    const area = $("error-area");
    if (area.querySelector(".muted")) area.innerHTML = "";
    const div = document.createElement("div");
    div.className = "error-item" + (kind.startsWith("HTTP 401") ? " warn" : "");
    const code = envelope?.code ?? "UNKNOWN";
    const message = envelope?.message ?? "(无 message)";
    const details = envelope?.details ? `\n<pre>${esc(JSON.stringify(envelope.details, null, 2))}</pre>` : "";
    div.innerHTML = `<div><span class="err-code">${esc(kind)}</span> · <span class="err-code">${esc(code)}</span></div>` +
      `<div>${esc(message)}</div>${details}`;
    area.prepend(div);
  }

  function showResponse(label, obj) {
    $("last-response").textContent = `${label}\n` + JSON.stringify(obj, null, 2);
    $("last-response").classList.remove("muted");
  }

  function handleEnvelopeResult(label, { status, json }) {
    showResponse(label, json);
    if (status === 401) {
      appendError(`HTTP 401 · ${label}`, json?.error ?? { code: "CTL_UNAUTHORIZED", message: "写操作需要 Bearer token" });
      return json;
    }
    if (status === 404 || status === 400 || status === 405) {
      appendError(`HTTP ${status} · ${label}`, json?.error ?? { code: "CTL_VALIDATION_FAILED", message: "请求被拒绝" });
      return json;
    }
    if (json && json.ok === false) {
      appendError(label, json.error ?? { code: "CTL_VALIDATION_FAILED", message: "命令返回错误封装" });
    }
    return json;
  }

  /* ---------------- ① Session 列表 ---------------- */
  async function loadSessions() {
    const { status, json } = await api("GET", "/sessions");
    handleEnvelopeResult("GET /sessions", { status, json });
    if (json?.ok) {
      state.sessions = json.sessions;
      renderSessionList();
    }
  }

  function renderSessionList() {
    const ul = $("session-list");
    ul.innerHTML = "";
    $("session-list-empty").classList.toggle("hidden", state.sessions.length > 0);
    for (const s of state.sessions) {
      const li = document.createElement("li");
      li.dataset.sid = s.session_id;
      if (s.session_id === state.currentSessionId) li.classList.add("active");
      const blocked = s.blocked_reason ? `<div class="blocked-reason">blocked:${esc(s.blocked_reason)}</div>` : "";
      li.innerHTML =
        `<div class="sid">${esc(s.session_id)}</div>` +
        `<div class="goal">${esc(s.goal)}</div>` +
        `<span class="state-badge ${esc(s.state)}">${esc(s.state)}</span>${blocked}` +
        `<div class="muted">更新:${esc(s.updated_at)}</div>`;
      li.addEventListener("click", () => selectSession(s.session_id));
      ul.appendChild(li);
    }
  }

  /* ---------------- ② Session 详情 ---------------- */
  async function selectSession(sid) {
    state.currentSessionId = sid;
    renderSessionList();
    await loadSessionView();
  }

  async function loadSessionView() {
    const sid = state.currentSessionId;
    if (!sid) return;
    const { status, json } = await api("GET", `/sessions/${encodeURIComponent(sid)}`);
    handleEnvelopeResult(`GET /sessions/${sid}`, { status, json });
    if (json?.ok) {
      state.view = json;
      renderSessionDetail();
    } else {
      state.view = null;
    }
  }

  function renderSessionDetail() {
    const v = state.view;
    if (!v) return;
    $("session-detail").classList.remove("hidden");
    $("detail-title").textContent = `会话详情 · ${v.session.session_id}`;
    const s = v.session;
    $("detail-meta").innerHTML =
      `<div><strong>状态</strong>:${esc(s.state)}${s.blocked_reason ? ` — blocked:${esc(s.blocked_reason)}` : ""}</div>` +
      `<div><strong>目标</strong>:${esc(s.goal)}</div>` +
      `<div><strong>工作区</strong>:${esc(s.workspace_id)} · <strong>创建</strong>:${esc(s.created_at)} · <strong>更新</strong>:${esc(s.updated_at)}</div>` +
      (s.authorization_boundary ? `<div><strong>授权边界</strong>:${esc(s.authorization_boundary)}</div>` : "");

    /* Runs */
    $("detail-runs").innerHTML = (v.runs ?? []).map((r) =>
      `<div class="run-item">` +
      `<div>${esc(r.run_id)} · ${esc(r.scenario_id)} · ${esc(r.environment)} · outcome=<span class="${r.outcome === "completed" ? "ok-Tag" : "bad-Tag"}">${esc(r.outcome ?? "-")}</span> · sealed=${r.sealed ? '<span class="ok-Tag">true</span>' : "false"}</div>` +
      (r.supersedes_run_id ? `<div class="muted">supersedes:${esc(r.supersedes_run_id)}</div>` : "") +
      `<div class="muted">case_summary:${esc(JSON.stringify(r.case_summary))}</div>` +
      `<div class="muted">findings:${esc((r.finding_ids ?? []).join(", ") || "-")}</div>` +
      `</div>`
    ).join("") || '<p class="muted">暂无 run。</p>';

    /* Drafts(含审批/门禁状态提示) */
    $("detail-drafts").innerHTML = (v.drafts ?? []).map((d) =>
      `<div class="draft-item">` +
      `<div>${esc(d.draft_id)} · finding:${esc(d.finding_id)} · ${d.published ? '<span class="ok-Tag">已发布</span>' : '<span class="bad-Tag">未发布</span>'}</div>` +
      (d.published ? "" :
        `<div class="muted">发布门禁:需 policy 批准 + 人工审批(scope=issue.publish:finding=${esc(d.finding_id)});无审批发布将被 C13 reviewer 门拒绝。</div>` +
        `<button type="button" class="tiny" data-scope="issue.publish:finding=${esc(d.finding_id)}">将审批 scope 填入审批面板</button>`) +
      `</div>`
    ).join("") || '<p class="muted">暂无草稿(需要 confirmed finding 的 run)。</p>';

    /* Published 回执摘要 */
    $("detail-published").innerHTML = (v.published ?? []).map((p) =>
      `<div class="pub-item">${esc(p.issue_ref)} · receipt:${esc(p.receipt_id)} · draft:${esc(p.draft_id)} · at:${esc(p.published_at)}</div>`
    ).join("") || '<p class="muted">暂无发布回执。</p>';

    renderTimeline();
  }

  /* ---------------- 事件时间线(SSE 实时) ---------------- */
  function sessionRunIds() {
    return new Set((state.view?.runs ?? []).map((r) => r.run_id));
  }

  function eventBelongsToCurrentSession(entry) {
    if (!state.currentSessionId) return false;
    const runs = sessionRunIds();
    const e = entry.event;
    if (e.object_id === state.currentSessionId) return true;
    if (runs.has(e.object_id)) return true;
    if (runs.has(e.payload?.run_id)) return true;
    return false;
  }

  function renderTimeline() {
    if (!state.currentSessionId) return;
    const entries = [...state.seenEvents.values()].filter(eventBelongsToCurrentSession)
      .concat(state.view?.events ?? []);
    const dedup = new Map();
    for (const entry of entries) dedup.set(entry.event.event_id, entry);
    const ordered = [...dedup.values()].sort((a, b) => {
      if (a.event.object_id !== b.event.object_id) return a.event.object_id < b.event.object_id ? -1 : 1;
      return a.event.sequence - b.event.sequence;
    });
    $("detail-events").innerHTML = ordered.map((e) =>
      `<div class="evt-item"><span class="evt-seq">#${e.event.sequence}</span> <span class="evt-name">${esc(e.name)}</span>` +
      ` <span class="muted">${esc(e.event.object_id)}</span>` +
      `<div class="muted">${esc(JSON.stringify(e.event.payload))}</div></div>`
    ).join("") || '<p class="muted">暂无事件。</p>';
  }

  /* ---------------- ③ 命令面板 ---------------- */
  let currentCommand = "createSession";

  function newCommandId() {
    return `cmd-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function fillCommandForm(name) {
    currentCommand = name;
    document.querySelectorAll(".cmd-tab").forEach((b) => b.classList.toggle("active", b.dataset.cmd === name));
    $("cmd-id").value = newCommandId();
    $("cmd-issued").value = isoNow();
    $("cmd-deadline").value = isoPlus(10 * 60 * 1000);
    $("cmd-payload").value = JSON.stringify(COMMAND_TEMPLATES[name] ?? {}, null, 2);
  }

  async function submitCommand(ev) {
    ev.preventDefault();
    let payload;
    try {
      payload = JSON.parse($("cmd-payload").value);
    } catch {
      appendError("命令面板", { code: "CTL_VALIDATION_FAILED", message: "payload 不是合法 JSON", details: { reason: "invalid_json" } });
      return;
    }
    const envelopeBody = {
      command_id: $("cmd-id").value.trim() || newCommandId(),
      issued_at: $("cmd-issued").value.trim() || isoNow(),
      deadline: $("cmd-deadline").value.trim() || isoPlus(10 * 60 * 1000),
      payload,
    };
    const label = `POST /commands/${currentCommand}`;
    const ret = handleEnvelopeResult(label, await api("POST", `/commands/${encodeURIComponent(currentCommand)}`, envelopeBody));
    $("cmd-id").value = newCommandId();
    await loadSessions();
    if (ret?.ok && (currentCommand === "createSession") && ret.result?.session_id) {
      await selectSession(ret.result.session_id);
    } else if (ret?.ok && state.currentSessionId) {
      await loadSessionView();
    }
  }

  /* ---------------- ④ 审批面板 ---------------- */
  function fillApprovalDefaults() {
    $("ap-approved-at").value = isoNow();
    $("ap-expires-at").value = isoPlus(60 * 60 * 1000);
  }

  async function submitApproval(ev) {
    ev.preventDefault();
    const body = {
      approver: $("ap-approver").value.trim(),
      decision: $("ap-decision").value,
      scope: $("ap-scope").value.trim(),
      approved_at: $("ap-approved-at").value.trim() || isoNow(),
      expires_at: $("ap-expires-at").value.trim() || isoPlus(60 * 60 * 1000),
      reason: $("ap-reason").value.trim(),
    };
    handleEnvelopeResult("POST /approvals", await api("POST", "/approvals", body));
    fillApprovalDefaults();
  }

  /* ---------------- SSE 订阅 ---------------- */
  function openEventStream() {
    const es = new EventSource("/events");
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (ev) => {
        try {
          const entry = JSON.parse(ev.data);
          if (!state.seenEvents.has(entry.event.event_id)) {
            state.seenEvents.set(entry.event.event_id, entry);
            renderTimeline();
            /* 事件驱动的轻量刷新:run 完成或发布后刷新详情 */
            if (state.currentSessionId && ["runCompleted", "issueDrafted", "issuePublished", "sessionStateChanged"].includes(name)) {
              loadSessionView().then(loadSessions).catch(() => {});
            }
          }
        } catch { /* 忽略坏帧 */ }
      });
    }
    es.onerror = () => { /* EventSource 自动重连;重连后服务器回放 history,客户端按 event_id 去重 */ };
  }

  /* ---------------- 初始化 ---------------- */
  function bindUI() {
    $("token-save").addEventListener("click", () => {
      state.token = $("token-input").value.trim();
      localStorage.setItem("nw_console_token", state.token);
      updateTokenState();
    });
    $("token-input").value = state.token;
    updateTokenState();

    $("refresh-sessions").addEventListener("click", loadSessions);
    $("refresh-detail").addEventListener("click", loadSessionView);
    $("clear-errors").addEventListener("click", () => {
      $("error-area").innerHTML = '<p class="muted">暂无错误。</p>';
    });

    document.querySelectorAll(".cmd-tab").forEach((b) => b.addEventListener("click", () => fillCommandForm(b.dataset.cmd)));
    $("cmd-regen").addEventListener("click", () => { $("cmd-id").value = newCommandId(); });
    $("command-form").addEventListener("submit", submitCommand);
    $("approval-form").addEventListener("submit", submitApproval);

    /* draft 面板里的 scope 填充按钮(事件委托) */
    $("detail-drafts").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-scope]");
      if (btn) {
        $("ap-scope").value = btn.dataset.scope;
        btn.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });

    fillCommandForm("createSession");
    fillApprovalDefaults();
  }

  function updateTokenState() {
    const el = $("token-state");
    if (state.token) {
      el.textContent = `已设置(${state.token.slice(0, 6)}…)`;
      el.classList.remove("muted");
    } else {
      el.textContent = "未设置(写操作将返回 401)";
      el.classList.add("muted");
    }
  }

  bindUI();
  openEventStream();
  loadSessions();
})();
