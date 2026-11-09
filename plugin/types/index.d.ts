export type Window = { kind: string; percentUsed: number; resetsAt?: string }

export type Probe = {
  label: string
  five?: number | null
  seven?: number | null
  fiveReset?: number | null
  sevenReset?: number | null
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    subscriptions: {
      account: string
      picked: string
      mine: Window[]
      others: Record<string, Probe>
      checkedAt: number
      sizes: Record<string, number>
      labels: Record<string, string>
      notes: Record<string, string>
      plans: Record<string, string>
      autoPlace: string
      barScale: string
    }
  }
}
