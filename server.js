// SuperMan Console 后端
// 启动：node server.js  （或 npm run console）
// 访问：http://localhost:8088

import express from 'express';
import { spawn, exec } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// ============ 外部依赖路径解析（可配置化,不硬编码绝对路径） ============
// 优先级: 环境变量 > PATH 查找 > 默认值
// 环境变量:
//   NEWMAN_BIN   — newman 可执行文件路径(默认从 PATH 查找)
//   TRAE_CLI_BIN — traecli 可执行文件路径(默认从 PATH 查找)
//   TRAE_KEYCHAIN_SERVICE / TRAE_KEYCHAIN_ACCOUNT — macOS keychain 凭证存储
import { execSync } from 'node:child_process';

function findBin(name, fallback) {
  // 1. 环境变量
  if (process.env[`${name.toUpperCase().replace(/-/g, '_')}_BIN`]) {
    return process.env[`${name.toUpperCase().replace(/-/g, '_')}_BIN`];
  }
  // 2. PATH 查找
  try {
    const p = execSync(`command -v ${name}`, { encoding: 'utf-8' }).trim();
    if (p) return p;
  } catch {}
  // 3. fallback
  return fallback;
}

const NEWMAN_BIN = findBin('newman', '/opt/homebrew/bin/newman');
const TRAE_CLI_BIN = findBin('traecli', '/Users/hydramr/.local/bin/traecli');
const KEYCHAIN_SERVICE = process.env.TRAE_KEYCHAIN_SERVICE || 'trae-cli-token';
const KEYCHAIN_ACCOUNT = process.env.TRAE_KEYCHAIN_ACCOUNT || 'traecli-personal-access-token';
const PORT = process.env.PORT || 8088;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ AI 助手配置 ============

const AI_CONFIG_FILE = path.join(ROOT, 'postman/ai-config.local.json');
const AI_CONFIG_DEFAULT = {
  base_url: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4-plus',
  api_key: '',
  temperature: 0.3,
  system_prompt: '你是 Lumi API 测试助手，运行在 Newman Web Console 中。用户正在测试 Lumi 设备平台/S4 交互/S5 内容媒体三类 API。\n\n【重要规则】每次用户提问时，系统会自动在消息前注入「当前上下文」（包含请求名、方法、URL、Headers、Body、响应状态、响应 Body、Console 输出）。你必须：\n1. 优先使用上下文中的信息回答，不要反问用户补充上下文\n2. 如果用户问"错误原因""为什么失败"，直接从响应状态码和 Body 诊断\n3. 如果用户问"导出请求""原始请求"，直接从上下文的 method/url/headers/body 生成 Raw HTTP 或 cURL\n4. 如果上下文为空（用户未选中请求），才询问用户需要什么\n\n你可以：1) 解读请求和响应 2) 诊断错误 3) 生成或修改 Postman prerequest/test 脚本 4) 解释 HMAC/proof/JWT 等鉴权机制 5) 导出 cURL/Raw HTTP。回答用中文，代码用代码块包裹。'
};

async function loadAiConfig() {
  try {
    if (existsSync(AI_CONFIG_FILE)) {
      const raw = await readFile(AI_CONFIG_FILE, 'utf-8');
      return { ...AI_CONFIG_DEFAULT, ...JSON.parse(raw) };
    }
  } catch (e) { /* ignore */ }
  return { ...AI_CONFIG_DEFAULT };
}

// 获取配置（api_key 脱敏）
app.get('/api/ai/config', async (req, res) => {
  const cfg = await loadAiConfig();
  const masked = cfg.api_key ? cfg.api_key.slice(0, 6) + '***' + cfg.api_key.slice(-4) : '';
  res.json({
    ok: true,
    data: {
      base_url: cfg.base_url,
      model: cfg.model,
      temperature: cfg.temperature,
      system_prompt: cfg.system_prompt,
      api_key_masked: masked,
      has_key: !!cfg.api_key
    }
  });
});

