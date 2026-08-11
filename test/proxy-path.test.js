import { describe, test, expect } from 'vitest';
import { LumiBrowserApiClient } from '../src/browser-client.js';

describe('LumiBrowserApiClient — 代理路径拼接', () => {
  test('baseUrl 含路径前缀时，代理请求路径不重复前缀', async () => {
    // 模拟 fetch，捕获传给 fetch 的 URL
    let capturedUrl = null;
    const mockFetch = async (url, init) => {
      capturedUrl = url;
      // 返回简单 200 响应
      return {
        status: 200, ok: true,
        text: async () => JSON.stringify({ ok: true }),
        headers: new Map(),
      };
    };
    globalThis.fetch = mockFetch;

    // baseUrl 含路径前缀 /lumi-mind
    const client = new LumiBrowserApiClient({
      baseUrl: 'https://api-lumi.cinmoore.cn/lumi-mind',
    });

    await client.login({ account: 'a', password: 'b' });

    // 代理收到的应该是 /proxy/v1/user-sessions（不含 /lumi-mind）
    expect(capturedUrl).toBe('/proxy/v1/user-sessions');
    // 不应该是 /proxy/lumi-mind/v1/user-sessions
    expect(capturedUrl).not.toContain('/lumi-mind/lumi-mind');
    expect(capturedUrl).not.toContain('/proxy/lumi-mind/');
  });

  test('baseUrl 无路径前缀时正常工作', async () => {
    let capturedUrl = null;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { status: 200, ok: true, text: async () => '{}', headers: new Map() };
    };

    const client = new LumiBrowserApiClient({
      baseUrl: 'https://api.example.com',
    });
    await client.login({ account: 'a', password: 'b' });

    expect(capturedUrl).toBe('/proxy/v1/user-sessions');
  });

  test('X-Target-Base 头应包含完整的 baseUrl（含路径前缀）', async () => {
    let capturedHeaders = null;
    globalThis.fetch = async (url, init) => {
      capturedHeaders = init.headers;
      return { status: 200, ok: true, text: async () => '{}', headers: new Map() };
    };

    const client = new LumiBrowserApiClient({
      baseUrl: 'https://api-lumi.cinmoore.cn/lumi-mind',
    });
    await client.login({ account: 'a', password: 'b' });

    // X-Target-Base 必须包含路径前缀，让代理知道完整目标
    expect(capturedHeaders.get('x-target-base')).toBe('https://api-lumi.cinmoore.cn/lumi-mind');
  });

  test('GET 请求带 query 参数时路径正确', async () => {
    let capturedUrl = null;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { status: 200, ok: true, text: async () => '{}', headers: new Map() };
    };

    const client = new LumiBrowserApiClient({
      baseUrl: 'https://api-lumi.cinmoore.cn/lumi-mind',
      userAccessToken: 't',
    });
    await client.getBinding({ deviceSn: 'SN-X' });

    expect(capturedUrl).toBe('/proxy/v1/device-bindings/current?device_sn=SN-X');
  });

  test('错误时 toDebugJSON 包含 actualUrl 和 targetUrl', async () => {
    // 模拟 fetch 返回 404 响应，并附带 _actualUrl / _targetUrl
    globalThis.fetch = async (url) => {
      const resp = {
        status: 404, ok: false,
        text: async () => JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }),
        headers: new Map(),
      };
      Object.defineProperty(resp, '_actualUrl', { value: url, enumerable: false });
      Object.defineProperty(resp, '_targetUrl', { value: 'https://api-lumi.cinmoore.cn/lumi-mind/v1/user-sessions', enumerable: false });
      return resp;
    };

    const client = new LumiBrowserApiClient({
      baseUrl: 'https://api-lumi.cinmoore.cn/lumi-mind',
    });
    const err = await client.login({ account: 'a', password: 'b' }).catch((e) => e);
    const debug = err.toDebugJSON();

    expect(debug.request.actualUrl).toBe('/proxy/v1/user-sessions');
    expect(debug.request.targetUrl).toBe('https://api-lumi.cinmoore.cn/lumi-mind/v1/user-sessions');
    // url 是逻辑 URL（baseUrl + path）
    expect(debug.request.url).toBe('https://api-lumi.cinmoore.cn/lumi-mind/v1/user-sessions');
  });
});
