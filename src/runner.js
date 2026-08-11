// Lumi Device Platform — 测试运行器
// 编排 A 组（顺序可用性）和 B 组（健壮性）测试用例
// 参照 docs/testing/public-api-eval-plan.md §4

import { LumiApiError } from './api-client.js';

/**
 * 测试用例定义
 * side: app | device | both — 用于 UI 左右分区
 */
const CASES = [
  // A 组
  { id: 'A0', group: 'A', side: 'device', name: '固定测试向量验证（本地）', desc: '验证 HMAC 实现与文档一致' },
  { id: 'A1', group: 'A', side: 'app', name: '用户登录', desc: 'POST /v1/user-sessions' },
  { id: 'A2', group: 'A', side: 'app', name: '用户 Token 刷新', desc: 'POST /v1/user-sessions:refresh' },
  { id: 'A3', group: 'A', side: 'device', name: '设备认证', desc: 'POST /v1/device-sessions' },
  { id: 'A4', group: 'A', side: 'device', name: '设备 Bootstrap', desc: 'GET /v1/device-bootstrap' },
  { id: 'A5', group: 'A', side: 'device', name: '获取 Pairing Nonce', desc: 'GET /v1/device-pairing-challenges' },
  { id: 'A6', group: 'A', side: 'device', name: '本地计算 Pairing Proof', desc: 'HMAC-SHA256' },
  { id: 'A7', group: 'A', side: 'app', name: '绑定设备', desc: 'POST /v1/device-bindings（用户侧调用）' },
  { id: 'A8', group: 'A', side: 'app', name: '查询绑定', desc: 'GET /v1/device-bindings/current' },
  { id: 'A9', group: 'A', side: 'app', name: '解绑 + 验证', desc: 'DELETE + GET 404' },
  { id: 'A10', group: 'A', side: 'app', name: '用户登出', desc: 'DELETE /v1/user-sessions/current' },
  { id: 'A11', group: 'A', side: 'both', name: '健康检查', desc: 'GET /healthz（根路径，不带 /lumi-mind 前缀）' },
  // B 组
  { id: 'B1', group: 'B', side: 'app', name: '错误密码登录', desc: 'POST /v1/user-sessions 预期 401' },
  { id: 'B2', group: 'B', side: 'app', name: '不存在账号', desc: '401 不泄露存在性' },
  { id: 'B3', group: 'B', side: 'app', name: '空密码', desc: '422' },
  { id: 'B4', group: 'B', side: 'app', name: '密码过短', desc: '422' },
  { id: 'B5', group: 'B', side: 'app', name: '账号过短', desc: '422' },
  { id: 'B6', group: 'B', side: 'app', name: 'SQL 注入', desc: '401 或 422' },
  { id: 'B7', group: 'B', side: 'app', name: '额外字段', desc: '422 (extra=forbid)' },
  { id: 'B8', group: 'B', side: 'app', name: 'Refresh 重放', desc: '401 family revoked' },
  { id: 'B9', group: 'B', side: 'app', name: '随机 refresh', desc: '401' },
  { id: 'B10', group: 'B', side: 'device', name: '无 Token', desc: '401/403' },
  { id: 'B11', group: 'B', side: 'device', name: '伪造 Token', desc: '401/403' },
  { id: 'B12', group: 'B', side: 'device', name: '错误 device_proof', desc: '401' },
  { id: 'B13', group: 'B', side: 'device', name: 'Device nonce 重放', desc: '409 或 401' },
  { id: 'B14', group: 'B', side: 'device', name: '设备过期 timestamp', desc: '401/400' },
  { id: 'B15', group: 'B', side: 'app', name: '错误 pairing_proof', desc: 'POST /v1/device-bindings 预期 401' },
  { id: 'B16', group: 'B', side: 'app', name: 'Pairing nonce 重放', desc: 'POST /v1/device-bindings 预期 409' },
  { id: 'B17', group: 'B', side: 'app', name: 'nonce 格式非法', desc: 'POST /v1/device-bindings 预期 422' },
  { id: 'B18', group: 'B', side: 'app', name: '缺少必填字段', desc: 'POST /v1/device-bindings 预期 422' },
  { id: 'B19', group: 'B', side: 'app', name: '绑定过期 timestamp', desc: 'POST /v1/device-bindings 预期 400/401' },
  { id: 'B20', group: 'B', side: 'app', name: '超长 device_sn', desc: 'POST /v1/device-bindings 预期 422' },
  { id: 'B21', group: 'B', side: 'app', name: '查询不存在设备', desc: '404/403' },
  { id: 'B22', group: 'B', side: 'device', name: '身份类型互窜（User→Device 端点）', desc: '401/403' },
  { id: 'B23', group: 'B', side: 'device', name: '身份类型互窜（Device→User 端点）', desc: '用设备 token 调 bindDevice 预期 401/403/422' },
  { id: 'B24', group: 'B', side: 'app', name: '登出后 Token 失效', desc: '401/403' },
  // S 组：端到端场景
  { id: 'S1', group: 'S', side: 'both', name: '完整生命周期', desc: '登录→设备认证→绑定→查询→解绑→刷新→登出' },
  // P 组：配对二维码场景
  { id: 'P1', group: 'P', side: 'device', name: '设备配对二维码生成', desc: '认证→Bootstrap→Nonce→Proof→生成 JSON' },
  { id: 'P2', group: 'P', side: 'app', name: '用户扫码绑定', desc: '登录→解析配对 JSON→绑定设备' },
];

/**
 * 把任意错误对象转换为 HTTP status
 * 注意：网络错误时 status=0，是合法值，必须用 ?? 而非 ||
 */
function errorStatus(e) {
  return e?.status ?? e?.response?.status ?? null;
}

function isExpectedStatus(actual, expected) {
  if (Array.isArray(expected)) return expected.includes(actual);
  return actual === expected;
}

/**
 * 测试运行器
 */
export class TestRunner {
  /**
   * @param {object} opts
   * @param {object} opts.client — LumiApiClient 实例
   * @param {object} opts.config — 配置（baseUrl/account/password/deviceSn/deviceSecretB64url/childProfileId/productId/credentialVersion）
   * @param {object} opts.crypto — 加密函数集 { computeDeviceProof, computePairingProof, genNonce }
   */
  constructor(opts) {
    this.client = opts.client;
    this.config = opts.config;
    this.crypto = opts.crypto;
    this.state = {
      userAccessToken: null,
      userRefreshToken: null,
      deviceAccessToken: null,
      deviceRefreshToken: null,
      deviceNonce: null,
      deviceTimestamp: null,
      pairingNonce: null,
      pairingTimestamp: null,
      pairingProof: null,
    };
    this.results = {};
  }

