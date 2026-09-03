# NightWatch Repository Instructions

本仓提供 API 黑盒测试工具和版本化 API Case。进入本仓的 Agent 必须先读取本文件，再按 Task 的 `request_class` 决定允许的工作范围。

API 测试员工的岗位定义、Skill、Workflow 和 Eval 由 `chadwangcn/OpenAgent` 管理。Paperclip 管理任务、责任人、运行状态和证据索引。本文件只保存稳定的仓库边界、输入规则与验证入口，不保存任何当前被测项目的信息。

## 运行输入

### Paperclip Task

Task 提供本次执行的动态信息，包括适用项：

- 测试目标、范围、成功标准、禁止范围和 `request_class`；
- API 定义的 repository、commit、path 和 digest；
- Case repository、commit、Case/suite ID；
- 被测源码、构建、OCI 或运行版本的不可变 digest；
- DeploymentReceipt 或等价的环境版本证明；
- 目标环境、Base URL 字段、鉴权 profile、允许操作和执行预算；
- 证据要求、输出位置、下一责任人和具名验收人；
- 是否允许维护 Case、修改 NightWatch、创建 Issue 或执行其他外部写操作。

### Paperclip Agent 环境

Agent 环境提供跨任务稳定的运行能力，例如 NightWatch 服务入口、默认测试环境、Artifact Store、GitHub/观测访问和被测 API 凭证的 Secret binding。具体变量名由 OpenAgent Agent Definition 和 Skill 声明，本文件不复制项目变量清单或具体值。

非秘密输入以 Task 为本次执行优先值，Agent 环境提供默认值。Secret 值只能由运行时 Secret provider 注入，Task 和 Git 只能保存 Secret Reference 名称。

缺少当前 gate 的必填输入时返回 `BlockerNotice`。不得从历史任务、实现代码、浮动 `main`、本地 `.local.json`、旧报告或仓库示例值推断当前合同和环境。

## 禁止写入本文件的信息

- 当前被测业务、组件、仓库、集合或 Owner 清单；
- 集合到业务仓库、Issue 或责任人的映射；
- 域名、Base URL、路由、端口、当前部署和健康状态；
- 当前鉴权流程、账号、Token、设备密钥或凭证规模；
- 某次任务的合同、Case、测试结果、缺陷、日志或临时工作区。

稳定的 NightWatch 工具协议进入 schema、代码或工具文档；跨员工规范进入 OpenAgent Skill；单次项目事实进入 Task 或 Agent 环境。

## 请求类型与目录边界

### `test_execution`

- 默认只读仓库并调用 Task 授权的测试环境。
- 允许生成 `TestRunReceipt`、`FindingNotice`、`BlockerNotice` 和外部 Artifact 引用。
- 不修改工具、Case、被测服务、正式合同、部署或路由。

### `test_case_maintenance`

- 只修改 `cases/` 及 Task 明确列出的 Postman Case 资产。
- 不修改 NightWatch 工具实现，不削弱断言以适配失败服务。

### `test_tool_improvement`

- 只修改 Task 明确列出的工具路径，例如 `nightwatch/`、`server.js`、`src/`、`public/`、`scripts/` 或工具测试。
- 不顺便修改业务 Case、被测服务代码或正式 API 合同。

### Agent、Skill 或 Workflow 迭代

在 `chadwangcn/OpenAgent` 完成，不在本仓复制岗位定义。

除 Task 明确授权的一次性迁移外，同一 PR 不得同时修改工具实现与业务 Case。

## 仓库约束

- 修改前读取最新文件并检查 Git 状态；使用干净、独立的分支或 worktree。
- 只在当前仓库和 Task 工作区内操作，不读取其他项目的本地目录和个人配置。
- `cases/index.json` 是正式 Case 的唯一发现入口；未登记资产不能用于正式验收。
- 不提交 `.env*`、`*.local.json`、`.workspace/`、`reports/`、原始响应、真实用户数据或凭证。
- 不修改其他仓库的正式合同，不从被测实现反推并改写合同。
- 不自动创建或更新 GitHub Issue；只有 Task 明确授权外部写操作时，才能按 Finding 指纹查重后执行。
- HTTP 200、health、Newman 退出 0 或 NightWatch run `completed` 只表示执行事实，不能代替逐 Case 断言。
- 破坏性、写入型、模糊或负载测试必须由 Task 明确指定环境、预算和授权。

## Case 与证据

- 每次运行必须固定 API 合同、Case 和被测对象版本；执行期间任一 pin 变化都必须停止并创建新 attempt。
- Case 只保存合成数据或 Secret Reference 名称，不保存真实凭证和临时签名 URL。
- 工具负责请求执行与证据事实；API 测试员工负责按 Case 解释结论。
- 原始请求/响应、报告和日志写入 Task 指定的 Artifact Store，并先做字段级脱敏。
- Paperclip 只保存安全摘要、artifact reference、SHA-256、subject/contract/Case pin 和结论。
- 每个失败只指定一个主要分类和一个 `next_owner`：`product`、`contract_ambiguity`、`case`、`tool` 或 `environment`。

## 修改后的最低验证

根据变更范围执行：

```bash
npm run cases:validate
npm test
git diff --check
```

工具行为变更还必须运行受影响模块的定向验证；Case 变更还必须验证索引、合同映射、正向/负向断言和清理步骤。没有 Task 提供的目标环境与授权时，只运行本地、合成或离线验证，不连接已知的历史服务地址。

交付时报告实际命令结果、修改文件、commit/tree、未验证项和下一 gate。实施者自测只能进入 `in_review`，不能自行给出最终验收。
