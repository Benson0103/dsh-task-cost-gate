# 任务成本、耗时与缓存预估

在**任务真正开始之前**算一笔账：这条消息加上已有上下文，会让模型读多少 tokens、写多少 tokens、大概花多少钱、**大概要等多久**；同时参考其他对话的真实缓存命中率，把费用区间收窄到更接近账单的范围。然后把这张账单递给你，由你决定「继续 / 取消 / 本会话不再询问」。

## 卡片出现在哪里

卡片由 DSH 自带的「提问」界面渲染在**输入框上方**（composer 区域），和 `ask_user_question` 工具弹出的问题卡是同一个组件：

- **继续执行（推荐）**：正常执行这个任务。
- **取消本次任务**：任务在这一步被拒绝（turn 以 `blocked` 结束），**你这条消息不会进入对话记录，也不会产生任何费用**。
- **本会话不再询问**：这个会话后面的任务直接执行；插件重启或新开会话后恢复询问。
- 直接点卡片上的「跳过」等同取消——不确定要不要花钱/花时间，就不要花。

卡片只对**新任务的第一步**出现：工具调用之间循环的后续步骤不会重复询问。子代理（subagent）会话以及后台无人值守的会话不会被拦——没有可回答的界面时，插件直接放行，绝不因为「问不到人」而卡住任务。

## 估算方式

| 项 | 来源 |
| --- | --- |
| 当前上下文 | `tokenMeter.measure(session).totalTokens`，已经包含系统提示和工具定义（前提是这个会话发过请求） |
| 这条消息 | `tokenMeter.estimateMessage()` 逐条累加 |
| 首次请求 | 上下文 + 消息；如果会话还从没发过请求（没有请求头记录），额外加上 `firstRequestToolsTokens`，否则工具定义会被漏算 |
| 后续步骤 | 按 `assumedSteps` 次模型调用，每次提示增长 `growthTokensPerStep`（上一轮输出 + 工具结果），输出按 `outputTokensPerStep` |
| 缓存命中 | 参考其他对话同路线、同调用位置的 `cacheReadTokens / (cacheReadTokens + inputTokens)` |
| 费用 | 单价表 × 每次调用的未命中/命中/输出 token；区间来自观测到的低/中/高三档命中率 |
| 耗时 | 模型生成 + 工具执行，见下文 |

这是一份**估算**，不是账单：真实消耗取决于模型实际走了几步、输出多长、缓存命中多少。估算偏小的常见情况是任务中途要读大文件或跑长命令；偏大的情况是模型一步就答完。

## 缓存命中校准

Provider 的用量里，`inputTokens` 是**未命中缓存**的输入，`cacheReadTokens` 是命中缓存的部分，`totalTokens = inputTokens + cacheReadTokens + outputTokens`。命中率按

```
cacheShare = cacheReadTokens / (cacheReadTokens + inputTokens)
```

计算，不能除以 `inputTokens`。

任务开始前，当前调用还没有用量数据。插件通过 DSH 的 `sessionQuery` 服务读取**其他对话**已经产生的 `assistant/message` 用量：

- 只取与当前 `provider/model` 相同的调用；
- 默认采样最近 6 个对话、最多 240 次调用，结果缓存 5 分钟；
- 排除当前会话和 `subagent` 会话；
- 按调用位置分池：新会话首调用参考其他会话的**第一次调用**；已有历史会话的首调用参考其他会话的**续聊回合首调用**；后续调用参考其他会话的**后续调用**；
- 每个池取 p10 / p50 / p90，分别投影低/中/高三档费用，卡片区间取三档的最小值与最大值。

本机真实数据里，新会话首调用的命中率从 0% 到 96% 都有，非常分散；后续调用通常 96%～99%。所以新会话的费用区间仍然较宽（但比「全部未命中～全部命中」窄），已有历史的会话会明显收窄。

样本不足（少于 3 个对话或 12 次调用）、`sessionQuery` 不可用时，退回 `cacheHitRatio`（默认 60%）和极端区间，并在卡片里注明。

缓存命中**不会减少 token 总数**，只会减少按未命中价格计费的输入 token，并缩短首字等待。卡片里的「输入 84.4K tokens」是总量，「其中缓存命中」与「按未命中计费的输入」分别给出范围——后者就是真正按输入价计费的部分。

## 耗时估算

```
预计耗时 = 模型生成 + 工具执行
模型生成（秒）= assumedSteps × (firstTokenMs ÷ 1000 + outputTokensPerStep ÷ outputTokensPerSecond)
工具执行（秒）= (assumedSteps - 1) × toolMsPerStep ÷ 1000
```