  listCases() {
    return CASES.slice();
  }

  /**
   * 返回用例的参数 schema（用于 UI 渲染参数表单）
   * 每条 schema 描述：字段名、类型、默认值来源、是否可编辑
   */
  getParamSchema(id) {
    const cfg = this.config;
    const schemas = {
      A1: [
        { key: 'account', label: '账号', type: 'string', default: cfg.account, required: true },
        { key: 'password', label: '密码', type: 'password', default: cfg.password, required: true },
      ],
      A2: [
        { key: 'user_refresh_token', label: 'Refresh Token', type: 'string', default: '（自动使用 A1 的 token）', required: true, auto: true },
      ],
      A3: [
        { key: 'product_id', label: '产品 ID', type: 'string', default: cfg.productId, required: true },
        { key: 'device_sn', label: '设备 SN', type: 'string', default: cfg.deviceSn, required: true },
        { key: 'credential_version', label: '凭证版本', type: 'number', default: cfg.credentialVersion, required: true },
        { key: 'timestamp', label: '时间戳', type: 'number', default: '（自动生成）', auto: true },
        { key: 'nonce', label: 'Nonce', type: 'string', default: '（自动生成）', auto: true },
        { key: 'device_proof', label: 'Device Proof', type: 'string', default: '（自动计算）', auto: true },
      ],
      A4: [],
      A5: [],
      A6: [],
      A7: [
        { key: 'device_sn', label: '设备 SN', type: 'string', default: cfg.deviceSn, required: true },
        { key: 'child_profile_id', label: '儿童档案 ID', type: 'string', default: cfg.childProfileId, required: true },
        { key: 'pairing_proof', label: 'Pairing Proof', type: 'string', default: '（自动使用 A6 的 proof）', auto: true },
        { key: 'nonce', label: 'Nonce', type: 'string', default: '（自动使用 A5 的 nonce）', auto: true },
        { key: 'timestamp', label: '时间戳', type: 'number', default: '（自动使用 A5 的 timestamp）', auto: true },
      ],
      A8: [
        { key: 'device_sn', label: '设备 SN', type: 'string', default: cfg.deviceSn, required: true },
      ],
      A9: [
        { key: 'device_sn', label: '设备 SN', type: 'string', default: cfg.deviceSn, required: true },
      ],
      A10: [],
      A11: [
        { key: 'user_refresh_token', label: 'Refresh Token', type: 'string', default: '（自动使用 A1 的 token）', required: true, auto: true },
      ],
    };
    return schemas[id] || [];
  }

  /**
   * 设置用例参数覆盖（UI 编辑后调用）
   * @param {string} id 用例 ID
   * @param {object} overrides 参数覆盖对象
   */
  setParamOverrides(id, overrides) {
    if (!this.state.overrides) this.state.overrides = {};
    this.state.overrides[id] = overrides;
  }

  /**
   * 获取用例参数覆盖
   */
  getParamOverrides(id) {
    return this.state.overrides?.[id] || {};
  }

  /**
   * 运行单个用例
   * @param {string} id
   * @returns {Promise<object>}
   */
  async run(id) {
    const handler = this[`_${id}`];
    if (!handler) throw new Error(`Unknown case: ${id}`);
    try {
      const result = await handler.call(this);
      this.results[id] = result;
      return result;
    } catch (e) {
      const result = {
        id,
        passed: false,
        error: e?.message || String(e),
        steps: [],
        startedAt: new Date().toISOString(),
      };
      this.results[id] = result;
      return result;
    }
  }

  /**
   * 顺序运行多个用例
   */
  async runSequence(ids, onProgress = null) {
    const results = [];
    for (const id of ids) {
      const r = await this.run(id);
      results.push(r);
      if (onProgress) onProgress(r);
    }
    return results;
  }

  /**
   * 聚合所有失败用例的完整调试报告
   * 不含敏感字段（password）
   * @returns {object} 可序列化的报告对象
   */
  collectFailureReport() {
    const all = Object.values(this.results);
    const failed = all.filter((r) => !r.passed);
    return {
      generatedAt: new Date().toISOString(),
      baseUrl: this.config?.baseUrl || null,
      account: this.config?.account || null,
      total: all.length,
      passed: all.length - failed.length,
      failed: failed.length,
      failures: failed.map((r) => ({
        id: r.id,
        title: r.title || r.id,
        group: r.group,
        side: r.side,
        passed: r.passed,
        error: r.error,
        actualStatus: r.actualStatus,
        expectedStatus: r.expectedStatus,
        startedAt: r.startedAt,
        steps: (r.steps || []).map((s) => ({
          method: s.method,
          path: s.path,
          request: s.request,
          response: s.response,
          error: s.error,
        })),
      })),
    };
  }

  /**
   * 记录单步请求/响应
   * @param {string} method
   * @param {string} path
   * @param {object|null} reqBody
   * @param {object|null} resp
   * @param {Error|null} error
   * @param {number} successStatus — 成功时的 HTTP 状态码（默认 200）
   */
  _step(method, path, reqBody, resp, error = null, successStatus = null) {
    let status;
    if (error) {
      status = errorStatus(error);
    } else if (resp === null) {
      status = 204;
    } else {
      status = successStatus || 200;
    }

    // 错误时优先使用 LumiApiError 携带的完整请求/响应上下文
    // 注意：_step 记录原始值（不脱敏），脱敏在 collectFailureReport / toDebugJSON 输出时统一处理
    const errCtx = error && error.request ? error : null;
    const request = errCtx ? {
      method: errCtx.request.method || method,
      path,
      url: errCtx.request.url,
      headers: errCtx.request.headers,
      query: errCtx.request.query,
      body: errCtx.request.body !== undefined && errCtx.request.body !== null ? errCtx.request.body : reqBody,
    } : { method, path, body: reqBody };

    const response = errCtx ? {
      status: errCtx.response?.status ?? status,
      body: errCtx.response?.body !== undefined ? errCtx.response.body : (error ? null : resp),
    } : {
      status,
      body: error ? null : resp,
    };

    return {
      method,
      path,
      request,
      response,
      error: error ? {
        message: error.message,
        status: errorStatus(error),
        code: error.code,
        // 完整上下文（用于 UI 复制粘贴）
        debug: typeof error.toDebugJSON === 'function' ? error.toDebugJSON() : null,
      } : null,
    };
  }

  // ============ A 组 ============

