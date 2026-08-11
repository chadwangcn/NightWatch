# Lumi API-Test 项目工作交接

**更新时间**: 2026-08-02
**项目路径**: `/Users/hydramr/API-Test`
**目标**: 为 Lumi 多服务平台建立完整的 API 测试体系，保障大模型生成代码的交付质量

---

## 一、项目背景

### 服务架构
Lumi 是多服务平台，包含多个独立服务，各服务通过 API 契约协作：

| 服务 | 职责 | 测试面（黑盒） | 仓库 |
|---|---|---|---|
| **device-platform** | 设备认证/绑定/运行时 | Device / User / Operator | https://github.com/chadwangcn/lumi-device-platform |
| **s4-interaction** | 交互运行时（语音/实时语音/拍搜/媒体） | Device | https://github.com/chadwangcn/lumi-s4-interaction |
| **s5-content-media** | 内容媒体（CMS/播放/发布） | Device / Operator | https://github.com/chadwangcn/lumi-s5-content-media |

### 服务依赖关系
```
device-platform（签发 token）
   ├─→ s4-interaction（消费 device_access_token）
   │     ├─→ s1-profile-memory（出站 service token）
   │     ├─→ s2-agent-core（出站 service token）
   │     ├─→ s5-content-media（出站 service token）
   │     └─→ s6-observation（出站 service token）
   └─→ s5-content-media（消费 device/user/operator token）
```

### 测试范围（当前阶段）
- ✅ **功能测试**：API 契约 + 业务场景 + 负向边界
- ✅ **压测**：核心路径性能基线
- ✅ **安全测试**：鉴权边界 + 参数伪造 + 异常序列
- ⏸️ **混沌测试**：暂不考虑（需 K8s 环境）

### 测试范围决策
- 用户明确：场景 D 及之后（设备运行时上报/OTA/生命周期管理）暂不测试，功能未完成开发
- 当前聚焦：APP 与设备互动场景（A 设备激活 / B 配对绑定 / C 解绑）

---

## 二、已交付的产出物

### 2.1 Postman 集合（4 个文件）

位于 `/Users/hydramr/API-Test/postman/`：

| 文件 | 用途 | 规模 |
|---|---|---|
| `lumi-device-platform.postman_collection.json` | 设备平台集合（健康检查/设备/用户/配对/解绑） | 6 分组 17 请求 |
| `lumi-s4-interaction.postman_collection.json` | S4 交互集合（语音/实时语音/拍搜/媒体/内部/场景/负面） | 8 分组 38 请求 |
| `lumi-s5-content-media.postman_collection.json` | S5 内容媒体集合（设备/家长/运营/场景/负面） | 7 分组 46 请求 |
| `lumi-device-platform.postman_environment.json` | **唯一共享环境文件**（三个集合共用） | 59 变量 |

### 2.2 集合结构

#### device-platform 集合（17 请求）
```
00 · 健康检查                          4 请求  /healthz /readyz /jwks /public-key-sets
01 · APP单边 · 用户登录                3 请求  login / refresh / logout
02 · 场景A · 设备首次激活              2 请求  device-sessions + bootstrap
03 · 场景B · QR配对绑定                5 请求  pairing → bind → poll → bootstrap → query
04 · 场景C · APP解绑                   3 请求  DELETE + 验证设备失效 + 验证 APP 404
99 · 暂不测试                          0 请求  D/E/F/G 场景待功能开发
```

#### S4 集合（7 分组 26 请求，黑盒化）
```
00 · 健康检查                          4 请求  /health /healthz /readyz /bootstrap
01 · 设备面 · 语音消息                  5 请求  session / turn / playback / directive:resolve / directive/events
02 · 设备面 · 实时语音                  3 请求  session / turn / hangup
03 · 设备面 · 拍搜与媒体                2 请求  camera-explore / media channels:resolve
10 · 场景A · 语音消息完整生命周期        5 请求  session→turn→playback→directive
11 · 场景B · 实时语音完整生命周期        3 请求  session→turn→hangup
12 · 场景C · 鉴权负面用例               4 请求  无 token / 无效 token / 篡改 signature / body deviceId 与 binding 不一致
```

