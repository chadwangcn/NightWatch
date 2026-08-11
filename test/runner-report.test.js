import { describe, test, expect } from 'vitest';
import { TestRunner } from '../src/runner.js';

// 模拟 LumiApiError 风格的错误对象
function makeError(status, code, message, request, response) {
  const e = new Error(message);
  e.name = 'LumiApiError';
  e.status = status;
  e.code = code;
  e.request = request;
  e.response = response;
  e.toDebugJSON = () => ({
    timestamp: '2026-07-31T00:00:00Z',
    error: { name: 'LumiApiError', message, code, status, requestId: response?.body?.request_id },
    request,
    response: { status, body: response?.body },
  });
  return e;
}

describe('TestRunner.collectFailureReport — 聚合失败用例报告', () => {
  test('未运行任何用例时返回空报告', () => {
    const runner = new TestRunner({
      client: {},
      config: { account: 'a', password: 'b', deviceSn: 'S', deviceSecretB64url: 'x'.repeat(43), childProfileId: 'c', productId: 'k1', credentialVersion: 1 },
      crypto: { computeDeviceProof: () => 'x', computePairingProof: () => 'x', genNonce: () => 'n' },
    });
    const report = runner.collectFailureReport();
    expect(report).toHaveProperty('total', 0);
    expect(report).toHaveProperty('failed', 0);
    expect(report).toHaveProperty('failures', []);
  });

  test('聚合多个失败用例的完整调试信息', () => {
    const runner = new TestRunner({
      client: {},
      config: { account: 'a', password: 'b', deviceSn: 'S', deviceSecretB64url: 'x'.repeat(43), childProfileId: 'c', productId: 'k1', credentialVersion: 1 },
      crypto: { computeDeviceProof: () => 'x', computePairingProof: () => 'x', genNonce: () => 'n' },
    });
    // 注入两个失败结果
    runner.results = {
      A1: {
        id: 'A1', group: 'A', side: 'app', title: '用户登录',
        passed: false, error: 'HTTP 401',
        actualStatus: 401,
        steps: [{
          method: 'POST', path: '/v1/user-sessions',
          request: { method: 'POST', path: '/v1/user-sessions', body: { account: 'a', password: 'b' } },
          response: { status: 401, body: { code: 'AUTH_CREDENTIAL_INVALID', message: 'bad password' } },
          error: {
            message: 'HTTP 401', status: 401, code: 'AUTH_CREDENTIAL_INVALID',
            debug: {
              timestamp: '2026-07-31T00:00:00Z',
              error: { name: 'LumiApiError', message: 'bad password', code: 'AUTH_CREDENTIAL_INVALID', status: 401 },
              request: { method: 'POST', url: 'https://api.example.com/v1/user-sessions', body: { account: 'a', password: 'b' } },
              response: { status: 401, body: { code: 'AUTH_CREDENTIAL_INVALID', message: 'bad password' } },
            },
          },
        }],
      },
      A2: {
        id: 'A2', group: 'A', side: 'app', title: '刷新会话',
        passed: true,
        steps: [{ method: 'POST', path: '/v1/user-sessions:refresh', request: {}, response: { status: 200, body: {} }, error: null }],
      },
      A3: {
        id: 'A3', group: 'A', side: 'app', title: '设备认证',
        passed: false, error: 'HTTP 422',
        actualStatus: 422,
        steps: [{
          method: 'POST', path: '/v1/device-sessions',
          request: { method: 'POST', path: '/v1/device-sessions', body: { device_sn: 'S' } },
          response: { status: 422, body: { code: 'VALIDATION_FAILED', message: 'invalid' } },
          error: {
            message: 'HTTP 422', status: 422, code: 'VALIDATION_FAILED',
            debug: {
              timestamp: '2026-07-31T00:00:01Z',
              error: { name: 'LumiApiError', message: 'invalid', code: 'VALIDATION_FAILED', status: 422 },
              request: { method: 'POST', url: 'https://api.example.com/v1/device-sessions', body: { device_sn: 'S' } },
              response: { status: 422, body: { code: 'VALIDATION_FAILED', message: 'invalid' } },
            },
          },
        }],
      },
    };
    const report = runner.collectFailureReport();
    expect(report.total).toBe(3);
    expect(report.failed).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failures).toHaveLength(2);
    expect(report.failures[0]).toMatchObject({ id: 'A1', title: '用户登录' });
    expect(report.failures[0].steps[0].error.debug).toBeDefined();
    expect(report.failures[1]).toMatchObject({ id: 'A3', title: '设备认证' });
    // 整体可序列化
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  test('报告包含时间戳和运行环境元信息', () => {
    const runner = new TestRunner({
      client: {},
      config: { account: 'a', password: 'b', deviceSn: 'S', deviceSecretB64url: 'x'.repeat(43), childProfileId: 'c', productId: 'k1', credentialVersion: 1 },
      crypto: { computeDeviceProof: () => 'x', computePairingProof: () => 'x', genNonce: () => 'n' },
    });
    const report = runner.collectFailureReport();
    expect(report).toHaveProperty('generatedAt');
    expect(report).toHaveProperty('baseUrl');
    expect(report).toHaveProperty('account');
    // 密码不应出现在报告中
    expect(JSON.stringify(report)).not.toContain('password');
  });
});
