import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectTiming,
  estimateDuration,
  formatDuration,
  summarizeTiming,
} from '../duration.js'

test('formatDuration renders seconds, minutes and hours', () => {
  assert.equal(formatDuration(0), '0 秒')
  assert.equal(formatDuration(42_000), '42 秒')
  assert.equal(formatDuration(60_000), '1 分')
  assert.equal(formatDuration(80_000), '1 分 20 秒')
  assert.equal(formatDuration(3_599_000), '59 分 59 秒')
  assert.equal(formatDuration(3_600_000), '1 小时')
  assert.equal(formatDuration(3_900_000), '1 小时 5 分')
})

test('formatDuration renders English units', () => {
  assert.equal(formatDuration(42_000, 'en'), '42s')
  assert.equal(formatDuration(80_000, 'en'), '1m 20s')
  assert.equal(formatDuration(3_900_000, 'en'), '1h 5m')
})

test('collectTiming reads model calls and tool phases, filtered by route', () => {
  const events = [
    { type: 'step/start', time: 1_000, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      time: 3_000,
      data: {
        turn: 1,
        step: 1,
        usage: { outputTokens: 100 },
        message: { source: { provider: 'p', model: 'm' } },
        stream: [{ type: 'text-chunks', time0: 1_500 }],
      },
    },
    { type: 'tool/call', time: 3_000, data: { turn: 1, step: 1, callId: 'call-a', name: 'pwsh' } },
    { type: 'tool/result', time: 4_500, data: { turn: 1, step: 1, message: { source: { callId: 'call-a' } } } },
    { type: 'step/start', time: 5_000, data: { turn: 1, step: 2 } },
    {
      type: 'assistant/message',
      time: 6_000,
      data: {
        turn: 1,
        step: 2,
        usage: { outputTokens: 50 },
        message: { source: { provider: 'other', model: 'm' } },
        stream: [{ type: 'text-chunks', time0: 5_500 }],
      },
    },
  ]

  const timing = collectTiming(events, { provider: 'p', model: 'm' })
  assert.equal(timing.calls.length, 1)
  assert.deepEqual(timing.calls[0], { tokens: 100, callMs: 2_000, streamMs: 1_500 })
  assert.deepEqual(timing.toolPhases, [1_500])
})

test('collectTiming ignores an unmatched tool result', () => {
  const events = [
    { type: 'tool/call', time: 1_000, data: { turn: 1, step: 1, callId: 'call-a' } },
    { type: 'tool/result', time: 2_000, data: { turn: 1, step: 1, message: { source: { callId: 'call-b' } } } },
  ]
  assert.deepEqual(collectTiming(events, undefined).toolPhases, [])
})

test('summarizeTiming derives speed, first-token wait and tool average', () => {
  const timing = summarizeTiming({
    calls: [
      { tokens: 100, callMs: 2_000, streamMs: 1_500 },
      { tokens: 200, callMs: 3_500, streamMs: 2_500 },
      { tokens: 300, callMs: 5_500, streamMs: 3_500 },
    ],
    toolPhases: [1_000, 3_000, 2_000],
  })
  assert.equal(timing.tokensPerSecond, 80)
  assert.equal(timing.firstTokenMs, 1_000)
  assert.equal(timing.toolMsPerStep, 2_000)
  assert.equal(timing.callSamples, 3)
  assert.equal(timing.toolSamples, 3)
})

test('summarizeTiming leaves fields unmeasured until there are enough samples', () => {
  const timing = summarizeTiming({
    calls: [{ tokens: 100, callMs: 2_000, streamMs: 1_500 }],
    toolPhases: [1_000],
  })
  assert.equal(timing.tokensPerSecond, undefined)
  assert.equal(timing.firstTokenMs, undefined)
  assert.equal(timing.toolMsPerStep, undefined)
})

test('estimateDuration uses configured defaults without session timing', () => {
  const duration = estimateDuration({
    steps: 3,
    outputTokensPerStep: 300,
    config: { outputTokensPerSecond: 100, firstTokenMs: 1_000, toolMsPerStep: 2_000 },
    timing: undefined,
  })
  assert.equal(duration.perCallMs, 4_000)
  assert.equal(duration.modelMs, 12_000)
  assert.equal(duration.toolMs, 4_000)
  assert.equal(duration.totalMs, 16_000)
  assert.deepEqual(duration.sources, { speed: 'default', tools: 'default' })
})

test('estimateDuration prefers measured timing over the configured defaults', () => {
  const duration = estimateDuration({
    steps: 3,
    outputTokensPerStep: 300,
    config: { outputTokensPerSecond: 100, firstTokenMs: 1_000, toolMsPerStep: 2_000 },
    timing: { tokensPerSecond: 200, firstTokenMs: 500, toolMsPerStep: 1_000, callSamples: 5, toolSamples: 4 },
  })
  assert.equal(duration.perCallMs, 2_000)
  assert.equal(duration.modelMs, 6_000)
  assert.equal(duration.toolMs, 2_000)
  assert.equal(duration.totalMs, 8_000)
  assert.deepEqual(duration.sources, { speed: 'session', tools: 'session' })
  assert.deepEqual(duration.samples, { calls: 5, tools: 4 })
})

test('estimateDuration has no tool phase for a single model call', () => {
  const duration = estimateDuration({
    steps: 1,
    outputTokensPerStep: 100,
    config: { outputTokensPerSecond: 100, firstTokenMs: 1_000, toolMsPerStep: 9_000 },
  })
  assert.equal(duration.toolMs, 0)
  assert.equal(duration.totalMs, 2_000)
})
