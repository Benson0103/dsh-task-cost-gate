# dsh-task-cost-gate · 任务成本、耗时与缓存预估

在模型开跑**之前**，先把这条任务要烧掉多少 token、大概多少钱、**大概要等多久**算给你看，然后由你点一下决定「继续执行 / 取消 / 本会话不再询问」。

这是 DeepSeek Harness（DSH）的一个 bundle 插件：纯 Host 侧实现，不加载任何浏览器代码，复用 DSH 自带的提问卡片，所以你输入框上方看到的就是它。

```
任务成本、耗时与缓存
本次任务预计约 1 分 4 秒、89,144 tokens（¥0.100），继续吗？

> 帮我把这个插件的 README 写好

**估算依据**（deepseek-official/deepseek-flash）
- 当前上下文：12.3K tokens
- 本次消息：+86 tokens
- 首次请求：18.4K tokens
- 按 4 次模型调用估算：输入 84.4K tokens，输出约 4.8K tokens
- 其中缓存命中：约 49,121～83,326 tokens
- 按未命中计费的输入：约 1,018～35,223 tokens
- 缓存命中率：参考其他 6 个对话的 214 次真实调用，新会话首步 1%～95%，后续 97%～99%
- 缓存只影响费用与首字等待，不改变 token 总数。

**预计耗时：约 1 分 4 秒**
- 模型生成：4 次调用 × 约 6 秒 ≈ 24 秒（含首字等待）
- 工具执行：3 段 × 约 13 秒 ≈ 40 秒（本会话实测）
- 依据：本会话最近 30 次真实调用（约 237 tokens/秒，首字约 1 秒）

**预计花费：¥0.100**（区间 ¥0.082 ～ ¥0.133）
- 单价（每百万 tokens）：输入 ¥2、缓存命中 ¥0.5、输出 ¥8
- 费用区间按上面观测到的缓存命中率估算。

> 取消后这条消息不会进入对话，也不产生费用。

[ 继续执行（推荐） ]  [ 取消本次任务 ]  [ 本会话不再询问 ]
```

> 上图为示意。缓存命中率现在来自**其他对话的真实用量**，费用区间不再是「全部未命中～全部命中」的极端值；样本不足时仍退回默认值。耗时来自默认假设或本会话实测校准。

## 为什么需要它

一次「随便改改」的任务，可能因为读大文件、跑长命令变成几十次模型调用。DSH 自带用量统计，但那是**花完之后**的账。这个插件把账单提前到第一步：在 `agent/pre-step` 这个唯一合法的拦截点估算并征求同意，选择取消时返回 `{ kind: 'reject' }`，这一轮以 `blocked` 结束，**你这条消息不会进入对话记录，也不会产生任何费用**。

耗时同理：开始前先知道「这大概要几十秒还是几分钟」，你可以决定现在等、换个时间，还是把任务拆小。

缓存命中则决定了**同样的 token 数实际要付多少钱**：长对话的后续调用通常大量命中前缀缓存，按未命中价算会明显高估。插件会参考其他对话的实测命中率，把费用区间收窄到更接近真实账单的范围。

## 三个选项

| 选项 | 行为 |
| --- | --- |
| 继续执行（推荐） | 正常执行这个任务 |
| 取消本次任务 | 任务在这一步被拒绝，消息不进入对话、不产生费用 |
| 本会话不再询问 | 这个会话后面直接执行；重启 DSH 或重载插件后恢复询问 |

卡片只对**新任务的第一步**出现，工具调用之间循环的后续步骤不会重复询问。子代理（subagent）会话和无人值守的后台会话不会被拦——没有可回答的界面时直接放行，绝不因为「问不到人」卡住任务。

## 估算方式

| 项 | 来源 |
| --- | --- |
| 当前上下文 | `tokenMeter.measure(session).totalTokens`，含系统提示与工具定义（前提是这个会话发过请求） |
| 这条消息 | `tokenMeter.estimateMessage()` 逐条累加 |
| 首次请求 | 上下文 + 消息；会话还没发过请求时额外加上 `firstRequestToolsTokens`，避免漏算工具定义 |
| 后续步骤 | 按 `assumedSteps` 次调用，每次提示增长 `growthTokensPerStep`，输出按 `outputTokensPerStep` |
| 每次调用的缓存命中 | 参考其他对话同路线、同调用位置的 `usage.cacheReadTokens / (cacheReadTokens + inputTokens)` |
| 费用 | 单价表 × 每次调用的未命中/命中/输出 token；区间来自观测到的低/中/高三档命中率 |
| 耗时 | 模型生成 + 工具执行，见下文 |

