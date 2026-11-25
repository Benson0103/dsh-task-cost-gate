import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cacheShare,
  collectCacheCalls,
  projectCost,
  summarizeCache,
} from '../cache.js'

const route = { provider: 'deepseek-official', model: 'deepseek-flash' }

function message({ turn, step, input, cached, provider = route.provider, model = route.model, usage = true }) {
  const event = {
    type: 'assistant/message',
    seq: 0,
    time: 0,
    data: {
      turn,
      step,
      message: { role: 'assistant', source: { kind: 'model', provider, model } },
      stream: [],
    },
  }
  if (usage) event.data.usage = { inputTokens: input, cacheReadTokens: cached, outputTokens: 10 }
  return event
}

/** One manual sample for `summarizeCache`. */
function sample(sessionId, firstInSession, turnIndex, share) {
  const prompt = 1000
  return { sessionId, firstInSession, turnIndex, prompt, cached: prompt * share, share }
}

test('cacheShare divides by the whole prompt, not by the uncached part', () => {
  assert.equal(cacheShare({ inputTokens: 52918, cacheReadTokens: 0 }), 0)
  assert.ok(Math.abs(cacheShare({ inputTokens: 2872, cacheReadTokens: 53248 }) - 53248 / 56120) < 1e-12)
  assert.equal(cacheShare({}), 0)
  assert.equal(cacheShare({ inputTokens: 0, cacheReadTokens: 0 }), 0)
  assert.ok(cacheShare({ inputTokens: 1, cacheReadTokens: 999 }) <= 1)
})

test('collectCacheCalls keeps the route, marks the first call and counts calls inside a turn', () => {
  const calls = collectCacheCalls([
    message({ turn: 1, step: 1, input: 100, cached: 900 }),
    message({ turn: 1, step: 2, input: 0, cached: 1000 }),
    message({ turn: 2, step: 1, input: 200, cached: 800 }),
    message({ turn: 1, step: 1, input: 100, cached: 900, provider: 'other', model: 'other' }),
    message({ turn: 3, step: 1, input: 100, cached: 900, usage: false }),
  ], route, 'session-a')

  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map((call) => call.turnIndex), [0, 1, 0])
  assert.deepEqual(calls.map((call) => call.firstInSession), [true, false, false])
  assert.deepEqual(calls.map((call) => call.turn), [1, 1, 2])
  assert.equal(calls[0].prompt, 1000)
  assert.equal(calls[0].share, 0.9)
  assert.equal(calls[1].share, 1)
})

test('summarizeCache refuses a corpus that is too small or too narrow', () => {
  const twoSessions = [
    sample('a', true, 0, 0.2), sample('a', false, 1, 0.99),
    sample('b', true, 0, 0.4), sample('b', false, 1, 0.99),
  ]
  assert.equal(summarizeCache(twoSessions, { steps: 2, freshSession: true }), undefined)

  const shortLaters = [
    sample('a', true, 0, 0.2), sample('a', false, 1, 0.99),
    sample('b', true, 0, 0.4), sample('b', false, 1, 0.99),
    sample('c', true, 0, 0.6), sample('c', false, 1, 0.99),
  ]
  assert.equal(summarizeCache(shortLaters, { steps: 2, freshSession: true }), undefined)
  assert.equal(summarizeCache([], { steps: 2 }), undefined)
})

test('summarizeCache builds a fresh-conversation profile from first calls', () => {
  const calls = []
  for (const [sessionId, firstShare] of [['a', 0.2], ['b', 0.4], ['c', 0.6]]) {
    calls.push(sample(sessionId, true, 0, firstShare))
    for (let index = 1; index <= 3; index += 1) calls.push(sample(sessionId, false, index, 0.99))
  }
  const profile = summarizeCache(calls, { steps: 4, freshSession: true })

  assert.ok(profile !== undefined)
  assert.equal(profile.freshSession, true)
  assert.equal(profile.samples.calls, 12)
  assert.equal(profile.samples.sessions, 3)
  assert.equal(profile.samples.first, 3)
  assert.equal(profile.samples.later, 9)
  assert.equal(profile.first.middle, 0.4)
  assert.equal(profile.later.middle, 0.99)
  assert.equal(profile.shares.middle[0], 0.4)
  assert.equal(profile.shares.middle[1], 0.99)
  assert.ok(profile.shares.low[0] <= profile.shares.middle[0])
  assert.ok(profile.shares.high[0] >= profile.shares.middle[0])
})

test('summarizeCache uses continuation starts for an existing conversation', () => {
  const calls = []
  for (const [sessionId, firstShare] of [['a', 0.95], ['b', 0.96], ['c', 0.97]]) {
    calls.push(sample(sessionId, true, 0, 0.1))
    for (let index = 1; index <= 3; index += 1) calls.push(sample(sessionId, false, index, 0.99))
    calls.push(sample(sessionId, false, 0, firstShare))
  }
  const profile = summarizeCache(calls, { steps: 3, freshSession: false })

  assert.ok(profile !== undefined)
  assert.equal(profile.freshSession, false)
  assert.equal(profile.first.middle, 0.96)
  assert.equal(profile.shares.middle[0], 0.96)
  assert.equal(profile.shares.middle[1], 0.99)
})

test('projectCost prices each call from its own cache share', () => {
  const projected = projectCost({
    firstInput: 1000,
    growthTokensPerStep: 1000,
    steps: 2,
    outputTokensPerStep: 100,
    price: { input: 2, cacheHit: 0.5, output: 8 },
    shares: [0, 1],
  })

  assert.equal(projected.totalInput, 3000)
  assert.equal(projected.totalOutput, 200)
  assert.equal(projected.cachedTokens, 2000)
  assert.equal(projected.uncachedTokens, 1000)
  assert.ok(Math.abs(projected.cost - 0.0046) < 1e-12)
})

test('projectCost still reports tokens when no price is known', () => {
  const projected = projectCost({
    firstInput: 1000,
    growthTokensPerStep: 1000,
    steps: 2,
    outputTokensPerStep: 100,
    price: undefined,
    shares: [1, 1],
  })

  assert.equal(projected.cost, undefined)
  assert.equal(projected.totalInput, 3000)
  assert.equal(projected.cachedTokens, 3000)
  assert.equal(projected.uncachedTokens, 0)
})
