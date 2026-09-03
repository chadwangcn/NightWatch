# NightWatch Repository Instructions

本仓是 NightWatch API 测试工具与版本化 API Case 的真源。任何 Agent（含 Paperclip Codex、Trae CLI、Codex、Claude Code 等）进入本仓后必须先读本文件。API 测试工程师的岗位定义、Skill、Workflow 和 Eval 由 `chadwangcn/OpenAgent` 管理；本文件只定义当前仓库边界与工具入口。

## Project Identity

```yaml
id: NightWatch
name: NightWatch
repo: chadwangcn/NightWatch
role: API 黑盒测试平台
type: postman/newman 驱动 + Node.js Web Console
sensitivity: 测试凭证敏感（device_secret/operator_password 不入 Git）
```

## Mission

为 Lumi 多服务平台（device-platform / s4-interaction / s5-content-media / s6-observation）提供完整的 API 黑盒测试体系，包含：

1. **统一 Case 索引**（cases/index.json）— 正式测试资产发现入口
2. **Postman 集合**（.postman_collection.json）— 过渡期 Case 执行适配格式
3. **共享环境模板**（.postman_environment.json）— 变量名称和非秘密默认值
4. **NightWatch Console**（server.js + public/index.html）— Web 测试平台，支持单接口调试、批量场景运行和报告查看
5. **Newman CLI**（scripts/run-newman.sh）— CI 自动化执行入口
6. **NightWatch 核心模块**（nightwatch/）— registry、library、policy、executor、evidence、issue、control 和 console

## Agent 与工具边界

- Paperclip API 测试 Agent 必须加载 `$nightwatch-api-testing`；设计或更新 Case 时同时加载 `$lumi-test-case-governance`。
- NightWatch 负责注册、计划、策略、执行、证据和 Finding；Agent 负责读取 D0 正式定义、选择 Case、判断结果和路由问题。
- `/api/ai/trae` 是历史可选适配器，不是 API 测试员工身份或正式协作控制面。Paperclip Task、Agent Definition 与 Skill 优先。
- `LUMI_API_BASE_URL` 是 Lumi API 地址唯一环境真源。工具适配层可以在子进程中映射为 NightWatch/Postman 变量，不得在 Paperclip 维护竞争地址。

## Boundaries

### ✅ 允许
- 按任务类型读写 `cases/` 或 `postman/*.postman_collection.json`
- 读写 `.workspace/`（Agent 沙箱工作区）
- 调用所有 `/api/*` HTTP 端点
- 在 `.workspace/` 内执行 bash 命令
- 修改 `server.js` / `public/index.html`（仅限开发任务，需用户明确要求）

### ❌ 禁止
- 修改项目根 `AGENTS.md` 以外的真源文档（`/Users/hydramr/lumi-s5-content-media/docs/` 等上游契约）
- 直接修改 `postman/*.local.json` 中的敏感凭证（应通过 Web Console 或环境变量覆盖）
- 在 Git 提交中包含 `.env*` / `postman/ai-config.local.json` / `.workspace/` / `reports/`
- 跨系统 import 上游子系统的业务代码或数据模型
- 在同一 PR 中同时修改工具实现和业务 Case，除非任务明确授权引导迁移
- 以 HTTP 200、Newman 退出 0 或 NightWatch run 完成替代逐 Case 断言

## 三条迭代线

1. `test_case_maintenance`：默认只修改 `cases/`、Postman Case 资产和 Case 文档。
2. `test_tool_improvement`：修改 `nightwatch/`、`server.js`、`src/`、执行适配器或工具测试，不得顺便降低 Case 断言。
3. Agent/Skill 迭代：在 `chadwangcn/OpenAgent` 完成，不在本仓复制长期岗位定义。

## 目录与文件索引

### 顶层结构

```
NightWatch/
├── AGENTS.md                          # ← 本文件，仓库规则真源
├── HANDOVER.md                        # 项目交接文档(人类阅读,Agent 可参考但非真源)
├── server.js                          # NightWatch Console 后端(Express)
├── package.json                      # npm scripts(newman/console/test)
├── postman/                           # Postman 集合与环境(测试资产)
├── cases/                             # 统一 Case 索引、schema 与套件
├── public/                            # Web Console 前端(单文件 index.html)
├── scripts/                           # CI 脚本
├── src/                               # JavaScript 工具库(crypto/runner/api-client)
├── test/                              # Vitest 单元测试
├── test-assets/                       # 测试音频(sample.wav)
├── reports/                           # Newman HTML 报告(.gitignore)
├── .workspace/                        # Agent 沙箱工作区(.gitignore)
├── .github/workflows/api-test.yml     # GitHub Actions CI
└── .schemathesis/                     # Schemathesis 模糊测试缓存(.gitignore)
```

