# dsh-task-cost-gate · 任务成本与耗时预估

在模型开跑**之前**，先把这条任务要烧掉多少 token、大概多少钱、**大概要等多久**算给你看，然后由你点一下决定「继续执行 / 取消 / 本会话不再询问」。

这是 DeepSeek Harness（DSH）的一个 bundle 插件：纯 Host 侧实现，不加载任何浏览器代码，复用 DSH 自带的提问卡片，所以你输入框上方看到的就是它。

```
任务成本与耗时
本次任务预计约 39 秒、89.2K tokens（¥0.131），继续吗？

> 帮我把这个插件的 README 写好

**估算依据**（deepseek-official/deepseek-flash）
- 当前上下文：12.3K tokens
- 本次消息：+86 tokens
- 首次请求：18.4K tokens
- 按 4 次模型调用估算：输入 84.4K tokens，输出约 4.8K tokens

**预计耗时：约 39 秒**
- 模型生成：4 次调用 × 约 6 秒 ≈ 24 秒（含首字等待）
- 工具执行：3 段 × 约 5 秒 ≈ 15 秒（本会话实测）
- 依据：本会话最近 30 次真实调用（约 237 tokens/秒，首字约 1 秒）

**预计花费：¥0.131**（区间 ¥0.081 ～ ¥0.207）
- 单价（每百万 tokens）：输入 ¥2、缓存命中 ¥0.5、输出 ¥8
- 缓存命中率按 60% 估算

> 取消后这条消息不会进入对话，也不产生费用。

[ 继续执行（推荐） ]  [ 取消本次任务 ]  [ 本会话不再询问 ]
```

> 上图为示意：金额区间来自「全部未命中缓存」与「全部命中缓存」两种极端，标题里的金额按 `cacheHitRatio` 取中间值；耗时则来自默认假设或本会话实测校准。

## 为什么需要它

一次「随便改改」的任务，可能因为读大文件、跑长命令变成几十次模型调用。DSH 自带用量统计，但那是**花完之后**的账。这个插件把账单提前到第一步：在 `agent/pre-step` 这个唯一合法的拦截点估算并征求同意，选择取消时返回 `{ kind: 'reject' }`，这一轮以 `blocked` 结束，**你这条消息不会进入对话记录，也不会产生任何费用**。

耗时同理：开始前先知道「这大概要几十秒还是几分钟」，你可以决定现在等、换个时间，还是把任务拆小。

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
| 费用 | 单价表 × 上述 token 数；区间下界为全部缓存命中、上界为全部未命中，标题金额按 `cacheHitRatio` 取中间值 |
| 耗时 | 模型生成 + 工具执行，见下一节 |

这是**估算**，不是账单：真实消耗取决于模型实际走了几步、输出多长、缓存命中多少。要读大文件或跑长命令的任务会偏小，一步答完的任务会偏大。

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

3. 安装完成后**新开一个会话**验证：发一句普通消息，输入框上方应出现成本与耗时卡片。

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

仓库里 `cordis.patch.yml` 放的是**示例价格**，请改成你实际服务的价目表：**设置 → 插件 → 任务成本与耗时预估**，或直接改 `cordis.patch.yml` 里的 `config`。

模型没匹配到价格时，卡片照常出现，只是只报 token 和耗时、不报钱，并在正文提示去补价格。

## 其它配置

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 关掉即完全不拦 |
| `language` | `zh` | 卡片语言，`zh` / `en` |
| `currency` | `¥` | 金额前缀符号 |
| `assumedSteps` | `4` | 假设一次任务要调用几次模型（≥1） |
| `outputTokensPerStep` | `1200` | 每次调用假设输出多少 tokens |
| `growthTokensPerStep` | `1800` | 每次调用提示增长多少 tokens |
| `cacheHitRatio` | `0.6` | 标题金额按多少比例命中缓存来算 |
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

- 取消后这一轮在对话里不留任何痕迹（DSH 不渲染 `blocked` 轮次的提示条），输入框里的文字也会被清空——所以卡片正文会先回显一遍你的消息，方便重新粘贴。
- 「本会话不再询问」只存在内存里，重启 DSH 或重载插件后失效。
- 估算基于 `tokenMeter` 和会话事件的公开接口，不读取真实账单；`tokenMeter` 不可用时直接放行。
- 耗时估算不含排队、网络重试、你思考和审批的时间；工具阶段按平均估，遇到浏览器操作或长命令可能明显偏小或偏大。
- 只对新任务的第一步负责，管不住任务中途升级成的大工程——那种情况请用 DSH 自带的用量与预算功能兜底。

## 目录结构

```
dsh-task-cost-gate/
├── index.js            # Host 插件本体（配置 schema、估算、拦截、卡片）
├── duration.js         # 耗时计算与从会话事件读取真实时间戳
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
