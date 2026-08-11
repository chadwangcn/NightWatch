import { describe, test, expect } from 'vitest';
import { TestRunner } from '../src/runner.js';

function makeRunner(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (method, path, body) => {
    calls.push({ method, path, body });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected call: ${method} ${path}`);
    if (next.error) throw next.error;
    return next.resp;
  };
  const client = {
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
  const runner = new TestRunner({
    client,
    config: {
      baseUrl: 'https://api.example.com',
      account: 'tester', password: 'pw',
      deviceSn: 'K1-2026-000001', deviceSecretB64url: 'A'.repeat(43),
      childProfileId: 'child-1', productId: 'k1', credentialVersion: 1,
    },
    crypto: {
      computeDeviceProof: async () => ({
        proof: 'd'.repeat(43),
        canonicalBody: JSON.stringify({
          product_id: 'k1', device_sn: 'K1-2026-000001', credential_version: 1,
          timestamp: 1785210000, nonce: 'n'.repeat(22),
          runtime: { app_version: '1.2.1', firmware_version: '1.0.0', capability_digest: 'x' },
        }),
      }),
      computePairingProof: async () => ({ proof: 'p'.repeat(43) }),
      genNonce: () => 'n'.repeat(22),
    },
  });
  return { runner, client };
}

describe('P1: 设备配对二维码生成', () => {
  test('P1 在 listCases 中可见，group=P，side=device', () => {
    const { runner } = makeRunner([]);
    const p1 = runner.listCases().find(c => c.id === 'P1');
    expect(p1).toBeDefined();
    expect(p1.group).toBe('P');
    expect(p1.side).toBe('device');
  });

  test('P1 生成配对 JSON（含 sn/proof/nonce/ts/pid/cv）', async () => {
    const { runner } = makeRunner([
      // 设备认证
      { resp: { device_access_token: 'eyJ.dev', device_refresh_token: 'dr', expires_in: 3600 } },
      // Bootstrap
      { resp: { device_sn: 'K1-2026-000001', firmware_version: '1.0.0' } },
      // Pairing Challenge
      { resp: { nonce: 'n'.repeat(22), timestamp: 1785210000, expires_in: 300, device_sn: 'K1-2026-000001' } },
    ]);
    const result = await runner.run('P1');
    expect(result.passed).toBe(true);
    expect(result.pairingPayload).toBeDefined();
    expect(result.pairingPayload.sn).toBe('K1-2026-000001');
    expect(result.pairingPayload.proof).toBe('p'.repeat(43));
    expect(result.pairingPayload.nonce).toBe('n'.repeat(22));
    expect(result.pairingPayload.ts).toBe(1785210000);
    expect(result.pairingPayload.pid).toBe('k1');
    expect(result.pairingPayload.cv).toBe(1);
    // 生成 JSON 字符串
    expect(result.pairingJson).toContain('"sn":"K1-2026-000001"');
    expect(result.pairingJson).toContain('"proof":"ppppp');
  });

  test('P1 失败时不生成 payload', async () => {
    const { runner } = makeRunner([
      { error: { status: 401, code: 'AUTH_FAILED', message: 'bad', request: {}, response: { status: 401 }, toDebugJSON: () => ({}) } },
    ]);
    const result = await runner.run('P1');
    expect(result.passed).toBe(false);
    expect(result.pairingPayload).toBeUndefined();
    expect(result.pairingJson).toBeUndefined();
  });
});

describe('P2: 用户扫描配对 JSON 绑定设备', () => {
  test('P2 在 listCases 中可见，group=P，side=app', () => {
    const { runner } = makeRunner([]);
    const p2 = runner.listCases().find(c => c.id === 'P2');
    expect(p2).toBeDefined();
    expect(p2.group).toBe('P');
    expect(p2.side).toBe('app');
  });

  test('P2 从 P1 的 pairingPayload 自动读取并绑定成功', async () => {
    const { runner } = makeRunner([
      // 用户登录
      { resp: { user_access_token: 'eyJ.user', user_refresh_token: 'rt', expires_in: 900 } },
      // 绑定设备
      { resp: { device_sn: 'K1-2026-000001', child_profile_id: 'child-1', binding_version: 1, status: 'active' } },
    ]);
    // 模拟 P1 已运行，存入 state
    runner.state.pairingPayload = {
      sn: 'K1-2026-000001', proof: 'p'.repeat(43),
      nonce: 'n'.repeat(22), ts: 1785210000, pid: 'k1', cv: 1,
    };
    runner.state.pairingJson = JSON.stringify(runner.state.pairingPayload);

    const result = await runner.run('P2');
    expect(result.passed).toBe(true);
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    // 绑定请求应使用 payload 中的字段
    const bindCall = result.steps.find(s => s.path === '/v1/device-bindings');
    expect(bindCall).toBeDefined();
    expect(bindCall.request.body.device_sn).toBe('K1-2026-000001');
    expect(bindCall.request.body.pairing_proof).toBe('p'.repeat(43));
    expect(bindCall.request.body.nonce).toBe('n'.repeat(22));
    expect(bindCall.request.body.timestamp).toBe(1785210000);
  });

  test('P2 未运行 P1 时报错提示', async () => {
    const { runner } = makeRunner([]);
    const result = await runner.run('P2');
    expect(result.passed).toBe(false);
    expect(result.error).toContain('P1');
  });

  test('P2 支持手动粘贴 pairingJson 覆盖 state', async () => {
    const { runner } = makeRunner([
      { resp: { user_access_token: 't', user_refresh_token: 'r', expires_in: 900 } },
      { resp: { device_sn: 'SN-MANUAL', child_profile_id: 'c', binding_version: 1, status: 'active' } },
    ]);
    // 手动注入 pairingJson（模拟用户粘贴）
    runner.state.pairingJson = JSON.stringify({
      sn: 'SN-MANUAL', proof: 'x'.repeat(43),
      nonce: 'y'.repeat(22), ts: 1785210099, pid: 'k1', cv: 1,
    });
    const result = await runner.run('P2');
    expect(result.passed).toBe(true);
    const bindCall = result.steps.find(s => s.path === '/v1/device-bindings');
    expect(bindCall.request.body.device_sn).toBe('SN-MANUAL');
  });
});
