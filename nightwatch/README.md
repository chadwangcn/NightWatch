# NightWatch Contract Foundation (NW-WP-00)

> 版本：1.0.0 · 架构 pin：NightWatch Architecture **v1.4**（SHA-256 `1381f834…22b3b`）
> 职责：为 NightWatch P0 全部 11 个工作包冻结**公共对象合同**——JSON Schema、Command/Event 契约、状态机、统一错误模型、ID/版本/时间规则、正负 Fixture 与离线验证器。**本目录只有合同，没有任何组件运行时行为。**

## 快速验证（独立进程，无服务依赖）

```bash
cd /Users/hydramr/API-Test
node nightwatch/verify/verify.mjs   # exit 0 = 全部通过；exit 1 = 任一检查失败
```

stdout 输出人类可读摘要；机器回执写入 `nightwatch/verify/receipt.json`（两次运行的 `checks` 逐字节一致，仅 `finished_at` 不同——确定性保证）。

## 目录结构

```
nightwatch/
├── schemas/
│   ├── index.json        # 合同注册表（对象/命令/事件 → 文件 → 版本 → 语义出处）
│   ├── common.json       # 共享 $defs：session_state 枚举、13 个 ID 前缀、ISO-8601 UTC、duration_ms
│   ├── errors.json       # 错误码注册表（12 命名空间 / 36 码 / 8 必需语义类别）
│   ├── <object>/v1.json  # 21 个核心对象 schema（每对象一目录，版本即文件名）
│   ├── commands/<name>/v1.json  # 7 个 Command schema
│   └── events/<name>/v1.json    # 8 个 Event schema
├── fixtures/
│   ├── index.json        # fixture 清单 + 状态机/错误语义覆盖声明
│   ├── objects/*.json    # 21 个对象的正负例（63 正 / 87 负）
│   ├── commands/*.json   # 7 个命令的正负例
│   └── events/*.json     # 8 个事件正负例（sessionStateChanged 含全 13 条合法迁移 + 5 条非法迁移负例）
├── verify/
│   ├── verify.mjs        # 验证入口（Ajv 2020-12，7 大检查）
│   └── receipt.json      # 机器回执
└── README.md             # 本文件
```

## 合同地图

### 核心对象（21 个，全部 v1.0.0）

| 类别 | 对象 | 不可变 | 语义出处 |
|---|---|---|---|
| 会话与执行 | `session` `checkpoint` `run` `execution_request` `execution_result` | run ✅ / execution_result ✅ | §7.2 / §14 / §5.7 |
| 测试资产 | `test_plan` `scenario` `test_case` | — | §5.6 / §10 |
| 证据与缺陷 | `observation` `finding` `issue_draft` `publish_receipt` | observation ✅ / publish_receipt ✅ | §5.8 / §15 / §16 |
| 治理与安全 | `audit_event` `lock` `policy_decision` `approval_record` `credential_reference` `injection_lease` | audit_event ✅ | §5.10 / §22.5.4 / §13.1 |
| Registry | `registry_entry` `import_history` | import_history ✅ | §5.3 / §9 |
| 错误 | `error` | — | §5.4 |

### Commands（7 个）

`createSession` `resumeSession` `startRun` `cancelRun` `retryRun` `publishIssue` `retestIssue` — 每个 Command 必含 `command_id`（幂等键）、`issued_at`、`deadline`、`payload`；`startRun`/`publishIssue` 的 `command_id` 即幂等键。

### Events（8 个）

`sessionStateChanged` `runStarted` `runStepRecorded` `runCompleted` `observationRecorded` `findingClassified` `issueDrafted` `issuePublished` — 每个 Event 必含 `event_id`、`object_id`、`object_type`、`occurred_at`（UTC）、`sequence`。`sessionStateChanged` 的 payload 用 if/then 矩阵约束 from→to，非法迁移在 schema 层不可表达。

### Session 状态机（§7.2）

```
discovery → library_draft → library_review → environment_ready → running
running → analyzing → issue_review → published | inconclusive
running ⇄ blocked（可恢复态）
published → retest_pending → closed
inconclusive → retest_pending → closed
```

