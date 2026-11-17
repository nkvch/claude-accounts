// One entry of state/limits.json, written by the app's main process.
export type Probe = {
  five?: number | null
  seven?: number | null
  fiveReset?: number | null
  sevenReset?: number | null
  error?: string
  unknown?: boolean
  status?: string
  at?: number
}

declare module 'claude-code' {
  interface PluginState {
    subscriptions: {
      account: string
      picked: string
      limits: Record<string, Probe>
      limitsText: string
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
