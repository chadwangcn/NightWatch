import { describe, test, expect, beforeEach, vi } from 'vitest';
import { LumiApiClient } from '../src/api-client.js';

// Mock fetch
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyResponse(status) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => null,
    text: async () => '',
  };
}

function mkFetchCapture() {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url: url.toString(), method: opts?.method || 'GET', headers: opts?.headers || {}, body: opts?.body });
    return currentResponse;
  };
  let currentResponse = jsonResponse(200, {});
  return { impl, calls, set: (r) => { currentResponse = r; } };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('LumiApiClient.login — POST /v1/user-sessions', () => {
  test('发送 account/password，返回 token 对', async () => {
    const cap = mkFetchCapture();
    fetchMock.mockImplementation(cap.impl);
    cap.set(jsonResponse(201, {
      user_access_token: 'eyJ.aaa.bbb',
      user_refresh_token: 'refresh-token-43chars-xxxxxxxxxxxxxxxxxxxxxx',
      expires_in: 900,
    }));

    const client = new LumiApiClient({ baseUrl: 'https://api.example.com' });
    const result = await client.login({ account: 'tester', password: 'supersecret-pw' });

    expect(cap.calls[0].url).toBe('https://api.example.com/v1/user-sessions');
    expect(cap.calls[0].method).toBe('POST');
    expect(cap.calls[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(cap.calls[0].body)).toEqual({ account: 'tester', password: 'supersecret-pw' });
    expect(result.user_access_token).toBe('eyJ.aaa.bbb');
    expect(result.expires_in).toBe(900);
  });

  test('错误密码返回 401 抛错带 code', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(401, {
      code: 'AUTH_CREDENTIAL_INVALID',
      message: 'bad password',
      request_id: 'uuid-1',
    }));
    const client = new LumiApiClient({ baseUrl: 'https://api.example.com' });
    await expect(client.login({ account: 'a', password: 'b' }))
      .rejects.toMatchObject({ status: 401, code: 'AUTH_CREDENTIAL_INVALID' });
  });

  test('错误对象应包含完整请求上下文（method/url/headers/body）便于排查', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(401, {
      code: 'AUTH_CREDENTIAL_INVALID',
      message: 'bad password',
      request_id: 'uuid-1',
    }));
    const client = new LumiApiClient({ baseUrl: 'https://api.example.com' });
    const err = await client.login({ account: 'a', password: 'b' })
      .catch((e) => e);
    expect(err).toMatchObject({
      status: 401,
      code: 'AUTH_CREDENTIAL_INVALID',
      // 请求上下文
      request: {
        method: 'POST',
        url: 'https://api.example.com/v1/user-sessions',
        body: { account: 'a', password: 'b' },
      },
    });
    // headers 应包含 content-type 与（如有）authorization
    expect(err.request.headers['content-type']).toBe('application/json');
    // 响应原文也保留，便于粘贴给系统排查
    expect(err.response).toMatchObject({
      status: 401,
      body: { code: 'AUTH_CREDENTIAL_INVALID', message: 'bad password', request_id: 'uuid-1' },
    });
  });

  test('GET 请求错误也应包含 url 与 query 参数', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(404, {}));
    const client = new LumiApiClient({ baseUrl: 'https://api.example.com', userAccessToken: 't' });
    const err = await client.getBinding({ deviceSn: 'SN-X' }).catch((e) => e);
    expect(err.request.method).toBe('GET');
    expect(err.request.url).toContain('device_sn=SN-X');
    expect(err.request.query).toEqual({ device_sn: 'SN-X' });
  });

  test('错误对象支持 toDebugJSON() 输出可粘贴的完整信息', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(422, {
      code: 'VALIDATION_FAILED',
      message: 'invalid',
      request_id: 'uuid-2',
    }));
    const client = new LumiApiClient({ baseUrl: 'https://api.example.com' });
    const err = await client.login({ account: 'a', password: 'b' }).catch((e) => e);
    const debug = err.toDebugJSON();
    expect(debug).toHaveProperty('request.method', 'POST');
    expect(debug).toHaveProperty('request.url');
    expect(debug).toHaveProperty('request.body');
    expect(debug).toHaveProperty('request.headers');
    expect(debug).toHaveProperty('response.status', 422);
    expect(debug).toHaveProperty('response.body');
    expect(debug).toHaveProperty('timestamp');
    // JSON 可序列化
    expect(() => JSON.stringify(debug)).not.toThrow();
  });
});