这是**估算**，不是账单：真实消耗取决于模型实际走了几步、输出多长、缓存命中多少。要读大文件或跑长命令的任务会偏小，一步答完的任务会偏大。

## 缓存命中校准

Provider 返回的用量里，`inputTokens` 是**未命中缓存**的输入，`cacheReadTokens` 是命中缓存的部分，`totalTokens = inputTokens + cacheReadTokens + outputTokens`。所以命中率必须按

```
cacheShare = cacheReadTokens / (cacheReadTokens + inputTokens)
```

来算，不能除以 `inputTokens`。

在任务开始前，当前这次调用还没有用量数据。插件于是通过 DSH 的 `sessionQuery` 服务读取**其他对话**已经产生的 `assistant/message` 用量：

- 只取与当前 `provider/model` 相同的调用；
- 默认取最近 6 个对话、最多 240 次调用，结果缓存 5 分钟；
- 排除当前会话和 `subagent` 会话；
- 按调用位置分池：
  - 新会话的第一次调用，参考其他会话的**第一次调用**（实测非常分散，常见 0%～96%）；
  - 已有历史会话的第一次调用，参考其他会话的**续聊回合首次调用**（通常已经命中大部分前缀）；
  - 后续调用参考其他会话的**后续调用**（通常 96%～99%）。
- 对每个池取 p10 / p50 / p90，分别投影出低/中/高三档费用，卡片的区间就是这三档的最小值与最大值。

这样做的效果是：**新会话**因为首调用确实不可预测，区间仍然较宽，但比「0%～100%」诚实且更窄；**已有历史的会话**区间会明显收窄。样本不足（少于 3 个对话或 12 次调用）、`sessionQuery` 不可用时，退回 `cacheHitRatio`（默认 60%）和「全未命中～全命中」区间，并在卡片里注明。

缓存命中**不会减少 token 总数**，只会减少按未命中价格计费的输入 token，并缩短首字等待。卡片里的「输入 84.4K tokens」是总量，「其中缓存命中」与「按未命中计费的输入」分别给出范围——后者就是真正按输入价计费的部分。

相关配置：

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `calibrateCacheFromSessions` | `true` | 是否用其他对话的实测缓存命中率收窄费用区间 |
| `cacheSampleSessions` | `6` | 最多采样几个其他对话（上限 12） |
| `cacheSampleCalls` | `240` | 最多采样多少次真实调用 |
| `cacheSampleTtlMs` | `300000` | 采样结果缓存多久（毫秒） |
| `cacheHitRatio` | `0.6` | 样本不足时的兜底命中率 |

## 耗时估算

公式很简单：

```
预计耗时 = 模型生成 + 工具执行
模型生成（秒）= assumedSteps × (firstTokenMs ÷ 1000 + outputTokensPerStep ÷ outputTokensPerSecond)
工具执行（秒）= (assumedSteps - 1) × toolMsPerStep ÷ 1000
```

- 每次模型调用都要先等首字（`firstTokenMs`），再按出字速度（`outputTokensPerSecond`）把 `outputTokensPerStep` 个 token 写完。
- 两次模型调用之间通常夹着一段工具执行，按 `toolMsPerStep` 估。
- 默认值来自本机真实会话统计：出字约 **220 tokens/秒**、首字约 **1.4 秒**、工具阶段约 **5 秒/段**。不同模型、不同工具差别很大，可以在设置里改。

**自动校准**：同一个会话里干过活之后，插件会从 `assistant/message` 的流式时间戳里算出当前模型的真实出字速度和首字延迟，并从 `tool/call → tool/result` 配对出真实工具阶段耗时。取最近 30 次调用/30 段工具阶段；不足 3 条时退回默认值。卡片正文会注明这次用的是「本会话实测」还是「默认速度估算」。

耗时**不包含**你阅读卡片、思考、点按钮的时间，也不包含排队和网络重试；工具阶段波动很大（例如浏览器操作、长命令）时误差会明显变大。

## 安装