### postman/ 目录

| 文件 | 用途 | 是否入 Git |
|---|---|---|
| `lumi-device-platform.postman_collection.json` | device-platform 集合(健康检查/激活/配对/解绑/运营) | ✅ |
| `lumi-s4-interaction.postman_collection.json` | S4 交互集合(黑盒化,仅设备面) | ✅ |
| `lumi-s5-content-media.postman_collection.json` | S5 内容媒体集合(8 分组 59 请求) | ✅ |
| `lumi-s6-observation.postman_collection.json` | S6 观测集合 | ✅ |
| `lumi-device-platform.postman_environment.json` | 共享环境变量模板(56+ 变量) | ✅ |
| `lumi-device-platform.postman_environment.local.json` | 本地真实值(含 token/password) | ❌ 实际入 Git,但敏感值应通过 CI Secrets 覆盖 |
| `ai-config.local.json` | AI 助手配置(含 api_key) | ❌ |

### .workspace/ 目录（Agent 沙箱）

| 路径 | 用途 |
|---|---|
| `last-request.json` | 最近一次请求-响应详情,Agent 按需读取诊断 |
| `lumi-s6-observation/` | S6 上游仓 clone(供 Agent 读取契约源码) |
| `run-*.log` | Newman CLI 运行日志 |
| Agent 生成的临时分析文件、测试方案、缺陷报告等 |

### server.js 端点清单

#### 环境变量
- `GET /api/env` — 读取环境变量(优先 .local.json,回退模板)
- `POST /api/env` — 保存(自动 SSE 广播 `env_updated` 通知前端刷新)
- `POST /api/notify/env-updated` — CLI 主动通知刷新
- `GET /api/events` — SSE 订阅(env_updated / request_updated / context_updated)

#### 集合管理
- `GET /api/collections` — 列出 postman/ 下所有集合
- `GET /api/collections/:name/structure` — 集合结构(分组+请求列表+hasPrerequest/hasTest)
- `GET /api/collections/:name/folders` — 文件夹列表
- `POST /api/collections/import` — 导入新集合
- `GET /api/collections/:name/requests/:requestName` — 请求详情
- `PUT /api/collections/:name/requests/:requestName` — 更新请求(SSE 广播 `request_updated`)

#### 测试运行
- `GET /api/run?collection=X&folder=Y` — 运行单 folder(SSE 流)
- `POST /api/run-batch` — 批量顺序运行(body: `{collection, folders[], stopOnFail}`),支持失败停止
- `POST /api/run-request` — 运行单请求(支持 prerequest/test/body override)

#### 报告
- `GET /api/reports` — 列出 reports/ 下历史报告
- `GET /api/reports/:name` — 单报告内容
- `GET /api/reports/:name/text` — 报告文本摘要(统计+失败用例)
- `POST /api/reports/batch-text` — 批量合并文本

#### Agent 上下文
- `GET /api/context/current` — 当前页面/集合/请求/报告指针
- `PUT /api/context/current` — 更新指针(前端切换页面时自动调用)

#### AI 集成
- `GET/POST /api/ai/config` — AI 配置(脱敏读取/保存)
- `POST /api/ai/chat` — OpenAI 兼容 chat/completions 流式对话
- `POST /api/ai/trae` — Trae CLI Agent SSE 端点(注入本文件作为 system prompt)

#### GitHub Issue 自动提交
- `GET /api/github/config` — 查询 GitHub 配置状态(token 是否设置 + 集合→仓库映射)
- `GET /api/github/issues?collection=X&state=open&labels=automated-test` — 列出已有 Issue(供 Agent 查重)
- `POST /api/github/issues?collection=X` body:`{title, body, labels}` — 创建新 Issue(供 Agent 调用)
- `POST /api/github/issues/:number/comments?collection=X` body:`{body}` — 在已有 Issue 追加评论(供 Agent 调用)

#### 故障诊断
- `POST /api/diagnostics/obs-query` — 拉取 S6 Observation 日志
- `POST /api/diagnostics/investigate` — 一键诊断(凭证自动获取)

## 数据规范（必须遵循 Postman/Newman 约定）

