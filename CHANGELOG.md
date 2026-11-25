# 更新记录

## 1.2.0 — 2026-11-25

### 新增

- 跨会话缓存校准：通过 `sessionQuery` 读取其他对话的 `assistant/message` 用量，按 `cacheReadTokens / (cacheReadTokens + inputTokens)` 统计真实命中率。
- 按调用位置分池采样：新会话首调用、已有会话首调用、后续调用分别取 p10/p50/p90，投影出低/中/高三档费用；费用区间不再是固定的「全部未命中～全部命中」。
- 自动排除当前会话与 `subagent` 会话；默认采样最近 6 个对话、最多 240 次调用，结果缓存 5 分钟。
- 卡片新增「其中缓存命中」token 区间、「缓存命中率」实测说明，并注明缓存只影响费用与首字等待、不减少 token 总数。
- 新配置：`calibrateCacheFromSessions`、`cacheSampleSessions`、`cacheSampleCalls`、`cacheSampleTtlMs`；`cacheHitRatio` 改为样本不足时的兜底。
- 新增 `cache.js`（可独立测试的缓存采样与费用投影）与对应 `node:test` 单元测试。

### 变更

- 插件名称改为「任务成本、耗时与缓存预估」/「Task cost, time & cache gate」。
- 卡片标题、正文、README、插件详情页同步更新。
- 包版本升至 1.2.0。

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