describe('LumiApiClient.refreshSession — POST /v1/user-sessions:refresh', () => {
  test('发送 refresh_token 返回新 token 对', async () => {
    const cap = mkFetchCapture();
    fetchMock.mockImplementation(cap.impl);
    cap.set(jsonResponse(200, {
      user_access_token: 'new-access',
      user_refresh_token: 'new-refresh',
      expires_in: 900,
    }));

    const client = new LumiApiClient({ baseUrl: 'https://api.example.com' });
    const result = await client.refreshSession({ userRefreshToken: 'old-refresh' });

    expect(cap.calls[0].url).toBe('https://api.example.com/v1/user-sessions:refresh');
    expect(JSON.parse(cap.calls[0].body)).toEqual({ user_refresh_token: 'old-refresh' });
    expect(result.user_access_token).toBe('new-access');
  });
});

describe('LumiApiClient.logout — DELETE /v1/user-sessions/current', () => {
  test('携带 User Bearer Token 返回 204', async () => {
    const cap = mkFetchCapture();
    fetchMock.mockImplementation(cap.impl);
    cap.set(emptyResponse(204));

    const client = new LumiApiClient({ baseUrl: 'https://api.example.com', userAccessToken: 'user-jwt' });
    const result = await client.logout();

    expect(cap.calls[0].method).toBe('DELETE');
    expect(cap.calls[0].url).toBe('https://api.example.com/v1/user-sessions/current');
    expect(cap.calls[0].headers['authorization']).toBe('Bearer user-jwt');
    expect(result).toBeNull();
  });
});

describe('LumiApiClient.deviceSession — POST /v1/device-sessions', () => {
  test('发送完整 body 含 device_proof 返回 device token', async () => {
    const cap = mkFetchCapture();
    fetchMock.mockImplementation(cap.impl);
    cap.set(jsonResponse(201, {
      device_access_token: 'dev-jwt',
      device_refresh_token: 'dev-refresh',
      expires_in: 900,
    }));

    const client = new LumiApiClient({ baseUrl: 'https://api.example.com' });
    const body = {
      product_id: 'k1',
      device_sn: 'K1-2026-000001',
      credential_version: 1,
      timestamp: 1785210000,
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
      runtime: { app_version: '1.0.0', capability_digest: 'sha256:' + '0'.repeat(64), firmware_version: '0.2.0' },
      device_proof: '31aCPbgG42Z5ObCVMuauwqNxZtrpSDU6GwJ0wvu5jes',
    };
    const result = await client.deviceSession(body);

    expect(cap.calls[0].url).toBe('https://api.example.com/v1/device-sessions');
    expect(JSON.parse(cap.calls[0].body)).toEqual(body);
    expect(result.device_access_token).toBe('dev-jwt');
  });
});

describe('LumiApiClient.deviceBootstrap — GET /v1/device-bootstrap', () => {
  test('携带 Device Bearer Token 返回设备信息', async () => {
    const cap = mkFetchCapture();
    fetchMock.mockImplementation(cap.impl);
    cap.set(jsonResponse(200, {
      device_sn: 'K1-2026-000001',
      credential_version: 1,
      binding_version: 0,
      api_base: 'https://api.example.com',
      capabilities: ['pairing'],
    }));

    const client = new LumiApiClient({ baseUrl: 'https://api.example.com', deviceAccessToken: 'dev-jwt' });
    const result = await client.deviceBootstrap();

    expect(cap.calls[0].headers['authorization']).toBe('Bearer dev-jwt');
    expect(result.device_sn).toBe('K1-2026-000001');
  });
});

