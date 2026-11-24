/**
 * Wall-clock duration math for the task cost gate.
 *
 * Kept apart from `index.js` so the arithmetic can be tested with `node --test`
 * without the DSH runtime or `@deepseek-ai/schemastery`. The gate feeds this
 * module (a) the same step/output assumptions it uses for tokens, and (b)
 * timing samples read from the live session log, whenever there are enough of
 * them to be more trustworthy than the configured defaults.
 *
 * @module dsh-task-cost-gate/duration
 */

/** Only the most recent model calls describe the route's current speed. */
const MAX_CALL_SAMPLES = 30

/** Tool phases are noisier, so average the same small window. */
const MAX_TOOL_SAMPLES = 30

/** Below this many samples, a measured average is not worth trusting. */
const MIN_SPEED_SAMPLES = 3

const MIN_RATE = 5
const MAX_RATE = 2000
const MIN_FIRST_TOKEN_MS = 50
const MAX_FIRST_TOKEN_MS = 30_000
const MAX_TOOL_MS = 600_000

/** Defaults used until a session has enough history to calibrate itself. */
export const DURATION_DEFAULTS = Object.freeze({
  outputTokensPerSecond: 220,
  firstTokenMs: 1_400,
  toolMsPerStep: 5_000,
})

/**
 * Render a duration for humans.
 *
 * @param ms - duration in milliseconds.
 * @param locale - `zh` or `en`.
 */
export function formatDuration(ms, locale = 'zh') {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  if (seconds < 60) return locale === 'en' ? `${seconds}s` : `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes < 60) {
    if (locale === 'en') return restSeconds === 0 ? `${minutes}m` : `${minutes}m ${restSeconds}s`
    return restSeconds === 0 ? `${minutes} 分` : `${minutes} 分 ${restSeconds} 秒`
  }
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (locale === 'en') return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
  return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`
}

/**
 * Read the model-call and tool-phase timings out of a session event log.
 *
 * A model call spans `step/start` → `assistant/message`; the stream's first
 * `time0` marks when the first chunk arrived, so `callMs - streamMs` is the
 * wait before the first token. A tool phase spans the matching `tool/call` →
 * `tool/result` pairs of one step.
 *
 * @param events - `session.snapshotEvents()` (anything non-array is ignored).
 * @param selection - route to keep; calls from other providers/models are skipped.
 */
export function collectTiming(events, selection) {
  const list = Array.isArray(events) ? events : []
  const stepStarts = new Map()
  const calls = []
  const toolCalls = new Map()
  const toolResults = new Map()

  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const step = `${data.turn}:${data.step}`
    if (event.type === 'step/start') {
      stepStarts.set(step, event.time)
      continue
    }
    if (event.type === 'assistant/message') {
      if (data.interrupted === true) continue
      const tokens = data.usage?.outputTokens
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) continue
      const source = data.message?.source
      if (selection !== undefined) {
        if (typeof selection.provider === 'string' && source?.provider !== selection.provider) continue
        if (typeof selection.model === 'string' && source?.model !== selection.model) continue
      }
      const start = stepStarts.get(step)
      if (start === undefined) continue
      const callMs = event.time - start
      if (!Number.isFinite(callMs) || callMs <= 0) continue
      const firstChunk = firstChunkTime(data.stream)
      const streamMs = firstChunk === undefined ? undefined : event.time - firstChunk
      calls.push({ tokens, callMs, streamMs })
      continue
    }
    if (event.type === 'tool/call') {
      const callId = data.callId
      if (typeof callId !== 'string' || callId.length === 0) continue
      let byId = toolCalls.get(step)
      if (byId === undefined) {
        byId = new Map()
        toolCalls.set(step, byId)
      }
      const previous = byId.get(callId)
      byId.set(callId, previous === undefined ? event.time : Math.min(previous, event.time))
      continue
    }
    if (event.type === 'tool/result') {
      const callId = data.message?.source?.callId ?? data.callId ?? data.toolCallId
      if (typeof callId !== 'string' || callId.length === 0) continue
      let byId = toolResults.get(step)
      if (byId === undefined) {
        byId = new Map()
        toolResults.set(step, byId)
      }
      const previous = byId.get(callId)
      byId.set(callId, previous === undefined ? event.time : Math.max(previous, event.time))
    }
  }

  const toolPhases = []
  for (const [step, callsById] of toolCalls) {
    const resultsById = toolResults.get(step)
    if (resultsById === undefined) continue
    let start = Infinity
    let end = -Infinity
    let matched = 0
    for (const [callId, callTime] of callsById) {
      const resultTime = resultsById.get(callId)
      if (resultTime === undefined) continue
      matched += 1
      if (callTime < start) start = callTime
      if (resultTime > end) end = resultTime
    }
    if (matched > 0 && end >= start) toolPhases.push(end - start)
  }

  return {
    calls: calls.slice(-MAX_CALL_SAMPLES),
    toolPhases: toolPhases.slice(-MAX_TOOL_SAMPLES),
  }
}

