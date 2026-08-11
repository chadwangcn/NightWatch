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

## 快速开始

### 1. 安装依赖

```bash
npm install
npm run newman:install   # 全局安装 newman + newman-reporter-htmlextra
```

### 2. 配置环境变量

复制模板并填入真实凭证:

```bash
cp postman/lumi-device-platform.postman_environment.json \
   postman/lumi-device-platform.postman_environment.local.json
# 编辑 .local.json,填入 device_secret_b64url / user_account / user_password / operator_account / operator_password 等
```

或通过 Web Console 的「环境变量」页编辑(自动保存到 `.local.json`,不入 Git)。

### 3. 启动 Web Console

```bash
npm run console
# 访问 http://localhost:8088
```

### 4. 运行测试

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

## 技术栈

- **后端**:Node.js + Express
- **前端**:单文件 HTML(原生 JS,无框架)
- **测试**:Postman Collection v2.1.0 + Newman CLI
- **Agent**:Trae CLI 子进程 + OpenAI 兼容 chat/completions
- **CI**:GitHub Actions
- **单元测试**:Vitest

## License

Private — 仅限 Lumi 团队内部使用