1. 克隆本仓库（或下载 ZIP 解压）到本地任意目录：

   ```powershell
   git clone https://github.com/Benson0103/dsh-task-cost-gate.git
   ```

2. 在 DSH 里安装这个本地目录：打开 **插件（Plugins） → 添加插件（Add plugin）**，选择 `dsh-task-cost-gate` 目录；或者让 Agent 代劳：

   > 安装 D:\\path\\to\\dsh-task-cost-gate 这个本地 bundle 插件

   它等价于调用 `plugin_manager` 的 `install_bundle`，参数是包目录的绝对路径。

3. 安装完成后**新开一个会话**验证：发一句普通消息，输入框上方应出现成本、耗时与缓存卡片。

4. 按自己所用服务的价目表改价格（见下一节），改完立即生效，不需要重启 DSH。

## 价格表

DSH 的模型目录里没有价格信息，所以单价由本插件配置提供，单位是**每 100 万 tokens**：

```yaml
prices:
  deepseek-official/deepseek-flash:   # 先按 "provider/model" 匹配，再按 "model"
    input: 2        # 未命中缓存的输入
    cacheHit: 0.5   # 命中缓存的输入（省略则等于 input）
    output: 8       # 输出
defaultPrice:       # 都没匹配到时的兜底；不配就只显示 token、不显示钱
  input: 2
  cacheHit: 0.5
  output: 8
```

仓库里 `cordis.patch.yml` 放的是**示例价格**，请改成你实际服务的价目表：**设置 → 插件 → 任务成本、耗时与缓存预估**，或直接改 `cordis.patch.yml` 里的 `config`。

模型没匹配到价格时，卡片照常出现，只是只报 token 和耗时、不报钱，并在正文提示去补价格。

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
| `estimateDuration` | `true` | 是否在卡片里显示耗时估算 |
| `calibrateFromSession` | `true` | 是否用本会话真实调用校准速度与工具耗时 |
| `outputTokensPerSecond` | `220` | 校准不足时假设的出字速度（tokens/秒） |
| `firstTokenMs` | `1400` | 校准不足时假设的每次调用首字等待（毫秒） |
| `toolMsPerStep` | `5000` | 校准不足时假设的工具阶段耗时（毫秒/段） |

## 已知限制

- 新会话的第一次调用缓存命中率本身高度不确定（本机实测 0%～96%），所以新会话的费用区间会明显宽于续聊会话；这是真实情况，不是估算失误。
- 缓存命中依赖 provider、账号、前缀内容和缓存过期策略；参考其他对话只能给出近似先验，不能保证当前任务完全一致。
- 读取其他对话的日志会在卡片出现前增加一点延迟；默认只读 6 个对话、240 次调用，结果缓存 5 分钟。
- 缓存只影响费用和首字等待，**不减少 token 总数**。
- 取消后这一轮在对话里不留任何痕迹（DSH 不渲染 `blocked` 轮次的提示条），输入框里的文字也会被清空——所以卡片正文会先回显一遍你的消息，方便重新粘贴。
- 「本会话不再询问」只存在内存里，重启 DSH 或重载插件后失效。
- 估算基于 `tokenMeter`、`sessionQuery` 和会话事件的公开接口，不读取真实账单；`tokenMeter` 不可用时直接放行。
- 耗时估算不含排队、网络重试、你思考和审批的时间；工具阶段按平均估，遇到浏览器操作或长命令可能明显偏小或偏大。
- 只对新任务的第一步负责，管不住任务中途升级成的大工程——那种情况请用 DSH 自带的用量与预算功能兜底。

## 目录结构

```
dsh-task-cost-gate/
├── index.js            # Host 插件本体（配置 schema、估算、拦截、卡片）
├── duration.js         # 耗时计算与从会话事件读取真实时间戳
├── cache.js            # 跨会话缓存命中率采样与费用投影
├── test/               # node:test 单元测试
├── cordis.patch.yml    # bundle 声明与默认配置（示例价格）
├── package.json        # dsh.bundle.patch 指向上面的 patch
├── icon.svg            # 插件图标
├── locale/             # zh.json / en.json 标题与简介
├── CHANGELOG.md        # 版本记录
└── docs/DETAIL.md      # 详细说明（插件详情页渲染的内容）
```

## License

[MIT](LICENSE)