// 保存配置
app.post('/api/ai/config', async (req, res) => {
  try {
    const { base_url, model, api_key, temperature, system_prompt } = req.body;
    const cfg = await loadAiConfig();
    if (base_url !== undefined) cfg.base_url = base_url;
    if (model !== undefined) cfg.model = model;
    if (api_key !== undefined && api_key !== '' && !api_key.includes('***')) cfg.api_key = api_key;
    if (temperature !== undefined) cfg.temperature = Number(temperature);
    if (system_prompt !== undefined) cfg.system_prompt = system_prompt;
    await mkdir(path.dirname(AI_CONFIG_FILE), { recursive: true });
    await writeFile(AI_CONFIG_FILE, JSON.stringify(cfg, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// SSE 流式对话（OpenAI 兼容 chat/completions）
app.post('/api/ai/chat', async (req, res) => {
  const cfg = await loadAiConfig();
  if (!cfg.api_key) {
    return res.status(400).json({ ok: false, error: '未配置 api_key，请先在 AI 配置中填写' });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages 不能为空' });
  }

  // 系统 prompt 注入
  const full = [{ role: 'system', content: cfg.system_prompt }, ...messages];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const upstream = await fetch(`${cfg.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.api_key}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: full,
        temperature: cfg.temperature,
        stream: true
      })
    });

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => '');
      send({ type: 'error', error: `上游错误 ${upstream.status}: ${txt.slice(0, 300)}` });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') {
          send({ type: 'done' });
          return res.end();
        }
        try {
          const j = JSON.parse(payload);
          const delta = j.choices?.[0]?.delta?.content || '';
          if (delta) send({ type: 'delta', content: delta });
        } catch { /* skip non-JSON keepalive */ }
      }
    }
    send({ type: 'done' });
    res.end();
  } catch (e) {
    send({ type: 'error', error: e.message });
    res.end();
  }
});

// ============ 环境变量管理 ============

const ENV_FILE = path.join(ROOT, 'postman/lumi-device-platform.postman_environment.json');
const LOCAL_ENV_FILE = path.join(ROOT, 'postman/lumi-device-platform.postman_environment.local.json');

// 获取环境变量
app.get('/api/env', async (req, res) => {
  try {
    // 优先读 .local.json（含真实值），fallback 到模板
    const file = existsSync(LOCAL_ENV_FILE) ? LOCAL_ENV_FILE : ENV_FILE;
    const raw = await readFile(file, 'utf-8');
    const env = JSON.parse(raw);
    res.json({ ok: true, data: env.values, source: path.basename(file) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 保存环境变量
app.post('/api/env', async (req, res) => {
  try {
    const { values } = req.body;
    const env = {
      name: 'Lumi Device Platform - Local',
      _postman_variable_scope: 'environment',
      values: values
    };
    await writeFile(LOCAL_ENV_FILE, JSON.stringify(env, null, 2));
    // 通知所有 SSE 订阅者
    broadcastEnvUpdate('manual_save');
    res.json({ ok: true, saved: path.basename(LOCAL_ENV_FILE) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ SSE 实时通知 ============
// 用于 CLI/外部进程修改 env 文件后，自动推送给前端刷新
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('event: connected\ndata: {"ok":true}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcastEnvUpdate(reason) {
  const payload = `event: env_updated\ndata: ${JSON.stringify({ reason, ts: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch {}
  }
  console.log(`[SSE] env_updated 广播给 ${sseClients.size} 个客户端，reason=${reason}`);
}

// 广播请求更新（Agent 修改请求后通知前端刷新）
function broadcastRequestUpdate(collection, requestName, changed) {
  const payload = `event: request_updated\ndata: ${JSON.stringify({ collection, requestName, changed, ts: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch {}
  }
  console.log(`[SSE] request_updated 广播给 ${sseClients.size} 个客户端，collection=${collection}, request=${requestName}, changed=${changed.join(',')}`);
}

// 监听 env 文件变化（CLI 直接改文件时触发）
import { watch } from 'node:fs';
let envWatchDebounce = null;
if (existsSync(LOCAL_ENV_FILE)) {
  watch(LOCAL_ENV_FILE, (eventType) => {
    // 防抖：CLI 可能连续写多次
    clearTimeout(envWatchDebounce);
    envWatchDebounce = setTimeout(() => {
      broadcastEnvUpdate(`file_${eventType}`);
    }, 300);
  });
  console.log(`[SSE] 已监听 env 文件变化: ${path.basename(LOCAL_ENV_FILE)}`);
}

// CLI 主动通知端点（CLI 执行后调用此端点通知前端刷新）
app.post('/api/notify/env-updated', (req, res) => {
  const reason = req.body?.reason || 'cli_notify';
  broadcastEnvUpdate(reason);
  res.json({ ok: true, clients: sseClients.size });
});

// ============ Newman 运行 ============

// 导入集合（接收 JSON 内容保存到 postman/ 目录）
app.post('/api/collections/import', async (req, res) => {
  try {
    const { name, content } = req.body;
    if (!name || !content) return res.status(400).json({ ok: false, error: 'name 和 content 必填' });
    // 安全校验：文件名只允许字母数字下划线连字符点
    const safeName = name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    if (!safeName.endsWith('.postman_collection.json')) {
      return res.status(400).json({ ok: false, error: '文件名必须以 .postman_collection.json 结尾' });
    }
    // 解析校验
    let parsed;
    try { parsed = JSON.parse(content); } catch (e) {
      return res.status(400).json({ ok: false, error: 'JSON 解析失败: ' + e.message });
    }
    if (!parsed.info || !parsed.info.name || !Array.isArray(parsed.item)) {
      return res.status(400).json({ ok: false, error: '不是合法的 Postman v2.1 集合（缺 info.name 或 item 数组）' });
    }
    const target = path.join(ROOT, 'postman', safeName);
    await writeFile(target, JSON.stringify(parsed, null, 2), 'utf-8');
    res.json({ ok: true, saved: safeName, requestCount: countRequests(parsed.item) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function countRequests(items) {
  let n = 0;
  for (const it of items) {
    if (it.item && Array.isArray(it.item)) n += countRequests(it.item);
    else n++;
  }
  return n;
}

app.get('/api/collections', async (req, res) => {
  try {
    const dir = path.join(ROOT, 'postman');
    const files = await readdir(dir);
    const collections = files
      .filter(f => f.endsWith('.postman_collection.json'))
      .map(f => ({ name: f, path: `postman/${f}` }));
    res.json({ ok: true, data: collections });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 解析集合结构：文件夹 + 单个请求
app.get('/api/collections/:name/structure', async (req, res) => {
  try {
    const file = path.join(ROOT, 'postman', req.params.name);
    const raw = await readFile(file, 'utf-8');
    const col = JSON.parse(raw);
    const structure = (col.item || []).map(group => {
      if (group.item && Array.isArray(group.item)) {
        return {
          type: 'folder',
          name: group.name,
          description: group.description || '',
          requests: group.item.map(r => ({
            name: r.name,
            method: r.request?.method || 'GET',
            url: typeof r.request?.url === 'string' ? r.request.url : (r.request?.url?.raw || ''),
            hasPrerequest: !!(r.event || []).find(e => e.listen === 'prerequest'),
            hasTest: !!(r.event || []).find(e => e.listen === 'test')
          }))
        };
      } else {
        return {
          type: 'request',
          name: group.name,
          method: group.request?.method || 'GET',
          url: typeof group.request?.url === 'string' ? group.request.url : (group.request?.url?.raw || ''),
          hasPrerequest: !!(group.event || []).find(e => e.listen === 'prerequest'),
          hasTest: !!(group.event || []).find(e => e.listen === 'test')
        };
      }
    });
    res.json({ ok: true, data: structure });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 解析集合的文件夹结构（旧接口，保留兼容）
app.get('/api/collections/:name/folders', async (req, res) => {
  try {
    const file = path.join(ROOT, 'postman', req.params.name);
    const raw = await readFile(file, 'utf-8');
    const col = JSON.parse(raw);
    const folders = (col.item || [])
      .filter(i => i.item && Array.isArray(i.item))
      .map(i => ({ name: i.name, requestCount: i.item.length }));
    res.json({ ok: true, data: folders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 运行单个请求（带 prerequest/test 脚本 + 环境变量回写）
// 支持 GET（用集合原始脚本）和 POST（用编辑后的脚本临时覆盖）
async function runRequestHandler(req, res) {
  const isPost = req.method === 'POST';
  const { collection, requestName } = isPost ? (req.body || {}) : req.query;

  const colPath = path.join(ROOT, 'postman', collection);
  const envPath = existsSync(LOCAL_ENV_FILE) ? LOCAL_ENV_FILE : ENV_FILE;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // 用于清理的临时文件列表
  const tempFiles = [];
  let actualColPath = colPath;

  // POST 模式：如果传了编辑后的脚本或 body override，生成临时集合副本
  if (isPost) {
    const { prerequest, test, bodyOverride } = req.body || {};
    if (prerequest !== undefined || test !== undefined || bodyOverride !== undefined) {
      try {
        const raw = await readFile(colPath, 'utf-8');
        const col = JSON.parse(raw);

        // 递归找到请求
        function findRequest(items) {
          for (const item of items) {
            if (item.item && Array.isArray(item.item)) {
              const found = findRequest(item.item);
              if (found) return found;
            } else if (item.name === requestName) {
              return item;
            }
          }
          return null;
        }

        const reqObj = findRequest(col.item || []);
        if (reqObj) {
          if (!reqObj.event) reqObj.event = [];
          // prerequest
          if (prerequest !== undefined) {
            let ev = reqObj.event.find(e => e.listen === 'prerequest');
            if (!ev) { ev = { listen: 'prerequest', script: { type: 'text/javascript', exec: [] } }; reqObj.event.push(ev); }
            ev.script.exec = prerequest.split('\n');
          }
          // test
          if (test !== undefined) {
            let ev = reqObj.event.find(e => e.listen === 'test');
            if (!ev) { ev = { listen: 'test', script: { type: 'text/javascript', exec: [] } }; reqObj.event.push(ev); }
            ev.script.exec = test.split('\n');
          }
          // body override（用户在结构化展示区编辑后的请求体）
          if (bodyOverride !== undefined) {
            if (!reqObj.request) reqObj.request = {};
            reqObj.request.body = {
              mode: 'raw',
              raw: bodyOverride,
              options: { raw: { language: 'json' } }
            };
          }
          const tmpCol = path.join(ROOT, 'postman', `.tmp-${Date.now()}-${Math.random().toString(36).slice(2,8)}.postman_collection.json`);
          await writeFile(tmpCol, JSON.stringify(col), 'utf-8');
          tempFiles.push(tmpCol);
          actualColPath = tmpCol;
        }
      } catch (e) {
        return res.status(500).json({ ok: false, error: '生成临时集合失败: ' + e.message });
      }
    }
  }

  // 加 JSON reporter 导出到临时文件，运行后解析结构化结果
  const jsonReportFile = path.join(ROOT, 'postman', `.tmp-report-${Date.now()}.json`);
  tempFiles.push(jsonReportFile);

  const args = [
    'run', actualColPath,
    '-e', envPath,
    '--folder', requestName,
    '--export-environment', LOCAL_ENV_FILE,
    '--reporters', 'cli,json',
    '--reporter-json-export', jsonReportFile
  ];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const send = (type, data) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('start', { collection, requestName, timestamp: ts, tempOverride: tempFiles.length > 0 });

  const proc = spawn(NEWMAN_BIN, args, { cwd: ROOT });

  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) send('stdout', { line });
    }
  });

  proc.stderr.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (line) send('stderr', { line });
  });

  proc.on('close', async (code) => {
    // 读取 JSON 报告，提取结构化请求/响应数据
    try {
      const rawReport = await readFile(jsonReportFile, 'utf-8');
      const report = JSON.parse(rawReport);
      const executions = report.run?.executions || [];
      const structuredResults = executions.map(exec => {
        const req = exec.item?.request || {};
        const res = exec.response || {};
        // 请求信息
        const requestInfo = {
          method: req.method || 'GET',
          url: typeof req.url === 'string' ? req.url : (req.url?.raw || ''),
          headers: (req.header || []).map(h => `${h.key}: ${h.value}`),
          body: req.body?.raw || ''
        };
        // 响应信息
        const responseInfo = {
          status: res.code || 0,
          statusText: res.status || '',
          time: res.responseTime || 0,
          size: res.responseSize || 0,
          headers: (res.header || []).map(h => `${h.key}: ${h.value}`),
          body: res.stream ? Buffer.from(res.stream).toString('utf-8') : (res.body || '')
        };
        // 测试断言
        const assertions = (exec.assertions || []).map(a => ({
          name: a.assertion,
          passed: !a.error,
          error: a.error?.message || ''
        }));
        // test 脚本输出
        const testResults = (exec.testResults || []).map(t => ({
          name: t.name,
          passed: !t.error,
          error: t.error?.message || ''
        }));
        return {
          name: exec.item?.name || requestName,
          request: requestInfo,
          response: responseInfo,
          assertions,
          testResults,
          testFailure: exec.testFailure || null
        };
      });
      send('result', { results: structuredResults, totalTests: report.run?.stats?.tests?.total || 0, failedTests: report.run?.stats?.tests?.failed || 0 });

      // 持久化最近一次请求-响应到 .workspace/last-request.json 供 Agent 按需读取
      try {
        const executions = report.run?.executions || [];
        const lastExec = executions[0];
        if (lastExec) {
          const req = lastExec.item?.request || {};
          const res2 = lastExec.response || {};
          const persist = {
            timestamp: ts,
            collection,
            requestName,
            request: {
              method: req.method || 'GET',
              url: typeof req.url === 'string' ? req.url : (req.url?.raw || ''),
              headers: (req.header || []).map(h => ({ key: h.key, value: h.value })),
              body: req.body?.raw || ''
            },
            response: {
              status: res2.code || 0,
              statusText: res2.status || '',
              time: res2.responseTime || 0,
              size: res2.responseSize || 0,
              headers: (res2.header || []).map(h => ({ key: h.key, value: h.value })),
              body: res2.stream ? Buffer.from(res2.stream).toString('utf-8') : (res2.body || '')
            },
            assertions: (lastExec.assertions || []).map(a => ({ name: a.assertion, passed: !a.error, error: a.error?.message || '' })),
            testResults: (lastExec.testResults || []).map(t => ({ name: t.name, passed: !t.error, error: t.error?.message || '' })),
            stats: {
              totalTests: report.run?.stats?.tests?.total || 0,
              failedTests: report.run?.stats?.tests?.failed || 0
            }
          };
          if (!existsSync(WORKSPACE_DIR)) await mkdir(WORKSPACE_DIR, { recursive: true });
          await writeFile(path.join(WORKSPACE_DIR, 'last-request.json'), JSON.stringify(persist, null, 2), 'utf-8');
        }
      } catch (e) {
        console.warn('[persist last-request] 写入 .workspace/last-request.json 失败:', e.message);
      }
    } catch (e) {
      send('result_error', { error: '解析 JSON 报告失败: ' + e.message });
    }
    send('end', { code, envFile: 'lumi-device-platform.postman_environment.local.json' });
    res.end();
    // 清理临时文件
    for (const f of tempFiles) {
      try { await unlink(f); } catch {}
    }
  });

  req.on('close', () => {
    if (!proc.killed) proc.kill('SIGTERM');
  });
}

app.get('/api/run-request', (req, res) => runRequestHandler(req, res));
app.post('/api/run-request', (req, res) => runRequestHandler(req, res));

// 获取单个请求详情（method/url/headers/body/prerequest/test）
app.get('/api/collections/:name/requests/:requestName', async (req, res) => {
  try {
    const file = path.join(ROOT, 'postman', req.params.name);
    const raw = await readFile(file, 'utf-8');
    const col = JSON.parse(raw);

    function findRequest(items) {
      for (const item of items) {
        if (item.item && Array.isArray(item.item)) {
          const found = findRequest(item.item);
          if (found) return found;
        } else if (item.name === req.params.requestName) {
          return item;
        }
      }
      return null;
    }

    const req_obj = findRequest(col.item || []);
    if (!req_obj) return res.status(404).json({ ok: false, error: 'Request not found' });

    const r = req_obj.request || {};
    const url = typeof r.url === 'string' ? r.url : (r.url?.raw || '');
    const headers = (r.header || []).map(h => ({ key: h.key, value: h.value, disabled: h.disabled || false }));
    const body = r.body?.raw || '';

    const prereq = (req_obj.event || []).find(e => e.listen === 'prerequest');
    const test = (req_obj.event || []).find(e => e.listen === 'test');

    res.json({
      ok: true,
      data: {
        name: req_obj.name,
        method: r.method || 'GET',
        url,
        headers,
        body,
        prerequest: prereq?.script?.exec?.join('\n') || '',
        test: test?.script?.exec?.join('\n') || '',
        description: req_obj.request?.description || ''
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 更新请求（prerequest/test/body/headers）— Agent 通过此端点修改，SSE 自动通知前端刷新
app.put('/api/collections/:name/requests/:requestName', async (req, res) => {
  try {
    const file = path.join(ROOT, 'postman', req.params.name);
    const raw = await readFile(file, 'utf-8');
    const col = JSON.parse(raw);

    function findRequest(items) {
      for (const item of items) {
        if (item.item && Array.isArray(item.item)) {
          const found = findRequest(item.item);
          if (found) return found;
        } else if (item.name === req.params.requestName) {
          return item;
        }
      }
      return null;
    }

    const req_obj = findRequest(col.item || []);
    if (!req_obj) return res.status(404).json({ ok: false, error: 'Request not found' });

    const { prerequest, test, body, headers } = req.body || {};
    const changed = [];

    // 更新 prerequest 脚本
    if (prerequest !== undefined) {
      if (!req_obj.event) req_obj.event = [];
      let ev = req_obj.event.find(e => e.listen === 'prerequest');
      if (!ev) { ev = { listen: 'prerequest', script: { type: 'text/javascript', exec: [] } }; req_obj.event.push(ev); }
      ev.script.exec = prerequest.split('\n');
      changed.push('prerequest');
    }
    // 更新 test 脚本
    if (test !== undefined) {
      if (!req_obj.event) req_obj.event = [];
      let ev = req_obj.event.find(e => e.listen === 'test');
      if (!ev) { ev = { listen: 'test', script: { type: 'text/javascript', exec: [] } }; req_obj.event.push(ev); }
      ev.script.exec = test.split('\n');
      changed.push('test');
    }
    // 更新 body
    if (body !== undefined && req_obj.request?.body) {
      req_obj.request.body.raw = body;
      changed.push('body');
    }
    // 更新 headers
    if (headers !== undefined && req_obj.request) {
      req_obj.request.header = headers.map(h => ({ key: h.key, value: h.value, disabled: h.disabled || false }));
      changed.push('headers');
    }

    if (changed.length === 0) {
      return res.json({ ok: true, changed: [], message: '无变更' });
    }

    await writeFile(file, JSON.stringify(col, null, 2), 'utf-8');
    // 通知前端刷新该请求
    broadcastRequestUpdate(req.params.name, req.params.requestName, changed);
    res.json({ ok: true, changed, collection: req.params.name, request: req.params.requestName });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 运行 Newman（SSE 实时输出）
app.get('/api/run', (req, res) => {
  const { collection, folder, mode } = req.query;

  const colPath = path.join(ROOT, 'postman', collection);
  const envPath = existsSync(LOCAL_ENV_FILE) ? LOCAL_ENV_FILE : ENV_FILE;
  const reportDir = path.join(ROOT, 'reports');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportFile = `report-${ts}.html`;
  const jsonReportFile = path.join(os.tmpdir(), `newman-run-${ts}.json`);

  const args = [
    'run', colPath,
    '-e', envPath,
    '--reporters', 'cli,htmlextra,json',
    '--reporter-htmlextra-export', path.join(reportDir, reportFile),
    '--reporter-json-export', jsonReportFile
  ];

  if (folder) {
    args.push('--folder', folder);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const send = (type, data) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('start', { collection, folder, timestamp: ts, cmd: `newman ${args.join(' ')}` });

  const proc = spawn(NEWMAN_BIN, args, { cwd: ROOT });

  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) send('stdout', { line });
    }
  });

  proc.stderr.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (line) send('stderr', { line });
  });

  proc.on('close', async (code) => {
    // 解析 JSON 报告，提取失败数
    let totalTests = 0;
    let failedTests = 0;
    let failedAssertions = 0;
    let failedRequests = 0;
    let failuresCount = 0;
    try {
      if (existsSync(jsonReportFile)) {
        const report = JSON.parse(await readFile(jsonReportFile, 'utf-8'));
        totalTests = report.run?.stats?.tests?.total || 0;
        failedAssertions = report.run?.stats?.assertions?.failed || 0;
        failedRequests = report.run?.stats?.requests?.failed || 0;
        failuresCount = (report.run?.failures || []).length;
        // Newman stats 语义:
        //   stats.tests.failed  — 只统计脚本异常,不统计 pm.test 断言失败(不准)
        //   stats.assertions.failed — pm.test 断言失败数(准确)
        //   failures[]  — 所有失败记录数组(含断言失败 + 脚本异常,与 assertions.failed 有重叠)
        // 正确公式:用 failuresCount 作为统一失败数(已含断言失败),不再叠加 failedAssertions
        failedTests = failuresCount;
        // 持久化最近一次请求-响应到 .workspace/last-request.json 供 Agent 按需读取
        try {
          const executions = report.run?.executions || [];
          const lastExec = executions[0];
          if (lastExec) {
            const req = lastExec.item?.request || {};
            const res2 = lastExec.response || {};
            const persist = {
              timestamp: ts,
              collection,
              requestName: lastExec.item?.name || folder || '',
              folder,
              request: {
                method: req.method || 'GET',
                url: typeof req.url === 'string' ? req.url : (req.url?.raw || ''),
                headers: (req.header || []).map(h => ({ key: h.key, value: h.value })),
                body: req.body?.raw || ''
              },
              response: {
                status: res2.code || 0,
                statusText: res2.status || '',
                time: res2.responseTime || 0,
                size: res2.responseSize || 0,
                headers: (res2.header || []).map(h => ({ key: h.key, value: h.value })),
                body: res2.stream ? Buffer.from(res2.stream).toString('utf-8') : (res2.body || '')
              },
              assertions: (lastExec.assertions || []).map(a => ({ name: a.assertion, passed: !a.error, error: a.error?.message || '' })),
              stats: { totalTests, failedTests, failedAssertions }
            };
            if (!existsSync(WORKSPACE_DIR)) await mkdir(WORKSPACE_DIR, { recursive: true });
            await writeFile(path.join(WORKSPACE_DIR, 'last-request.json'), JSON.stringify(persist, null, 2), 'utf-8');
          }
        } catch (e) {
          console.warn('[persist last-request] 写入 .workspace/last-request.json 失败:', e.message);
        }
      }
    } catch (e) {
      console.warn('[run] 解析 JSON 报告失败:', e.message);
    }
    // 清理 JSON 临时文件
    try { await unlink(jsonReportFile); } catch {}
    send('end', { code, reportFile: code === 0 ? reportFile : null, stats: { totalTests, failedTests, failedAssertions, failedRequests, failuresCount } });
    res.end();
  });

  req.on('close', () => {
    if (!proc.killed) proc.kill('SIGTERM');
  });
});

// ============ 批量顺序运行多个 folder（支持 stopOnFail） ============
// POST /api/run-batch
// body: { collection: "xxx.json", folders: ["场景D", "场景E"], stopOnFail: true }
// SSE 事件流：
//   batch_start   { folders, stopOnFail }
//   folder_start  { folder, index, total }
//   stdout        { line }
//   stderr        { line }
//   folder_end    { folder, index, total, code, stats, reportFile, stopped? }
//   batch_end     { summary, stoppedReason? }
app.post('/api/run-batch', async (req, res) => {
  const { collection, folders, stopOnFail, autoSubmitIssues } = req.body || {};
  if (!collection || !Array.isArray(folders) || folders.length === 0) {
    return res.status(400).json({ ok: false, error: '参数错误：需要 collection 和 folders' });
  }

  const colPath = path.join(ROOT, 'postman', collection);
  const envPath = existsSync(LOCAL_ENV_FILE) ? LOCAL_ENV_FILE : ENV_FILE;
  const reportDir = path.join(ROOT, 'reports');
  const batchTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const send = (type, data) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('batch_start', { folders, stopOnFail: !!stopOnFail, timestamp: batchTs });

  const summary = [];
  let stoppedReason = null;
  let aborted = false;

  // 客户端断开时停止后续 folder
  req.on('close', () => { aborted = true; });

  for (let i = 0; i < folders.length; i++) {
    if (aborted) { stoppedReason = '客户端断开连接'; break; }

    const folder = folders[i];
    const ts = `${batchTs}-${i}-${String(i+1).padStart(2,'0')}`;
    const reportFile = `report-${ts}.html`;
    const jsonReportFile = path.join(os.tmpdir(), `newman-batch-${ts}.json`);

    send('folder_start', { folder, index: i, total: folders.length });

    const args = [
      'run', colPath,
      '-e', envPath,
      '--folder', folder,
      '--reporters', 'cli,htmlextra,json',
      '--reporter-htmlextra-export', path.join(reportDir, reportFile),
      '--reporter-json-export', jsonReportFile
    ];

    const proc = spawn(NEWMAN_BIN, args, { cwd: ROOT });

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) send('stdout', { line });
      }
    });

    proc.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) send('stderr', { line });
    });

    // 等待进程结束
    const code = await new Promise(resolve => {
      proc.on('close', resolve);
    });

    // 解析 JSON 报告
    let totalTests = 0, failedTests = 0, failedAssertions = 0, failedRequests = 0, failuresCount = 0;
    try {
      if (existsSync(jsonReportFile)) {
        const report = JSON.parse(await readFile(jsonReportFile, 'utf-8'));
        totalTests = report.run?.stats?.tests?.total || 0;
        failedAssertions = report.run?.stats?.assertions?.failed || 0;
        failedRequests = report.run?.stats?.requests?.failed || 0;
        failuresCount = (report.run?.failures || []).length;
        // Newman stats 语义:
        //   stats.tests.failed  — 只统计脚本异常,不统计 pm.test 断言失败(不准)
        //   stats.assertions.failed — pm.test 断言失败数(准确)
        //   failures[]  — 所有失败记录数组(含断言失败 + 脚本异常,与 assertions.failed 有重叠)
        // 正确公式:用 failuresCount 作为统一失败数(已含断言失败),不再叠加 failedAssertions
        failedTests = failuresCount;
      }
    } catch (e) {
      // JSON 解析失败，仅记录
    }
    try { await unlink(jsonReportFile); } catch {}

    const folderFailed = code !== 0 || failedTests > 0 || failedAssertions > 0;
    const folderSummary = {
      folder, index: i, total: folders.length,
      code, stats: { totalTests, failedTests, failedAssertions, failedRequests, failuresCount },
      reportFile, // 即使失败也保留报告
      passed: !folderFailed
    };
    summary.push(folderSummary);
    send('folder_end', folderSummary);

    // 失败时自动触发 GitHub Issue 提交(Agent 自主查重 + 生成内容 + 提交)
    if (folderFailed && autoSubmitIssues) {
      send('github_start', { folder, message: '触发 Agent 分析失败并提交 GitHub Issue...' });
      try {
        const failureCtx = await persistFailureContext(collection, folder, folderSummary, path.join(reportDir, reportFile), folderSummary.stats);
        if (failureCtx) {
          const agentResult = await triggerAgentForFailure(failureCtx);
          send('github_end', {
            folder,
            success: agentResult.success,
            content: agentResult.content?.slice(0, 2000),
            error: agentResult.error
          });
        } else {
          send('github_end', { folder, success: false, error: '写入 last-failure.json 失败' });
        }
      } catch (e) {
        send('github_end', { folder, success: false, error: e.message });
      }
    }

    // 判断是否需要停止后续 folder
    if (folderFailed && stopOnFail) {
      stoppedReason = `前置场景 "${folder}" 失败（${failedTests} 个测试失败 / ${failedAssertions} 个断言失败），已停止后续场景`;
      break;
    }
  }

  send('batch_end', { summary, stoppedReason });
  res.end();
});

// ============ 报告列表 ============

app.get('/api/reports', async (req, res) => {
  try {
    const dir = path.join(ROOT, 'reports');
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
      return res.json({ ok: true, data: [] });
    }
    const files = await readdir(dir);
    const reports = [];
    for (const f of files) {
      if (!f.endsWith('.html')) continue;
      const fstat = await stat(path.join(dir, f));
      reports.push({
        name: f,
        size: fstat.size,
        mtime: fstat.mtime.toISOString()
      });
    }
    reports.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json({ ok: true, data: reports });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/reports/:name', async (req, res) => {
  try {
    const file = path.join(ROOT, 'reports', req.params.name);
    if (!existsSync(file)) return res.status(404).send('Not found');
    const html = await readFile(file);
    res.type('html').send(html);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// 提取 Newman htmlextra 报告的纯文本摘要（供 Agent 阅读）
app.get('/api/reports/:name/text', async (req, res) => {
  try {
    const file = path.join(ROOT, 'reports', req.params.name);
    if (!existsSync(file)) return res.status(404).json({ ok: false, error: 'Not found' });
    const html = await readFile(file, 'utf-8');
    const summary = extractHtmlextraText(html, req.params.name);
    res.json({ ok: true, name: req.params.name, text: summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 批量提取多个报告的合并文本
app.post('/api/reports/batch-text', async (req, res) => {
  try {
    const { names } = req.body || {};
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ ok: false, error: 'names 数组必填' });
    }
    const parts = [];
    for (const name of names) {
      const file = path.join(ROOT, 'reports', name);
      if (!existsSync(file)) {
        parts.push(`## ${name}\n(文件不存在)`);
        continue;
      }
      const html = await readFile(file, 'utf-8');
      parts.push(extractHtmlextraText(html, name));
    }
    res.json({ ok: true, names, text: parts.join('\n\n---\n\n') });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 从 htmlextra HTML 提取关键信息：统计 + 失败用例
function extractHtmlextraText(html, name) {
  const lines = [];
  lines.push(`# Newman 报告：${name}`);

  // 1. 运行时间
  const dateM = html.match(/<h5 class="text-center">([^<]+)<\/h5>/);
  if (dateM) lines.push(`运行时间: ${dateM[1].trim()}`);

  // 2. 统计卡片（Total Iterations / Assertions / Failed Tests / Skipped）
  const stats = {};
  const statRe = /<h6 class="text-uppercase">([^<]+)<\/h6>\s*<h1 class="display-1">(\d+)<\/h1>/g;
  let m;
  while ((m = statRe.exec(html)) !== null) {
    stats[m[1].trim()] = parseInt(m[2]);
  }
  if (Object.keys(stats).length) {
    lines.push(`## 统计`);
    for (const [k, v] of Object.entries(stats)) lines.push(`- ${k}: ${v}`);
  }

  // 3. Collection 名
  const colM = html.match(/<strong> Collection:<\/strong>\s*([^<]+)/);
  if (colM) lines.push(`Collection: ${colM[1].trim()}`);

  // 4. 失败用例（pills-failed 区块的 card 结构）
  // 截取 pills-failed 区块
  const failedStart = html.indexOf('id="pills-failed"');
  const failedEnd = failedStart >= 0 ? html.indexOf('id="pills-skipped"', failedStart) : -1;
  const failedSection = failedStart >= 0 && failedEnd > failedStart
    ? html.slice(failedStart, failedEnd)
    : '';
  const failures = [];
  if (failedSection) {
    // 每个 card border-danger 是一个失败用例
    const cardRe = /<div class="card border-danger">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
    let m;
    while ((m = cardRe.exec(failedSection)) !== null) {
      const block = m[1];
      // 标题在 card-header > a 内（文本节点，到第一个 <i> 之前）
      const headerM = block.match(/<a[^>]*>\s*([\s\S]*?)<i /);
      const header = headerM ? headerM[1].replace(/\s+/g, ' ').trim() : '';
      // Failed Test 名
      const testM = block.match(/<strong>Failed Test:<\/strong>\s*([^<]+)/);
      const testName = testM ? testM[1].trim() : '';
      // Assertion Error Message
      const errM = block.match(/<pre><code[^>]*>([^<]+)<\/code><\/pre>/);
      const error = errM
        ? errM[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
        : '';
      if (header || testName) {
        failures.push({ header, testName, error });
      }
    }
  }

  lines.push('');
  if (failures.length === 0) {
    lines.push(`## 失败用例\n（无失败）`);
  } else {
    lines.push(`## 失败用例（${failures.length} 个）`);
    failures.forEach((f, i) => {
      lines.push(`### ${i + 1}. ${f.header}`);
      lines.push(`  断言名: ${f.testName}`);
      lines.push(`  错误: ${f.error}`);
    });
  }

  return lines.join('\n');
}

// ============ Trae CLI Agent 集成 ============

// TRAE_CLI_BIN / KEYCHAIN_SERVICE / KEYCHAIN_ACCOUNT 已在文件顶部可配置化声明
// Agent 沙箱工作区：只允许在此目录及显式授权的目录内操作
const WORKSPACE_DIR = path.join(ROOT, '.workspace');

// AGENTS.md 作为 Agent 系统提示词真源(启动时读取,避免硬编码 prompt)
let AGENT_SYSTEM_PROMPT = '';
try {
  const agentsFile = path.join(ROOT, 'AGENTS.md');
  if (existsSync(agentsFile)) {
    AGENT_SYSTEM_PROMPT = await readFile(agentsFile, 'utf-8');
    console.log(`[agent] 已加载 AGENTS.md (${AGENT_SYSTEM_PROMPT.length} 字符) 作为 system prompt`);
  } else {
    console.warn('[agent] AGENTS.md 不存在,Agent 功能将使用空 prompt');
  }
} catch (e) {
  console.warn('[agent] AGENTS.md 读取失败:', e.message);
}

// Trae CLI 同步调用(非 SSE,用于自动场景如 Issue 生成)
// 返回 { success, content, sessionId, error }
async function callTraeCliSync(message, opts = {}) {
  const token = await readTraeToken();
  if (!token) return { success: false, error: '未从 keychain 读取到 trae-cli token' };
  if (!existsSync(TRAE_CLI_BIN)) return { success: false, error: `traecli 未安装于 ${TRAE_CLI_BIN}` };
  if (!existsSync(WORKSPACE_DIR)) await mkdir(WORKSPACE_DIR, { recursive: true });

  const fullMessage = `${AGENT_SYSTEM_PROMPT}\n\n=== 用户指令 ===\n${message}`;
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--permission-mode', 'bypass_permissions',
    '--query-timeout', String(opts.timeoutSec || 120) + 's',
    '--add-dir', WORKSPACE_DIR
  ];
  if (opts.sessionId) args.push('--session-id', opts.sessionId);
  args.push(fullMessage);

  return new Promise((resolve) => {
    const proc = spawn(TRAE_CLI_BIN, args, {
      cwd: WORKSPACE_DIR,
      env: {
        ...process.env,
        PATH: '/Users/hydramr/.local/bin:' + (process.env.PATH || ''),
        TRAECLI_PERSONAL_ACCESS_TOKEN: token
      }
    });
    let stdoutBuf = '';
    let lastResult = null;
    let stderrBuf = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      resolve({ success: false, error: 'Trae CLI 调用超时' });
    }, (opts.timeoutSec || 120) * 1000);

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) console.log(`[trae-cli sync stderr] ${line}`);
      }
    });
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
          const evt = JSON.parse(trimmed);
          if (evt.type === 'result') {
            lastResult = evt;
          } else if (evt.type === 'assistant' && evt.content) {
            // 累积 assistant content 用于最终返回
            if (!lastResult) lastResult = { contentAcc: '' };
            lastResult.contentAcc = (lastResult.contentAcc || '') + evt.content;
          }
        } catch {}
      }
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (lastResult) {
        resolve({
          success: !lastResult.is_error,
          content: lastResult.contentAcc || lastResult.content || '',
          sessionId: lastResult.session_id,
          error: lastResult.is_error ? 'Agent 返回错误' : null
        });
      } else {
        resolve({ success: false, error: `Trae CLI 退出码 ${code},无输出` });
      }
    });
  });
}

