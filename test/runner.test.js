import { describe, test, expect, vi, beforeEach } from 'vitest';
import { TestRunner } from '../src/runner.js';
import { LumiApiClient } from '../src/api-client.js';
import { computeDeviceProof, computePairingProof, genNonce } from '../src/crypto.js';

// 模拟整个 LumiApiClient
function makeMockClient() {
  const calls = [];
  const state = { unbound: new Set() };
  const client = {
    baseUrl: 'https://api.example.com',
    userAccessToken: null,
    deviceAccessToken: null,
    setUserToken: vi.fn((t) => { client.userAccessToken = t; }),
    setDeviceToken: vi.fn((t) => { client.deviceAccessToken = t; }),
    clearUserToken: vi.fn(() => { client.userAccessToken = null; }),
    clearDeviceToken: vi.fn(() => { client.deviceAccessToken = null; }),
    login: vi.fn(async () => ({ user_access_token: 'user-jwt', user_refresh_token: 'refresh-1', expires_in: 900 })),
    refreshSession: vi.fn(async () => ({ user_access_token: 'user-jwt-2', user_refresh_token: 'refresh-2', expires_in: 900 })),
    logout: vi.fn(async () => null),
    deviceSession: vi.fn(async () => ({ device_access_token: 'dev-jwt', device_refresh_token: 'dev-refresh', expires_in: 900 })),
    deviceBootstrap: vi.fn(async () => ({ device_sn: 'K1-2026-000001', credential_version: 1, binding_version: 0 })),
    pairingChallenge: vi.fn(async () => ({ device_sn: 'K1-2026-000001', nonce: 'AAAAAAAAAAAAAAAAAAAAAA', timestamp: 1785210000, expires_in: 300 })),
    bindDevice: vi.fn(async ({ device_sn }) => {
      state.unbound.delete(device_sn);
      return { device_sn, child_profile_id: 'child-1', binding_version: 1, status: 'active' };
    }),
    getBinding: vi.fn(async ({ deviceSn }) => {
      if (state.unbound.has(deviceSn)) {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      }
      return { device_sn: deviceSn, child_profile_id: 'child-1', binding_version: 1, status: 'active' };
    }),
    unbind: vi.fn(async ({ deviceSn }) => { state.unbound.add(deviceSn); return null; }),
    health: vi.fn(async () => ({ status: 'ok' })),
    ready: vi.fn(async () => ({ schema: 'compatible' })),
  };
  return client;
}

const config = {
  baseUrl: 'https://api.example.com',
  account: 'tester',
  password: 'supersecret-pw-1234',
  deviceSn: 'K1-2026-000001',
  deviceSecretB64url: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  childProfileId: 'child-1',
  productId: 'k1',
  credentialVersion: 1,
};

describe('TestRunner — A 组顺序执行', () => {
  test('A1 登录成功后 user token 注入 client', async () => {
    const client = makeMockClient();
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    const result = await runner.run('A1');

    expect(result.id).toBe('A1');
    expect(result.passed).toBe(true);
    expect(client.setUserToken).toHaveBeenCalledWith('user-jwt');
    expect(result.steps[0].request).toMatchObject({ method: 'POST', path: '/v1/user-sessions' });
    expect(result.steps[0].response.status).toBe(201);
  });

  test('A2 刷新使用 A1 的 refresh token', async () => {
    const client = makeMockClient();
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    await runner.run('A1');
    const result = await runner.run('A2');

    expect(result.passed).toBe(true);
    expect(client.refreshSession).toHaveBeenCalledWith({ userRefreshToken: 'refresh-1' });
  });

  test('A3 设备认证计算 device_proof 并提交', async () => {
    const client = makeMockClient();
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    const result = await runner.run('A3');

    expect(result.passed).toBe(true);
    expect(client.deviceSession).toHaveBeenCalled();
    const body = client.deviceSession.mock.calls[0][0];
    expect(body.device_sn).toBe('K1-2026-000001');
    expect(body.device_proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(client.setDeviceToken).toHaveBeenCalledWith('dev-jwt');
  });

  test('A5 获取 pairing nonce 后保存到 state', async () => {
    const client = makeMockClient();
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    await runner.run('A3');
    const result = await runner.run('A5');

    expect(result.passed).toBe(true);
    expect(runner.state.pairingNonce).toBe('AAAAAAAAAAAAAAAAAAAAAA');
    expect(runner.state.pairingTimestamp).toBe(1785210000);
  });

  test('A7 绑定使用 A5 nonce 计算的 pairing_proof', async () => {
    const client = makeMockClient();
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    await runner.run('A3');
    await runner.run('A5');
    await runner.run('A6');
    const result = await runner.run('A7');

    expect(result.passed).toBe(true);
    const body = client.bindDevice.mock.calls[0][0];
    expect(body.pairing_proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.nonce).toBe('AAAAAAAAAAAAAAAAAAAAAA');
  });

  test('runSequence 顺序执行 A1..A11 返回所有结果', async () => {
    const client = makeMockClient();
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    const results = await runner.runSequence(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11']);

    expect(results.length).toBe(11);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  test('失败时记录错误且 passed=false', async () => {
    const client = makeMockClient();
    client.login.mockRejectedValueOnce(new Error('network'));
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    const result = await runner.run('A1');

    expect(result.passed).toBe(false);
    expect(result.error).toBe('network');
  });
});

describe('TestRunner — B 组健壮性', () => {
  test('B1 错误密码预期 401', async () => {
    const client = makeMockClient();
    client.login.mockRejectedValueOnce({ status: 401, code: 'AUTH_CREDENTIAL_INVALID', message: 'bad' });
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    const result = await runner.run('B1');

    expect(result.passed).toBe(true);
    expect(result.expectedStatus).toBe(401);
    expect(result.actualStatus).toBe(401);
  });

  test('B3 空密码预期 422', async () => {
    const client = makeMockClient();
    client.login.mockRejectedValueOnce({ status: 422, code: undefined, message: 'invalid' });
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    const result = await runner.run('B3');

    expect(result.passed).toBe(true);
    expect(result.actualStatus).toBe(422);
  });
});

describe('TestRunner — 用例定义', () => {
  test('列出所有 A 组用例', () => {
    const client = makeMockClient();
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    const cases = runner.listCases();
    const aCases = cases.filter((c) => c.id.startsWith('A'));
    expect(aCases.map((c) => c.id)).toEqual(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11']);
  });

  test('列出所有 B 组用例', () => {
    const client = makeMockClient();
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    const cases = runner.listCases();
    const bCases = cases.filter((c) => c.id.startsWith('B'));
    expect(bCases.length).toBe(24);
    expect(bCases.map((c) => c.id)).toEqual(Array.from({ length: 24 }, (_, i) => `B${i + 1}`));
  });

  test('每个用例有 side 字段（app/device）', () => {
    const client = makeMockClient();
    const runner = new TestRunner({ client, config, crypto: { computeDeviceProof, computePairingProof, genNonce } });
    const cases = runner.listCases();
    for (const c of cases) {
      expect(['app', 'device', 'both']).toContain(c.side);
    }
  });
});
