import { expect, mock, test } from 'claude-code/testing'

import { fmtClock, fmtTokens, inputPrice, nextMessageCost, ttlFromTranscript } from '../hooks/register'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

test('detects the cache TTL from the transcript', async () => {
  const row = (cc: object, extra: object = {}) =>
    JSON.stringify({ type: 'assistant', ...extra, message: { usage: { cache_creation: cc } } })
  const oneHour = [row({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 })].join('\n')
  const fiveMin = [row({ ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 0 })].join('\n')
  const sidechainLast = [oneHour, row({ ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 }, { isSidechain: true })].join('\n')
  expect(ttlFromTranscript(oneHour)).toBe(60)
  expect(ttlFromTranscript(fiveMin)).toBe(5)
  expect(ttlFromTranscript(sidechainLast)).toBe(60)
  expect(ttlFromTranscript('{"type":"user"}')).toBe(undefined)
})

test('prices the next message warm and cold', async () => {
  expect(inputPrice('claude-sonnet-4-5').usd).toBe(3)
  expect(inputPrice('claude-opus-4-1').usd).toBe(15)
  const oneHour = nextMessageCost(100_000, 3, 60)
  expect(Math.round(oneHour.cold * 1000)).toBe(600)
  expect(Math.round(oneHour.warm * 1000)).toBe(30)
  expect(Math.round(nextMessageCost(100_000, 3, 5).cold * 1000)).toBe(375)
  expect(fmtTokens(84_200)).toBe('84.2k')
  expect(fmtClock(61_000)).toBe('1:01')
})

test('the strip draws with its Handoff & Clear button on terminal and desktop', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cache-keeper', surface, ...BAND })
    expect(await ui.find({ key: 'handoff' })).toBeDefined()
    expect(await ui.find({ text: /no requests yet/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/cache-window sets a manual window the strip shows', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const r = await $.command.run({
    command: 'cache-window',
    args: '5',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(r.text).toMatch(/5 min/)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /5m manual/ })).toBeDefined()
  await ui.unmount()
})
