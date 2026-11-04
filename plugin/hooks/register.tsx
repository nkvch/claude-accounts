import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Probe, Window } from '../types'

// The patched app (claude-accounts) tells every session where its code and config are
// (CLAUDE_ACCOUNTS_APP / CLAUDE_ACCOUNTS_HOME) and which subscription it runs on (CC_ACCOUNT;
// unset = the desktop login).
const PANE = 'subscriptions'
const TITLE = 'Subscriptions'
const where = { app: '', home: '' }
const ACCT = () => `${where.app}/acct`
const ACCOUNTS = () => `${where.home}/accounts.json`
const ADD_PY = () => `${where.app}/add_subscription.py`
const LIMITS_PY = () => `${where.app}/limits.py`
const PROBE_EVERY_MS = 10 * 60 * 1000
const WATCH_EVERY_MS = 20 * 1000
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// The empty part of a bar: a faint grey that reads on a light and a dark theme alike.
const TRACK = '#8080802e'
// The even-pace mark: blue, so it stands out against a green, amber or red fill.
const MARK = '#2f6fed'
const WINDOW_MS = { five: 5 * 3600 * 1000, seven: 7 * 86400 * 1000 }
// The colour says the pace: what is left against how much of the window is left.
// Ahead of an even spend is green, a little behind is amber, far behind is red.
const pace = (left: number, timeLeft: number) =>
  left >= timeLeft ? 'success' : left >= timeLeft * 0.7 ? 'warning' : 'error'

const account = atom({ plugin: 'subscriptions', key: 'account' } as const, 'default')
const mine = atom({ plugin: 'subscriptions', key: 'mine' } as const, [])
const others = atom({ plugin: 'subscriptions', key: 'others' } as const, {})
const checkedAt = atom({ plugin: 'subscriptions', key: 'checkedAt' } as const, 0)
// Each plan's size in "times Pro usage per week" (accounts.json `proX`): bars are drawn to scale.
const sizes = atom({ plugin: 'subscriptions', key: 'sizes' } as const, {})
// Each account's name and an optional note under it (accounts.json `label`, `note`).
const labels = atom({ plugin: 'subscriptions', key: 'labels' } as const, {})
const notes = atom({ plugin: 'subscriptions', key: 'notes' } as const, {})

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
// 16:00 · Wed 03:00
const when = (ms: number) => {
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString() ? hm(d) : `${DAYS[d.getDay()]} ${hm(d)}`
}
const isoMs = (iso?: string) => (iso ? Date.parse(iso) : null)

// The accounts list as last read: when it changes (a subscription added), probe at once
// instead of waiting for the 10-minute round.
let seenAccounts = ''
async function watchAccounts($: EngineInterface) {
  try {
    const text = await $.fs.read(ACCOUNTS())
    if (seenAccounts && text !== seenAccounts) void probe($)
    seenAccounts = text
  } catch {}
}

