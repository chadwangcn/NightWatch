# NightWatch API Case Library

`cases/index.json` 是 API 测试资产的唯一发现入口。现有 Postman Collection 在迁移期继续保留原路径，由索引显式登记；未登记的 Collection 或 Case 不进入正式执行集合。

```text
cases/
├── index.json          唯一发现入口
├── schema/             Case Index schema
├── suites/             新的 NightWatch 原生 Case 套件
└── imports/postman/    Postman 迁移与映射说明
```

每次执行必须由 Paperclip Task 固定 D0 API 定义 commit/path/digest、Case commit/IDs、部署 digest 和 DeploymentReceipt。Case 只保存 Secret Reference 名称，不能保存 Token、密码、设备密钥、授权头、真实用户数据或临时 URL。

运行 `npm run cases:validate` 检查索引、重复 ID、遗漏 Collection 和来源文件。