**S4 关键特性（黑盒化后）**：
- **只测设备面**：原 `05 · 内部 service API` 分组（10 请求）已删除，对应 `s4_service_secret_b64url` 等内部面变量已从环境文件移除
- **幂等键在 body 中**（不是 HTTP 头）：`requestId` / `request_id` / `idempotencyKey`
- **无 If-Match / ETag**：并发控制靠 body 幂等键 + binding_version 资源归属
- **WebSocket 一次性 token**：`GET /v1/ai/realtime-voice/media/{oneTimeToken}` 首次使用即消费
- **降级模式**：S2/S5 不可用时返回 degraded=true，不是错误

### 2.3 环境变量设计（53 变量，带分类标记）

环境文件 `lumi-device-platform.postman_environment.json` 的每个变量 description 字段都有来源标记：

| 标记 | 数量 | 含义 |
|---|---|---|
| `[用户输入]` | 18 | 测试前必须由用户填入真实值 |
| `[运行时·服务端签发]` | 6 | Token，客户端不能自造 |
| `[运行时·服务端产出]` | 28 | 资源 ID / 版本号 / 并发控制字段 |
| `[运行时·客户端计算]` | 1 | pairing_proof（设备端本地 HMAC） |
| `[约定值]` | 6 | 文档约定的固定值 |
| `[用户输入·场景B]` | 2 | private_child 可见性测试专属 |

