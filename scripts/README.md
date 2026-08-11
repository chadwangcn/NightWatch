# Newman CI 集成

## 快速开始

### 本地运行

```bash
# 1. 安装 Newman（一次性）
npm run newman:install

# 2. 设置环境变量（敏感凭证）
export DEVICE_SECRET_B64URL="AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
export USER_ACCOUNT="tester@lumi.local"
export USER_PASSWORD="TestPassword123!"
export OPERATOR_ACCOUNT="admin"
export OPERATOR_PASSWORD="AdminPassword123!"
export S5_TEST_AUDIO_PATH="/Users/hydramr/API-Test/test-assets/sample.wav"
# 场景B 可选
export S5_TEST_FAMILY_ID="family-test-001"
export S5_TEST_CHILD_ID="child-test-001"

# 3. 运行（默认 P0 冒烟）
bash scripts/run-newman.sh smoke

# 或运行其他模式
bash scripts/run-newman.sh device      # 设备面单接口
bash scripts/run-newman.sh guardian     # 家长面单接口
bash scripts/run-newman.sh ops         # 运营面单接口
bash scripts/run-newman.sh s5-full     # S5 全量 59 请求
bash scripts/run-newman.sh all         # 三集合全量
```

### 通过 npm scripts 运行

```bash
npm run newman:s5:smoke     # P0 冒烟
npm run newman:s5:device    # 设备面
npm run newman:s5:guardian  # 家长面
npm run newman:s5:ops       # 运营面
npm run newman:s5           # S5 全量
npm run newman:all          # 三集合全量
```

报告输出到 `reports/*.html`，浏览器打开即可。

## 测试模式

| 模式 | 范围 | 用途 | 预期耗时 |
|---|---|---|---|
| `smoke` | 00 健康检查 + 10 场景A + 12 场景C | PR 必跑 | ~30s |
| `device` | 01 设备面 7 请求 | 单接口完整性 | ~15s |
| `guardian` | 03 家长面 10 请求 | 单接口完整性 | ~20s |
| `ops` | 02+04 运营面 17 请求 | 单接口完整性 | ~30s |
| `s5-full` | S5 全量 59 请求 | 发布前验收 | ~2min |
| `all` | 三集合全量 | 每日定时 | ~5min |

## CI/CD 触发

### GitHub Actions 自动触发

| 事件 | 模式 | 说明 |
|---|---|---|
| `push` 到 main/develop | smoke | 快速验证 |
| `pull_request` 到 main | smoke | PR 检查 |
| `workflow_dispatch` 手动 | 可选 | 指定模式 |
| `schedule` 每天 03:00 BJT | all | 全量回归 |

### 需配置的 GitHub Secrets

| Secret | 说明 |
|---|---|
| `DEVICE_SECRET_B64URL` | 设备出厂密钥（HMAC key） |
| `USER_ACCOUNT` | 用户登录账号 |
| `USER_PASSWORD` | 用户登录密码 |
| `OPERATOR_ACCOUNT` | 运营账号 |
| `OPERATOR_PASSWORD` | 运营密码 |
| `S5_TEST_FAMILY_ID` | 场景B private_child family_id（可选） |
| `S5_TEST_CHILD_ID` | 场景B private_child child_id（可选） |

## 报告查看

- **本地**：`reports/*.html` 浏览器打开
- **GitHub Actions**：Artifacts 下载 `newman-report.zip`
- **GitHub Pages**（main 分支）：`https://<owner>.github.io/<repo>/reports/`

## 测试数据

- 非敏感约定值（device_sn / product_id / s5_cms_page_key 等）直接写在环境文件中
- 敏感凭证通过环境变量覆盖，不进 Git
- 测试音频由 CI 在运行时生成 1 秒静音 WAV

## 故障排查

### `command not found: newman`
```bash
npm run newman:install
```

### 上传请求失败
- 检查 `S5_TEST_AUDIO_PATH` 文件是否存在
- CI 环境会自动生成测试音频，本地需手动准备

### 场景B 失败
- 场景B 需要 `s5_test_family_id` / `s5_test_child_id`，且必须与 device token 绑定身份一致
- 当前 API 设计缺口：无法从 API 自动获取这两个 ID，需从 S5 运营后台手动获取

### 跨设备验证（B5）已删除
- 当前只有一台设备，无法验证 private_child 跨设备不可见
- 如需恢复，在环境文件中添加 `other_device_access_token` / `other_device_sn`
