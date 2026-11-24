/**
 * Task cost & time gate — a host plugin that estimates what an incoming task
 * will cost in tokens, money and wall-clock time, and asks the user before the
 * first model call happens.
 *
 * Why `agent/pre-step`: that waterfall is the only sanctioned point between
 * "the user submitted a message" and "the model is billed". Returning
 * `{ kind: 'reject' }` there ends the turn as `blocked` and the claimed user
 * message never enters the session surface, so a cancelled task costs nothing.
 *
 * Why no Client module: a blocking `userQuestions.ask()` without a `wait`
 * call id is rendered by the shipped user-questions Client as a composer card
 * for that session, and its answer resolves the promise. Reusing that keeps
 * this bundle to one host plugin with nothing to load in the browser.
 *
 * @module dsh-task-cost-gate
 */

import z from '@deepseek-ai/schemastery'
import {
  collectTiming,
  DURATION_DEFAULTS,
  estimateDuration,
  formatDuration,
  summarizeTiming,
} from './duration.js'

/** Token prices are quoted per this many tokens. */
const PER_MILLION = 1_000_000

/** Question id of the gate card; stable so a re-render neither duplicates nor drops it. */
const ASK_ID = 'task-cost-gate'

/** Permission asked for by the three fixed options, in order. */
const CHOICE_CONTINUE = 'continue'
const CHOICE_CANCEL = 'cancel'
const CHOICE_MUTE = 'mute'

/** Price of one exact route, per one million tokens. */
const priceEntry = z.object({
  input: z.number().min(0).default(0).description('Uncached prompt tokens, per 1M.'),
  cacheHit: z.number().min(0).default(0).description('Cache-hit prompt tokens, per 1M (defaults to `input`).'),
  output: z.number().min(0).default(0).description('Completion tokens, per 1M.'),
})

/** Row configuration of this plugin. */
export const Config = z.object({
  enabled: z.boolean().default(true).description('Ask before each task. Turning this off disables the gate entirely.'),
  language: z.string().default('zh').description('Card language: `zh` or `en`.'),
  currency: z.string().default('¥').description('Symbol printed in front of every amount.'),
  assumedSteps: z.natural().default(4).description('Model calls a task is assumed to need (>= 1).'),
  outputTokensPerStep: z.natural().default(1200).description('Completion tokens assumed per model call.'),
  growthTokensPerStep: z.natural().default(1800).description('Prompt growth tokens added per call (earlier output plus tool results).'),
  cacheHitRatio: z.number().min(0).max(1).default(0.6).description('Assumed share of prompt tokens billed at the cache-hit price.'),
  firstRequestToolsTokens: z.natural().default(6000).description('Tool-schema tokens added when the session has never issued a request yet.'),
  minInputTokens: z.natural().default(0).description('Skip the gate for tasks whose first request is smaller than this.'),
  showMessagePreview: z.boolean().default(true).description('Quote the submitted message inside the card.'),
  askTimeoutMs: z.natural().default(0).description('Proceed automatically when the card is unanswered for this long (0 = wait for the user).'),
  estimateDuration: z.boolean().default(true).description('Estimate the wall-clock time of the task next to its token cost.'),
  calibrateFromSession: z.boolean().default(true).description('Learn model speed and tool time from earlier calls in the same session.'),
  outputTokensPerSecond: z.natural().default(DURATION_DEFAULTS.outputTokensPerSecond).description('Output speed assumed when the session has no usable history (tokens/second).'),
  firstTokenMs: z.natural().default(DURATION_DEFAULTS.firstTokenMs).description('Wait assumed before the first output token of each model call (ms).'),
  toolMsPerStep: z.natural().default(DURATION_DEFAULTS.toolMsPerStep).description('Time assumed to run tools between two model calls (ms).'),
  defaultPrice: priceEntry.description('Fallback price for routes missing from `prices`.'),
  prices: z.dict(priceEntry).description('Price table keyed by `<provider>/<model>`, then `<model>`.'),
})

/**
 * Normalize untrusted configuration into the shape the gate uses.
 * @param raw - configuration supplied by the bundle row (or nothing at all).
 */