每次模型调用都先等首字（`firstTokenMs`），再按出字速度（`outputTokensPerSecond`）把假设的输出写完；两次调用之间按 `toolMsPerStep` 加一段工具执行。

- 默认：出字 **220 tokens/秒**、首字 **1.4 秒**、工具 **5 秒/段**（来自本机真实会话统计，可按自己的模型/工具改）。
- **自动校准**：同一个会话有历史后，插件从 `assistant/message` 的流式时间戳计算真实出字速度和首字延迟，从 `tool/call → tool/result` 配对计算真实工具阶段耗时；取最近 30 次调用 / 30 段工具阶段，样本不足 3 条时退回默认值。
- 卡片会注明耗时依据是「本会话实测」还是「默认速度估算」。
- 耗时**不含**你阅读卡片、思考、点按钮的时间，也不含排队与网络重试；浏览器操作、长命令等会让工具阶段波动很大。

## 价格表

DSH 自身的模型目录里没有价格信息，所以单价由本插件的配置提供，单位是**每 100 万 tokens**：

```yaml
prices:
  deepseek-official/deepseek-flash:   # 先按 "provider/model" 匹配
    input: 2        # 未命中缓存的输入
    cacheHit: 0.5   # 命中缓存的输入（省略则等于 input）
    output: 8       # 输出
defaultPrice:       # 都没匹配到时的兜底；不配就只显示 token、不显示钱
  input: 2
  cacheHit: 0.5
  output: 8
```

安装时 `cordis.patch.yml` 里放的是**示例价格**，请按你所用服务的实际价目表改：设置 → 插件 → 任务成本、耗时与缓存预估（或直接改这一行的 `config`）。改完立刻生效，不需要重启 DSH。

模型没有匹配到价格时，卡片依然出现，只是只报 token 和耗时、不报钱，并在正文里提示去补价格。

## 其它配置

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 关掉即完全不拦 |
| `language` | `zh` | 卡片语言，`zh` / `en` |
| `currency` | `¥` | 金额前缀符号 |
| `assumedSteps` | `4` | 假设一次任务要调用几次模型（≥1，上限 64） |
| `outputTokensPerStep` | `1200` | 每次调用假设输出多少 tokens |
| `growthTokensPerStep` | `1800` | 每次调用提示增长多少 tokens |
| `cacheHitRatio` | `0.6` | 样本不足时的兜底缓存命中率 |
| `calibrateCacheFromSessions` | `true` | 用其他对话的实测命中率收窄费用区间 |
| `cacheSampleSessions` | `6` | 最多采样几个其他对话（上限 12） |
| `cacheSampleCalls` | `240` | 最多采样多少次真实调用 |
| `cacheSampleTtlMs` | `300000` | 采样结果缓存时间（毫秒） |
| `firstRequestToolsTokens` | `6000` | 会话首次请求时补上的工具定义开销 |
| `minInputTokens` | `0` | 首次请求小于这个值就不问（省掉琐碎问候） |
| `showMessagePreview` | `true` | 卡片里回显你这条消息 |
| `askTimeoutMs` | `0` | 超过这么久没人回答就自动放行（0 = 一直等） |
| `estimateDuration` | `true` | 是否显示耗时估算 |
| `calibrateFromSession` | `true` | 是否用本会话真实调用校准 |
| `outputTokensPerSecond` | `220` | 校准不足时的出字速度（tokens/秒） |
| `firstTokenMs` | `1400` | 校准不足时的首字等待（毫秒） |
| `toolMsPerStep` | `5000` | 校准不足时的工具阶段耗时（毫秒/段） |

## 已知限制

- 新会话首调用的缓存命中率本身高度不确定（本机实测 0%～96%），新会话的费用区间会明显宽于续聊会话；这是真实情况，不是估算失误。
- 缓存命中依赖 provider、账号、前缀内容和缓存过期策略；参考其他对话只能给出近似先验。
- 读取其他对话日志会让卡片出现前多一点延迟；默认只读 6 个对话、240 次调用，结果缓存 5 分钟。
- 缓存只影响费用和首字等待，不减少 token 总数。
- 取消后，这一轮在对话里不留任何痕迹（DSH 对 `blocked` 轮次不渲染提示条），你刚才输入的文字也会随输入框一起清空——所以卡片正文会先回显一遍你的消息，方便重新粘贴。
- 「本会话不再询问」只存在内存里，重启 DSH 或重载插件后失效。
- 估算基于 `tokenMeter`、`sessionQuery` 和会话事件的公开接口，不读取模型真实账单；`tokenMeter` 不可用时插件直接放行。
- 耗时估算不含排队、网络重试、你思考和审批的时间；工具阶段按平均估，误差可能较大。
