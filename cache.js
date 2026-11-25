/**
 * Cross-session prompt-cache calibration for the task cost gate.
 *
 * DSH records the provider's usage on every `assistant/message`: `inputTokens`
 * is the part that was *not* served from the provider prompt cache, and
 * `cacheReadTokens` is the part that was. The gate can therefore replace its
 * "0% to 100% cache hit" cost bounds with the hit rate actually observed in
 * other conversations of the same route.
 *
 * The module is deliberately pure: it turns event logs into call samples, then
 * turns samples into a low / middle / high cache-share profile. `index.js` owns
 * the service lookup and the card rendering.
 *
 * @module dsh-task-cost-gate/cache
 */

/** Ignore a profile that comes from fewer conversations than this. */
const MIN_SESSIONS = 3

/** Ignore a profile with fewer usable calls than this. */
const MIN_CALLS = 12

/** A per-step bucket needs this many samples before it is used instead of "all later calls". */
const MIN_STEP_SAMPLES = 6

/** A fresh conversation also needs enough first calls; one per sampled session is enough. */
const MIN_FIRST_SAMPLES = 3

/** Keep the sample bounded when the corpus contains very long conversations. */
const MAX_SAMPLES = 400

/** Keep the first calls of the sampled conversations when the corpus is trimmed. */
const KEEP_STARTS = 80

const LOW_QUANTILE = 0.1
const MID_QUANTILE = 0.5
const HIGH_QUANTILE = 0.9

/** Read a finite, non-negative number. */
function number(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** Cache share of one request: cached / (cached + uncached). */
export function cacheShare(usage) {
  const uncached = number(usage?.inputTokens)
  const cached = number(usage?.cacheReadTokens)
  const prompt = uncached + cached
  return prompt > 0 ? cached / prompt : 0
}

/**
 * Read the cache-relevant calls of one session log.
 *
 * Only calls of the selected route are kept. `turnIndex` is the zero-based
 * position of the call inside its turn, and `firstInSession` marks the very
 * first call of the conversation. Both matter: a fresh conversation starts
 * with no session prefix to cache, while a new turn of an existing conversation
 * starts with a large cached prefix.
 *
 * @param events - session event log (anything non-array is ignored).
 * @param selection - route to keep.
 * @param sessionId - optional identity stored on each sample.
 */
export function collectCacheCalls(events, selection, sessionId = '') {
  const list = Array.isArray(events) ? events : []
  const turns = new Map()
  const calls = []
  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'assistant/message') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const message = data.message
    const source = message?.source
    const usage = data.usage
    if (usage === null || typeof usage !== 'object' || source === null || typeof source !== 'object') continue
    if (source.provider !== selection?.provider || source.model !== selection?.model) continue
    const prompt = number(usage.inputTokens) + number(usage.cacheReadTokens)
    if (prompt <= 0) continue
    const turn = Number.isFinite(data.turn) ? data.turn : 0
    const index = turns.get(turn) ?? 0
    turns.set(turn, index + 1)
    const cached = number(usage.cacheReadTokens)
    calls.push({
      sessionId,
      turn,
      step: Number.isFinite(data.step) ? data.step : 0,
      turnIndex: index,
      firstInSession: calls.length === 0,
      prompt,
      cached,
      share: cached / prompt,
    })
  }
  return calls
}