### 环境变量格式
```json
{
  "name": "Lumi Device Platform - Local",
  "_postman_variable_scope": "environment",
  "values": [
    {
      "key": "base_url",
      "value": "https://api-lumi.cinmoore.cn/lumi-mind",
      "enabled": true,
      "type": "any",
      "description": {"content": "[用户输入] ...", "type": "text/plain"}
    }
  ]
}
```

### 集合格式
Postman Collection v2.1.0:`{info:{name,schema}, item:[{name, request:{method,url,header,body}, event:[{listen, script:{exec}}]}]}`

### 变量来源标记（description.content 前缀）
- `[用户输入]` — 测试前必须由用户填入真实值
- `[运行时·服务端签发]` — Token,客户端不能自造
- `[运行时·服务端产出]` — 资源 ID / 版本号 / 并发控制字段
- `[运行时·客户端计算]` — pairing_proof 等本地 HMAC
- `[约定值]` — 文档约定的固定值(如 capability_digest 全零占位)

### prerequest 脚本规范
- 用 `pm.environment.get/set`、`pm.variables.get`、`pm.sendRequest`
- 自动生成 `trace_id` / `request_id` / `idempotency_key` / `nonce` 等可变数据(防过拟合)
- 计算 `device_proof` / `pairing_proof`(HMAC-SHA256 + base64url 43 字符)

### test 脚本规范
- 用 `pm.test` + `pm.expect` 断言
- 状态码 + 响应结构 + 关键字段值 + 错误码 + env 回写
- 用 `pm.response.json()` 解析,`pm.environment.set` 回写运行时变量
- Newman sandbox 不支持 `pm.response.buffer()`,改用 `pm.response.stream()`
- 计算 sha256 用 `crypto.lib.WordArray.create(buf)` 转换 Buffer

## 域名架构（关键约束）

| 变量 | 域名 | 路径前缀 | 承载接口 |
|---|---|---|---|
| `base_url` | `https://api-lumi.cinmoore.cn` | `/lumi-mind` | 设备/用户 API(`{base_url}/v1/device/*`、`/v1/user-sessions`、`/v1/guardian/*`) |
| `origin_url` | `https://api-lumi.cinmoore.cn` | (无) | 健康检查 `/healthz` `/readyz` |
| `admin_base_url` | `https://admin-lumi.cinmoore.cn` | (无) | 运营管理 `/ops/v1/operator-sessions` + `/ops/v1/*` |

**重要**:`/ops/v1/operator-sessions` 运营登录由 device-platform 提供,但只在 admin 域 `admin-lumi.cinmoore.cn` 上经 Caddy 反代到 DP。请求 `{{base_url}}/v1/operator-sessions` 会 404。

## Newman stats 字段语义（重要）

Newman JSON 报告 `run.stats` 各字段含义不同,判断真实失败数必须用对字段:

| 字段 | 含义 | 是否统计 pm.test 失败 |
|---|---|---|
| `stats.tests.failed` | 脚本异常失败 | ❌ 不统计断言失败 |
| `stats.assertions.failed` | pm.test 断言失败 | ✅ |
| `failures[]` 数组 | 所有失败记录(含断言) | ✅ |
| `stats.requests.failed` | HTTP 请求失败(非 2xx) | — |

**正确公式**:`failedTests = failedAssertions + failuresCount`(避免 Newman stats.tests.failed 不准的坑)

## QA 工作模式

### 测试用例设计原则
1. **业务驱动** — 先理解业务场景(配对/发布/鉴权),再设计用例
2. **分层覆盖**:
   - L1 冒烟:核心正向流程
   - L2 功能:单接口参数校验、返回结构、状态码
   - L3 集成:跨接口时序、env 变量传递、状态机转换
   - L4 异常:负向、越权、资源不存在、并发冲突
   - L5 安全:鉴权绕过、注入、敏感数据泄漏
3. **可变性** — 测试数据每次运行用不同 trace_id/nonce/idempotency_key(prerequest 生成)
4. **幂等性验证** — 重复请求、Idempotency-Key 复用、状态机违规
5. **断言完备** — 状态码 + 响应结构 + 关键字段值 + 错误码 + env 回写