#### 关键共享变量（三个集合都用）
- `device_access_token` ← device-platform A1/B3 产出 → S4 /v1/ai/* + S5 /v1/device/* 消费
- `user_access_token` ← device-platform 01.user-login 产出 → S5 /v1/guardian/* 消费
- `operator_access_token` ← device-platform 04.operator-sessions 产出 → S5 /ops/v1/* 消费
- `service_token` ← device-platform 内部签发 → S4 /v1/interaction/* 消费（需 audience=lumi-s4-interaction）
- `device_sn` / `child_profile_id` 三个集合共用

#### S4 专属变量（18 个）
- `s4_base_url` / `s4_origin_url` / `s4_service_base_url`：API 入口
- `s4_service_id` / `s4_service_audience` / `s4_service_secret_b64url`：内部面鉴权
- `s4_voice_session_id` / `s4_voice_turn_id` / `s4_speech_id` / `s4_directive_id`：语音消息运行时
- `s4_call_session_id` / `s4_media_one_time_token` / `s4_channel_id`：实时语音与媒体
- `s4_interaction_session_id` / `s4_interaction_turn_id` / `s4_receipt_ref`：内部面运行时

#### 敏感凭证（需 CI Secrets 管理，不能入 Git）
- `device_secret_b64url` — 设备出厂 HMAC 密钥
- `user_password` / `operator_password` / `operator_mfa_code`
- `s5_test_family_id` / `s5_test_child_id` — 场景B 绑定参数

---

## 三、关键技术实现

### 3.1 Device Proof / Pairing Proof 自动计算

在 device-platform 集合的 A1/B2/B3 请求的 prerequest 脚本中实现，已用 P1.1 规范测试向量验证：

**真源文档**：
- `/Users/hydramr/Documents/Lumi-Mind™-D0/definitions/identity/P1.1 K1 IoT 设备凭证与 Token 规范.md`
- 代码实现：`lumi_auth/proofs.py`

**device_proof 算法**：
```
canonical = "\n".join([
  "K1_DEVICE_AUTH_V1",       # prefix
  "POST",                     # method
  "/v1/device-sessions",     # path
  "product_id=k1",
  "device_sn=K1-2026-000001",
  "credential_version=1",
  "timestamp=1785210000",
  "nonce=<16字节base64url>",
  "body_sha256=<JCS排序后body的sha256>"
])
proof = HMAC-SHA256(device_secret_bytes, canonical) → base64url(43字符)
```

**pairing_proof 算法**：
```
canonical = "\n".join([
  "K1_PAIRING_V1",
  "POST",
  "/v1/device-bindings",
  "device_sn=...",
  "timestamp=...",
  "nonce=..."
])
proof = HMAC-SHA256(device_secret_bytes, canonical) → base64url(43字符)
```

**验证结果**：Node.js（Postman 同款 CryptoJS）与 Python 实现输出完全一致，匹配 P1.1 测试向量 `31aCPbgG42Z5ObCVMuauwqNxZtrpSDU6GwJ0wvu5jes`。

### 3.2 集合两种使用模式

**单接口测试**：每个请求独立 Send，prerequest 自动生成 trace_id/request_id/idempotency_key

**场景序列测试**：Collection Runner 选中文件夹按顺序执行，环境变量自动串联
- 场景 A：A1→A10 端到端最小验收链路（运营上传→发布→设备 CMS→Catalog→Play→CDN range）
- 场景 B：B1→B5 private_child 可见性边界（B5 需在环境中预置 s5_other_device_token/sn）
- 场景 C：N1→N6 鉴权与参数负向一次性跑完

### 3.3 API 设计合理性观察

**设计清晰的点**：
1. Token 全部服务端签发 — 客户端无法伪造身份
2. 资源 ID 全部服务端生成 — 客户端只能引用不能创造
3. 并发控制字段服务端管 — shadow_version / category_revision 乐观锁
4. Pairing nonce 服务端签发 — 防止设备自选 nonce 重放

**需注意的点**：
- `capability_digest` 当前是全零占位（本地测试向量），真实场景由设备启动计算
- `credential_version` / `binding_version` 应由 device-sessions 响应自动写回环境
- `pairing_proof` 是设备端本地 HMAC 计算，不是服务端产出
- `s5_publication_id` vs `s5_publication_version_id` 是持久 ID vs 版本 ID，使用时别搞混

---

## 四、API 路由清单（真源对齐）

### 4.1 device-platform（47 个路由，4 类身份面）

详细清单见 `https://github.com/chadwangcn/lumi-device-platform/blob/main/docs/api/API-INDEX.md`

**关键端点**：
- `POST /v1/device-sessions` (Device Proof HMAC)
- `POST /v1/device-bindings:start-pairing` (201, 签发 nonce)
- `POST /v1/device-bindings` (User token + pairing_proof)
- `GET /v1/device-bindings/{device_sn}` (User token)
- `DELETE /v1/device-bindings/{device_sn}` (User token, 无 body)
- `GET /v1/device-bootstrap` (Device token)

### 4.2 s4-interaction（25 路由，4 类身份面）

详细清单见 `https://github.com/chadwangcn/lumi-s4-interaction/blob/main/docs/api/README.md`
OpenAPI 真源：`https://github.com/chadwangcn/lumi-s4-interaction/blob/main/docs/openapi.yaml`

**设备面 API**（10 个，device_access_v1，/v1/ai/* + /v1/media/*）：
- `POST /v1/ai/voice-message/session` - 创建语音会话
- `POST /v1/ai/voice-message/{voiceSessionId}/turn` - 提交 ASR 终结结果
- `POST /v1/ai/voice-message/{voiceSessionId}/playback-receipt` - 播放回执
- `POST /v1/ai/voice-message/{voiceSessionId}/directives/{directiveId}:resolve` - 解决 directive
- `POST /v1/ai/voice-message/{voiceSessionId}/directives/{directiveId}/events` - directive 事件
- `POST /v1/ai/realtime-voice/session` - 创建实时语音会话
- `POST /v1/ai/realtime-voice/{callSessionId}/turn` - 实时语音 turn
- `POST /v1/ai/realtime-voice/{callSessionId}:hangup` - 挂断
- `POST /v1/ai/camera-explore` - 拍搜（JSON 或 multipart）
- `POST /v1/media/channels:resolve` - 媒体通道解析

**公开能力端点**（1 个，无鉴权）：
- `GET /v1/ai/realtime-voice/media/{oneTimeToken}` - WebSocket 升级（一次性 token）

**内部 Service API**（10 个，service_access_v1，/v1/interaction/*）：
- `POST /v1/interaction/sessions` - 创建交互会话
- `GET /v1/interaction/sessions/{session_id}` - 查询会话
- `POST /v1/interaction/sessions/{session_id}:close` - 关闭会话
- `POST /v1/interaction/sessions/{session_id}/turns` - 提交互turn
- `GET /v1/interaction/sessions/{session_id}/turns/{turn_id}` - 查询 turn
- `POST /v1/interaction/sessions/{session_id}/directives/{directive_id}:resolve` - 解决 directive
- `POST /v1/interaction/sessions/{session_id}/directives/{directive_id}/events` - directive 事件
- `POST /v1/interaction/sessions/{session_id}/media-receipts` - 媒体回执
- `GET /v1/interaction/media/receipts/{receipt_ref}` - 查询回执
- `POST /v1/interaction/media/receipts/{receipt_ref}:connect` - 连接 grant

**健康检查 / 元数据**（4 个，无鉴权）：
- `GET /health` / `GET /healthz` / `GET /readyz` / `GET /v1/interaction/bootstrap`

### 4.3 s5-content-media

详细清单见 `https://github.com/chadwangcn/lumi-s5-content-media/blob/main/docs/api/README.md`

---

## 五、项目硬约束（必须遵守）

来自 `project_memory.md` 和用户规则：

1. **健康检查端点必须用绝对 URL**：/healthz 部署在根路径，不加 /lumi-mind 前缀
2. **POST /v1/device-bindings 只在用户侧（APP）调用**：使用 user_access_token，设备侧不直接调绑定 API
3. **API client 的 _request() 方法**：直接使用 `http` 开头的路径作为绝对 URL，不拼接 base URL
4. **A 组测试用例必须在 catch 块调用 _step()**：记录完整错误上下文
5. **computeDeviceProof 调用**：在 runner.js 中应从 `this.config.capabilityDigest` 读取
6. **capability_digest 输入框**：空值时用全零占位（仅本地测试向量验证用）
7. **测试用例 side 标记**：
   - A7, B15-B20: `side: app`（之前误标 'both' 已修正）
   - B23: `side: device`（设备 token 身份篡改测试）

---

## 六、待完成工作（按优先级）

### P0：功能测试完善
- [ ] 给 S5 集合关键请求加 JSON Schema 断言（当前只验状态码和字段存在）
- [ ] 新增场景 D · 参数负向（伪造 ID / 缺必填 / 类型错 / SQL 注入）
- [ ] 新增场景 E · Token 生命周期（过期 / 撤销 / 旧 bv）
- [ ] 新增场景 F · 异常序列（重复 publish / 乱序 / 状态机违规）
- [ ] 新增场景 G · 并发冲突（If-Match 不匹配 / Idempotency-Key 重复）
- [ ] 同步给 device-platform 集合补负向用例

### P1：压测
- [ ] 创建 `perf/` 目录
- [ ] k6 脚本：device-sessions（Token 签发，CPU 密集）
- [ ] k6 脚本：D-CMS（核心读路径，DB 密集）
- [ ] k6 脚本：D-Play（播放请求）
- [ ] 阈值定义：P99 < SLO，错误率 < 0.1%

### P1：CI/CD 集成
- [ ] 创建 `package.json`（Newman 统一入口脚本）
- [ ] 创建 `.github/workflows/functional-test.yml`（Push/PR 触发）
- [ ] 敏感凭证管理（GitHub Secrets 注入）
- [ ] TOTP MFA 处理（oathtool 实时计算 或 测试环境静态码）
- [ ] 测试报告（JUnit XML / HTML）

### P2：安全测试
- [ ] OWASP ZAP CI 集成（`.github/workflows/security-scan.yml`）
- [ ] JWT 篡改测试（payload 改 family_id）
- [ ] IDOR 测试（A 家庭访问 B 家庭 private_child）
- [ ] CDN URL 签名篡改

### P2：契约模糊
- [ ] Schemathesis 从 OpenAPI 自动生成边界用例
- [ ] 补全参数类型/枚举/边界值测试

### P3：报告聚合
- [ ] Allure 多工具结果聚合
- [ ] 统一 Dashboard

---

## 七、推荐技术栈（全开源）

| 类型 | 工具 | 选择理由 |
|---|---|---|
| 功能测试 | **Newman** | 复用已有 Postman 集合，零迁移成本 |
| 压测 | **k6** | JS 脚本、thresholds 阈值、Grafana 集成 |
| 安全扫描 | **OWASP ZAP** | OWASP 官方、CI 集成成熟 |
| 契约模糊 | **Schemathesis** | 从 OpenAPI 自动生成用例 |
| 报告聚合 | **Allure** | 多工具聚合、可视化 |
| CI/CD | **GitHub Actions** | 项目已在 GitHub，零部署成本 |

### 工具选型对比详情

**功能测试**：
- Newman（Apache 2.0，Postman 官方） vs pytest+requests（需重写用例） vs Karate DSL（学习成本）
- 选 Newman：已有集合复用

**压测**：
- k6（Grafana Labs，25k stars） vs Locust（Python，24k stars） vs JMeter（重）
- 选 k6：JS 友好、CI 集成最佳

**安全扫描**：
- OWASP ZAP（OWASP 官方，12k stars） vs Nuclei（模板丰富） vs Burp CE（功能受限）
- 选 ZAP：官方维护、CI 集成成熟

### Newman 与 Postman 的关系
- Postman GUI：开发期调试、写用例（闭源免费）
- Newman：CI/CD 自动化跑用例（开源 Apache 2.0）
- 两者共用 collection.json / environment.json
- Newman 完全免费、无用量限制、无需 Postman 账号

---

## 八、推荐项目目录结构

```
/Users/hydramr/API-Test/
├── postman/                          # 功能测试（已有）
│   ├── lumi-device-platform.postman_collection.json
│   ├── lumi-s5-content-media.postman_collection.json
│   └── lumi-device-platform.postman_environment.json
├── perf/                             # 压测（待建）
│   ├── k6-device-sessions.js
│   ├── k6-cms-resolve.js
│   └── k6-play-resources.js
├── security/                         # 安全扫描（待建）
│   ├── zap-scan.sh
│   └── nuclei-templates/
├── contract/                         # 契约模糊（待建）
│   └── schemathesis-run.sh
├── .github/workflows/                # CI 编排（待建）
│   ├── functional-test.yml
│   ├── performance-test.yml
│   └── security-scan.yml
├── reports/                          # 测试报告输出（gitignore）
├── test-assets/                      # 测试资产（gitignore）
│   └── sample.wav
├── package.json                      # 统一入口（待建）
└── README.md                         # 本文件
```

---

## 九、Agent 接入指引

### 9.1 接入前必读
1. **用户偏好**：见 `/Users/hydramr/.trae-cn/memory/user_profile.md`
   - 通信语言：中文
   - 文档优先：先设计后编码，禁止对重要规则自行 YY
   - 测试偏好：场景测试 + 可变测试数据，防止模型过拟合
2. **项目约束**：见 `/Users/hydramr/.trae-cn/memory/projects/-Users-hydramr-API-Test/project_memory.md`
3. **近期话题**：见 `/Users/hydramr/.trae-cn/memory/projects/-Users-hydramr-API-Test/20260801/topics.md`

### 9.2 真源文档位置
- **P1.1 凭证规范**：`/Users/hydramr/Documents/Lumi-Mind™-D0/definitions/identity/P1.1 K1 IoT 设备凭证与 Token 规范.md`
- **device-platform API**：https://github.com/chadwangcn/lumi-device-platform/blob/main/docs/api/API-INDEX.md
- **S4 API**：https://github.com/chadwangcn/lumi-s4-interaction/blob/main/docs/api/README.md
- **S4 OpenAPI**：https://github.com/chadwangcn/lumi-s4-interaction/blob/main/docs/openapi.yaml
- **S5 API**：https://github.com/chadwangcn/lumi-s5-content-media/blob/main/docs/api/README.md
- **S5 联调指南**：https://github.com/chadwangcn/lumi-s5-content-media/blob/main/docs/api/external-api-test-guide.v1.md
- **CDN 鉴权**：https://github.com/chadwangcn/lumi-s5-content-media/blob/main/docs/runbooks/cdn-url-authentication.md

### 9.3 接入任务分类
- **继续完善 Postman 集合**：参考第六章 P0 待办
- **搭建压测**：参考第六章 P1 待办，创建 `perf/` 目录
- **搭 CI/CD**：参考第六章 P1 待办，创建 `.github/workflows/`
- **安全测试**：参考第六章 P2 待办

### 9.4 关键约定
- **环境变量共享**：三个集合（device-platform / S4 / S5）共用 `lumi-device-platform.postman_environment.json`，不要新建独立环境文件
- **变量标记**：环境文件中每个变量 description 必须带 `[用户输入]` / `[运行时·服务端签发]` / `[运行时·服务端产出]` / `[约定值]` 等来源标记
- **不要自行 YY 规则**：核心规则、框架实现细节缺失时停止编码，反馈用户补充文档
- **测试数据可变**：避免模型过拟合，测试数据每次运行应有变化（如随机 nonce/timestamp）
- **黑盒测试边界**：只测设备面 + 运营面，不测 internal API；S4 已删除内部面分组，S5 已删除 internal API 分组

### 9.5 常见坑
1. `s5_device_base_url` / `s4_base_url` 已合并为 `base_url`，不要再创建重复变量
2. device-platform 集合的 `setNextRequest` 已移除（兼容单接口 Send），轮询需手动重复 Send
3. `multipart/form-data` 的 file part 在 CI 中需确保文件存在（绝对路径或 base64 还原）
4. operator MFA 是 TOTP 30 秒变化，CI 中需用 `oathtool` 实时计算或测试环境静态码（当前测试环境用静态码 `123456`）
5. 场景 B 跨设备不可见验证（B5）已删除：当前环境只有一台设备。如需恢复，需在环境中预置 `other_device_access_token` / `other_device_sn`
6. S4 幂等键在 body 中（`requestId` / `request_id` / `idempotencyKey`），不是 HTTP 头
7. S4 无 If-Match / ETag，并发控制靠 body 幂等键 + binding_version 资源归属检查
8. S4 WebSocket 一次性 token 首次使用即消费，不能重复连接
9. S4 降级模式（degraded=true）是正常响应，不是错误，测试断言要区分
10. S5 设备请求体禁带身份字段（device_sn/user_id/child_id/family_id 等），违规返回 400 `identity_context_field_forbidden`
11. S5 设备请求体必须含 `client_capabilities`，audio 客户端必须声明 supported_audio_codecs 至少含 audio/mp4, audio/mpeg, audio/wav
12. S5 page_key 约定值为 `k1_content_validation`（external-api-test-guide.v1.md 约定，不是 `k1_story_time`）
13. **S5 API 设计缺口**：`owner_binding.family_id` / `child_id` 是 S5 内部 opaque ref，与 device-platform 的 `child_profile_id` 不是同一体系。当前 S5 设备 API 响应不返回身份字段，device-platform binding 查询响应也未见 family_id/child_id。运营创建 private_child publication 时这两个 ID 只能从 S5 运营后台手动获取，无法通过 API 自动串联
14. `other_device_access_token` / `other_device_sn` 已从环境文件移除（当前只有一台设备）。如需恢复 private_child 跨设备验证，需重新添加这两个变量

---

## 十、验证状态

| 项 | 状态 | 验证方式 |
|---|---|---|
| Postman 集合 JSON 合法性 | ✅ 通过 | `python3 -c "import json; json.load(open(...))"` |
| 环境变量引用完整性 | ✅ 通过 | 所有 `{{var}}` 引用都能在环境文件找到 |
| Device Proof 测试向量 | ✅ 通过 | Node.js + Python 输出匹配 P1.1 规范 `31aCPbgG42Z5ObCVMuauwqNxZtrpSDU6GwJ0wvu5jes` |
| Pairing Proof 算法 | ✅ 通过 | 6 行 canonical + HMAC-SHA256 + base64url(43字符) |
| 集合双模式（单接口+场景） | ✅ 通过 | 移除 setNextRequest，兼容单 Send 和 Run Folder |
| 环境变量共享设计 | ✅ 通过 | 三集合共用同一环境文件，token 自动跨集合传递 |
| base_url 合并 | ✅ 通过 | s4/s5 独立 base_url 已全部合并为 base_url/origin_url |
| 变量来源标记 | ✅ 通过 | 53 变量全部带 `[xxx]` 标记 |
| S5 集合结构完整性 | ✅ 通过 | 6 分组 37 请求，对齐 device-content.v1.md + publishing.v1.md + external-api-test-guide.v1.md |
| S5 场景C 错误码断言 | ✅ 通过 | 6 个错误码断言（identity_context_field_forbidden / client_audio_capability_incomplete / operation_idempotency_key_missing / content_target_invalid） |
| S5 private_child 跨设备不可见 | ⏸️ 待补 | 当前只有一台设备，B5 已删除。需第二台设备 token 才能验证 404 content_not_found |
| S4 集合黑盒化 | ✅ 通过 | 7 分组 26 请求，删除内部面分组（原 10 请求）和相关变量 |
| S5 page_key 约定值 | ✅ 通过 | 改为 k1_content_validation（external-api-test-guide.v1.md 约定） |

---

**文档结束。其他 Agent 接入时请先读完本文档，再参考 memory 文件和真源文档。**
