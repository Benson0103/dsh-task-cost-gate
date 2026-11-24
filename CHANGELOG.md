# 更新记录

## 1.1.0 — 2026-11-24

### 新增

- 成本卡片同时预估任务的**墙钟耗时**：标题给出「约 X 分 Y 秒」，正文拆分为模型生成与工具执行。
- 从当前会话的 `assistant/message` 流式时间戳自动校准出字速度与首字延迟，从 `tool/call → tool/result` 配对校准工具阶段耗时；样本不足时使用默认值，卡片注明依据。
- 新配置：`estimateDuration`、`calibrateFromSession`、`outputTokensPerSecond`、`firstTokenMs`、`toolMsPerStep`。
- 新增 `duration.js`（可独立测试的耗时计算）与 `node:test` 单元测试。

### 变更

- 插件名称改为「任务成本与耗时预估」/「Task cost & time gate」。
- 卡片标题、正文、README、插件详情页同步更新。
- 包版本升至 1.1.0。

## 1.0.0

- 首个版本：在 `agent/pre-step` 拦截新任务，估算 tokens 与费用，并提供「继续执行 / 取消本次任务 / 本会话不再询问」三个选项。