12 状态 / 13 条合法迁移 / 唯一终态 `closed`。注册表、common.json 枚举、事件 schema 矩阵、fixture 覆盖四方一致（验证器强制检查）。

### 统一错误模型

- Envelope：`{code, message, details, retryable, idempotent_replay}`（`schemas/error/v1.json`）
- 12 命名空间：`CTL_` `REG_` `LIB_` `CMP_` `POL_` `CRED_` `EXE_` `FIX_` `EVD_` `FND_` `ISS_` `AUD_`，共 36 码
- 8 个必需语义类别均有码 + 正例 fixture：idempotency-conflict（`CTL_IDEMPOTENCY_CONFLICT` / `ISS_IDEMPOTENCY_CONFLICT`）、timeout、cancellation、lock-expired、policy-denied、credential-missing、validation-failed、unauthorized
- 错误码 enum 与 errors.json 注册表双向一致（验证器强制检查）

### ID / 版本 / 时间规则

- **ID**：`<prefix>_<ULID 26 字符>`，13 个前缀全注册（session/run/exec/plan/scen/case/obs/find/draft/issue/audit/lease/lock），模式 `[0-9A-HJKMNP-TV-Z]{26}`（Crockford Base32，单调可排序）
- **版本**：schema 文件 semver；加可选字段/widen 枚举 = minor；删字段/改类型/加必填/收紧枚举 = major；不可变对象修订 = 新对象 + `supersedes_*_id` 父引用
- **时间**：时间戳一律 UTC ISO-8601 Z 后缀；duration/timeout 一律毫秒整数；唯一例外 `execution_request.timeout_seconds` 保留 §5.7 冻结的字段名（秒），已在注册表 `time_semantics.exception` 显式记录

## Fixture 约定

- 每个 fixture 文件含 `schema`（$id 引用）、`positive[]`、`negative[]`
- 负例必带 `violated_rule`（说明违反的规则）；正例可带 `_transition` / `_semantic_category` 等下划线注解（验证前剥离）
- **全部合成数据**：合成标识用 `synthetic-` 前缀；验证器对 schemas/ + fixtures/ 全部 JSON 做 7 类 secret 模式扫描（AWS key、GitHub token、OpenAI key、Slack token、私钥块、JWT 等），命中数必须为 0
- 凭证对象（`credential_reference` / `injection_lease` / checkpoint 凭证字段 / `credential_env_allowlist`）**只有引用名，无任何值字段**（§13.1）

## 验证器七大检查

| 检查 | 内容 |
|---|---|
| `schemas_meta_valid` | 37 个 schema 均为合法 draft 2020-12，带 $id/title/x-nightwatch-object/x-nightwatch-version，与注册表一致 |
| `fixtures_positive` | 63 个正例全部通过对应 schema 校验 |
| `fixtures_negative_rejected` | 87 个负例全部被拒绝，回执逐条列出违反规则与 AJV 证据 |
| `state_machine_consistency` | 枚举/矩阵/注册表/fixture 四方一致；终态无出边；初始可达终态；blocked 可恢复；非法迁移负例 ≥3 且全部被拒 |
| `error_registry_consistency` | 错误码 enum ↔ 注册表双向一致；12 命名空间非空；8 语义类别有码有例；fixture 码 ⊆ 注册表 |
| `id_prefix_coverage` | 13 个前缀均有 common.json 定义且正例中出现 |
| `secret_scan` | 76 个 JSON 文件 secret 模式命中 0 |

## 依赖

唯一运行时依赖：`ajv@8.17.1`（精确 pin，无 `^`/`~`），已在 `package.json`。Node ≥ 20。

## 已知边界（供 Coordinator 裁决）

- `inconclusive→retest_pending` 迁移来自 WorkRequest §5.2 字面文本（"published/inconclusive → retest_pending → closed"）；架构 §7.2 图中只画了 published→retest_pending。当前按 WorkRequest 字面语义收录，已在注册表 `state_machine.notes` 标记。
- `run` 对象 schema 要求 `immutable: true` 的合同语义通过注册表标注 + 版本规则表达（JSON Schema 本身无法表达"文件不可修改"，由后续 WP-04 Runtime 强制）。