/** Linear-interpolated quantile of a numeric array. */
function quantile(values, q) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/** Clamp a share into 0..1. */
function share(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/** Keep the first calls of the sampled conversations when the corpus is trimmed. */
function trimSamples(calls, maxCalls = MAX_SAMPLES) {
  const limit = Math.max(MIN_CALLS, Math.round(Number(maxCalls) || MAX_SAMPLES))
  const list = calls.filter((call) => call !== null && typeof call === 'object' && Number.isFinite(call.share))
  if (list.length <= limit) return list
  // The first call of a conversation and the first call of a later turn are the
  // two priors the projection needs; keep them before trimming the steady state.
  const firsts = list.filter((call) => call.firstInSession === true)
  const continues = list.filter((call) => call.firstInSession !== true && call.turnIndex === 0)
  const rest = list.filter((call) => call.firstInSession !== true && call.turnIndex !== 0)
  const keepFirsts = Math.min(firsts.length, KEEP_STARTS, limit)
  const keepContinues = Math.min(continues.length, Math.max(0, Math.min(40, limit - keepFirsts)))
  const keepRest = Math.max(0, limit - keepFirsts - keepContinues)
  return [...firsts.slice(0, keepFirsts), ...continues.slice(0, keepContinues), ...rest.slice(-keepRest)]
}

/** Average cache share weighted by prompt size; this is the share that matters for money. */
function weightedShare(calls) {
  const prompt = calls.reduce((sum, call) => sum + call.prompt, 0)
  if (prompt <= 0) return 0
  return calls.reduce((sum, call) => sum + call.cached, 0) / prompt
}

/**
 * Summarize observed calls into the per-call cache-share profile the cost
 * projection needs.
 *
 * The first call is sampled from the same situation as the conversation that is
 * about to start: `firstInSession` calls for a fresh session, or
 * `turnIndex === 0 && !firstInSession` calls for a continuation. Later calls
 * use the same turn position when there are enough samples, and all later calls
 * otherwise.
 *
 * @param calls - samples from `collectCacheCalls`.
 * @param options.steps - model calls the task is assumed to need.
 * @param options.freshSession - whether the current session has never issued a request.
 */
export function summarizeCache(calls, options = {}) {
  const samples = trimSamples(Array.isArray(calls) ? calls : [], options.maxCalls)
  const sessions = new Set(samples.map((call) => call.sessionId).filter((id) => typeof id === 'string' && id.length > 0))
  if (samples.length < MIN_CALLS || sessions.size < MIN_SESSIONS) return undefined

  const steps = Math.max(1, Math.round(Number(options.steps) || 4))
  const freshSession = options.freshSession === true
  const firstPool = freshSession
    ? samples.filter((call) => call.firstInSession)
    : samples.filter((call) => call.turnIndex === 0 && !call.firstInSession)
  const laterPool = samples.filter((call) => call.turnIndex > 0)
  if (firstPool.length < MIN_FIRST_SAMPLES || laterPool.length < MIN_STEP_SAMPLES) return undefined

  const low = []
  const middle = []
  const high = []
  const firstShares = firstPool.map((call) => call.share)
  const laterShares = laterPool.map((call) => call.share)
  for (let index = 0; index < steps; index += 1) {
    const pool = index === 0
      ? firstShares
      : (() => {
          const exact = laterPool.filter((call) => call.turnIndex === index)
          return exact.length >= MIN_STEP_SAMPLES ? exact.map((call) => call.share) : laterShares
        })()
    const lower = quantile(pool, LOW_QUANTILE)
    const median = quantile(pool, MID_QUANTILE)
    const upper = quantile(pool, HIGH_QUANTILE)
    low.push(share(Math.min(lower, median)))
    middle.push(share(median))
    high.push(share(Math.max(upper, median)))
  }

  return {
    steps,
    freshSession,
    shares: { low, middle, high },
    samples: {
      calls: samples.length,
      sessions: sessions.size,
      first: firstPool.length,
      later: laterPool.length,
    },
    first: {
      low: share(quantile(firstShares, LOW_QUANTILE)),
      middle: share(quantile(firstShares, MID_QUANTILE)),
      high: share(quantile(firstShares, HIGH_QUANTILE)),
    },
    later: {
      low: share(quantile(laterShares, LOW_QUANTILE)),
      middle: share(quantile(laterShares, MID_QUANTILE)),
      high: share(quantile(laterShares, HIGH_QUANTILE)),
    },
    observed: {
      first: weightedShare(firstPool),
      later: weightedShare(laterPool),
      overall: weightedShare(samples),
    },
  }
}

/**
 * Project prompt tokens and money for one cache-share profile.
 *
 * Prompt `i` (zero-based) is `firstInput + i * growth`: the first request plus
 * the context growth assumed for each later call. Cached tokens are that prompt
 * times the profile's share for that call.
 *
 * @param input.firstInput - prompt tokens of the first model call.
 * @param input.growthTokensPerStep - prompt growth per later call.
 * @param input.steps - number of model calls.
 * @param input.outputTokensPerStep - completion tokens per call.
 * @param input.price - per-million prices, or undefined when unknown.
 * @param input.shares - one cache share per call (0..1).
 */
export function projectCost(input) {
  const steps = Math.max(1, Math.round(Number(input.steps) || 1))
  const firstInput = Math.max(0, Number(input.firstInput) || 0)
  const growth = Math.max(0, Number(input.growthTokensPerStep) || 0)
  const output = Math.max(0, Number(input.outputTokensPerStep) || 0)
  const shares = Array.isArray(input.shares) ? input.shares : []
  let totalInput = 0
  let cachedTokens = 0
  for (let index = 0; index < steps; index += 1) {
    const prompt = firstInput + index * growth
    totalInput += prompt
    cachedTokens += prompt * share(shares[index] ?? shares.at(-1))
  }
  const outputTokens = steps * output
  const price = input.price
  const cost = price === undefined
    ? undefined
    : ((totalInput - cachedTokens) * price.input + cachedTokens * price.cacheHit + outputTokens * price.output) / 1_000_000
  return {
    totalInput,
    totalOutput: outputTokens,
    cachedTokens,
    uncachedTokens: Math.max(0, totalInput - cachedTokens),
    cost,
  }
}
