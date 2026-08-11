// Lumi Device Platform — 浏览器代理版 API Client
// 通过 Vite 中间件 /proxy 转发，避免 CORS
// 实际请求 URL: /proxy/v1/user-sessions，并通过 X-Target-Base 头告诉代理真实地址

import { LumiApiClient, LumiApiError } from './api-client.js';

export class LumiBrowserApiClient extends LumiApiClient {
  constructor(opts) {
    super(opts);
    // 解析 baseUrl 中的路径前缀（如 https://host/lumi-mind 中的 /lumi-mind）
    // 用于从完整 URL 中剥离，避免代理拼接时双重前缀
    const base = new URL(this.baseUrl);
    this._basePath = base.pathname.replace(/\/+$/, ''); // 去尾部斜杠，如 /lumi-mind

    // 浏览器版 fetch 通过 /proxy 转发
    this.fetch = async (url, init) => {
      // url 是完整 URL（baseUrl+path），需改成 /proxy+path
      const u = new URL(url);
      let pathAndQuery = u.pathname + u.search;
      // 剥离 baseUrl 的路径前缀，只保留相对路径（/v1/user-sessions）
      // 避免 /proxy/lumi-mind/lumi-mind/v1/... 双重前缀
      if (this._basePath && pathAndQuery.startsWith(this._basePath + '/')) {
        pathAndQuery = pathAndQuery.slice(this._basePath.length);
      } else if (this._basePath && pathAndQuery === this._basePath) {
        pathAndQuery = '/';
      }
      const proxyUrl = '/proxy' + pathAndQuery;
      const headers = new Headers(init.headers);
      // 对部署在根路径的端点（/healthz、/readyz），target-base 用 origin 而非完整 baseUrl
      // 避免代理拼接成 https://host/lumi-mind/healthz
      const isRootPath = pathAndQuery === '/healthz' || pathAndQuery === '/readyz' || pathAndQuery.startsWith('/healthz?') || pathAndQuery.startsWith('/readyz?');
      headers.set('x-target-base', isRootPath ? new URL(this.baseUrl).origin : this.baseUrl);
      const newInit = { ...init, headers };
      const resp = await globalThis.fetch(proxyUrl, newInit);
      // 把实际请求 URL 注入到响应，便于错误上下文记录真实请求路径
      try {
        Object.defineProperty(resp, '_actualUrl', {
          value: proxyUrl,
          writable: false,
          enumerable: false,
          configurable: false,
        });
        Object.defineProperty(resp, '_targetUrl', {
          value: headers.get('x-target-base') + pathAndQuery,
          writable: false,
          enumerable: false,
          configurable: false,
        });
      } catch { /* 已存在则忽略 */ }
      return resp;
    };
  }
}
