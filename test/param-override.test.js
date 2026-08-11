import { describe, test, expect } from 'vitest';
import { TestRunner } from '../src/runner.js';

function makeRunner() {
  const calls = [];
  const impl = async (m, p, b) => {
    calls.push({ method: m, path: p, body: b });
    if (m === 'POST' && p === '/v1/user-sessions') {
      return { user_access_token: 'eyJ.token', user_refresh_token: 'rt', expires_in: 900 };
    }
    if (m === 'POST' && p === '/v1/device-sessions') {
      return { device_access_token: 'eyJ.dev', device_refresh_token: 'drt', expires_in: 900 };
    }
    if (m === 'POST' && p === '/v1/device-bindings') {
      return { device_sn: b.device_sn, child_profile_id: b.child_profile_id, binding_version: 1, status: 'active' };
    }
    if (m === 'GET' && p === '/v1/device-bindings/current') {
      return { device_sn: b?.device_sn, child_profile_id: 'default-child', status: 'active' };
    }
    if (m === 'DELETE' && p === '/v1/device-bindings/current') return null;
    return {};
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
    getBinding: async (b) => impl('GET', '/v1/device-bindings/current', b),
    unbind: async (b) => impl('DELETE', '/v1/device-bindings/current', b),
  };
  return new TestRunner({
    client,
    config: {
      baseUrl: 'https://api.example.com',
      account: 'default-account', password: 'default-pw',
      deviceSn: 'K1-DEFAULT', deviceSecretB64url: 'A'.repeat(43),
      childProfileId: 'default-child', productId: 'k1', credentialVersion: 1,
    },
    crypto: {
      computeDeviceProof: async (params) => ({
        proof: 'd'.repeat(43),
        canonicalBody: JSON.stringify({
          product_id: params.productId,
          device_sn: params.deviceSn,
          credential_version: params.credentialVersion,
          timestamp: params.timestamp,
          nonce: params.nonce,
        }),
      }),
      computePairingProof: async () => ({ proof: 'p'.repeat(43) }),
      genNonce: () => 'n'.repeat(22),
    },
  });
}

describe('参数 override 机制', () => {
  test('A1 使用 override 的 account/password', async () => {
    const runner = makeRunner();
    runner.setParamOverrides('A1', { account: 'custom-user', password: 'custom-pw' });
    const result = await runner.run('A1');
    expect(result.passed).toBe(true);
    expect(runner.client.calls[0].body.account).toBe('custom-user');
    expect(runner.client.calls[0].body.password).toBe('custom-pw');
  });

  test('A1 无 override 时使用 config 默认值', async () => {
    const runner = makeRunner();
    const result = await runner.run('A1');
    expect(result.passed).toBe(true);
    expect(runner.client.calls[0].body.account).toBe('default-account');
    expect(runner.client.calls[0].body.password).toBe('default-pw');
  });

  test('A3 使用 override 的 device_sn', async () => {
    const runner = makeRunner();
    runner.setParamOverrides('A3', { device_sn: 'CUSTOM-SN', product_id: 'custom-pid' });
    const result = await runner.run('A3');
    expect(result.passed).toBe(true);
    // 设备认证请求中的 device_sn 应该是 override 的值
    const call = runner.client.calls.find(c => c.path === '/v1/device-sessions');
    expect(call.body.device_sn).toBe('CUSTOM-SN');
    expect(call.body.product_id).toBe('custom-pid');
  });

  test('A7 使用 override 的 child_profile_id', async () => {
    const runner = makeRunner();
    // 前置：注入 pairing state
    runner.state.pairingProof = 'p'.repeat(43);
    runner.state.pairingNonce = 'n'.repeat(22);
    runner.state.pairingTimestamp = 1785210000;
    runner.setParamOverrides('A7', { child_profile_id: 'custom-child', device_sn: 'CUSTOM-SN' });
    const result = await runner.run('A7');
    expect(result.passed).toBe(true);
    const call = runner.client.calls.find(c => c.path === '/v1/device-bindings' && c.method === 'POST');
    expect(call.body.child_profile_id).toBe('custom-child');
    expect(call.body.device_sn).toBe('CUSTOM-SN');
  });

  test('getParamSchema 返回 A1 的参数 schema', () => {
    const runner = makeRunner();
    const schema = runner.getParamSchema('A1');
    expect(schema).toHaveLength(2);
    expect(schema[0]).toMatchObject({ key: 'account', label: '账号', type: 'string', required: true });
    expect(schema[1]).toMatchObject({ key: 'password', label: '密码', type: 'password', required: true });
  });

  test('getParamSchema 返回空数组给未知用例', () => {
    const runner = makeRunner();
    const schema = runner.getParamSchema('UNKNOWN');
    expect(schema).toEqual([]);
  });

  test('override 不影响其他用例', async () => {
    const runner = makeRunner();
    runner.setParamOverrides('A1', { account: 'custom' });
    const result = await runner.run('A1');
    expect(runner.client.calls[0].body.account).toBe('custom');
    // A3 不应受 A1 override 影响
    const r3 = await runner.run('A3');
    const call = runner.client.calls.find(c => c.path === '/v1/device-sessions');
    expect(call.body.device_sn).toBe('K1-DEFAULT');
  });
});