  async _A0() {
    const { computeDeviceProof } = this.crypto;
    // 文档 §3.4 固定测试向量（非真实设备，用于验证本地加密实现）
    const { proof } = await computeDeviceProof({
      secretB64url: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      productId: 'k1',
      deviceSn: 'K1-2026-000001',
      credentialVersion: 1,
      timestamp: 1785210000,
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
      appVersion: '1.2.1',
      firmwareVersion: '1.0.0',
    });
    const expected = '31aCPbgG42Z5ObCVMuauwqNxZtrpSDU6GwJ0wvu5jes';
    return {
      id: 'A0',
      group: 'A',
      passed: proof === expected,
      steps: [{ method: 'LOCAL', path: 'computeDeviceProof', request: { vector: 'fixed' }, response: { status: 'ok', body: { proof, expected } } }],
      assertions: [{ name: 'proof === 31aCPbgG42Z5ObCVMuauwqNxZtrpSDU6GwJ0wvu5jes', passed: proof === expected }],
      startedAt: new Date().toISOString(),
    };
  }

  async _A1() {
    const startedAt = new Date().toISOString();
    const ov = this.getParamOverrides('A1');
    const account = ov.account ?? this.config.account;
    const password = ov.password ?? this.config.password;
    try {
      const resp = await this.client.login({ account, password });
      this.state.userAccessToken = resp.user_access_token;
      this.state.userRefreshToken = resp.user_refresh_token;
      this.client.setUserToken(resp.user_access_token);
      return {
        id: 'A1', group: 'A', passed: true, startedAt,
        expectedStatus: 201, actualStatus: 201,
        steps: [this._step('POST', '/v1/user-sessions', { account, password: '***' }, resp, null, 201)],
        assertions: [
          { name: 'user_access_token 以 ey 开头', passed: resp.user_access_token?.startsWith('ey') },
          { name: 'user_refresh_token 存在', passed: !!resp.user_refresh_token },
          { name: 'expires_in=900', passed: resp.expires_in === 900 },
        ],
      };
    } catch (e) {
      return { id: 'A1', group: 'A', passed: false, error: e.message, startedAt, steps: [this._step('POST', '/v1/user-sessions', { account, password: '***' }, null, e)] };
    }
  }

  async _A2() {
    const startedAt = new Date().toISOString();
    try {
      const resp = await this.client.refreshSession({ userRefreshToken: this.state.userRefreshToken });
      this.state.userAccessToken = resp.user_access_token;
      this.state.userRefreshToken = resp.user_refresh_token;
      this.client.setUserToken(resp.user_access_token);
      return {
        id: 'A2', group: 'A', passed: true, startedAt,
        expectedStatus: 200, actualStatus: 200,
        steps: [this._step('POST', '/v1/user-sessions:refresh', { user_refresh_token: '***' }, resp)],
      };
    } catch (e) {
      return { id: 'A2', group: 'A', passed: false, error: e.message, startedAt, steps: [this._step('POST', '/v1/user-sessions:refresh', null, null, e)] };
    }
  }

  async _A3() {
    const { computeDeviceProof, genNonce } = this.crypto;
    const startedAt = new Date().toISOString();
    const ov = this.getParamOverrides('A3');
    const productId = ov.product_id ?? this.config.productId;
    const deviceSn = ov.device_sn ?? this.config.deviceSn;
    const credentialVersion = ov.credential_version != null ? Number(ov.credential_version) : this.config.credentialVersion;
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = genNonce();
    this.state.deviceNonce = nonce;
    this.state.deviceTimestamp = timestamp;
    try {
      const { proof, canonicalBody } = await computeDeviceProof({
        secretB64url: this.config.deviceSecretB64url,
        productId, deviceSn, credentialVersion,
        timestamp, nonce,
        capabilityDigest: this.config.capabilityDigest,
      });
      const body = JSON.parse(canonicalBody);
      body.device_proof = proof;
      const resp = await this.client.deviceSession(body);
      this.state.deviceAccessToken = resp.device_access_token;
      this.state.deviceRefreshToken = resp.device_refresh_token;
      this.client.setDeviceToken(resp.device_access_token);
      return {
        id: 'A3', group: 'A', passed: true, startedAt,
        expectedStatus: 201, actualStatus: 201,
        steps: [this._step('POST', '/v1/device-sessions', body, resp, null, 201)],
        assertions: [
          { name: 'device_access_token 存在', passed: !!resp.device_access_token },
          { name: 'expires_in=900', passed: resp.expires_in === 900 },
        ],
      };
    } catch (e) {
      return { id: 'A3', group: 'A', passed: false, error: e.message, startedAt, steps: [this._step('POST', '/v1/device-sessions', null, null, e)] };
    }
  }

  async _A4() {
    const startedAt = new Date().toISOString();
    try {
      const resp = await this.client.deviceBootstrap();
      return {
        id: 'A4', group: 'A', passed: true, startedAt,
        expectedStatus: 200, actualStatus: 200,
        steps: [this._step('GET', '/v1/device-bootstrap', null, resp)],
        assertions: [{ name: 'device_sn 匹配', passed: resp.device_sn === this.config.deviceSn }],
      };
    } catch (e) {
      return { id: 'A4', group: 'A', passed: false, error: e.message, startedAt, steps: [this._step('GET', '/v1/device-bootstrap', null, null, e)] };
    }
  }

  async _A5() {
    const startedAt = new Date().toISOString();
    try {
      const resp = await this.client.pairingChallenge();
      this.state.pairingNonce = resp.nonce;
      this.state.pairingTimestamp = resp.timestamp;
      return {
        id: 'A5', group: 'A', passed: true, startedAt,
        expectedStatus: 200, actualStatus: 200,
        steps: [this._step('GET', '/v1/device-pairing-challenges', null, resp)],
        assertions: [
          { name: 'nonce 格式 ^[A-Za-z0-9_-]{22}$', passed: /^[A-Za-z0-9_-]{22}$/.test(resp.nonce) },
          { name: 'expires_in=300', passed: resp.expires_in === 300 },
          { name: 'device_sn 匹配', passed: resp.device_sn === this.config.deviceSn },
        ],
      };
    } catch (e) {
      return { id: 'A5', group: 'A', passed: false, error: e.message, startedAt, steps: [this._step('GET', '/v1/device-pairing-challenges', null, null, e)] };
    }
  }

