export type TtlSource = 'detected' | 'inferred' | 'default' | 'manual'

/** The last main-thread request: when it was sent, and what it carried. */
export type Anchor = {
  at: number
  contextTokens: number
  model: string
}

export type Ttl = { minutes: number; source: TtlSource }

export type Limit = { percentUsed: number; resetsAt?: string }

export type Meter = {
  contextTokens?: number
  contextWindow?: number
  contextPercent?: number
  fiveHour?: Limit
  weekly?: Limit
  costUsd?: number
}

export type Handoff = {
  phase: 'idle' | 'writing' | 'clearing' | 'pasting' | 'error'
  message?: string
}

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': {
      anchor: Anchor | null
      ttl: Ttl
      now: number
      meter: Meter
      handoff: Handoff
      notifiedFor: number
      coldToastFor: number
    }
  }
}