export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const prices = {}
  if (config.prices !== null && typeof config.prices === 'object' && !Array.isArray(config.prices)) {
    for (const [key, value] of Object.entries(config.prices)) {
      if (typeof key !== 'string' || key.length === 0) continue
      const price = normalizePrice(value)
      if (price !== undefined) prices[key] = price
    }
  }
  return {
    enabled: config.enabled !== false,
    language: config.language === 'en' ? 'en' : 'zh',
    currency: typeof config.currency === 'string' && config.currency.length > 0 ? config.currency : '¥',
    assumedSteps: Math.max(1, natural(config.assumedSteps, 4)),
    outputTokensPerStep: natural(config.outputTokensPerStep, 1200),
    growthTokensPerStep: natural(config.growthTokensPerStep, 1800),
    cacheHitRatio: ratio(config.cacheHitRatio, 0.6),
    firstRequestToolsTokens: natural(config.firstRequestToolsTokens, 6000),
    minInputTokens: natural(config.minInputTokens, 0),
    showMessagePreview: config.showMessagePreview !== false,
    askTimeoutMs: natural(config.askTimeoutMs, 0),
    estimateDuration: config.estimateDuration !== false,
    calibrateFromSession: config.calibrateFromSession !== false,
    outputTokensPerSecond: Math.max(1, natural(config.outputTokensPerSecond, DURATION_DEFAULTS.outputTokensPerSecond)),
    firstTokenMs: natural(config.firstTokenMs, DURATION_DEFAULTS.firstTokenMs),
    toolMsPerStep: natural(config.toolMsPerStep, DURATION_DEFAULTS.toolMsPerStep),
    defaultPrice: normalizePrice(config.defaultPrice),
    prices,
  }
}

/** Read one non-negative integer, falling back when the value is unusable. */
function natural(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback
}

/** Read one ratio inside 0..1, falling back when the value is unusable. */
function ratio(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback
}