### 典型 QA 任务流
1. **运行并诊断** — 调用 `/api/run-request` 或 `/api/run` 执行请求,分析 Newman 输出定位失败
2. **故障诊断** — 用户提供 traceId/requestId 时,调 `/api/diagnostics/investigate` 拉取 S6 日志
3. **增强 test 脚本** — 读请求 → 补 JSON Schema 断言、错误码断言、env 回写 → PUT 更新
4. **设计负向用例** — 基于现有请求生成 token 缺失/过期/跨面/越权变体
5. **覆盖度分析** — 读集合结构,识别未覆盖的 API、缺失的负向场景
6. **生成测试方案** — 在 `.workspace/` 生成 Markdown 测试计划/缺陷报告

### 诊断框架（根因分析）
当用户问"为什么失败""排查问题"时:
1. **优先读 `.workspace/last-request.json`** — 获取最近请求的 method/url/headers/body/response/assertions
2. **再调 `/api/context/current`** — 确认用户当前选中的集合/请求/报告
3. **如需日志,调 `/api/diagnostics/investigate`** — 凭证自动获取
4. **输出结构化诊断报告**:结论 + 证据(引用具体字段值) + 建议 Action(可执行步骤)

## 输出风格规范（严格遵守）

**输出原则**:精简结论,不展示过程。用户不需要看你调用 API 的过程、读文件的步骤、思考链路。

### 回答结构（按场景）

- **诊断类问题**("为什么失败"/"什么原因"):
  ```
  **结论**:<一句话根因>
  **证据**:<关键状态码/错误码/断言失败项,引用具体字段值>
  **建议 Action**:
  1. <可执行的修复步骤>
  2. ...
  ```

- **分析类问题**("覆盖率如何"/"有什么问题"):
  ```
  **关键发现**:<2-4 条要点>
  **风险等级**:高/中/低
  **建议 Action**:<按优先级排序>
  ```

- **操作类问题**("帮我生成"/"帮我修复"):
  ```
  **已完成**:<动作结果>
  **变更摘要**:<改了什么>
  **下一步建议**:<可选>
  ```

- **简单问答** — 直接一句话回答,不要套模板

### 禁止行为
- ❌ 不要复述"我读取了 last-request.json,发现..."——直接给结论
- ❌ 不要展示 API 调用日志、HTTP 响应原文、文件内容
- ❌ 不要写"根据上下文分析..."、"经过检查..."等过程性语句
- ❌ 不要在结论前铺垫思考过程
- ✅ 要在"证据"字段引用具体值(如 "状态码 404,期望 201")
- ✅ 要在"建议 Action"给出可直接执行的步骤(如"运行 OP-C04 创建类目")

## 当前项目上下文

### 测试目标
Lumi 设备平台 API(device/user/ops 三面) + S4 交互 + S5 内容媒体 + S6 Observation 日志拉取

### 集合清单
- `lumi-device-platform` — 健康检查/激活/配对/解绑/运营账号
- `lumi-s4-interaction` — 语音消息/实时语音/拍搜/媒体(仅设备面)
- `lumi-s5-content-media` — CMS/Catalog/PlayResource/Categories/Library/Recommendations/Uploads/Publications/CMS Pages/场景
- `lumi-s6-observation` — Observation 日志拉取

### 鉴权机制
- `device_proof` / `pairing_proof`(HMAC-SHA256,base64url 43 字符)
- Bearer token(device/user/operator/service 四类)
- `Idempotency-Key`(部分写接口)
- `If-Match` 乐观并发(替代 body 中 `expected_revision`)
- `X-Lumi-Device-ID`(S5 设备请求必带)

### 环境变量规模
67 变量(含 [用户输入]/[运行时·服务端签发]/[运行时·服务端产出]/[运行时·客户端计算]/[约定值] 五类来源)

### Web Console 运行地址
`http://localhost:8088`(本地开发,`npm run console` 启动)

### 运营登录
- 端点:`POST /ops/v1/operator-sessions`(admin 域)
- 返回:`operator_access_token`(TTL 600s,role=operator)
- MFA:测试环境已禁用

### 健康检查
- `GET /healthz` → 200(根路径,绝对 URL)
- `GET /readyz` → 404(内部接口,外部不可访问)

## GitHub Issue 自动提交工作流

当测试运行失败时，server.js 可以写入 `.workspace/last-failure.json`。创建或更新 GitHub Issue 属于独立外部写操作：必须由 Paperclip Task 明确授权、先按 Finding 指纹查重，再由 API 测试 Agent 调用受控代理；默认只生成 Finding 和脱敏证据，不自动发布 Issue。

### 集合 → 仓库映射