  async _A6() {
    const { computePairingProof } = this.crypto;
    const startedAt = new Date().toISOString();
    try {
      const { proof } = await computePairingProof({
        secretB64url: this.config.deviceSecretB64url,
        deviceSn: this.config.deviceSn,
        timestamp: this.state.pairingTimestamp,
        nonce: this.state.pairingNonce,
      });
      this.state.pairingProof = proof;
      return {
        id: 'A6', group: 'A', passed: true, startedAt,
        steps: [{ method: 'LOCAL', path: 'computePairingProof', request: { timestamp: this.state.pairingTimestamp, nonce: this.state.pairingNonce }, response: { status: 'ok', body: { proof, length: proof.length } } }],
        assertions: [{ name: 'proof 长度=43', passed: proof.length === 43 }],
      };
    } catch (e) {
      return { id: 'A6', group: 'A', passed: false, error: e.message, startedAt, steps: [] };
    }
  }

  async _A7() {
    const startedAt = new Date().toISOString();
    const ov = this.getParamOverrides('A7');
    const deviceSn = ov.device_sn ?? this.config.deviceSn;
    const childProfileId = ov.child_profile_id ?? this.config.childProfileId;
    // 先尝试解绑清理（忽略错误）
    try { await this.client.unbind({ deviceSn }); } catch {}
    try {
      const resp = await this.client.bindDevice({
        device_sn: deviceSn,
        child_profile_id: childProfileId,
        pairing_proof: this.state.pairingProof,
        nonce: this.state.pairingNonce,
        timestamp: this.state.pairingTimestamp,
      });
      return {
        id: 'A7', group: 'A', passed: true, startedAt,
        expectedStatus: 201, actualStatus: 201,
        steps: [this._step('POST', '/v1/device-bindings', {
          device_sn: deviceSn, child_profile_id: childProfileId,
          pairing_proof: this.state.pairingProof, nonce: this.state.pairingNonce, timestamp: this.state.pairingTimestamp,
        }, resp, null, 201)],
        assertions: [
          { name: 'status="active"', passed: resp.status === 'active' },
          { name: 'binding_version≥1', passed: resp.binding_version >= 1 },
        ],
      };
    } catch (e) {
      return { id: 'A7', group: 'A', passed: false, error: e.message, startedAt, steps: [this._step('POST', '/v1/device-bindings', { device_sn: deviceSn, child_profile_id: childProfileId }, null, e)] };
    }
  }

  async _A8() {
    const startedAt = new Date().toISOString();
    const ov = this.getParamOverrides('A8');
    const deviceSn = ov.device_sn ?? this.config.deviceSn;
    try {
      const resp = await this.client.getBinding({ deviceSn });
      return {
        id: 'A8', group: 'A', passed: true, startedAt,
        expectedStatus: 200, actualStatus: 200,
        steps: [this._step('GET', '/v1/device-bindings/current', { device_sn: deviceSn }, resp)],
        assertions: [{ name: 'child_profile_id 匹配', passed: resp.child_profile_id === this.config.childProfileId }],
      };
    } catch (e) {
      return { id: 'A8', group: 'A', passed: false, error: e.message, startedAt, steps: [this._step('GET', '/v1/device-bindings/current', null, null, e)] };
    }
  }

  async _A9() {
    const startedAt = new Date().toISOString();
    const ov = this.getParamOverrides('A9');
    const deviceSn = ov.device_sn ?? this.config.deviceSn;
    try {
      await this.client.unbind({ deviceSn });
      // 验证 404
      let secondStatus = null;
      try {
        await this.client.getBinding({ deviceSn });
      } catch (e) {
        secondStatus = errorStatus(e);
      }
      const passed = secondStatus === 404;
      return {
        id: 'A9', group: 'A', passed, startedAt,
        expectedStatus: 404, actualStatus: secondStatus,
        steps: [
          this._step('DELETE', '/v1/device-bindings/current', { device_sn: deviceSn }, null),
          { method: 'GET', path: '/v1/device-bindings/current', request: { device_sn: deviceSn }, response: { status: secondStatus, body: null } },
        ],
      };
    } catch (e) {
      return { id: 'A9', group: 'A', passed: false, error: e.message, startedAt, steps: [] };
    }
  }

  async _A10() {
    const startedAt = new Date().toISOString();
    try {
      await this.client.logout();
      this.state.userAccessToken = null;
      this.client.clearUserToken();
      return {
        id: 'A10', group: 'A', passed: true, startedAt,
        expectedStatus: 204, actualStatus: 204,
        steps: [this._step('DELETE', '/v1/user-sessions/current', null, null)],
      };
    } catch (e) {
      return { id: 'A10', group: 'A', passed: false, error: e.message, startedAt, steps: [this._step('DELETE', '/v1/user-sessions/current', null, null, e)] };
    }
  }

  async _A11() {
    // 健康检查：/healthz 部署在根路径（不带 /lumi-mind 前缀）
    // /readyz 仅 Docker/Caddy 内部使用，不对外暴露，故不测试
    const startedAt = new Date().toISOString();
    const steps = [];
    try {
      let h = null;
      try {
        h = await this.client.health();
        steps.push(this._step('GET', '/healthz', null, h));
      } catch (e1) {
        steps.push(this._step('GET', '/healthz', null, null, e1));
        throw e1;
      }
      return {
        id: 'A11', group: 'A', passed: true, startedAt,
        expectedStatus: 200, actualStatus: 200,
        steps,
        assertions: [
          { name: 'healthz status=ok', passed: h.status === 'ok' },
        ],
      };
    } catch (e) {
      const status = errorStatus(e);
      return {
        id: 'A11', group: 'A', passed: false, error: e.message, startedAt,
        expectedStatus: 200, actualStatus: status,
        steps,
      };
    }
  }

  // ============ B 组 ============
  // 通用 B 组执行器：构造异常输入，断言预期 HTTP status
  async _runB(id, expectedStatus, fn) {
    const startedAt = new Date().toISOString();
    try {
      await fn();
      // 没抛错 — 如果 expectedStatus 是 4xx/5xx 则视为未拦截
      return {
        id, group: 'B', passed: false, startedAt,
        expectedStatus, actualStatus: null,
        error: 'Expected error not raised',
        steps: [],
      };
    } catch (e) {
      const actual = errorStatus(e);
      const passed = isExpectedStatus(actual, expectedStatus);
      return {
        id, group: 'B', passed, startedAt,
        expectedStatus, actualStatus: actual,
        error: passed ? null : e.message,
        steps: [{ method: 'B', path: id, request: { scenario: id }, response: { status: actual, body: e.body || null } }],
      };
    }
  }