// ============ 故障诊断：S6 Observation 日志拉取 ============
// 封装 A6-06 三步流程，供 Agent / 前端调用拉取线上日志做故障分析
// 流程：自动获取凭证 → 创建 Query Grant → 兑换 session_token → 查询 evidence

// 从环境文件读取指定 key 的 value
async function readEnvValue(key) {
  const file = existsSync(LOCAL_ENV_FILE) ? LOCAL_ENV_FILE : ENV_FILE;
  const raw = await readFile(file, 'utf-8');
  const env = JSON.parse(raw);
  const v = (env.values || []).find(x => x.key === key);
  return v?.value || '';
}

// 向环境文件写入 key=value（自动广播 SSE 通知）
async function writeEnvValue(key, value) {
  const file = existsSync(LOCAL_ENV_FILE) ? LOCAL_ENV_FILE : ENV_FILE;
  const raw = await readFile(file, 'utf-8');
  const env = JSON.parse(raw);
  let v = (env.values || []).find(x => x.key === key);
  if (v) { v.value = value; v.enabled = true; }
  else { env.values.push({ key, value, enabled: true, type: 'any' }); }
  await writeFile(file, JSON.stringify(env, null, 2), 'utf-8');
  broadcastEnvUpdate('diagnostics_env_write');
}

