# Postman Transition

现有 `postman/*.postman_collection.json` 暂不移动，由 `cases/index.json` 显式登记。新增业务 Case 优先使用 NightWatch `test_case` schema；仍需 Newman 执行时，保留稳定 Case ID 到 Collection item 的映射。迁移完成前不得删除或重命名现有 Collection 路径。