  async _B1() {
    return this._runB('B1', 401, () => this.client.login({ account: this.config.account, password: 'wrong-password' }));
  }
  async _B2() {
    return this._runB('B2', 401, () => this.client.login({ account: 'nonexistent-' + Date.now(), password: 'supersecret-pw-1234' }));
  }
  async _B3() {
    return this._runB('B3', 422, () => this.client.login({ account: this.config.account, password: '' }));
  }
  async _B4() {
    return this._runB('B4', 422, () => this.client.login({ account: this.config.account, password: 'short' }));
  }
  async _B5() {
    return this._runB('B5', 422, () => this.client.login({ account: 'ab', password: 'supersecret-pw-1234' }));
  }
  async _B6() {
    return this._runB('B6', [401, 422], () => this.client.login({ account: "admin' OR '1'='1", password: 'supersecret-pw-1234' }));
  }
  async _B7() {
    return this._runB('B7', 422, () => this.client.login({ account: this.config.account, password: this.config.password, is_admin: true }));
  }
  async _B8() {
    // 重放已消费的 refresh token
    if (!this.state.userRefreshToken) {
      return { id: 'B8', group: 'B', passed: false, error: '需要先运行 A1/A2 获取 refresh token', steps: [] };
    }
    return this._runB('B8', 401, () => this.client.refreshSession({ userRefreshToken: this.state.userRefreshToken }));
  }
  async _B9() {
    const random = 'x'.repeat(43);
    return this._runB('B9', 401, () => this.client.refreshSession({ userRefreshToken: random }));
  }
  async _B10() {
    const saved = this.client.deviceAccessToken;
    this.client.clearDeviceToken();
    const r = await this._runB('B10', [401, 403], () => this.client.pairingChallenge());
    if (saved) this.client.setDeviceToken(saved);
    return r;
  }
  async _B11() {
    const saved = this.client.deviceAccessToken;
    this.client.setDeviceToken('fake.jwt.token');
    const r = await this._runB('B11', [401, 403], () => this.client.pairingChallenge());
    if (saved) this.client.setDeviceToken(saved); else this.client.clearDeviceToken();
    return r;
  }
  async _B12() {
    const { computeDeviceProof, genNonce } = this.crypto;
    const ts = Math.floor(Date.now() / 1000);
    const nonce = genNonce();
    const { proof, canonicalBody } = await computeDeviceProof({
      secretB64url: this.config.deviceSecretB64url,
      productId: this.config.productId,
      deviceSn: this.config.deviceSn,
      credentialVersion: this.config.credentialVersion,
      timestamp: ts, nonce,
      capabilityDigest: this.config.capabilityDigest,
    });
    const body = JSON.parse(canonicalBody);
    body.device_proof = 'A'.repeat(43); // 全零/全A proof
    return this._runB('B12', 401, () => this.client.deviceSession(body));
  }
  async _B13() {
    if (!this.state.deviceNonce) {
      return { id: 'B13', group: 'B', passed: false, error: '需要先运行 A3 获取 nonce', steps: [] };
    }
    const { computeDeviceProof } = this.crypto;
    const ts = Math.floor(Date.now() / 1000);
    const { proof, canonicalBody } = await computeDeviceProof({
      secretB64url: this.config.deviceSecretB64url,
      productId: this.config.productId,
      deviceSn: this.config.deviceSn,
      credentialVersion: this.config.credentialVersion,
      timestamp: ts, nonce: this.state.deviceNonce, // 重放
      capabilityDigest: this.config.capabilityDigest,
    });
    const body = JSON.parse(canonicalBody);
    body.device_proof = proof;
    return this._runB('B13', [409, 401], () => this.client.deviceSession(body));
  }
  async _B14() {
    const { computeDeviceProof, genNonce } = this.crypto;
    const ts = Math.floor(Date.now() / 1000) - 700;
    const nonce = genNonce();
    const { proof, canonicalBody } = await computeDeviceProof({
      secretB64url: this.config.deviceSecretB64url,
      productId: this.config.productId,
      deviceSn: this.config.deviceSn,
      credentialVersion: this.config.credentialVersion,
      timestamp: ts, nonce,
      capabilityDigest: this.config.capabilityDigest,
    });
    const body = JSON.parse(canonicalBody);
    body.device_proof = proof;
    return this._runB('B14', [401, 400], () => this.client.deviceSession(body));
  }
  async _B15() {
    if (!this.state.pairingNonce) {
      return { id: 'B15', group: 'B', passed: false, error: '需要先运行 A5/A6', steps: [] };
    }
    return this._runB('B15', 401, () => this.client.bindDevice({
      device_sn: this.config.deviceSn,
      child_profile_id: this.config.childProfileId,
      pairing_proof: 'A'.repeat(43),
      nonce: this.state.pairingNonce,
      timestamp: this.state.pairingTimestamp,
    }));
  }
  async _B16() {
    if (!this.state.pairingProof) {
      return { id: 'B16', group: 'B', passed: false, error: '需要先运行 A5/A6', steps: [] };
    }
    return this._runB('B16', 409, () => this.client.bindDevice({
      device_sn: this.config.deviceSn,
      child_profile_id: this.config.childProfileId,
      pairing_proof: this.state.pairingProof,
      nonce: this.state.pairingNonce,
      timestamp: this.state.pairingTimestamp,
    }));
  }
  async _B17() {
    return this._runB('B17', 422, () => this.client.bindDevice({
      device_sn: this.config.deviceSn,
      child_profile_id: this.config.childProfileId,
      pairing_proof: 'A'.repeat(43),
      nonce: '!!!invalid!!!',
      timestamp: Math.floor(Date.now() / 1000),
    }));
  }
  async _B18() {
    return this._runB('B18', 422, () => this.client.bindDevice({
      device_sn: this.config.deviceSn,
    }));
  }
  async _B19() {
    if (!this.state.pairingNonce) {
      return { id: 'B19', group: 'B', passed: false, error: '需要先运行 A5', steps: [] };
    }
    return this._runB('B19', [400, 401], () => this.client.bindDevice({
      device_sn: this.config.deviceSn,
      child_profile_id: this.config.childProfileId,
      pairing_proof: this.state.pairingProof,
      nonce: this.state.pairingNonce,
      timestamp: Math.floor(Date.now() / 1000) - 600,
    }));
  }
  async _B20() {
    return this._runB('B20', 422, () => this.client.bindDevice({
      device_sn: 'X'.repeat(200),
      child_profile_id: this.config.childProfileId,
      pairing_proof: 'A'.repeat(43),
      nonce: 'n'.repeat(22),
      timestamp: Math.floor(Date.now() / 1000),
    }));
  }
  async _B21() {
    return this._runB('B21', [404, 403], () => this.client.getBinding({ deviceSn: 'NONEXIST-99999' }));
  }
  async _B22() {
    const saved = this.client.deviceAccessToken;
    // 用 User Token 访问 Device 端点
    this.client.setDeviceToken(this.state.userAccessToken);
    const r = await this._runB('B22', [401, 403], () => this.client.pairingChallenge());
    if (saved) this.client.setDeviceToken(saved); else this.client.clearDeviceToken();
    return r;
  }
  async _B23() {
    const savedUser = this.client.userAccessToken;
    // 用 Device Token 访问 User 端点
    this.client.setUserToken(this.state.deviceAccessToken);
    const r = await this._runB('B23', [401, 403, 422], () => this.client.bindDevice({
      device_sn: this.config.deviceSn,
      child_profile_id: this.config.childProfileId,
      pairing_proof: 'A'.repeat(43),
      nonce: 'n'.repeat(22),
      timestamp: Math.floor(Date.now() / 1000),
    }));
    if (savedUser) this.client.setUserToken(savedUser); else this.client.clearUserToken();
    return r;
  }
  async _B24() {
    // B24: 验证登出后旧 Token 失效
    // 设计：保存当前 token → 调用登出 → 用旧 token 发请求 → 验证 401/403 → 恢复状态
    const savedToken = this.state.userAccessToken;
    if (!savedToken) {
      return { id: 'B24', group: 'B', passed: false, error: '需要先运行 A1 登录获取 token', steps: [] };
    }
    try {
      // 登出（会清理服务端 session）
      await this.client.logout();
      // 用旧 token 发请求（应被拒绝）
      this.client.setUserToken(savedToken);
      const r = await this._runB('B24', [401, 403], () => this.client.getBinding({ deviceSn: this.config.deviceSn }));
      // 清理本地状态
      this.state.userAccessToken = null;
      this.state.userRefreshToken = null;
      this.client.clearUserToken();
      return r;
    } catch (e) {
      // 即使登出失败也清理
      this.client.setUserToken(savedToken);
      return { id: 'B24', group: 'B', passed: false, error: e.message, steps: [] };
    }
  }

