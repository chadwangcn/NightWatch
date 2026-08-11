// Lumi Device Platform — API Client
// 参照 docs/testing/public-api-eval-plan.md §3

/**
 * API 错误，携带完整请求/响应上下文便于排查
 */
export class LumiApiError extends Error {
  constructor({ status, body, requestId, request, response }) {
    super(body?.message || `HTTP ${status}`);
    this.name = 'LumiApiError';
    this.status = status;
    this.code = body?.code;
    this.requestId = requestId || body?.request_id;
    this.body = body;
    // 请求上下文：method/url/headers/body/query
    this.request = request || {};
    // 响应上下文：status/body/headers
    this.response = response || { status, body };
    this.timestamp = new Date().toISOString();
  }

  /**
   * 输出可粘贴给系统排查的完整 JSON
   * 测试平台场景：保留完整信息便于排查 API 问题
   */
  toDebugJSON() {
    return {
      timestamp: this.timestamp,
      error: {
        name: this.name,
        message: this.message,
        code: this.code,
        status: this.status,
        requestId: this.requestId,
      },
      request: {
        method: this.request.method,
        url: this.request.url,
        // 浏览器代理版：实际代理请求路径 + 目标服务器完整 URL
        actualUrl: this.request.actualUrl || null,
        targetUrl: this.request.targetUrl || null,
        headers: this.request.headers,
        query: this.request.query,
        body: this.request.body,
      },
      response: {
        status: this.response.status,
        body: this.response.body,
      },
    };
  }

  /**
   * 格式化为可读的调试文本（用于 toast/日志/粘贴）
   */
  toDebugString() {
    return JSON.stringify(this.toDebugJSON(), null, 2);
  }
}

/**
 * LumiApiClient 封装所有 11 个端点
 */
export class LumiApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {string} [opts.userAccessToken]
   * @param {string} [opts.deviceAccessToken]
   * @param {function} [opts.fetch] — 可注入 fetch（测试用）
   */
  constructor(opts) {
    if (!opts || !opts.baseUrl) throw new Error('baseUrl required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.userAccessToken = opts.userAccessToken || null;
    this.deviceAccessToken = opts.deviceAccessToken || null;
    this.fetch = opts.fetch || globalThis.fetch.bind(globalThis);
  }

  setUserToken(t) { this.userAccessToken = t; }
  setDeviceToken(t) { this.deviceAccessToken = t; }
  clearUserToken() { this.userAccessToken = null; }
  clearDeviceToken() { this.deviceAccessToken = null; }

  async _request(path, { method = 'GET', body, auth = null, query = null, raw = false } = {}) {
    // 支持绝对 URL（如 /healthz 部署在根路径，不带 baseUrl 的路径前缀）
    const url = path.startsWith('http') ? new URL(path) : new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const headers = { 'content-type': 'application/json' };
    if (auth === 'user' && this.userAccessToken) headers['authorization'] = `Bearer ${this.userAccessToken}`;
    if (auth === 'device' && this.deviceAccessToken) headers['authorization'] = `Bearer ${this.deviceAccessToken}`;
    const init = { method, headers };
    if (body !== undefined && body !== null) init.body = JSON.stringify(body);

    // 请求上下文快照（用于错误时排查）
    const requestContext = {
      method,
      url: url.toString(),
      headers: { ...headers },
      query: query || null,
      body: body === undefined || body === null ? null : body,
    };

    let resp, parsed = null, text = '';
    try {
      resp = await this.fetch(url, init);
    } catch (networkErr) {
      // 网络层错误（DNS/连接失败/超时/代理错误）
      throw new LumiApiError({
        status: 0,
        body: { code: 'NETWORK_ERROR', message: networkErr.message },
        request: requestContext,
        response: { status: 0, body: { error: networkErr.message } },
      });
    }

    text = await resp.text().catch(() => '');
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }

    if (raw) {
      return { status: resp.status, ok: resp.ok, body: parsed, headers: resp.headers };
    }

    if (!resp.ok) {
      // 附加实际请求 URL（浏览器代理版会注入 _actualUrl / _targetUrl）
      const req = { ...requestContext };
      if (resp._actualUrl) req.actualUrl = resp._actualUrl;
      if (resp._targetUrl) req.targetUrl = resp._targetUrl;
      const errBody = parsed && typeof parsed === 'object' ? parsed : { message: text || `HTTP ${resp.status}` };
      throw new LumiApiError({
        status: resp.status,
        body: errBody,
        requestId: errBody.request_id,
        request: req,
        response: { status: resp.status, body: parsed },
      });
    }
    return parsed;
  }

  // 3.1 用户登录
  login({ account, password }) {
    return this._request('/v1/user-sessions', { method: 'POST', body: { account, password } });
  }

  // 3.2 用户刷新
  refreshSession({ userRefreshToken }) {
    return this._request('/v1/user-sessions:refresh', { method: 'POST', body: { user_refresh_token: userRefreshToken } });
  }

  // 3.3 用户登出
  logout() {
    return this._request('/v1/user-sessions/current', { method: 'DELETE', auth: 'user' });
  }

  // 3.4 设备认证
  deviceSession(body) {
    return this._request('/v1/device-sessions', { method: 'POST', body });
  }

  // 3.5 设备引导
  deviceBootstrap() {
    return this._request('/v1/device-bootstrap', { method: 'GET', auth: 'device' });
  }

  // 3.6 获取配对 Nonce
  pairingChallenge() {
    return this._request('/v1/device-pairing-challenges', { method: 'GET', auth: 'device' });
  }

  // 3.8 绑定设备
  bindDevice({ device_sn, child_profile_id, pairing_proof, nonce, timestamp }) {
    return this._request('/v1/device-bindings', {
      method: 'POST',
      auth: 'user',
      body: { device_sn, child_profile_id, pairing_proof, nonce, timestamp },
    });
  }

  // 3.9 查询绑定
  getBinding({ deviceSn }, opts = {}) {
    return this._request('/v1/device-bindings/current', {
      method: 'GET', auth: 'user', query: { device_sn: deviceSn }, raw: opts.raw,
    });
  }

  // 3.10 解绑
  unbind({ deviceSn }) {
    return this._request('/v1/device-bindings/current', {
      method: 'DELETE', auth: 'user', query: { device_sn: deviceSn },
    });
  }

  // 3.11 健康检查（/healthz 部署在根路径，不带 baseUrl 的 /lumi-mind 前缀）
  health() {
    const origin = new URL(this.baseUrl).origin;
    return this._request(origin + '/healthz', { method: 'GET' });
  }

  ready() {
    // /readyz 仅 Docker/Caddy 内部使用，不对外暴露
    const origin = new URL(this.baseUrl).origin;
    return this._request(origin + '/readyz', { method: 'GET' });
  }
}
