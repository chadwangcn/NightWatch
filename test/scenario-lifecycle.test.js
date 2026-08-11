import { describe, test, expect, beforeEach } from 'vitest';
import { TestRunner } from '../src/runner.js';

// 构造 mock client，按调用顺序返回预设响应
function makeMockClient(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (method, path, body) => {
    calls.push({ method, path, body });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected call: ${method} ${path}`);
    if (next.error) throw next.error;
    return next.resp;
  };
  return {
    calls,
    setUserToken() {}, clearUserToken() {},
    setDeviceToken() {}, clearDeviceToken() {},
    login: async (b) => impl('POST', '/v1/user-sessions', b),
    refreshSession: async (b) => impl('POST', '/v1/user-sessions:refresh', b),
    logout: async () => impl('DELETE', '/v1/user-sessions/current'),
    deviceSession: async (b) => impl('POST', '/v1/device-sessions', b),
    deviceBootstrap: async () => impl('GET', '/v1/device-bootstrap'),
    pairingChallenge: async () => impl('GET', '/v1/device-pairing-challenges'),
    bindDevice: async (b) => impl('POST', '/v1/device-bindings', b),
    getBinding: async (b) => impl('GET', '/v1/device-bindings/current'),
    unbind: async (b) => impl('DELETE', '/v1/device-bindings/current'),
  };
}

function makeRunner(responses) {
  const client = makeMockClient(responses);
  const runner = new TestRunner({
    client,
    config: {
      baseUrl: 'https://api.example.com',
      account: 'tester', password: 'supersecret-pw',
      deviceSn: 'K1-2026-000001', deviceSecretB64url: 'A'.repeat(43),
      childProfileId: 'child-1', productId: 'k1', credentialVersion: 1,
    },
    crypto: {
      computeDeviceProof: async () => ({
        proof: 'p'.repeat(43),
        canonicalBody: JSON.stringify({
          product_id: 'k1', device_sn: 'K1-2026-000001', credential_version: 1,
          timestamp: 1785210000, nonce: 'n'.repeat(22),
          runtime: { app_version: '1.2.1', firmware_version: '1.0.0', capability_digest: 'x' },
        }),
      }),
      computePairingProof: async () => ({ proof: 'q'.repeat(43) }),
      genNonce: () => 'n'.repeat(22),
    },
  });
  return { runner, client };
}

describe('Scenario: 用户登录到设备绑定完整生命周期', () => {
  test('S1: 登录→认证→绑定→查询→解绑→刷新→登出 全流程通过', async () => {
    const { runner } = makeRunner([
      // 1. 用户登录
      { resp: { user_access_token: 'eyJ.user.token', user_refresh_token: 'rt-1', expires_in: 900 } },
      // 2. 设备认证
      { resp: { device_access_token: 'eyJ.dev.token', device_refresh_token: 'drt-1', expires_in: 3600 } },
      // 3. Bootstrap
      { resp: { device_sn: 'K1-2026-000001', firmware_version: '1.0.0' } },
      // 4. Pairing Challenge
      { resp: { nonce: ' PairNonce1234567890123'.slice(1), timestamp: 1785210000, expires_in: 300, device_sn: 'K1-2026-000001' } },
      // 5. 绑定设备
      { resp: { device_sn: 'K1-2026-000001', child_profile_id: 'child-1', binding_version: 1, status: 'active' } },
      // 6. 查询绑定
      { resp: { device_sn: 'K1-2026-000001', child_profile_id: 'child-1', status: 'active' } },
      // 7. 解绑
      { resp: null },
      // 8. 查询解绑后状态（404）
      { error: { status: 404, code: 'BINDING_NOT_FOUND', message: 'not found', request: {}, response: { status: 404 }, toDebugJSON: () => ({}) } },
      // 9. 刷新 user token
      { resp: { user_access_token: 'eyJ.user.token2', user_refresh_token: 'rt-2', expires_in: 900 } },
      // 10. 用户登出
      { resp: null },
    ]);

    const result = await runner.run('S1');
    expect(result.passed).toBe(true);
    expect(result.id).toBe('S1');
    expect(result.steps.length).toBeGreaterThanOrEqual(10);
    // 关键调用链顺序
    const paths = result.steps.filter(s => s.method !== 'LOCAL').map(s => s.path);
    expect(paths).toContain('/v1/user-sessions');
    expect(paths).toContain('/v1/device-sessions');
    expect(paths).toContain('/v1/device-bindings');
    expect(paths).toContain('/v1/user-sessions:refresh');
    expect(paths).toContain('/v1/user-sessions/current');
  });

  test('S1: 任一步骤失败时整体标记为失败但保留已完成步骤', async () => {
    const { runner } = makeRunner([
      { resp: { user_access_token: 'eyJ.user.token', user_refresh_token: 'rt-1', expires_in: 900 } },
      { error: { status: 401, code: 'DEVICE_AUTH_FAILED', message: 'bad proof', request: {}, response: { status: 401 }, toDebugJSON: () => ({}) } },
    ]);
    const result = await runner.run('S1');
    expect(result.passed).toBe(false);
    expect(result.steps.length).toBeGreaterThanOrEqual(2); // 登录成功 + 设备认证失败
    expect(result.steps[0].response.status).toBe(201);
    expect(result.steps[1].error).toBeDefined();
  });

  test('S1: 解绑后查询应返回 404，否则断言失败', async () => {
    const { runner } = makeRunner([
      { resp: { user_access_token: 't', user_refresh_token: 'r', expires_in: 900 } },
      { resp: { device_access_token: 'dt', device_refresh_token: 'dr', expires_in: 3600 } },
      { resp: { device_sn: 'K1-2026-000001' } },
      { resp: { nonce: 'n'.repeat(22), timestamp: 1785210000, expires_in: 300, device_sn: 'K1-2026-000001' } },
      { resp: { device_sn: 'K1-2026-000001', child_profile_id: 'child-1', binding_version: 1, status: 'active' } },
      { resp: { device_sn: 'K1-2026-000001', child_profile_id: 'child-1', status: 'active' } },
      { resp: null },
      // 解绑后查询仍返回 200（错误行为）
      { resp: { device_sn: 'K1-2026-000001', status: 'active' } },
      { resp: { user_access_token: 't2', user_refresh_token: 'r2', expires_in: 900 } },
      { resp: null },
    ]);
    const result = await runner.run('S1');
    expect(result.passed).toBe(false);
    // 应该有断言失败：解绑后查询不应返回 200
    const failedAssertion = result.assertions?.find(a => !a.passed);
    expect(failedAssertion).toBeDefined();
  });

  test('S1 在 listCases 中可见，group=S，side=both', () => {
    const { runner } = makeRunner([]);
    const s1 = runner.listCases().find(c => c.id === 'S1');
    expect(s1).toBeDefined();
    expect(s1.group).toBe('S');
    expect(s1.side).toBe('both');
  });
});