// 自动获取 operator_access_token：先读环境变量，为空则用 account/password 登录
async function ensureOperatorToken(steps) {
  let token = await readEnvValue('operator_access_token');
  if (token) {
    steps.push({ step: '0a_token_from_env', status: 'cached', response: { source: 'environment', token_preview: token.slice(0, 20) + '...' } });
    return token;
  }
  // 自动登录
  const account = await readEnvValue('operator_account');
  const password = await readEnvValue('operator_password');
  if (!account || !password) {
    steps.push({ step: '0a_token_auto_login', status: 'failed', error: '环境变量 operator_access_token 为空，且 operator_account/operator_password 未配置' });
    return null;
  }
  const baseUrl = 'https://api-lumi.cinmoore.cn';
  const loginRes = await fetch(`${baseUrl}/v1/operator-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password })
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  steps.push({ step: '0a_token_auto_login', status: loginRes.status, request: { account }, response: { has_token: !!loginBody.operator_access_token, expires_in: loginBody.expires_in } });
  if (!loginRes.ok || !loginBody.operator_access_token) return null;
  // 回写环境变量
  await writeEnvValue('operator_access_token', loginBody.operator_access_token);
  return loginBody.operator_access_token;
}

app.post('/api/diagnostics/obs-query', async (req, res) => {
  try {
    const { operatorToken, timeFrom, timeTo, traceIds, requestIds, sourceSystems, deviceRefs, allowedViews, view, filters, limit } = req.body || {};

    if (!timeFrom || !timeTo) return res.status(400).json({ ok: false, error: 'timeFrom / timeTo 必填（ISO8601）' });

    const baseUrl = 'https://api-lumi.cinmoore.cn';
    const steps = [];

    // Step 0: 自动获取凭证（若未传 operatorToken）
    const token = operatorToken || (await ensureOperatorToken(steps));
    if (!token) {
      return res.json({ ok: false, error: '无法获取 operator_access_token（环境变量为空且自动登录失败）', steps });
    }

    // 合并 traceIds 和 requestIds（request_id 也作为 trace_id 查询）
    const allTraceIds = [...(traceIds || []), ...(requestIds || [])];

    // Step 1: 创建 Query Grant
    const grantReqBody = {
      schema_version: 'a6-observation-query-grant-request-v1',
      time_range: { from: timeFrom, to: timeTo },
      scope: {
        trace_ids: allTraceIds,
        source_systems: sourceSystems || ['device', 'app', 's5', 's4'],
        device_refs: deviceRefs || []
      },
      allowed_views: allowedViews || ['trace_timeline', 'log_summary', 'metric_window', 'issue_rca'],
      budget: { max_queries: 100, max_rows: 10000, max_total_bytes: 20971520 }
    };
    const step1 = await fetch(`${baseUrl}/v1/observation/query-grants`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(grantReqBody)
    });
    const step1Body = await step1.json().catch(() => ({}));
    steps.push({ step: '1_create_grant', status: step1.status, request: grantReqBody, response: step1Body });
    if (!step1.ok || !step1Body.grant_code) {
      return res.json({ ok: false, error: '创建 Query Grant 失败', steps });
    }
    const grantCode = step1Body.grant_code;

    // Step 2: 兑换 session_token
    const step2 = await fetch(`${baseUrl}/v1/observation/query-grants/${grantCode}:redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const step2Body = await step2.json().catch(() => ({}));
    steps.push({ step: '2_redeem', status: step2.status, response: step2Body });
    if (!step2.ok || !step2Body.session_token) {
      return res.json({ ok: false, error: '兑换 session_token 失败', steps });
    }
    const sessionToken = step2Body.session_token;

    // Step 3: 查询日志（支持多源：对每个 source_system 各查一次，合并结果）
    const sources = sourceSystems || ['device', 'app', 's5', 's4'];
    const targetView = view || 'trace_timeline';
    const queryBody = {
      schema_version: 'a6-observation-evidence-query-v1',
      view: targetView,
      filters: filters || { from: timeFrom, to: timeTo, ...(allTraceIds.length ? { trace_id: allTraceIds[0] } : {}) },
      limit: limit || 200
    };

    // 单源查询
    const step3 = await fetch(`${baseUrl}/v1/observation/evidence:query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody)
    });
    const step3Body = await step3.json().catch(() => ({}));
    steps.push({ step: '3_query', status: step3.status, request: queryBody, response: step3Body });

    res.json({ ok: step3.ok, steps, evidence: step3Body });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 一键故障诊断：用户描述问题 + traceId/requestId，Agent 自动拉日志分析
// Agent 调用此端点后，直接拿到结构化日志，无需自己拼参数
app.post('/api/diagnostics/investigate', async (req, res) => {
  try {
    const { description, traceId, requestId, timeFrom, timeTo, sourceSystems } = req.body || {};

    if (!traceId && !requestId) {
      return res.status(400).json({ ok: false, error: 'traceId 或 requestId 至少提供一个' });
    }

    // 默认时间范围：当前往前推 1 小时
    const now = new Date();
    const from = timeFrom || new Date(now.getTime() - 3600000).toISOString();
    const to = timeTo || now.toISOString();

    // 调用 obs-query（内部复用）
    const baseUrl = `http://localhost:${PORT}`;
    const resp = await fetch(`${baseUrl}/api/diagnostics/obs-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeFrom: from,
        timeTo: to,
        traceIds: traceId ? [traceId] : [],
        requestIds: requestId ? [requestId] : [],
        sourceSystems: sourceSystems || ['device', 'app', 's5', 's4'],
        view: 'trace_timeline'
      })
    });
    const result = await resp.json();

    // 附加诊断上下文
    res.json({
      ok: result.ok,
      description,
      traceId,
      requestId,
      timeRange: { from, to },
      steps: result.steps,
      evidence: result.evidence,
      error: result.error
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// AGENT_SYSTEM_PROMPT 已在文件前面(WORKSPACE_DIR 定义后)从 AGENTS.md 读取并注入
// 历史硬编码 system prompt 已迁移至项目根 AGENTS.md（启动时读取）
// 修改 Agent 行为只需改 AGENTS.md,无需改 server.js


// 从 macOS keychain 读取 token
async function readTraeToken() {
  return new Promise((resolve) => {
    exec(`security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w 2>/dev/null`, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim());
    });
  });
}

// ============ 当前上下文（供 Agent 按需查询） ============
// 前端 PUT 当前页面/集合/请求/报告指针，后端内存缓存；Agent 通过 GET 获取指针
// 不缓存内容（内容 Agent 按需调用 GET /api/collections/:name/requests/:requestName 等 API 获取）
let currentContext = {
  page: 'builder',
  collection: '',
  requestName: '',
  reportName: '',
  reports: [],
  updatedAt: null
};

app.get('/api/context/current', (req, res) => {
  res.json({ ok: true, data: currentContext });
});

app.put('/api/context/current', (req, res) => {
  const { page, collection, requestName, reportName, reports } = req.body || {};
  if (page) currentContext.page = page;
  if (collection !== undefined) currentContext.collection = collection;
  if (requestName !== undefined) currentContext.requestName = requestName;
  if (reportName !== undefined) currentContext.reportName = reportName;
  if (reports !== undefined) currentContext.reports = reports;
  currentContext.updatedAt = new Date().toISOString();
  broadcastEnvUpdate('context_updated'); // 复用 SSE 通知前端刷新（虽然前端是写入方，无副作用）
  res.json({ ok: true, data: currentContext });
});

// Trae CLI Agent SSE 端点（流式 JSON 输出）
app.post('/api/ai/trae', async (req, res) => {
  const { message, sessionId, cwd } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ ok: false, error: 'message 必填' });
  }

  // 读取 token
  const token = await readTraeToken();
  if (!token) {
    return res.status(500).json({ ok: false, error: '未从 keychain 读取到 trae-cli token' });
  }

  // 检查 traecli 是否存在
  if (!existsSync(TRAE_CLI_BIN)) {
    return res.status(500).json({ ok: false, error: `traecli 未安装于 ${TRAE_CLI_BIN}` });
  }

  // 确保 workspace 目录存在
  if (!existsSync(WORKSPACE_DIR)) {
    await mkdir(WORKSPACE_DIR, { recursive: true });
  }

  // 在用户消息前注入系统约束
  const fullMessage = `${AGENT_SYSTEM_PROMPT}\n\n=== 用户指令 ===\n${message}`;

  // 构建 CLI 参数 — 严格限制可访问目录
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--permission-mode', 'bypass_permissions',
    '--query-timeout', '300s',
    '--add-dir', WORKSPACE_DIR
  ];
  if (sessionId) args.push('--session-id', sessionId);
  args.push(fullMessage);

  // 启动子进程 — cwd 设为 workspace 目录
  const proc = spawn(TRAE_CLI_BIN, args, {
    cwd: WORKSPACE_DIR,
    env: {
      ...process.env,
      PATH: '/Users/hydramr/.local/bin:' + (process.env.PATH || ''),
      TRAECLI_PERSONAL_ACCESS_TOKEN: token
    }
  });

  // SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  // stderr 日志（登录信息等）— 不转发给前端，但记录到 console
  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) console.log(`[trae-cli stderr] ${line}`);
    }
  });

  // stdout 流式 JSON 解析与转发
  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;
      try {
        const evt = JSON.parse(trimmed);
        // 转发所有事件，前端按 type 分流处理
        send('trae', evt);
        // 前端需要的最终结果也单独推送一个 'done' 事件
        if (evt.type === 'result') {
          send('done', { sessionId: evt.session_id, success: !evt.is_error });
        }
      } catch { /* 非 JSON 行跳过 */ }
    }
  });

  proc.on('close', (code) => {
    if (code !== 0 && code !== null) {
      send('error', { code, message: `trae-cli 退出码 ${code}` });
    }
    send('close', { code });
    res.end();
  });

  proc.on('error', (e) => {
    send('error', { message: e.message });
    res.end();
  });

  // 客户端断开时杀掉子进程
  req.on('close', () => {
    try { proc.kill('SIGTERM'); } catch {}
  });
});

// ============ GitHub Issue 自动提交(供 Agent 调用代理)============

// 集合 → 仓库映射(owner/repo 格式)
const GITHUB_REPO_MAP = {
  'lumi-device-platform': 'chadwangcn/lumi-device-platform',
  'lumi-s4-interaction': 'chadwangcn/lumi-s4-interaction',
  'lumi-s5-content-media': 'chadwangcn/lumi-s5-content-media',
  'lumi-s6-observation': 'chadwangcn/lumi-s6-observation'
};

function getGitHubToken() {
  return process.env.GITHUB_TOKEN || '';
}

function githubOwnerRepo(collection) {
  return GITHUB_REPO_MAP[collection] || null;
}

// GET /api/github/config — 返回 GitHub 配置状态(供 Agent 与前端查询)
app.get('/api/github/config', (req, res) => {
  res.json({
    ok: true,
    data: {
      hasToken: !!getGitHubToken(),
      repoMap: GITHUB_REPO_MAP
    }
  });
});

// GET /api/github/issues?collection=X&state=open&labels=bug — 列出已有 Issue(供 Agent 查重)
app.get('/api/github/issues', async (req, res) => {
  try {
    const { collection, state = 'open', labels = 'automated-test', per_page = 100 } = req.query;
    if (!collection) return res.status(400).json({ ok: false, error: 'collection 必填' });
    const repo = githubOwnerRepo(collection);
    if (!repo) return res.status(400).json({ ok: false, error: `集合 ${collection} 未配置 GitHub 仓库映射` });
    if (!getGitHubToken()) return res.status(400).json({ ok: false, error: 'GITHUB_TOKEN 环境变量未设置' });

    const url = `https://api.github.com/repos/${repo}/issues?state=${encodeURIComponent(state)}&labels=${encodeURIComponent(labels)}&per_page=${per_page}`;
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${getGitHubToken()}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'NightWatch-Console'
      }
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, error: `GitHub 查询失败: ${await resp.text()}` });
    }
    const issues = await resp.json();
    // 返回精简字段(避免响应过大)
    const items = issues.map(i => ({
      number: i.number,
      title: i.title,
      state: i.state,
      url: i.html_url,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      labels: (i.labels || []).map(l => l.name),
      comments: i.comments
    }));
    res.json({ ok: true, data: items, repo });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/github/issues?collection=X — 创建新 Issue(供 Agent 调用)