/** Timestamp of the first chunk in one assistant stream, if it was recorded. */
function firstChunkTime(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record !== null && typeof record === 'object' && typeof record.time0 === 'number' && Number.isFinite(record.time0)) {
      return record.time0
    }
  }
  return undefined
}

/**
 * Turn raw samples into speeds, or leave a field undefined when the session is
 * too young to measure it (the caller then falls back to configuration).
 */
export function summarizeTiming(samples) {
  const calls = Array.isArray(samples?.calls) ? samples.calls : []
  const toolPhases = Array.isArray(samples?.toolPhases) ? samples.toolPhases : []
  const streamed = calls.filter(
    (call) =>
      Number.isFinite(call?.tokens) &&
      call.tokens >= 10 &&
      Number.isFinite(call?.streamMs) &&
      call.streamMs >= 50 &&
      Number.isFinite(call?.callMs) &&
      call.callMs >= call.streamMs,
  )

  let tokensPerSecond
  let firstTokenMs
  if (streamed.length >= MIN_SPEED_SAMPLES) {
    const tokens = streamed.reduce((sum, call) => sum + call.tokens, 0)
    const streamMs = streamed.reduce((sum, call) => sum + call.streamMs, 0)
    const rate = tokens / (streamMs / 1000)
    if (Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE) tokensPerSecond = rate
    const gaps = streamed.map((call) => call.callMs - call.streamMs).sort((left, right) => left - right)
    const gap = median(gaps)
    if (gap >= MIN_FIRST_TOKEN_MS && gap <= MAX_FIRST_TOKEN_MS) firstTokenMs = gap
  }

  let toolMsPerStep
  const usableTools = toolPhases.filter((ms) => Number.isFinite(ms) && ms >= 0)
  if (usableTools.length >= MIN_SPEED_SAMPLES) {
    const mean = usableTools.reduce((sum, ms) => sum + ms, 0) / usableTools.length
    if (mean <= MAX_TOOL_MS) toolMsPerStep = mean
  }

  return {
    tokensPerSecond,
    firstTokenMs,
    toolMsPerStep,
    callSamples: streamed.length,
    toolSamples: usableTools.length,
  }
}

/** Middle value of a non-empty sorted array. */
function median(sorted) {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Project the wall-clock time of one task.
 *
 * Each of the assumed model calls pays the first-token wait plus its output at
 * the current speed; `steps - 1` tool phases sit between those calls.
 *
 * @param options - steps/output assumptions, normalized config, and measured timing.
 */
export function estimateDuration({ steps, outputTokensPerStep, config = {}, timing }) {
  const calls = Math.max(1, Math.round(Number(steps) || 1))
  const output = Math.max(0, Math.round(Number(outputTokensPerStep) || 0))
  const measuredSpeed = Number.isFinite(timing?.tokensPerSecond) && timing.tokensPerSecond > 0
  const measuredFirst = Number.isFinite(timing?.firstTokenMs) && timing.firstTokenMs >= 0
  const measuredTools = Number.isFinite(timing?.toolMsPerStep) && timing.toolMsPerStep >= 0
  const tokensPerSecond = measuredSpeed ? timing.tokensPerSecond : Math.max(1, Number(config.outputTokensPerSecond) || 1)
  const firstTokenMs = measuredFirst ? timing.firstTokenMs : Math.max(0, Number(config.firstTokenMs) || 0)
  const toolMsPerStep = measuredTools ? timing.toolMsPerStep : Math.max(0, Number(config.toolMsPerStep) || 0)
  const perCallMs = firstTokenMs + (output / tokensPerSecond) * 1000
  const modelMs = perCallMs * calls
  const toolMs = Math.max(0, calls - 1) * toolMsPerStep
  return {
    totalMs: modelMs + toolMs,
    modelMs,
    toolMs,
    perCallMs,
    calls,
    outputTokensPerStep: output,
    tokensPerSecond,
    firstTokenMs,
    toolMsPerStep,
    samples: { calls: timing?.callSamples ?? 0, tools: timing?.toolSamples ?? 0 },
    sources: {
      speed: measuredSpeed ? 'session' : 'default',
      tools: measuredTools ? 'session' : 'default',
    },
  }
}