describe('LumiApiClient.pairingChallenge — GET /v1/device-pairing-challenges', () => {
  test('携带 Device Token 返回 nonce', async () => {
    const cap = mkFetchCapture();
    fetchMock.mockImplementation(cap.impl);
    cap.set(jsonResponse(200, {
      device_sn: 'K1-2026-000001',
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
      timestamp: 1785210000,
      expires_in: 300,
    }));

    const client = new LumiApiClient({ baseUrl: 'https://api.example.com', deviceAccessToken: 'dev-jwt' });
    const result = await client.pairingChallenge();

    expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(result.expires_in).toBe(300);
  });
});

describe('LumiApiClient.bindDevice — POST /v1/device-bindings', () => {
  test('携带 User Token 提交绑定', async () => {
    const cap = mkFetchCapture();
    fetchMock.mockImplementation(cap.impl);
    cap.set(jsonResponse(201, {
      device_sn: 'K1-2026-000001',
      child_profile_id: 'child-1',
      binding_version: 1,
      status: 'active',
    }));

    const client = new LumiApiClient({ baseUrl: 'https://api.example.com', userAccessToken: 'user-jwt' });
    const result = await client.bindDevice({
      device_sn: 'K1-2026-000001',
      child_profile_id: 'child-1',
      pairing_proof: 'p'.repeat(43),
      nonce: 'n'.repeat(22),
      timestamp: 1785210000,
    });

    expect(cap.calls[0].headers['authorization']).toBe('Bearer user-jwt');
    expect(result.status).toBe('active');
  });
});

describe('LumiApiClient.getBinding — GET /v1/device-bindings/current', () => {
  test('携带 device_sn 查询参数', async () => {
    const cap = mkFetchCapture();
    fetchMock.mockImplementation(cap.impl);
    cap.set(jsonResponse(200, { device_sn: 'K1-2026-000001', child_profile_id: 'c1', binding_version: 1, status: 'active' }));

    const client = new LumiApiClient({ baseUrl: 'https://api.example.com', userAccessToken: 'user-jwt' });
    await client.getBinding({ deviceSn: 'K1-2026-000001' });

    expect(cap.calls[0].url).toContain('device_sn=K1-2026-000001');
  });

  test('404 不抛错只返回 status（用于 A9 验证解绑）', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(404, {}));
    const client = new LumiApiClient({ baseUrl: 'https://api.example.com', userAccessToken: 'user-jwt' });
    const result = await client.getBinding({ deviceSn: 'none' }, { raw: true });
    expect(result.status).toBe(404);
  });
});

describe('LumiApiClient.unbind — DELETE /v1/device-bindings/current', () => {
  test('携带 device_sn 查询参数 + User Token 返回 204', async () => {
    const cap = mkFetchCapture();
    fetchMock.mockImplementation(cap.impl);
    cap.set(emptyResponse(204));

    const client = new LumiApiClient({ baseUrl: 'https://api.example.com', userAccessToken: 'user-jwt' });
    await client.unbind({ deviceSn: 'K1-2026-000001' });

    expect(cap.calls[0].method).toBe('DELETE');
    expect(cap.calls[0].url).toContain('device_sn=K1-2026-000001');
  });
});

describe('LumiApiClient.health — GET /healthz 和 /readyz', () => {
  test('健康检查不带鉴权', async () => {
    const cap = mkFetchCapture();
    fetchMock.mockImplementation(cap.impl);
    cap.set(jsonResponse(200, { status: 'ok' }));

    const client = new LumiApiClient({ baseUrl: 'https://api.example.com' });
    await client.health();
    expect(cap.calls[0].url).toBe('https://api.example.com/healthz');
    expect(cap.calls[0].headers['authorization']).toBeUndefined();
  });

  test('ready 检查', async () => {
    const cap = mkFetchCapture();
    fetchMock.mockImplementation(cap.impl);
    cap.set(jsonResponse(200, { schema: 'compatible' }));

    const client = new LumiApiClient({ baseUrl: 'https://api.example.com' });
    await client.ready();
    expect(cap.calls[0].url).toBe('https://api.example.com/readyz');
  });
});