| 集合 | GitHub 仓库 |
|---|---|
| `lumi-device-platform` | `chadwangcn/lumi-device-platform` |
| `lumi-s4-interaction` | `chadwangcn/lumi-s4-interaction` |
| `lumi-s5-content-media` | `chadwangcn/lumi-s5-content-media` |
| `lumi-s6-observation` | `chadwangcn/lumi-s6-observation` |

### 工作流步骤

1. **读取失败详情** — `cat .workspace/last-failure.json`,获取:
   - `collection` / `folder` / `stats` — 失败上下文
   - `failedExecutions[]` — 每个失败请求的 method/url/request/response/assertions

2. **查重(对每个失败请求)** — 调用:
   ```
   GET http://localhost:8088/api/github/issues?collection={collection}&state=open&labels=automated-test
   ```
   返回 `[{number, title, state, url, labels, comments}]`。判断标题是否精确匹配 `[Auto] {collection} · {请求名} 失败`。

3. **决策**:
   - **已有 open Issue 标题匹配** → 追加评论(补充本次失败信息):
     ```
     POST http://localhost:8088/api/github/issues/{number}/comments?collection={collection}
     body: {"body": "<评论内容>"}
     ```
   - **无匹配** → 创建新 Issue:
     ```
     POST http://localhost:8088/api/github/issues?collection={collection}
     body: {"title": "[Auto] {collection} · {请求名} 失败", "body": "<正文>", "labels": ["bug","automated-test"]}
     ```

### Issue 内容规范

**标题**:`[Auto] {collection} · {requestName} 失败`

**正文/评论**(Agent 生成,需精简):
```markdown
## 根因
<1-2 句话根因分析,引用具体状态码/错误码>

## 证据
- 请求:`POST /ops/v1/uploads`
- 响应:`401 Unauthorized`
- 断言失败:`Upload story returns 201`(期望 201,实际 401)
- 关键字段:`operator_access_token` 为空(E0 登录失败级联)

## 复现
1. 运行 `{collection}` 集合,执行 `{folder}` 场景
2. 执行请求 `{requestName}`
3. 检查响应状态码与断言

## 建议 Action
1. <可执行的修复步骤>
2. ...
```

**禁止行为**:
- ❌ 不要创建重复 Issue,务必先查重
- ❌ 不要在正文中粘贴完整响应体(超过 1000 字符截断)
- ❌ 不要修改已关闭 Issue(只对 open Issue 追加评论)
- ✅ 标题必须用 `[Auto]` 前缀 + 精确请求名,确保后续查重有效

### GitHub Token 配置

- 环境变量 `GITHUB_TOKEN`(Personal Access Token,需 `repo` scope)
- 未设置时,Agent 提示用户设置并跳过提交

## 仓库工具能力

Agent 可使用以下工具/技能完成任务:

### 文件操作
- `cat` / `head` / `tail` — 读取文件
- `jq` — JSON 解析与查询
- `write` — 写入 `.workspace/` 临时文件

### HTTP 调用
- `curl` — 调用 server.js 端点 / 外部 API
- `httpie` (`http`) — 更友好的 HTTP 客户端(如已安装)

### 测试运行
- `newman` — 运行 Postman 集合(CLI 模式)
- `bash scripts/run-newman.sh <mode>` — CI 入口(smoke/device/guardian/ops/s5-full/all)
- `bash scripts/check-deps.sh` — 依赖检查

### Git 操作
- `git status` / `git diff` / `git log` — 查看仓库状态
- `git add` / `git commit` — 提交变更(需用户确认)

### GitHub 集成
- `GET /api/github/config` — 查询配置
- `GET /api/github/issues` — 查询 Issue
- `POST /api/github/issues` — 创建 Issue
- `POST /api/github/issues/:number/comments` — 追加评论

### 诊断工具
- `cat .workspace/last-request.json` — 最近请求-响应详情
- `cat .workspace/last-failure.json` — 最近测试失败详情
- `GET /api/context/current` — 当前页面/集合/请求指针
- `POST /api/diagnostics/investigate` — S6 日志拉取与根因分析

### 分析能力
- Newman JSON 报告解析(统计/失败用例/响应详情)
- Postman Collection v2.1.0 结构分析(覆盖度/缺口)
- HMAC-SHA256 / JWT / ES256 凭证机制分析
- API 契约符合性验证(对照上游文档)

### 编码能力
- 生成 Postman prerequest/test 脚本
- 生成 cURL / Raw HTTP 命令
- 生成 Vitest 单元测试
- 生成 Markdown 测试方案/缺陷报告
