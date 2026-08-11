import { defineConfig } from 'vite';

// 动态代理：前端通过 X-Target-Base 头指定真实 API 地址，避免 CORS
function dynamicProxyMiddleware() {
  return {
    name: 'dynamic-proxy',
    configureServer(server) {
      server.middlewares.use('/proxy', async (req, res, next) => {
        const targetBase = req.headers['x-target-base'];
        if (!targetBase) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing X-Target-Base header', code: 'PROXY_NO_TARGET' }));
          return;
        }
        try {
          // 读取请求体
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = chunks.length ? Buffer.concat(chunks) : undefined;

          // 路径：/proxy/v1/user-sessions -> <targetBase>/v1/user-sessions
          const pathAndQuery = req.url || '';
          const targetUrl = new URL(targetBase.replace(/\/+$/, '') + pathAndQuery);

          // 转发除 hop-by-hop / proxy 控制头外的头部
          // - x-target-base: 代理控制头
          // - host: 由 fetch 自动设置为目标 URL 的 host
          // - connection: hop-by-hop
          // - transfer-encoding / content-length: fetch 会根据 body 重新计算，转发原始值会导致与实际 body 不匹配
          const headers = { ...req.headers };
          delete headers['x-target-base'];
          delete headers['host'];
          delete headers['connection'];
          delete headers['transfer-encoding'];
          delete headers['content-length'];

          // 超时控制：30 秒后 abort，避免目标服务器挂起导致代理永久阻塞
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30000);

          let resp;
          try {
            resp = await fetch(targetUrl, {
              method: req.method,
              headers,
              body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }

          res.statusCode = resp.status;
          resp.headers.forEach((v, k) => {
            const lk = k.toLowerCase();
            // 跳过 hop-by-hop 和编码相关头：
            // - transfer-encoding: 由 Node 自动处理
            // - content-encoding: fetch 已解压响应体，再次转发此头会让浏览器误以为是压缩的
            // - content-length: 解压后字节数变化，与原头不匹配
            if (lk === 'transfer-encoding' || lk === 'content-encoding' || lk === 'content-length') return;
            res.setHeader(k, v);
          });
          const buf = new Uint8Array(await resp.arrayBuffer());
          res.end(Buffer.from(buf));
        } catch (e) {
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          const code = e.name === 'AbortError' ? 'PROXY_TIMEOUT' : 'PROXY_ERROR';
          res.end(JSON.stringify({ proxy_error: e.message, code }));
        }
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 5173,
  },
  plugins: [dynamicProxyMiddleware()],
});
