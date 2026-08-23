# NightWatch

> 守夜人 — Lumi 多服务平台 API 黑盒测试与守夜平台

[![API Test (Newman)](https://github.com/chadwangcn/NightWatch/actions/workflows/api-test.yml/badge.svg)](https://github.com/chadwangcn/NightWatch/actions/workflows/api-test.yml)

NightWatch 是一个面向 Agent 的 API 测试平台,围绕 Postman + Newman 构建,集成资深 QA Agent,为 Lumi 设备/交互/内容/观测四面 API 提供完整的黑盒测试体系:单接口调试、场景批量运行、故障诊断、覆盖度分析、CI 自动化回归。

## 核心能力

| 能力 | 入口 | 说明 |
|---|---|---|
| Web Console | `npm run console` → http://localhost:8088 | 集合/环境变量/请求编辑、单接口运行、批量场景运行、报告预览 |
| Agent 集成 | Console 内 Agent 面板 | Trae CLI 子进程接入,系统 prompt 真源为 [AGENTS.md](./AGENTS.md) |
| Newman CLI | `npm run newman:*` 或 `bash scripts/run-newman.sh <mode>` | 命令行批量运行,支持 smoke/device/guardian/ops/s5-full/all 六种模式 |
| CI/CD | `.github/workflows/api-test.yml` | push/PR 触发 smoke,每天 03:00 BJT 全量回归 |
| 故障诊断 | `POST /api/diagnostics/investigate` | 一键拉取 S6 Observation 日志,Agent 自动分析根因 |

## 测试目标

| 集合 | 覆盖面 | 请求数 |
|---|---|---|
| `lumi-device-platform` | 健康检查/设备激活/QR 配对/APP 解绑/运营账号 | 17 |
| `lumi-s4-interaction` | 语音消息/实时语音/拍搜/媒体(黑盒化,仅设备面) | 26 |
| `lumi-s5-content-media` | CMS/Catalog/PlayResource/Categories/Library/Recommendations/Uploads/Publications/CMS Pages/场景 | 78 |
| `lumi-s6-observation` | Observation 日志拉取与诊断 | — |

> **机器计数对齐**:迁移管线导入 4 集合 218 请求(26+26+114+52),机器真源 `nightwatch/migration/reports/migration-report.json`。

## 快速开始

### 1. 安装依赖

**一键安装**(推荐):

```bash
bash scripts/install-deps.sh
```

该脚本会自动检查并安装:Node.js ≥ 20、项目 npm 依赖、Newman + newman-reporter-htmlextra,并提示 Trae CLI(可选)和本地环境变量配置。

**手动安装**:

```bash
# Node.js >= 20 (https://nodejs.org/)
npm install
npm install -g newman newman-reporter-htmlextra
```

**依赖检查**:

```bash
bash scripts/check-deps.sh
```

检查 Node.js / npm / Newman / Trae CLI / keychain 凭证 / node_modules / 环境变量文件是否就绪。

### 2. 外部依赖

#### Newman(必需)

Postman CLI,运行测试集合的核心依赖。

```bash
npm install -g newman newman-reporter-htmlextra
```

- 官方文档:https://learning.postman.com/docs/collections/using-newman-cli/command-line-integration-with-newman/
- 最低版本:6.0.0

#### Trae CLI(可选,Agent 集成功能用)

供 `POST /api/ai/trae` 端点调用,接入资深 QA Agent。不安装不影响核心测试运行。

- 官方文档:https://docs.trae.cn/cli/get-started-with-trae-cli
- 系统要求:macOS 14.7.8+ / Ubuntu 20.04+ / Windows 10+

```bash
# macOS & Linux
sh -c "$(curl -L https://trae.cn/trae-cli/install.sh)" && export PATH=~/.local/bin:$PATH

# Windows (PowerShell)
irm https://trae.cn/trae-cli/install.ps1 | iex
```

安装后,首次运行 `traecli` 会唤起企业账号登录授权。

**macOS keychain 凭证**(供 server.js 自动读取 token):

```bash
security add-generic-password -s trae-cli-token -a traecli-personal-access-token -w <YOUR_TRAE_CLI_TOKEN>
```

**路径覆盖**(如 traecli 不在默认 PATH):

```bash
TRAE_CLI_BIN=/path/to/traecli node server.js
```

### 3. 配置环境变量

复制模板并填入真实凭证:

```bash
cp postman/lumi-device-platform.postman_environment.json \
   postman/lumi-device-platform.postman_environment.local.json
# 编辑 .local.json,填入 device_secret_b64url / user_account / user_password / operator_account / operator_password 等
```

或通过 Web Console 的「环境变量」页编辑(自动保存到 `.local.json`,不入 Git)。

### 4. 启动 Web Console

```bash
npm run console
# 访问 http://localhost:8088
```

### 5. 运行测试

```bash
# 通过 Web Console:左侧 Runner 页选择 folder → 运行
# 通过 CLI:
npm run newman:s5:smoke      # P0 冒烟(00 健康检查 + 10 场景A + 12 场景C)
npm run newman:s5            # S5 全量 78 请求
npm run newman:all           # 三集合全量
```

报告输出到 `reports/*.html`,浏览器打开即可。

## Agent 集成

NightWatch 内置 Agent 真源 [AGENTS.md](./AGENTS.md),定义了:

- **角色**:Lumi API 资深 QA 工程师 Agent
- **职责**:功能验证、测试设计、质量洞察、工程实践
- **边界**:只读 `.workspace/` 沙箱 + 调用 `/api/*` HTTP 端点,不修改项目源码
- **输出规范**:诊断类「结论 + 证据 + 建议 Action」,精简结论不展示过程
- **诊断框架**:优先读 `.workspace/last-request.json` → 调 `/api/context/current` 确认上下文 → 必要时调 `/api/diagnostics/investigate` 拉日志

修改 Agent 行为只需改 AGENTS.md,server.js 启动时自动读取注入,无需改代码。

## 项目结构

```
NightWatch/
├── AGENTS.md                # Agent 真源(角色/规则/端点/规范)
├── README.md               # 本文件
├── HANDOVER.md             # 项目交接文档(人类阅读)
├── server.js               # Express 后端(Newman 运行 + Agent SSE + 诊断)
├── public/index.html       # Web Console 前端(单文件)
├── postman/                # Postman 集合与环境变量(测试资产)
│   ├── lumi-device-platform.postman_collection.json
│   ├── lumi-s4-interaction.postman_collection.json
│   ├── lumi-s5-content-media.postman_collection.json
│   ├── lumi-s6-observation.postman_collection.json
│   ├── lumi-device-platform.postman_environment.json   # 模板(入 Git)
│   └── *.local.json                                     # 本地真实值(不入 Git)
├── scripts/run-newman.sh    # CI 入口脚本
├── src/                    # JS 工具库(crypto/runner/api-client)
├── test/                   # Vitest 单元测试
├── test-assets/            # 测试音频
├── reports/                # Newman HTML 报告(不入 Git)
├── .workspace/             # Agent 沙箱工作区(不入 Git)
└── .github/workflows/api-test.yml  # GitHub Actions CI
```

## CI/CD

| 事件 | 模式 | 说明 |
|---|---|---|
| `push` 到 main/develop | smoke | 快速验证 |
| `pull_request` 到 main | smoke | PR 检查 |
| `workflow_dispatch` 手动 | 可选 smoke/device/guardian/ops/s5-full/all | 指定模式 |
| `schedule` 每天 03:00 BJT | all | 全量回归 |

### GitHub Secrets

| Secret | 说明 |
|---|---|
| `DEVICE_SECRET_B64URL` | 设备出厂 HMAC 密钥 |
| `USER_ACCOUNT` / `USER_PASSWORD` | 用户登录凭证 |
| `OPERATOR_ACCOUNT` / `OPERATOR_PASSWORD` | 运营账号凭证 |
| `S5_TEST_FAMILY_ID` / `S5_TEST_CHILD_ID` | S5 场景B private_child 参数 |
| `S5_TEST_AUDIO_PATH` | S5 测试音频路径(CI 自动生成) |
| `GITHUB_TOKEN` | 自动提交 Issue 用 PAT(需 `repo` scope),供 server.js 与 Trae Agent 调用 |

## GitHub Issue 自动提交

测试失败时,可自动向对应后端仓库提交 Issue。整个工作流由 Trae CLI Agent 自主决策:查重 → 生成 Issue 内容(根因/证据/复现/Action) → 创建新 Issue 或追加评论。

### 集合 → 仓库映射

| 集合 | GitHub 仓库 |
|---|---|
| `lumi-device-platform` | `chadwangcn/lumi-device-platform` |
| `lumi-s4-interaction` | `chadwangcn/lumi-s4-interaction` |
| `lumi-s5-content-media` | `chadwangcn/lumi-s5-content-media` |
| `lumi-s6-observation` | `chadwangcn/lumi-s6-observation` |

### 配置

```bash
# 设置 GitHub Personal Access Token(需 repo scope)
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# 启动服务
npm run console
```

### 使用

1. 在 Runner 页勾选「失败自动提交 Issue」
2. 选择场景 + 运行策略(失败停止/失败继续)
3. 运行 → 失败时自动触发 Agent 处理

Agent 工作流详情见 [AGENTS.md](./AGENTS.md)「GitHub Issue 自动提交工作流」章节。

## 技术栈

- **后端**:Node.js + Express
- **前端**:单文件 HTML(原生 JS,无框架)
- **测试**:Postman Collection v2.1.0 + Newman CLI
- **Agent**:Trae CLI 子进程 + OpenAI 兼容 chat/completions
- **CI**:GitHub Actions
- **单元测试**:Vitest

## License

Private — 仅限 Lumi 团队内部使用