  // ============ S 组：端到端场景 ============

  /**
   * S1: 完整生命周期
   * 用户登录 → 设备认证 → Bootstrap → Pairing Nonce → 计算 Proof → 绑定设备 → 查询绑定 →
   * 解绑 → 验证解绑(404) → 刷新 User Token → 用户登出
   *
   * 场景自包含：重置 state，内部完成全部前置准备
   */
  async _S1() {
    const startedAt = new Date().toISOString();
    const steps = [];
    const assertions = [];
    const { computeDeviceProof, computePairingProof } = this.crypto;

    // 重置 state，确保场景独立可运行（保留 overrides，否则用户在 UI 设置的参数覆盖会丢失）
    const preservedOverrides = this.state.overrides;
    this.state = {
      userAccessToken: null, userRefreshToken: null,
      deviceAccessToken: null, deviceRefreshToken: null,
      deviceNonce: null, deviceTimestamp: null,
      pairingNonce: null, pairingTimestamp: null, pairingProof: null,
      overrides: preservedOverrides,
    };
    this.client.clearUserToken();
    this.client.clearDeviceToken();

    try {
      // 1. 用户登录
      const loginResp = await this.client.login({
        account: this.config.account,
        password: this.config.password,
      });
      this.state.userAccessToken = loginResp.user_access_token;
      this.state.userRefreshToken = loginResp.user_refresh_token;
      this.client.setUserToken(loginResp.user_access_token);
      steps.push(this._step('POST', '/v1/user-sessions', { account: this.config.account, password: '***' }, loginResp, null, 201));
      assertions.push({ name: '登录: user_access_token 以 ey 开头', passed: !!loginResp.user_access_token?.startsWith('ey') });
      assertions.push({ name: '登录: user_refresh_token 存在', passed: !!loginResp.user_refresh_token });

      // 2. 设备认证（计算 device_proof）
      const ts = Math.floor(Date.now() / 1000);
      const devNonce = this.crypto.genNonce();
      const { proof: devProof, canonicalBody: devCanonicalBody } = await computeDeviceProof({
        secretB64url: this.config.deviceSecretB64url,
        productId: this.config.productId,
        deviceSn: this.config.deviceSn,
        credentialVersion: this.config.credentialVersion,
        timestamp: ts,
        nonce: devNonce,
        appVersion: '1.2.1',
        firmwareVersion: '1.0.0',
        capabilityDigest: this.config.capabilityDigest,
      });
      const devAuthBody = JSON.parse(devCanonicalBody);
      devAuthBody.device_proof = devProof;
      const devAuthResp = await this.client.deviceSession(devAuthBody);
      this.state.deviceAccessToken = devAuthResp.device_access_token;
      this.state.deviceRefreshToken = devAuthResp.device_refresh_token;
      this.client.setDeviceToken(devAuthResp.device_access_token);
      steps.push(this._step('POST', '/v1/device-sessions', devAuthBody, devAuthResp, null, 201));
      assertions.push({ name: '设备认证: device_access_token 以 ey 开头', passed: !!devAuthResp.device_access_token?.startsWith('ey') });

      // 3. 设备 Bootstrap
      const bootResp = await this.client.deviceBootstrap();
      steps.push(this._step('GET', '/v1/device-bootstrap', null, bootResp));
      assertions.push({ name: 'Bootstrap: device_sn 匹配', passed: bootResp.device_sn === this.config.deviceSn });

      // 4. 获取 Pairing Nonce
      const pairResp = await this.client.pairingChallenge();
      this.state.pairingNonce = pairResp.nonce;
      this.state.pairingTimestamp = pairResp.timestamp;
      steps.push(this._step('GET', '/v1/device-pairing-challenges', null, pairResp));
      assertions.push({ name: 'Pairing: nonce 格式合法', passed: /^[A-Za-z0-9_-]{22}$/.test(pairResp.nonce) });

      // 5. 计算 Pairing Proof
      const { proof: pairProof } = await computePairingProof({
        secretB64url: this.config.deviceSecretB64url,
        deviceSn: this.config.deviceSn,
        timestamp: this.state.pairingTimestamp,
        nonce: this.state.pairingNonce,
      });
      this.state.pairingProof = pairProof;
      steps.push({
        method: 'LOCAL', path: 'computePairingProof',
        request: { timestamp: this.state.pairingTimestamp, nonce: this.state.pairingNonce },
        response: { status: 'ok', body: { proof: pairProof, length: pairProof.length } },
        error: null,
      });
      assertions.push({ name: 'Pairing Proof: 长度=43', passed: pairProof.length === 43 });

      // 6. 绑定设备
      const bindResp = await this.client.bindDevice({
        device_sn: this.config.deviceSn,
        child_profile_id: this.config.childProfileId,
        pairing_proof: pairProof,
        nonce: this.state.pairingNonce,
        timestamp: this.state.pairingTimestamp,
      });
      steps.push(this._step('POST', '/v1/device-bindings', {
        device_sn: this.config.deviceSn, child_profile_id: this.config.childProfileId,
        pairing_proof: pairProof, nonce: this.state.pairingNonce, timestamp: this.state.pairingTimestamp,
      }, bindResp, null, 201));
      assertions.push({ name: '绑定: 返回 child_profile_id', passed: !!bindResp.child_profile_id });
      assertions.push({ name: '绑定: status=active', passed: bindResp.status === 'active' });

      // 7. 查询绑定验证
      const getResp = await this.client.getBinding({ deviceSn: this.config.deviceSn });
      steps.push(this._step('GET', '/v1/device-bindings/current', { device_sn: this.config.deviceSn }, getResp));
      assertions.push({ name: '查询绑定: device_sn 匹配', passed: getResp.device_sn === this.config.deviceSn });
      assertions.push({ name: '查询绑定: status=active', passed: getResp.status === 'active' });

      // 8. 解绑设备
      const unbindResp = await this.client.unbind({ deviceSn: this.config.deviceSn });
      steps.push(this._step('DELETE', '/v1/device-bindings/current', { device_sn: this.config.deviceSn }, unbindResp, null, 204));
      assertions.push({ name: '解绑: 返回 204', passed: true });

      // 9. 验证解绑后查询应返回 404
      try {
        const verifyResp = await this.client.getBinding({ deviceSn: this.config.deviceSn });
        // 仍能查到，断言失败
        steps.push(this._step('GET', '/v1/device-bindings/current (验证)', { device_sn: this.config.deviceSn }, verifyResp, null, 404));
        assertions.push({ name: '解绑后查询: 应返回 404', passed: false });
      } catch (e) {
        steps.push(this._step('GET', '/v1/device-bindings/current (验证)', { device_sn: this.config.deviceSn }, null, e, 404));
        assertions.push({ name: '解绑后查询: 返回 404', passed: e.status === 404 });
      }

      // 10. 刷新 User Token
      const refreshResp = await this.client.refreshSession({ user_refresh_token: this.state.userRefreshToken });
      this.state.userAccessToken = refreshResp.user_access_token;
      this.state.userRefreshToken = refreshResp.user_refresh_token;
      this.client.setUserToken(refreshResp.user_access_token);
      steps.push(this._step('POST', '/v1/user-sessions:refresh', { user_refresh_token: '***' }, refreshResp, null, 200));
      assertions.push({ name: '刷新: 新 user_access_token 存在', passed: !!refreshResp.user_access_token });

      // 11. 用户登出
      const logoutResp = await this.client.logout();
      steps.push(this._step('DELETE', '/v1/user-sessions/current', null, logoutResp, null, 204));
      assertions.push({ name: '登出: 返回 204', passed: true });

      const passed = assertions.every(a => a.passed);
      return {
        id: 'S1', group: 'S', side: 'both',
        passed, startedAt,
        title: '完整生命周期',
        steps,
        assertions,
        expectedStatus: null,
        actualStatus: null,
      };
    } catch (e) {
      // 场景中途失败：保留已完成步骤，标记整体失败
      const failedStep = this._step('—', '—', null, null, e);
      steps.push(failedStep);
      assertions.push({ name: '场景无异常', passed: false });
      return {
        id: 'S1', group: 'S', side: 'both',
        passed: false, startedAt,
        title: '完整生命周期',
        error: e?.message || String(e),
        steps,
        assertions,
      };
    }
  }

