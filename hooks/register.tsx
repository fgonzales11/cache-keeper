import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Anchor, Handoff, Limit, Meter, Ttl } from '../types'

// ---------------------------------------------------------------- state

const anchorA = atom({ plugin: 'cache-keeper', key: 'anchor' } as const, null as Anchor | null)
const ttlA = atom({ plugin: 'cache-keeper', key: 'ttl' } as const, { minutes: 60, source: 'default' } as Ttl)
const nowA = atom({ plugin: 'cache-keeper', key: 'now' } as const, 0)
const meterA = atom({ plugin: 'cache-keeper', key: 'meter' } as const, {} as Meter)
const handoffA = atom({ plugin: 'cache-keeper', key: 'handoff' } as const, { phase: 'idle' } as Handoff)
const notifiedA = atom({ plugin: 'cache-keeper', key: 'notifiedFor' } as const, 0)
const coldToastA = atom({ plugin: 'cache-keeper', key: 'coldToastFor' } as const, 0)

const OVERRIDE_KEY = 'windowOverrideMinutes'
const LAST_BRIEF_KEY = 'lastHandoffBrief'

// ---------------------------------------------------------------- pricing

/** List price of uncached input, $ per million tokens, by model id. */
export function inputPrice(model: string): { usd: number; isKnown: boolean } {
  const m = model.toLowerCase()
  if (/claude-3-opus|opus-4-0|opus-4-1|opus-4-2025|opus-4$/.test(m)) return { usd: 15, isKnown: true }
  if (/opus-4-[5-9]|opus-[5-9]/.test(m)) return { usd: 5, isKnown: true }
  if (m.includes('opus')) return { usd: 5, isKnown: false }
  if (m.includes('sonnet')) return { usd: 3, isKnown: true }
  if (/haiku-4|haiku-[5-9]/.test(m)) return { usd: 1, isKnown: true }
  if (/3-5-haiku|haiku-3-5/.test(m)) return { usd: 0.8, isKnown: true }
  if (/3-haiku|haiku-3/.test(m)) return { usd: 0.25, isKnown: true }
  if (m.includes('haiku')) return { usd: 1, isKnown: false }
  return { usd: 3, isKnown: false }
}

/** What re-sending `tokens` costs: written to a cold cache, or read from a warm one. */
export function nextMessageCost(tokens: number, perMTok: number, ttlMinutes: number) {
  const base = (tokens / 1_000_000) * perMTok
  const writeMultiplier = ttlMinutes > 5 ? 2 : 1.25
  return { cold: base * writeMultiplier, warm: base * 0.1 }
}

// ---------------------------------------------------------------- formatting

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

export function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (x: number) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

function fmtIn(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000))
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}h${String(min % 60).padStart(2, '0')}m`
  return `${Math.round(h / 24)}d`
}

// ---------------------------------------------------------------- TTL detection

/**
 * Reads the transcript's most recent main-thread assistant usage that wrote to
 * the cache and says which TTL the write used: 60 for ephemeral_1h, 5 for 5m.
 */
export function ttlFromTranscript(jsonl: string): number | undefined {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 400; i--) {
    const line = lines[i]
    if (!line || !line.includes('cache_creation')) continue
    seen++
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.type !== 'assistant' || row?.isSidechain) continue
    const cc = row?.message?.usage?.cache_creation
    if (!cc) continue
    if ((cc.ephemeral_1h_input_tokens ?? 0) > 0) return 60
    if ((cc.ephemeral_5m_input_tokens ?? 0) > 0) return 5
  }
  return undefined
}

async function readTail($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const r = await $.process.run(['tail', '-c', '1500000', path], { timeoutMs: 5000 })
    if (r.exitCode === 0) return r.stdout
  } catch {}
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

function limitOf(list: readonly SessionRateLimit[], kind: string): Limit | undefined {
  const l = list.find(x => x.kind === kind)
  return l ? { percentUsed: l.percentUsed, resetsAt: l.resetsAt } : undefined
}

// ---------------------------------------------------------------- handoff

const BRIEF_PROMPT = `Write a handoff brief so a brand-new session with no memory of this conversation can pick up exactly where we are. Use these headings, terse bullets, under 450 words total:

## Goal
## Current state (what is done, what is in progress)
## Key files, paths, commands
## Decisions and constraints (and why)
## Open issues / gotchas
## Next steps (ordered)