/** Read one non-negative number without rounding (token prices are fractional). */
function amount(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** Read one price row, treating an all-zero row as "no price known". */
function normalizePrice(value) {
  if (value === null || typeof value !== 'object') return undefined
  const input = amount(value.input, 0)
  const output = amount(value.output, 0)
  const cacheHit = value.cacheHit === undefined ? input : amount(value.cacheHit, input)
  if (input === 0 && output === 0 && cacheHit === 0) return undefined
  return { input, cacheHit, output }
}

/** Format a token count with thousands separators. */
function formatTokens(tokens) {
  return Math.max(0, Math.round(tokens)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Format money with enough decimals to stay readable for sub-cent amounts. */
function formatMoney(amount, currency) {
  if (!Number.isFinite(amount)) return `${currency}—`
  const absolute = Math.abs(amount)
  const digits = absolute >= 1 ? 2 : absolute >= 0.01 ? 3 : 4
  return `${currency}${amount.toFixed(digits)}`
}

/** Collapse a submitted message into a short single-line preview. */
function preview(messages, limit = 180) {
  const text = messages
    .flatMap((message) => Array.isArray(message?.content) ? message.content : [])
    .map((part) => typeof part?.text === 'string' ? part.text : '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Look up the price of one route: `<provider>/<model>`, then `<model>`, then the default. */
export function priceFor(config, provider, model) {
  const exact = config.prices[`${provider}/${model}`]
  if (exact !== undefined) return exact
  const byModel = config.prices[model]
  if (byModel !== undefined) return byModel
  return config.defaultPrice
}

/**
 * Build the token and money projection for one incoming task.
 *
 * Token math: `base` is what the context already costs (including tool schemas
 * once the session has issued a request), `added` is what the claimed messages
 * add, and `tools` covers the first-request case where no header is logged yet
 * and `measure()` therefore cannot see the tool schemas.
 *
 * @param deps - measured facts about the session.
 * @param config - normalized plugin configuration.
 */
export function buildEstimate({ base, added, tools, steps, config, price, provider, model }) {
  const firstInput = Math.max(0, base + added + tools)
  const growth = config.growthTokensPerStep
  // Sum of `firstInput + i * growth` for i in [0, steps).
  const totalInput = steps * firstInput + (growth * steps * (steps - 1)) / 2
  const totalOutput = steps * config.outputTokensPerStep
  const cost = (hitRatio) => {
    if (price === undefined) return undefined
    const cached = totalInput * hitRatio
    const uncached = totalInput - cached
    return (uncached * price.input + cached * price.cacheHit + totalOutput * price.output) / PER_MILLION
  }
  const midpoint = cost(config.cacheHitRatio)
  const bounds = price === undefined ? [] : [cost(0), cost(1)].filter((value) => value !== undefined)
  return {
    provider,
    model,
    base,
    added,
    tools,
    steps,
    firstInput,
    totalInput,
    totalOutput,
    price,
    middle: midpoint,
    low: bounds.length === 0 ? undefined : Math.min(...bounds, midpoint),
    high: bounds.length === 0 ? undefined : Math.max(...bounds, midpoint),
  }
}

/**
 * Project how long the task will take, using real timings from this session
 * when it has enough history and the configured defaults otherwise.
 */
function buildDuration(session, selection, estimate, config) {
  let timing
  if (config.calibrateFromSession) {
    try {
      if (typeof session.snapshotEvents === 'function') {
        timing = summarizeTiming(collectTiming(session.snapshotEvents(), selection))
      }
    } catch {
      // A session log that cannot be read only costs us the calibration.
      timing = undefined
    }
  }
  return estimateDuration({
    steps: estimate.steps,
    outputTokensPerStep: config.outputTokensPerStep,
    config,
    timing,
  })
}

/** Render the card title (one line, kept inside the composer width). */
function title(locale, estimate, config) {
  const tokens = formatTokens(estimate.totalInput + estimate.totalOutput)
  const duration = estimate.duration
  const time = duration === undefined ? undefined : formatDuration(duration.totalMs, locale)
  const money = estimate.middle === undefined ? undefined : formatMoney(estimate.middle, config.currency)
  if (locale === 'en') {
    if (time !== undefined && money !== undefined) return `This task should take about ${time} and use about ${tokens} tokens (${money}). Continue?`
    if (time !== undefined) return `This task should take about ${time} and use about ${tokens} tokens. Continue?`
    if (money !== undefined) return `This task should use about ${tokens} tokens (${money}). Continue?`
    return `This task should use about ${tokens} tokens. Continue?`
  }
  if (time !== undefined && money !== undefined) return `本次任务预计约 ${time}、${tokens} tokens（${money}），继续吗？`
  if (time !== undefined) return `本次任务预计约 ${time}、${tokens} tokens，继续吗？`
  if (money !== undefined) return `本次任务预计消耗约 ${tokens} tokens（${money}），继续吗？`
  return `本次任务预计消耗约 ${tokens} tokens，继续吗？`
}

/** Render the duration section of the card body. */
function durationLines(locale, time) {
  if (locale === 'en') {
    const lines = [
      '',
      `**Estimated time: about ${formatDuration(time.totalMs, locale)}**`,
      '',
      `- Model calls: ${time.calls} × about ${formatDuration(time.perCallMs, locale)} ≈ ${formatDuration(time.modelMs, locale)} (includes the wait for the first token)`,
    ]
    if (time.toolMs > 0) {
      const measured = time.sources.tools === 'session' ? ' (measured in this session)' : ''
      lines.push(`- Tool phases: ${time.calls - 1} × about ${formatDuration(time.toolMsPerStep, locale)} ≈ ${formatDuration(time.toolMs, locale)}${measured}`)
    }
    lines.push(time.sources.speed === 'session'
      ? `- Basis: the last ${time.samples.calls} real model calls in this session (about ${Math.round(time.tokensPerSecond)} tokens/s, first token after about ${formatDuration(time.firstTokenMs, locale)})`
      : '- Basis: configured default speed (this session does not have enough history yet)')
    return lines
  }
  const lines = [
    '',
    `**预计耗时：约 ${formatDuration(time.totalMs, locale)}**`,
    '',
    `- 模型生成：${time.calls} 次调用 × 约 ${formatDuration(time.perCallMs, locale)} ≈ ${formatDuration(time.modelMs, locale)}（含首字等待）`,
  ]
  if (time.toolMs > 0) {
    const measured = time.sources.tools === 'session' ? '（本会话实测）' : ''
    lines.push(`- 工具执行：${time.calls - 1} 段 × 约 ${formatDuration(time.toolMsPerStep, locale)} ≈ ${formatDuration(time.toolMs, locale)}${measured}`)
  }
  lines.push(time.sources.speed === 'session'
    ? `- 依据：本会话最近 ${time.samples.calls} 次真实调用（约 ${Math.round(time.tokensPerSecond)} tokens/秒，首字约 ${formatDuration(time.firstTokenMs, locale)}）`
    : '- 依据：默认速度估算（本会话历史不足，可在插件设置里调整）')
  return lines
}

/** Render the card body as markdown. */
function detail(locale, estimate, config, messages, currency) {
  const lines = []
  const price = estimate.price
  const route = `${estimate.provider}/${estimate.model}`
  if (locale === 'en') {
    if (config.showMessagePreview) {
      const text = preview(messages)
      if (text.length > 0) lines.push(`> ${text}`, '')
    }
    lines.push(
      `**How this is estimated** (${route})`,
      '',
      `- Context so far: ${formatTokens(estimate.base)} tokens`,
      `- This message: +${formatTokens(estimate.added)} tokens`,
      `- First request: ${formatTokens(estimate.firstInput)} tokens`,
      `- Assuming ${estimate.steps} model calls: ${formatTokens(estimate.totalInput)} input and about ${formatTokens(estimate.totalOutput)} output tokens`,
    )
    if (estimate.duration !== undefined) lines.push(...durationLines(locale, estimate.duration))
    if (price === undefined) {
      lines.push(
        '',
        `No price is configured for \`${route}\`, so only tokens${estimate.duration === undefined ? '' : ' and time'} are shown. Add it under **Settings → Plugins → Task cost & time gate** to see money as well.`,
      )
    } else {
      lines.push(
        '',
        `**Estimated cost: ${formatMoney(estimate.middle, currency)}** (range ${formatMoney(estimate.low, currency)} – ${formatMoney(estimate.high, currency)})`,
        '',
        `- Prices per 1M tokens: input ${currency}${price.input}, cache hit ${currency}${price.cacheHit}, output ${currency}${price.output}`,
        `- Cache hits assumed for ${Math.round(config.cacheHitRatio * 100)}% of the prompt`,
        '',
        '> Cancelling leaves this message out of the conversation and costs nothing.',
      )
    }
    return lines.join('\n')
  }
  if (config.showMessagePreview) {
    const text = preview(messages)
    if (text.length > 0) lines.push(`> ${text}`, '')
  }
  lines.push(
    `**估算依据**（${route}）`,
    '',
    `- 当前上下文：${formatTokens(estimate.base)} tokens`,
    `- 本次消息：+${formatTokens(estimate.added)} tokens`,
    `- 首次请求：${formatTokens(estimate.firstInput)} tokens`,
    `- 按 ${estimate.steps} 次模型调用估算：输入 ${formatTokens(estimate.totalInput)} tokens，输出约 ${formatTokens(estimate.totalOutput)} tokens`,
  )
  if (estimate.duration !== undefined) lines.push(...durationLines(locale, estimate.duration))
  if (price === undefined) {
    lines.push(
      '',
      `这个模型（\`${route}\`）还没有配置单价，所以只给出 token${estimate.duration === undefined ? '' : ' 与耗时'}估算。在 **设置 → 插件 → 任务成本与耗时预估** 里补上价格就能显示费用。`,
    )
  } else {
    lines.push(
      '',
      `**预计花费：${formatMoney(estimate.middle, currency)}**（区间 ${formatMoney(estimate.low, currency)} ～ ${formatMoney(estimate.high, currency)}）`,
      '',
      `- 单价（每百万 tokens）：输入 ${currency}${price.input}、缓存命中 ${currency}${price.cacheHit}、输出 ${currency}${price.output}`,
      `- 缓存命中率按 ${Math.round(config.cacheHitRatio * 100)}% 估算`,
      '',
      '> 取消后这条消息不会进入对话，也不产生费用。',
    )
  }
  return lines.join('\n')
}

/** Build the blocking question for one task. */
function buildQuestion(estimate, config, messages) {
  const locale = config.language
  const labels = locale === 'en'
    ? {
        ask: 'Task cost & time',
        continue: 'Run it (Recommended)',
        cancel: 'Cancel this task',
        mute: "Don't ask again this session",
      }
    : {
        ask: '任务成本与耗时',
        continue: '继续执行（推荐）',
        cancel: '取消本次任务',
        mute: '本会话不再询问',
      }
  return {
    labels,
    question: {
      id: ASK_ID,
      header: labels.ask,
      question: title(locale, estimate, config),
      detail: detail(locale, estimate, config, messages, config.currency),
      options: [
        { label: labels.continue, description: locale === 'en' ? 'Run this task on the current model.' : '按当前模型执行这个任务。' },
        { label: labels.cancel, description: locale === 'en' ? 'Costs nothing; the message stays out of the conversation.' : '不消耗 tokens，这条消息也不会进入对话。' },
        { label: labels.mute, description: locale === 'en' ? 'Later tasks in this session run without asking.' : '这个会话之后的任务直接执行，不再询问。' },
      ],
    },
  }
}

/** Map the answer back to one of the three choices. */
function readChoice(answer, labels) {
  const selected = answer?.answers?.[0]?.selected
  const label = Array.isArray(selected) && selected.length > 0 ? String(selected[0]).trim() : ''
  if (label === labels.continue) return CHOICE_CONTINUE
  if (label === labels.mute) return CHOICE_MUTE
  // An empty selection (the card's skip button) means "do not run it".
  return CHOICE_CANCEL
}

/** Read the tokens the current context already contributes. */
function measureBase(meter, session) {
  try {
    const measurement = meter.measure(session)
    const total = measurement?.totalTokens
    return typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : 0
  } catch {
    return 0
  }
}

/** Read the tokens the claimed messages add, with a character-based fallback. */
function measureMessages(meter, messages) {
  let total = 0
  for (const message of messages) {
    let tokens
    try {
      tokens = meter.estimateMessage(message)
    } catch {
      tokens = undefined
    }
    if (typeof tokens !== 'number' || !Number.isFinite(tokens)) {
      const text = preview([message], 4000)
      tokens = Math.ceil(text.length / 3.5)
    }
    total += Math.max(0, tokens)
  }
  return total
}

/** Best-effort display name of the route; falls back to `provider/model`. */
function modelLabel(ctx, selection) {
  try {
    const listed = ctx.get('llm')?.listModels?.(selection.provider)
    if (Array.isArray(listed)) {
      const found = listed.find((info) => info?.id === selection.model)
      if (typeof found?.name === 'string' && found.name.length > 0) return found.name
    }
  } catch {
    // A missing or unhappy llm service never blocks the gate.
  }
  return undefined
}

/**
 * Decide whether this step is a new task that deserves a cost card.
 * @param ctx - plugin context, used to resolve the optional services.
 * @param payload - `agent/pre-step` payload.
 * @param muted - sessions that opted out.
 */
function gateContext(ctx, payload, muted) {
  const { agent, messages, step, modelSelection } = payload
  if (step !== 1) return undefined
  const session = agent?.session
  if (session === undefined) return undefined
  if (session.header?.origin === 'subagent') return undefined
  if (muted.has(session)) return undefined
  const claimed = Array.isArray(messages) ? messages : []
  if (!claimed.some((message) => message?.source?.kind === 'user')) return undefined
  if (modelSelection === undefined) return undefined
  const meter = ctx.get?.('tokenMeter')
  const questions = ctx.get?.('userQuestions')
  if (meter === undefined || questions === undefined) return undefined
  if (typeof meter.measure !== 'function' || typeof questions.ask !== 'function') return undefined
  return { session, claimed, meter, questions, selection: modelSelection }
}

/**
 * Install the gate.
 * @param ctx - plugin context.
 * @param rawConfig - bundle-row configuration.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return
  /** Sessions that asked not to be gated again; per plugin instance, so a restart clears it. */
  const muted = new WeakSet()

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const state = gateContext(ctx, payload, muted)
      if (state === undefined) return await next()
      const { session, claimed, meter, questions, selection } = state
      const { agent, signal } = payload
      const base = measureBase(meter, session)
      const added = measureMessages(meter, claimed)
      const headerless = typeof session.requestHeader === 'function' && session.requestHeader() === undefined
      const steps = config.assumedSteps
      const price = priceFor(config, selection.provider, selection.model)
      const estimate = buildEstimate({
        base,
        added,
        tools: headerless ? config.firstRequestToolsTokens : 0,
        steps,
        config,
        price,
        provider: selection.provider,
        model: selection.model,
      })
      if (estimate.firstInput < config.minInputTokens) return await next()
      if (config.estimateDuration) estimate.duration = buildDuration(session, selection, estimate, config)
      const label = modelLabel(ctx, selection)
      if (label !== undefined) estimate.model = label
      const { labels, question } = buildQuestion(estimate, config, claimed)
      const askSignal = askSignalFor(signal, config.askTimeoutMs)
      let answer
      try {
        answer = await questions.ask({ agent, signal: askSignal, questions: [question] })
      } catch (error) {
        // No card was shown (a headless session, a closed tab) or the turn moved
        // on: never block the task because the estimate could not be asked for.
        if (signal?.aborted !== true) {
          ctx.logger?.warn?.(`task-cost-gate: no answer (${error instanceof Error ? error.message : String(error)}); running the task`)
        }
        return await next()
      }
      const choice = readChoice(answer, labels)
      if (choice === CHOICE_CONTINUE) return await next()
      if (choice === CHOICE_MUTE) {
        muted.add(session)
        return await next()
      }
      return { kind: 'reject' }
    } catch (error) {
      ctx.logger?.warn?.(`task-cost-gate: ${error instanceof Error ? error.message : String(error)}; running the task`)
      return await next()
    }
  })
}

/**
 * Signal for the card: the turn's own signal, optionally bounded by a timeout so
 * an unattended session never waits forever for an answer nobody will give.
 */
function askSignalFor(signal, timeoutMs) {
  if (timeoutMs <= 0 || typeof AbortSignal.any !== 'function' || typeof AbortSignal.timeout !== 'function') return signal
  try {
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  } catch {
    return signal
  }
}