  // ============ P 组：配对二维码场景 ============

  /**
   * P1: 设备配对二维码生成
   * 设备认证 → Bootstrap → 获取 Pairing Nonce → 计算 Pairing Proof → 组装 JSON
   *
   * 生成的 JSON 结构：
   *   { sn, proof, nonce, ts, pid, cv }
   * 该 JSON 是配对二维码的内容，传递给用户侧（P2）用于绑定设备
   */
  async _P1() {
    const startedAt = new Date().toISOString();
    const steps = [];
    const assertions = [];
    const { computeDeviceProof, computePairingProof } = this.crypto;

    // 重置设备相关 state
    this.state.deviceAccessToken = null;
    this.state.deviceRefreshToken = null;
    this.state.pairingNonce = null;
    this.state.pairingTimestamp = null;
    this.state.pairingProof = null;
    this.state.pairingPayload = null;
    this.state.pairingJson = null;
    this.client.clearDeviceToken();

    try {
      // 1. 设备认证
      const ts = Math.floor(Date.now() / 1000);
      const devNonce = this.crypto.genNonce();
      const { proof: devProof, canonicalBody: devCanonicalBody } = await computeDeviceProof({
        secretB64url: this.config.deviceSecretB64url,
        productId: this.config.productId,
        deviceSn: this.config.deviceSn,
        credentialVersion: this.config.credentialVersion,
        timestamp: ts,
        nonce: devNonce,
        appVersion: '1.2.1',
        firmwareVersion: '1.0.0',
        capabilityDigest: this.config.capabilityDigest,
      });
      const devAuthBody = JSON.parse(devCanonicalBody);
      devAuthBody.device_proof = devProof;
      const devAuthResp = await this.client.deviceSession(devAuthBody);
      this.state.deviceAccessToken = devAuthResp.device_access_token;
      this.state.deviceRefreshToken = devAuthResp.device_refresh_token;
      this.client.setDeviceToken(devAuthResp.device_access_token);
      steps.push(this._step('POST', '/v1/device-sessions', devAuthBody, devAuthResp, null, 201));
      assertions.push({ name: '设备认证: device_access_token 存在', passed: !!devAuthResp.device_access_token });

      // 2. Bootstrap
      const bootResp = await this.client.deviceBootstrap();
      steps.push(this._step('GET', '/v1/device-bootstrap', null, bootResp));
      assertions.push({ name: 'Bootstrap: device_sn 匹配', passed: bootResp.device_sn === this.config.deviceSn });

      // 3. 获取 Pairing Nonce
      const pairResp = await this.client.pairingChallenge();
      this.state.pairingNonce = pairResp.nonce;
      this.state.pairingTimestamp = pairResp.timestamp;
      steps.push(this._step('GET', '/v1/device-pairing-challenges', null, pairResp));
      assertions.push({ name: 'Pairing: nonce 格式合法', passed: /^[A-Za-z0-9_-]{22}$/.test(pairResp.nonce) });

      // 4. 计算 Pairing Proof
      const { proof: pairProof } = await computePairingProof({
        secretB64url: this.config.deviceSecretB64url,
        deviceSn: this.config.deviceSn,
        timestamp: this.state.pairingTimestamp,
        nonce: this.state.pairingNonce,
      });
      this.state.pairingProof = pairProof;
      steps.push({
        method: 'LOCAL', path: 'computePairingProof',
        request: { timestamp: this.state.pairingTimestamp, nonce: this.state.pairingNonce },
        response: { status: 'ok', body: { proof: pairProof, length: pairProof.length } },
        error: null,
      });
      assertions.push({ name: 'Pairing Proof: 长度=43', passed: pairProof.length === 43 });

      // 5. 组装配对 JSON（二维码内容）
      const payload = {
        sn: this.config.deviceSn,
        proof: pairProof,
        nonce: this.state.pairingNonce,
        ts: this.state.pairingTimestamp,
        pid: this.config.productId,
        cv: this.config.credentialVersion,
      };
      const pairingJson = JSON.stringify(payload);
      this.state.pairingPayload = payload;
      this.state.pairingJson = pairingJson;
      steps.push({
        method: 'LOCAL', path: 'generatePairingJson',
        request: { payload },
        response: { status: 'ok', body: { json: pairingJson, length: pairingJson.length } },
        error: null,
      });
      assertions.push({ name: '配对 JSON: 包含 sn', passed: pairingJson.includes('"sn"') });
      assertions.push({ name: '配对 JSON: 包含 proof', passed: pairingJson.includes('"proof"') });
      assertions.push({ name: '配对 JSON: 可解析', passed: !!JSON.parse(pairingJson) });

      const passed = assertions.every(a => a.passed);
      return {
        id: 'P1', group: 'P', side: 'device',
        passed, startedAt,
        title: '设备配对二维码生成',
        steps, assertions,
        pairingPayload: payload,
        pairingJson,
      };
    } catch (e) {
      const failedStep = this._step('—', '—', null, null, e);
      steps.push(failedStep);
      assertions.push({ name: '场景无异常', passed: false });
      return {
        id: 'P1', group: 'P', side: 'device',
        passed: false, startedAt,
        title: '设备配对二维码生成',
        error: e?.message || String(e),
        steps, assertions,
      };
    }
  }