app.post('/api/github/issues', async (req, res) => {
  try {
    const { collection } = req.query;
    const { title, body, labels } = req.body || {};
    if (!collection) return res.status(400).json({ ok: false, error: 'collection 必填(query)' });
    if (!title) return res.status(400).json({ ok: false, error: 'title 必填' });
    if (!body) return res.status(400).json({ ok: false, error: 'body 必填' });
    const repo = githubOwnerRepo(collection);
    if (!repo) return res.status(400).json({ ok: false, error: `集合 ${collection} 未配置 GitHub 仓库映射` });
    if (!getGitHubToken()) return res.status(400).json({ ok: false, error: 'GITHUB_TOKEN 环境变量未设置' });

    const url = `https://api.github.com/repos/${repo}/issues`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getGitHubToken()}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'NightWatch-Console',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title,
        body,
        labels: labels && Array.isArray(labels) ? labels : ['bug', 'automated-test']
      })
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, error: `GitHub 创建 Issue 失败: ${await resp.text()}` });
    }
    const created = await resp.json();
    res.json({
      ok: true,
      data: { number: created.number, title: created.title, url: created.html_url, state: created.state }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/github/issues/:number/comments?collection=X — 在已有 Issue 追加评论(供 Agent 调用)
app.post('/api/github/issues/:number/comments', async (req, res) => {
  try {
    const { number } = req.params;
    const { collection } = req.query;
    const { body } = req.body || {};
    if (!collection) return res.status(400).json({ ok: false, error: 'collection 必填(query)' });
    if (!body) return res.status(400).json({ ok: false, error: 'body 必填' });
    const repo = githubOwnerRepo(collection);
    if (!repo) return res.status(400).json({ ok: false, error: `集合 ${collection} 未配置 GitHub 仓库映射` });
    if (!getGitHubToken()) return res.status(400).json({ ok: false, error: 'GITHUB_TOKEN 环境变量未设置' });

    const url = `https://api.github.com/repos/${repo}/issues/${number}/comments`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getGitHubToken()}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'NightWatch-Console',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ body })
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, error: `GitHub 评论失败: ${await resp.text()}` });
    }
    const comment = await resp.json();
    res.json({
      ok: true,
      data: { id: comment.id, url: comment.html_url, createdAt: comment.created_at }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 写入失败详情到 .workspace/last-failure.json(供 Agent 读取分析)
async function persistFailureContext(collection, folder, summary, reportFile, stats) {
  try {
    const reportPath = reportFile?.replace(/\.html$/, '.json');
    let failedExecutions = [];
    if (reportPath && existsSync(reportPath)) {
      const report = JSON.parse(await readFile(reportPath, 'utf-8'));
      const executions = report.run?.executions || [];
      failedExecutions = executions
        .filter(e => (e.assertions || []).some(a => a.error || a.passed === false))
        .map(e => ({
          requestName: e.item?.name || '(unknown)',
          method: e.request?.method,
          url: e.request?.url,
          requestHeaders: e.request?.headers,
          requestBody: e.request?.body,
          responseStatus: e.response?.code,
          responseStatusText: e.response?.status,
          responseTime: e.response?.responseTime,
          responseSize: e.response?.responseSize,
          responseHeaders: e.response?.headers,
          responseBody: e.response?.body,
          assertions: (e.assertions || [])
            .filter(a => a.error || a.passed === false)
            .map(a => ({
              name: a.name,
              error: a.error || { message: '断言失败' }
            }))
        }));
    }
    const ctx = {
      timestamp: new Date().toISOString(),
      collection,
      folder,
      repo: githubOwnerRepo(collection),
      reportFile,
      stats,
      summary,
      failedExecutions,
      hint: '请分析以上失败,按下方工作流执行 GitHub Issue 提交',
      githubApiWorkflow: {
        step1_check_existing: `GET http://localhost:${PORT}/api/github/issues?collection=${collection}&state=open&labels=automated-test`,
        step2a_create_new: `POST http://localhost:${PORT}/api/github/issues?collection=${collection}  body: {title, body, labels}`,
        step2b_append_comment: `POST http://localhost:${PORT}/api/github/issues/{issue_number}/comments?collection=${collection}  body: {body}`,
        rule: '若已有 open Issue 标题与本失败请求精确匹配,追加评论;否则创建新 Issue。Issue 标题用「[Auto] {collection} · {requestName} 失败」格式。'
      }
    };
    await mkdir(WORKSPACE_DIR, { recursive: true });
    await writeFile(path.join(WORKSPACE_DIR, 'last-failure.json'), JSON.stringify(ctx, null, 2), 'utf-8');
    return ctx;
  } catch (e) {
    console.warn('[github] 写入 last-failure.json 失败:', e.message);
    return null;
  }
}

// 触发 Trae Agent 处理失败(查重 + 生成内容 + 提交)
async function triggerAgentForFailure(failureContext) {
  if (!existsSync(TRAE_CLI_BIN)) {
    console.warn('[github] traecli 未安装,跳过 Agent 自动提交');
    return { success: false, error: 'traecli 未安装' };
  }
  const prompt = `自动化测试失败,请按以下工作流处理 GitHub Issue 提交:

1. 读取失败详情文件: ${path.join(WORKSPACE_DIR, 'last-failure.json')}
2. 对每个失败请求:
   a. 调用 ${failureContext.githubApiWorkflow.step1_check_existing} 查询已有 open Issue
   b. 若有标题精确匹配 "[Auto] ${failureContext.collection} · {请求名} 失败" 的 Issue → 调用 ${failureContext.githubApiWorkflow.step2b_append_comment} 追加评论(评论内容需分析根因 + 失败证据 + 复现步骤 + 建议 Action)
   c. 若无匹配 → 调用 ${failureContext.githubApiWorkflow.step2a_create_new} 创建新 Issue(标题用上述格式,正文需包含集合/请求/时间/失败详情/根因分析/复现步骤/建议 Action)
3. 所有调用通过 curl 或 HTTP 客户端完成,服务监听 http://localhost:${PORT}
4. 完成后输出: 每个失败请求的处理结果(created #N / commented #N / skipped)

注意:
- 标题格式必须为 "[Auto] ${failureContext.collection} · {请求名} 失败" 以便后续查重
- 评论/正文要精简:根因 1-2 句、证据引用具体值、Action 用清单
- 不要创建重复 Issue,务必先查重`;
  const result = await callTraeCliSync(prompt, { timeoutSec: 300 });
  return result;
}

// ============ 启动 ============

app.listen(PORT, () => {
  console.log(`\n  SuperMan Console (NightWatch)`);
  console.log(`  ─────────────────────────────`);
  console.log(`  访问:      http://localhost:${PORT}`);
  console.log(`  Newman:    ${NEWMAN_BIN}${existsSync(NEWMAN_BIN) ? '' : ' (⚠️ 不存在,请运行 scripts/install-deps.sh)'}`);
  console.log(`  Trae CLI:  ${TRAE_CLI_BIN}${existsSync(TRAE_CLI_BIN) ? '' : ' (⚠️ 不存在,Agent 功能将不可用)'}`);
  console.log(`  Workspace: ${WORKSPACE_DIR}`);
  console.log(`  集合:      ${path.join(ROOT, 'postman')}`);
  console.log(`  报告:      ${path.join(ROOT, 'reports')}`);
  console.log(`\n`);
});
