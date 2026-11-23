# dsh-task-cost-gate · 任务成本预估

在模型开跑**之前**，先把这条任务要烧掉多少 token、大概多少钱算给你看，然后由你点一下决定「继续执行 / 取消 / 本会话不再询问」。

这是 DeepSeek Harness（DSH）的一个 bundle 插件：纯 Host 侧实现，不加载任何浏览器代码，复用 DSH 自带的提问卡片，所以你输入框上方看到的就是它。

```
任务成本预估
本次任务预计消耗约 28.4K tokens（¥0.19），继续吗？

> 帮我把这个插件的 README 写好

**估算依据**（deepseek-official/deepseek-flash）
- 当前上下文：12.3K tokens
- 本次消息：+86 tokens
- 首次请求：18.4K tokens
- 按 4 次模型调用估算：输入 42.6K tokens，输出约 4.8K tokens

**预计花费：¥0.19**（区间 ¥0.12 ～ ¥0.26）
- 单价（每百万 tokens）：输入 ¥2、缓存命中 ¥0.5、输出 ¥8
- 缓存命中率按 60% 估算

> 取消后这条消息不会进入对话，也不产生费用。

[ 继续执行（推荐） ]  [ 取消本次任务 ]  [ 本会话不再询问 ]
```

> 上图为示意：金额区间来自「全部未命中缓存」与「全部命中缓存」两种极端，标题里的金额按 `cacheHitRatio` 取中间值。

## 为什么需要它

一次「随便改改」的任务，可能因为读大文件、跑长命令变成几十次模型调用。DSH 自带用量统计，但那是**花完之后**的账。这个插件把账单提前到第一步：在 `agent/pre-step` 这个唯一合法的拦截点估算并征求同意，选择取消时返回 `{ kind: 'reject' }`，这一轮以 `blocked` 结束，**你这条消息不会进入对话记录，也不会产生任何费用**。

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

这是**估算**，不是账单：真实消耗取决于模型实际走了几步、输出多长、缓存命中多少。要读大文件或跑长命令的任务会偏小，一步答完的任务会偏大。

## 安装

1. 克隆本仓库（或下载 ZIP 解压）到本地任意目录：

   ```powershell
   git clone https://github.com/Benson0103/dsh-task-cost-gate.git
   ```

2. 在 DSH 里安装这个本地目录：打开 **插件（Plugins） → 添加插件（Add plugin）**，选择 `dsh-task-cost-gate` 目录；或者让 Agent 代劳：

   > 安装 D:\\path\\to\\dsh-task-cost-gate 这个本地 bundle 插件

   它等价于调用 `plugin_manager` 的 `install_bundle`，参数是包目录的绝对路径。

3. 安装完成后**新开一个会话**验证：发一句普通消息，输入框上方应出现成本卡片。

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

仓库里 `cordis.patch.yml` 放的是**示例价格**，请改成你实际服务的价目表：**设置 → 插件 → 任务成本预估**，或直接改 `cordis.patch.yml` 里的 `config`。

模型没匹配到价格时，卡片照常出现，只是只报 token 不报钱，并在正文提示去补价格。

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

## 已知限制

- 取消后这一轮在对话里不留任何痕迹（DSH 不渲染 `blocked` 轮次的提示条），输入框里的文字也会被清空——所以卡片正文会先回显一遍你的消息，方便重新粘贴。
- 「本会话不再询问」只存在内存里，重启 DSH 或重载插件后失效。
- 估算基于 `tokenMeter` 的公开接口，不读取真实账单；`tokenMeter` 不可用时直接放行。
- 只对新任务的第一步负责，管不住任务中途升级成的大工程——那种情况请用 DSH 自带的用量与预算功能兜底。

## 目录结构

```
dsh-task-cost-gate/
├── index.js            # Host 插件本体（配置 schema、估算、拦截、卡片）
├── cordis.patch.yml    # bundle 声明与默认配置（示例价格）
├── package.json        # dsh.bundle.patch 指向上面的 patch
├── icon.svg            # 插件图标
├── locale/             # zh.json / en.json 标题与简介
└── docs/DETAIL.md      # 详细说明（插件详情页渲染的内容）
```

## License

[MIT](LICENSE)