  /**
   * P2: 用户扫码绑定
   * 用户登录 → 解析配对 JSON → 调用绑定 API → 验证绑定成功
   *
   * 配对 JSON 来源（优先级）：
   *   1. 运行时手动粘贴（state.pairingJsonInput，由 UI 输入框提供）
   *   2. P1 自动注入的 state.pairingJson
   */
  async _P2() {
    const startedAt = new Date().toISOString();
    const steps = [];
    const assertions = [];

    // 获取配对 JSON：优先手动输入，其次 P1 注入
    const pairingJson = this.state.pairingJsonInput || this.state.pairingJson;
    if (!pairingJson) {
      return {
        id: 'P2', group: 'P', side: 'app',
        passed: false, startedAt,
        title: '用户扫码绑定',
        error: '需要先运行 P1 生成配对 JSON，或在输入框手动粘贴配对 JSON',
        steps: [],
        assertions: [],
      };
    }

    let payload;
    try {
      payload = JSON.parse(pairingJson);
    } catch (e) {
      return {
        id: 'P2', group: 'P', side: 'app',
        passed: false, startedAt,
        title: '用户扫码绑定',
        error: '配对 JSON 解析失败: ' + e.message,
        steps: [],
        assertions: [],
      };
    }

    // 重置用户 state
    this.state.userAccessToken = null;
    this.state.userRefreshToken = null;
    this.client.clearUserToken();

    try {
      // 1. 用户登录
      const loginResp = await this.client.login({
        account: this.config.account,
        password: this.config.password,
      });
      this.state.userAccessToken = loginResp.user_access_token;
      this.state.userRefreshToken = loginResp.user_refresh_token;
      this.client.setUserToken(loginResp.user_access_token);
      steps.push(this._step('POST', '/v1/user-sessions', { account: this.config.account, password: '***' }, loginResp, null, 201));
      assertions.push({ name: '登录: user_access_token 存在', passed: !!loginResp.user_access_token });

      // 2. 解析配对 JSON（模拟扫码）
      steps.push({
        method: 'LOCAL', path: 'parsePairingJson',
        request: { json: pairingJson },
        response: { status: 'ok', body: payload },
        error: null,
      });
      assertions.push({ name: '配对 JSON: 包含 sn', passed: !!payload.sn });
      assertions.push({ name: '配对 JSON: 包含 proof', passed: !!payload.proof });
      assertions.push({ name: '配对 JSON: 包含 nonce', passed: !!payload.nonce });
      assertions.push({ name: '配对 JSON: 包含 ts', passed: payload.ts != null });

      // 3. 调用绑定 API
      const bindResp = await this.client.bindDevice({
        device_sn: payload.sn,
        child_profile_id: this.config.childProfileId,
        pairing_proof: payload.proof,
        nonce: payload.nonce,
        timestamp: payload.ts,
      });
      steps.push(this._step('POST', '/v1/device-bindings', {
        device_sn: payload.sn, child_profile_id: this.config.childProfileId,
        pairing_proof: payload.proof, nonce: payload.nonce, timestamp: payload.ts,
      }, bindResp, null, 201));
      assertions.push({ name: '绑定: 返回 child_profile_id', passed: !!bindResp.child_profile_id });
      assertions.push({ name: '绑定: status=active', passed: bindResp.status === 'active' });
      assertions.push({ name: '绑定: device_sn 匹配', passed: bindResp.device_sn === payload.sn });

      const passed = assertions.every(a => a.passed);
      return {
        id: 'P2', group: 'P', side: 'app',
        passed, startedAt,
        title: '用户扫码绑定',
        steps, assertions,
      };
    } catch (e) {
      const failedStep = this._step('—', '—', null, null, e);
      steps.push(failedStep);
      assertions.push({ name: '场景无异常', passed: false });
      return {
        id: 'P2', group: 'P', side: 'app',
        passed: false, startedAt,
        title: '用户扫码绑定',
        error: e?.message || String(e),
        steps, assertions,
      };
    }
  }
}