Be concrete: real file paths, function names, commands, error messages. Output only the brief, no preamble.`

const BRIEF_HEADER = 'Continuing from a previous session. Handoff brief:\n\n'

// Set by register from the plugin's options; read by the helpers below.
let cfg = { defaultWindow: 60, warnMinutes: 5, priceOverride: 0 }
let stopTick: (() => void) | undefined
let clearWaiter: (() => void) | undefined

async function resolveTtl($: EngineInterface, detected?: { minutes: number; source: 'detected' | 'inferred' }) {
  const override = Number(await $.store.get(OVERRIDE_KEY))
  if (override > 0) return update($, ttlA, (): Ttl => ({ minutes: override, source: 'manual' }))
  if (detected) return update($, ttlA, () => detected)
  return update($, ttlA, (t): Ttl => (t.source === 'detected' || t.source === 'inferred' ? t : { minutes: cfg.defaultWindow, source: 'default' }))
}

async function refreshMeter($: EngineInterface) {
  try {
    const u = await $.session.usage()
    await update($, meterA, () => ({
      contextTokens: u.context.tokens,
      contextWindow: u.context.window,
      contextPercent: u.context.percent,
      fiveHour: limitOf(u.rateLimits, 'five_hour'),
      weekly: limitOf(u.rateLimits, 'seven_day'),
      costUsd: u.cost?.usd,
    }))
  } catch {}
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  await update($, nowA, () => now)
  const anchor = await read($, anchorA)
  if (!anchor) return
  const ttl = await read($, ttlA)
  const windowMs = ttl.minutes * 60_000
  const left = anchor.at + windowMs - now
  const leadMs = Math.min(cfg.warnMinutes * 60_000, windowMs / 2)

  if (left > 0 && left <= leadMs && (await read($, notifiedA)) !== anchor.at) {
    await update($, notifiedA, () => anchor.at)
    const price = cfg.priceOverride > 0 ? cfg.priceOverride : inputPrice(anchor.model).usd
    const cost = nextMessageCost(anchor.contextTokens, price, ttl.minutes)
    const text = `Prompt cache goes cold in ${Math.ceil(left / 60000)} min. Send a message to keep it warm, or the next one re-caches ${fmtTokens(anchor.contextTokens)} tokens (~${fmtUsd(cost.cold)}).`
    $.ui.toast(text, { timeoutMs: 15000 })
    try {
      await $.ui.notify(text, { title: 'Cache Keeper' })
    } catch {}
  }
  if (left <= 0 && (await read($, coldToastA)) !== anchor.at) {
    await update($, coldToastA, () => anchor.at)
    $.ui.toast('Prompt cache is now cold.', { timeoutMs: 8000 })
  }
}

async function handoffAndClear($: EngineInterface) {
  const h = await read($, handoffA)
  if (h.phase !== 'idle' && h.phase !== 'error') return
  await update($, handoffA, (): Handoff => ({ phase: 'writing' }))
  try {
    const r = await $.model.fork({ prompt: BRIEF_PROMPT })
    if (!r.isAnswered) {
      const why = r.reason === 'nothing-to-fork' ? 'nothing to hand off yet' : `could not write the brief (${r.reason})`
      await update($, handoffA, (): Handoff => ({ phase: 'error', message: why }))
      $.ui.toast(`Handoff: ${why}. Session left as is.`)
      return
    }
    const brief = BRIEF_HEADER + r.text.trim()
    await $.store.set(LAST_BRIEF_KEY, brief)

    await update($, handoffA, (): Handoff => ({ phase: 'clearing' }))
    const cleared = new Promise<void>(resolve => {
      clearWaiter = resolve
    })
    const ran = $.command.run({ command: 'clear' }).then(
      () => undefined,
      () => undefined,
    )
    await Promise.race([cleared, ran.then(() => $.clock.sleep(500)), $.clock.sleep(20_000)])
    clearWaiter = undefined

    await update($, handoffA, (): Handoff => ({ phase: 'pasting' }))
    let filled = false
    for (let i = 0; i < 12 && !filled; i++) {
      filled = (await $.prompt.fill({ text: brief })).isFilled
      if (!filled) await $.clock.sleep(250)
    }
    await update($, handoffA, (): Handoff => ({ phase: 'idle' }))
    $.ui.toast(
      filled
        ? 'Fresh session: the handoff brief is in the prompt box. Review it and press Enter.'
        : 'Cleared, but the prompt box would not take the brief. Run /handoff-restore to paste it.',
      { timeoutMs: 8000 },
    )
  } catch (err) {
    clearWaiter = undefined
    await update($, handoffA, (): Handoff => ({ phase: 'error', message: String((err as Error)?.message ?? err).slice(0, 120) }))
    $.ui.toast('Handoff & Clear failed; see the band for why.')
  }
}


export const register: Register = (on, options) => {
  cfg = {
    defaultWindow: Math.max(1, Number(options.defaultWindowMinutes ?? 60)),
    warnMinutes: Math.max(0, Number(options.warnMinutes ?? 5)),
    priceOverride: Number(options.inputPricePerMTok ?? 0),
  }
  const defaultWindow = cfg.defaultWindow
  const warnMinutes = cfg.warnMinutes
  const priceOverride = cfg.priceOverride

  // ------------------------------------------------------------ lifecycle

  on('session.start', async ($, e, next) => {
    await resolveTtl($)
    await refreshMeter($)
    await update($, handoffA, (h): Handoff => (h.phase === 'error' ? h : { phase: 'idle' }))
    await $.command.register({
      name: 'cache-window',
      description: 'Cache Keeper: set the prompt-cache window in minutes, or "auto" to detect it',
      argumentHint: '<minutes|auto>',
    })
    await $.command.register({
      name: 'handoff',
      description: 'Cache Keeper: write a handoff brief, /clear, and paste the brief into the fresh session',
    })
    await $.command.register({
      name: 'handoff-restore',
      description: 'Cache Keeper: paste the last handoff brief into the prompt box again',
    })
    stopTick?.()
    const t = $.clock.every(5000, () => void tick($))
    stopTick = () => t.cancel()
    await tick($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, anchorA, () => null)
      await update($, notifiedA, () => 0)
      await update($, coldToastA, () => 0)
      clearWaiter?.()
    }
    return next(e)
  })

  // Every main-thread request re-reads (and refreshes) the cache: anchor the countdown on its send time.
  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    if (!e.agentId && result.usage) {
      const u = result.usage
      const prev = await read($, anchorA)
      const ttl = await read($, ttlA)
      // A cache hit after a gap longer than 5 minutes proves a 1-hour TTL.
      if (prev && u.cache_read_input_tokens > 0 && sentAt - prev.at > 6 * 60_000 && ttl.source === 'default') {
        await resolveTtl($, { minutes: 60, source: 'inferred' })
      }
      await update($, anchorA, () => ({
        at: sentAt,
        contextTokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens,
        model: u.model,
      }))
    }
    return result
  })

  // The transcript says which TTL each cache write used: read it after every main turn.
  on('classic.Stop', async ($, e, next) => {
    const path = e.transcript_path
    if (path) {
      const tail = await readTail($, path)
      const minutes = tail ? ttlFromTranscript(tail) : undefined
      if (minutes) await resolveTtl($, { minutes, source: 'detected' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await update($, meterA, m => ({
      ...m,
      contextTokens: e.context.tokens,
      contextWindow: e.context.window,
      contextPercent: e.context.percent,
      fiveHour: limitOf(e.rateLimits, 'five_hour') ?? m.fiveHour,
      weekly: limitOf(e.rateLimits, 'seven_day') ?? m.weekly,
      costUsd: e.cost?.usd ?? m.costUsd,
    }))
    return next(e)
  })

  // ------------------------------------------------------------ commands

  on('command.run', { command: 'cache-window' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'auto' || arg === '') {
      await $.store.set(OVERRIDE_KEY, 0)
      await update($, ttlA, (): Ttl => ({ minutes: defaultWindow, source: 'default' }))
      return { text: `Cache window: auto (detects from the session, ${defaultWindow} min until then).` }
    }
    const minutes = Number(arg.replace(/m(in(utes)?)?$/, ''))
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
      return { text: 'Usage: /cache-window <minutes>  (e.g. 5 or 60), or /cache-window auto' }
    }
    await $.store.set(OVERRIDE_KEY, minutes)
    await resolveTtl($)
    await update($, notifiedA, () => 0)
    return { text: `Cache window set to ${minutes} min (manual). /cache-window auto to go back to detection.` }
  })

  on('command.run', { command: 'handoff' }, async $ => {
    $.clock.after(10, () => void handoffAndClear($))
    return { text: 'Writing a handoff brief, then clearing the session…' }
  })

  on('command.run', { command: 'handoff-restore' }, async $ => {
    const brief = (await $.store.get(LAST_BRIEF_KEY)) as string | undefined
    if (!brief) return { text: 'No handoff brief saved yet.' }
    const r = await $.prompt.fill({ text: brief })
    return { text: r.isFilled ? 'Pasted the last handoff brief into the prompt box.' : 'The prompt box would not take the brief right now.' }
  })

  // ------------------------------------------------------------ the strip

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    const anchor = await read($, anchorA)
    const ttl = await read($, ttlA)
    const now = (await read($, nowA)) || (await $.clock.now())
    const meter = await read($, meterA)
    const handoff = await read($, handoffA)

    const ttlLabel = `${ttl.minutes >= 60 && ttl.minutes % 60 === 0 ? `${ttl.minutes / 60}h` : `${ttl.minutes}m`} ${ttl.source}`
    const warnMs = Math.min(warnMinutes * 60_000, (ttl.minutes * 60_000) / 2)

    let cacheText: string
    let cacheColor: string
    if (e.props.isWorking) {
      cacheText = 'cache warm · working'
      cacheColor = 'success'
    } else if (!anchor) {
      cacheText = 'cache: no requests yet'
      cacheColor = 'subtle'
    } else {
      const left = anchor.at + ttl.minutes * 60_000 - now
      if (left <= 0) {
        cacheText = `cache COLD (${fmtIn(-left)} ago)`
        cacheColor = 'error'
      } else {
        cacheText = `cache warm ${fmtClock(left)}`
        cacheColor = left <= warnMs ? 'warning' : 'success'
      }
    }

    const tokens = anchor?.contextTokens ?? meter.contextTokens ?? 0
    const ctxText =
      tokens > 0
        ? `ctx ${fmtTokens(tokens)}${meter.contextWindow ? `/${fmtTokens(meter.contextWindow)}` : ''}${meter.contextPercent != null ? ` (${meter.contextPercent}%)` : ''}`
        : 'ctx —'

    const limitText = (label: string, l?: Limit) => {
      if (!l) return `${label} —`
      const reset = l.resetsAt ? ` ↻${fmtIn(Date.parse(l.resetsAt) - now)}` : ''
      return `${label} ${l.percentUsed}%${reset}`
    }
    const limitColor = (l?: Limit) => (!l ? 'subtle' : l.percentUsed >= 90 ? 'error' : l.percentUsed >= 75 ? 'warning' : 'text')

    const model = anchor?.model ?? ''
    const price = priceOverride > 0 ? { usd: priceOverride, isKnown: true } : inputPrice(model)
    const cost = nextMessageCost(tokens, price.usd, ttl.minutes)
    const approx = price.isKnown ? '' : '~'

    const busy = handoff.phase === 'writing' || handoff.phase === 'clearing' || handoff.phase === 'pasting'
    const handoffLabel =
      handoff.phase === 'writing' ? 'Writing brief…' : handoff.phase === 'clearing' ? 'Clearing…' : handoff.phase === 'pasting' ? 'Pasting…' : 'Handoff & Clear'

    const sep = <Text dimColor> · </Text>

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" alignItems="center">
          <Text color={cacheColor} bold>
            {cacheText}
          </Text>
          <Text dimColor> ({ttlLabel})</Text>
          {sep}
          <Text>{ctxText}</Text>
          {sep}
          <Text color={limitColor(meter.fiveHour)}>{limitText('5h', meter.fiveHour)}</Text>
          {sep}
          <Text color={limitColor(meter.weekly)}>{limitText('wk', meter.weekly)}</Text>
          {sep}
          <Text>session {meter.costUsd != null ? fmtUsd(meter.costUsd) : '—'} API</Text>
          {sep}
          <Text color={anchor && cacheColor === 'error' ? 'error' : 'text'}>
            cold msg {tokens > 0 ? `${approx}${fmtUsd(cost.cold)}` : '—'}
          </Text>
          <Text dimColor>{tokens > 0 ? ` (warm ${approx}${fmtUsd(cost.warm)})` : ''} </Text>
          <Button
            key="handoff"
            label={handoffLabel}
            variant="primary"
            onPress={() => {
              if (busy) return
              if (e.props.isWorking) {
                $.ui.toast('Wait for the current turn to finish, then press Handoff & Clear.')
                return
              }
              return handoffAndClear($)
            }}
          />
        </Box>
        {handoff.phase === 'error' && handoff.message ? (
          <Text color="error" dimColor>
            Handoff: {handoff.message}
          </Text>
        ) : null}
      </Box>
    )
  })
}