async function probe($: EngineInterface) {
  try {
    if (!where.app) return
    const cfg = JSON.parse(await $.fs.read(ACCOUNTS())) as { accounts: Record<string, { proX?: number; label?: string; note?: string }> }
    const each = <T,>(f: (k: string, a: { proX?: number; label?: string; note?: string }) => T) =>
      Object.fromEntries(Object.entries(cfg.accounts).map(([k, a]) => [k, f(k, a)]))
    await update($, sizes, () => each((_, a) => a.proX ?? 1))
    await update($, labels, () => each((k, a) => a.label ?? (k === 'default' ? 'Desktop login' : k)))
    await update($, notes, () => each((_, a) => a.note ?? ''))
    const { exitCode, stdout } = await $.process.run(['/usr/bin/python3', LIMITS_PY()], { timeoutMs: 60000 })
    if (exitCode === 0) await update($, others, () => JSON.parse(stdout) as Record<string, Probe>)
    await update($, checkedAt, () => Date.now())
  } catch (err) {
    $.ui.log(`subscriptions: probe failed: ${String(err)}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'limits', description: 'Show the subscriptions pane' })
    await $.command.register({ name: 'acct', description: 'Show or switch this chat\'s subscription by its name in accounts.json (no model call)' })
    where.app = (await $.env.get('CLAUDE_ACCOUNTS_APP')) ?? ''
    where.home = (await $.env.get('CLAUDE_ACCOUNTS_HOME')) ?? ''
    const acct = (await $.env.get('CC_ACCOUNT')) ?? 'default'
    await update($, account, () => acct)
    const usage = await $.session.usage()
    await update($, mine, () => usage.rateLimits)
    void $.ui.open({ id: PANE, title: TITLE })
    void probe($)
    $.clock.every(PROBE_EVERY_MS, () => void probe($))
    $.clock.every(WATCH_EVERY_MS, () => void watchAccounts($))
    return started
  })

  on('command.run', { command: 'limits' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void probe($)
    return { text: 'Subscriptions pane opened.' }
  })

  // Runs locally, without the model, so it works when the current subscription is out of limit.
  on('command.run', { command: 'acct' }, async ($, e) => {
    const args = e.args.trim() ? [e.args.trim()] : []
    const { stdout, stderr } = await $.process.run([ACCT(), ...args], { timeoutMs: 15000 })
    return { text: (stdout || stderr).trim() }
  })

  on('session.measure', async ($, e, next) => {
    await update($, mine, () => e.rateLimits)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    if (!where.app) {
      return <Text size="footnote" dimColor>This chat does not run in Claude Accounts. Open Claude through Claude Launcher.</Text>
    }
    const acct = await read($, account)
    const limits = await read($, mine)
    const probes = await read($, others)
    const checked = await read($, checkedAt)
    const scale = await read($, sizes)
    const names = await read($, labels)
    const nameOf = (k: string) => names[k] ?? k
    const noteOf = await read($, notes)
    const biggest = Math.max(1, ...Object.values(scale))

    const now = Date.now()
    const moveHere = (name: string) => async () => {
      const { stdout, stderr } = await $.process.run([ACCT(), name], { timeoutMs: 15000 })
      $.ui.toast(stdout.includes('->') ? `Switching this chat to ${nameOf(name)}: it restarts on it as soon as it is idle.` : (stderr || stdout).trim())
    }
    // Dialogs take it from here (name, plan, sign-in); detached so the pane is not held while they wait.
    const addSubscription = async () => {
      await $.process.run(['/bin/sh', '-c', `nohup /usr/bin/python3 '${ADD_PY()}' >/dev/null 2>&1 &`], { timeoutMs: 5000 })
      $.ui.toast('Follow the dialogs to add a subscription.')
    }

    // One limit as what is left: the bar is drawn to the plan's size, filled with what is left,
    // and a thin mark stands where an even spend would be now (the share of the window still to go).
    const meter = (key: string, label: string, pct: number | null | undefined, reset: number | null | undefined,
      size: number, windowMs: number) => {
      const left = 100 - Math.max(0, Math.min(100, Math.round(pct ?? 0)))
      const timeLeft = reset ? Math.max(0, Math.min(100, Math.round(((reset - now) / windowMs) * 100))) : 100
      const note = reset ? `resets ${when(reset)}` : 'window not started'
      const fill = pace(left, timeLeft)
      const seg = (k: string, w: number, color: string) => w > 0 && <Box key={k} width={`${w}%`} height={1} backgroundColor={color} />
      return (
        <Box key={key} flexDirection="column" gap="xs">
          <Box flexDirection="row" justifyContent="space-between" gap="sm">
            <Text size="footnote">{label}</Text>
            <Text size="footnote" tabular>
              <Text weight="semibold">{`${left}% left`}</Text>
              <Text dimColor>{`  ${note}`}</Text>
            </Text>
          </Box>
          <Box flexDirection="row" height={1} width={`${Math.round((size / biggest) * 100)}%`} backgroundColor={TRACK}>
            {left >= timeLeft
              ? [seg('a', timeLeft, fill), <Box key="m" width="2%" height={1} backgroundColor={MARK} />, seg('b', left - timeLeft, fill)]
              : [seg('a', left, fill), seg('b', timeLeft - left, TRACK), <Box key="m" width="2%" height={1} backgroundColor={MARK} />]}
          </Box>
        </Box>
      )
    }

    // An account's name, what it is, and the control that moves this chat onto it.
    const accountHead = (name: string, label: string) => (
      <Box flexDirection="row" justifyContent="space-between" gap="sm">
        <Text weight="semibold">{label}{noteOf[name] ? <Text weight="regular" size="footnote" dimColor>{`  ${noteOf[name]}`}</Text> : ''}</Text>
        <Button key={`move-${name}`} label="Move chat here" variant="secondary" onPress={moveHere(name)} />
      </Box>
    )

    const five = limits.find(l => l.kind === 'five_hour')
    const seven = limits.find(l => l.kind === 'seven_day')
    const rest = Object.entries(probes).filter(([name]) => name !== acct)
    const hasRest = rest.length > 0 || acct !== 'default'

    return (
      <Box flexDirection="column" gap="lg">
        <Box flexDirection="column" gap="sm">
          <Text size="heading" weight="semibold">
            {nameOf(acct)}<Text weight="regular" dimColor>  this chat</Text>
          </Text>
          {five || seven
            ? [five && meter('mine-5', '5 hours', five.percentUsed, isoMs(five.resetsAt), scale[acct] ?? 1, WINDOW_MS.five),
               seven && meter('mine-7', 'Week', seven.percentUsed, isoMs(seven.resetsAt), scale[acct] ?? 1, WINDOW_MS.seven)]
            : <Text size="footnote" dimColor>Numbers appear after the first reply.</Text>}
        </Box>

        {hasRest && (
          <Box flexDirection="column" gap="md">
            <Text size="heading" weight="semibold">Others</Text>
            {rest.map(([name, p]) => (
              <Box key={`acct-${name}`} flexDirection="column" gap="sm">
                {accountHead(name, nameOf(name))}
                {p.error
                  ? <Text size="footnote" dimColor>{`Couldn't check: ${p.error}`}</Text>
                  : [p.five != null && meter(`${name}-5`, '5 hours', p.five, p.fiveReset, scale[name] ?? 1, WINDOW_MS.five),
                     meter(`${name}-7`, 'Week', p.seven, p.sevenReset, scale[name] ?? 1, WINDOW_MS.seven)]}
              </Box>
            ))}
            {acct !== 'default' && !probes.default && (
              <Box key="acct-default" flexDirection="column" gap="sm">
                {accountHead('default', nameOf('default'))}
                <Text size="footnote" dimColor>No fresh numbers yet</Text>
              </Box>
            )}
          </Box>
        )}

        {rest.length === 0 && acct === 'default' && <Text size="footnote" dimColor>Checking…</Text>}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
          <Text size="footnote" dimColor>{checked > 0 ? `Checked at ${when(checked)}` : ''}</Text>
          <Button key="add-subscription" label="Add subscription" variant="secondary" onPress={addSubscription} />
        </Box>
      </Box>
    )
  })
}
