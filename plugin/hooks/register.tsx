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
// The narrowest a bar is drawn, in percent of the pane, so a tiny plan stays visible and readable.
const MIN_BAR = 4
const WINDOW_MS = { five: 5 * 3600 * 1000, seven: 7 * 86400 * 1000 }
// The colour says the pace: what is left against how much of the window is left.
// Ahead of an even spend is green, a little behind is amber, far behind is red.
const pace = (left: number, timeLeft: number) =>
  left >= timeLeft ? 'success' : left >= timeLeft * 0.7 ? 'warning' : 'error'

const account = atom({ plugin: 'subscriptions', key: 'account' } as const, 'default')
// The last pick in the dropdown: the chat runs on `account` until its process restarts.
const picked = atom({ plugin: 'subscriptions', key: 'picked' } as const, 'default')
const mine = atom({ plugin: 'subscriptions', key: 'mine' } as const, [])
const others = atom({ plugin: 'subscriptions', key: 'others' } as const, {})
const checkedAt = atom({ plugin: 'subscriptions', key: 'checkedAt' } as const, 0)
// Each plan's size in "times Pro usage per week" (accounts.json `proX`): bars are drawn to scale and it is shown as text next to the name.
const sizes = atom({ plugin: 'subscriptions', key: 'sizes' } as const, {})
// Each account's name and an optional note under it (accounts.json `label`, `note`).
const labels = atom({ plugin: 'subscriptions', key: 'labels' } as const, {})
const notes = atom({ plugin: 'subscriptions', key: 'notes' } as const, {})
// Each account's plan name (accounts.json `plan`, e.g. "Pro", "Ultra").
const plans = atom({ plugin: 'subscriptions', key: 'plans' } as const, {})

// `acct auto`: 'on' or 'off' (whether new chats are placed on a subscription automatically), 'unknown' when
// reading it failed, '' until read.
const autoPlace = atom({ plugin: 'subscriptions', key: 'autoPlace' } as const, '')

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
    if (seenAccounts && text !== seenAccounts) {
      void probe($)
      void readAuto($)
    }
    seenAccounts = text
  } catch {}
}

// Screenshot mode: HOME/demo.json replaces every number and name with made-up ones (see
// demo.example.json; reset times are given in hours from now, so a screenshot always looks right).
type Demo = {
  account: string
  accounts: Record<string, { proX?: number; plan?: string; label?: string; note?: string }>
  mine: { kind: string; percentUsed: number; resetsInHours: number }[]
  others: Record<string, { label: string; five: number | null; seven: number; fiveInHours?: number; sevenInHours: number }>
}
let demo = false

async function readDemo($: EngineInterface): Promise<Demo | null> {
  try { return JSON.parse(await $.fs.read(`${where.home}/demo.json`)) as Demo } catch { return null }
}

// Every `acct auto` call (read or press) takes a number; an answer is taken only from the latest one, so a slow
// read that comes back after a press cannot put the old state back.
let autoSeq = 0
const autoState = (out: string) => (out.trim() === 'on' || out.trim() === 'off' ? out.trim() : 'unknown')

// Returns why the read failed (for a toast), or null when it worked or its answer was already stale.
async function readAuto($: EngineInterface): Promise<string | null> {
  const seq = ++autoSeq
  const fail = async (why: string) => {
    $.ui.log(`subscriptions: acct auto failed: ${why}`, { to: 'debug' })
    if (seq !== autoSeq) return null
    try {
      await update($, autoPlace, () => 'unknown')
    } catch (err) {
      $.ui.log(`subscriptions: acct auto state not stored: ${String(err)}`, { to: 'debug' })
    }
    return why
  }
  try {
    const { exitCode, stdout, stderr } = await $.process.run([ACCT(), 'auto'], { timeoutMs: 15000 })
    if (exitCode !== 0) return await fail(stderr.trim())
    const state = autoState(stdout)
    if (state === 'unknown') return await fail(`unexpected output ${JSON.stringify(stdout.trim())}`)
    if (seq === autoSeq) await update($, autoPlace, () => state)
    return null
  } catch (err) {
    return await fail(String(err))
  }
}

async function probe($: EngineInterface) {
  try {
    if (!where.app) return
    const d = await readDemo($)
    demo = !!d
    const at = (h?: number) => (h == null ? null : Date.now() + h * 3600 * 1000)
    if (d) {
      await update($, account, () => d.account)
      await update($, picked, () => d.account)
      await update($, mine, () => d.mine.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: new Date(at(w.resetsInHours)!).toISOString() })))
      await update($, others, () => Object.fromEntries(Object.entries(d.others).map(([k, o]) =>
        [k, { label: o.label, five: o.five, seven: o.seven, fiveReset: at(o.fiveInHours), sevenReset: at(o.sevenInHours) }])))
    }
    const cfg = d ?? JSON.parse(await $.fs.read(ACCOUNTS())) as { accounts: Record<string, { proX?: number; plan?: string; label?: string; note?: string }> }
    const each = <T,>(f: (k: string, a: { proX?: number; plan?: string; label?: string; note?: string }) => T) =>
      Object.fromEntries(Object.entries(cfg.accounts).map(([k, a]) => [k, f(k, a)]))
    await update($, sizes, () => Object.fromEntries(Object.entries(cfg.accounts).flatMap(([k, a]) => (a.proX == null ? [] : [[k, a.proX]]))))
    await update($, plans, () => Object.fromEntries(Object.entries(cfg.accounts).flatMap(([k, a]) => (a.plan ? [[k, a.plan]] : []))))
    await update($, labels, () => each((k, a) => a.label ?? (k === 'default' ? 'Desktop login' : k)))
    await update($, notes, () => each((_, a) => a.note ?? ''))
    if (!d) {
      const { exitCode, stdout } = await $.process.run(['/usr/bin/python3', LIMITS_PY()], { timeoutMs: 60000 })
      if (exitCode === 0) await update($, others, () => JSON.parse(stdout) as Record<string, Probe>)
    }
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
    await update($, picked, () => acct)
    const usage = await $.session.usage()
    await update($, mine, () => usage.rateLimits)
    void $.ui.open({ id: PANE, title: TITLE })
    void probe($)
    void readAuto($)
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
    if (!demo) await update($, mine, () => e.rateLimits)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Select = 'Select' in ui ? ui.Select : undefined
    if (!where.app) {
      return <Text size="footnote" dimColor>This chat does not run in Claude Accounts. Open Claude through Claude Launcher.</Text>
    }
    const acct = await read($, account)
    const shown = await read($, picked)
    const limits = await read($, mine)
    const probes = await read($, others)
    const checked = await read($, checkedAt)
    const scale = await read($, sizes)
    const names = await read($, labels)
    const nameOf = (k: string) => names[k] ?? k
    const noteOf = await read($, notes)
    const planNames = await read($, plans)
    const sized = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
    const biggest = Math.max(1, ...Object.values(scale).filter(sized))
    // A plan with no usable size in accounts.json gets the full width rather than a guess.
    const barOf = (k: string) => {
      const x = scale[k]
      return sized(x) ? Math.max(MIN_BAR, Math.round((x / biggest) * 100)) : 100
    }
    // "Ultra · 10x", "Pro", "10x" or nothing: only what accounts.json says.
    const planOf = (k: string) => [planNames[k], scale[k] != null ? `${scale[k]}x` : ''].filter(Boolean).join(' · ')

    const auto = await read($, autoPlace)

    const now = Date.now()
    const moveHere = (name: string) => async () => {
      try {
        const { exitCode, stdout, stderr } = await $.process.run([ACCT(), name], { timeoutMs: 15000 })
        const moved = exitCode === 0 && stdout.includes('->')
        if (moved) await update($, picked, () => name)
        $.ui.toast(moved ? `Switching this chat to ${nameOf(name)}: it restarts on it as soon as it is idle.` : (stderr || stdout).trim())
      } catch (err) {
        $.ui.toast(`Could not switch to ${nameOf(name)}: ${String(err)}`)
      }
    }
    const flipAuto = async () => {
      if (auto === 'unknown') {
        const why = await readAuto($)
        if (why != null) $.ui.toast(`Could not read the auto-placement state${why ? `: ${why}` : ''}`)
        return
      }
      const next = auto === 'on' ? 'off' : 'on'
      const seq = ++autoSeq
      try {
        const { exitCode, stdout, stderr } = await $.process.run([ACCT(), 'auto', next], { timeoutMs: 15000 })
        if (exitCode !== 0) $.ui.toast((stderr || stdout).trim() || `acct auto ${next} exited with code ${exitCode}`)
        else if (seq === autoSeq) await update($, autoPlace, () => autoState(stdout))
      } catch (err) {
        $.ui.toast(`Could not change auto-placement: ${String(err)}`)
      }
    }
    // Dialogs take it from here (name, plan, sign-in); detached so the pane is not held while they wait.
    const addSubscription = async () => {
      await $.process.run(['/bin/sh', '-c', `nohup /usr/bin/python3 '${ADD_PY()}' >/dev/null 2>&1 &`], { timeoutMs: 5000 })
      $.ui.toast('Follow the dialogs to add a subscription.')
    }

    // One limit as what is left: the percent on the left, the window and its reset above a bar drawn to the
    // plan's size, filled with what is left; a thin mark stands where an even spend would be now (the share of the window still to go).
    const meter = (key: string, label: string, pct: number | null | undefined, reset: number | null | undefined,
      size: number, windowMs: number) => {
      const left = 100 - Math.max(0, Math.min(100, Math.round(pct ?? 0)))
      const timeLeft = reset ? Math.max(0, Math.min(100, Math.round(((reset - now) / windowMs) * 100))) : 100
      const note = reset ? `resets ${when(reset)}` : 'window not started'
      const fill = pace(left, timeLeft)
      const seg = (k: string, w: number, color: string) => w > 0 && <Box key={k} width={`${w}%`} height={1} backgroundColor={color} />
      return (
        <Box key={key} flexDirection="row" alignItems="center" gap="md">
          <Box width={7} justifyContent="flex-end">
            <Text size="heading" weight="semibold" tabular>{`${left}%`}</Text>
          </Box>
          <Box flexDirection="column" gap="xs" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" gap="sm">
              <Text size="footnote" weight="semibold">{label}</Text>
              <Text size="footnote" tabular dimColor>{note}</Text>
            </Box>
            <Box key={`track-${key}`} flexDirection="row" height={1} width={`${size}%`} backgroundColor={TRACK}>
              {left >= timeLeft
                ? [seg('a', timeLeft, fill), <Box key="m" width="2%" height={1} backgroundColor={MARK} />, seg('b', left - timeLeft, fill)]
                : [seg('a', left, fill), seg('b', timeLeft - left, TRACK), <Box key="m" width="2%" height={1} backgroundColor={MARK} />]}
            </Box>
          </Box>
        </Box>
      )
    }

    // An account's name, plan and note. Where there is no Select (mobile), a button moves this chat onto it.
    const accountHead = (name: string, label: string) => (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
        <Text weight="semibold">
          {label}
          {planOf(name) ? <Text weight="regular" size="footnote" dimColor>{`  ${planOf(name)}`}</Text> : ''}
          {noteOf[name] ? <Text weight="regular" size="footnote" dimColor>{`  ${noteOf[name]}`}</Text> : ''}
        </Text>
        {!Select && <Button key={`move-${name}`} label="Move chat here" variant="secondary" onPress={moveHere(name)} />}
      </Box>
    )
    const choices = [...new Set([...Object.keys(names), acct, shown])].sort((a, b) => Number(b === 'default') - Number(a === 'default'))

    const five = limits.find(l => l.kind === 'five_hour')
    const seven = limits.find(l => l.kind === 'seven_day')
    const rest = Object.entries(probes).filter(([name]) => name !== acct)
    const hasRest = rest.length > 0 || acct !== 'default'

    return (
      <Box flexDirection="column" gap="lg">
        <Box flexDirection="column" gap="sm">
          <Box flexDirection="column">
            <Text size="footnote" dimColor>This chat runs on</Text>
            <Text size="heading" weight="semibold">
              {nameOf(acct)}
              {planOf(acct) ? <Text weight="regular" size="footnote" dimColor>{`  ${planOf(acct)}`}</Text> : ''}
            </Text>
          </Box>
          {shown !== acct && <Text size="footnote" color="warning">{`Switching to ${nameOf(shown)} when this chat is idle`}</Text>}
          {Select && choices.length > 0 && (
            <Select
              key="account"
              label="Switch to"
              value={shown}
              options={choices.map(k => ({ value: k, label: nameOf(k) }))}
              onSelect={value => { if (value !== shown) void moveHere(value)() }}
            />
          )}
          {five || seven
            ? [five && meter('mine-5', '5 hours', five.percentUsed, isoMs(five.resetsAt), barOf(acct), WINDOW_MS.five),
               seven && meter('mine-7', 'Week', seven.percentUsed, isoMs(seven.resetsAt), barOf(acct), WINDOW_MS.seven)]
            : <Text size="footnote" dimColor>Numbers appear after the first reply.</Text>}
        </Box>

        {hasRest && (
          <Box flexDirection="column" gap="lg">
            <Text size="footnote" dimColor>Other subscriptions</Text>
            {rest.map(([name, p]) => (
              <Box key={`acct-${name}`} flexDirection="column" gap="md">
                {accountHead(name, nameOf(name))}
                {p.error
                  ? <Text size="footnote" dimColor>{`Couldn't check: ${p.error}`}</Text>
                  : [p.five != null && meter(`${name}-5`, '5 hours', p.five, p.fiveReset, barOf(name), WINDOW_MS.five),
                     meter(`${name}-7`, 'Week', p.seven, p.sevenReset, barOf(name), WINDOW_MS.seven)]}
              </Box>
            ))}
            {acct !== 'default' && !probes.default && names.default !== undefined && (
              <Box key="acct-default" flexDirection="column" gap="md">
                {accountHead('default', nameOf('default'))}
                <Text size="footnote" dimColor>No fresh numbers yet</Text>
              </Box>
            )}
          </Box>
        )}

        {rest.length === 0 && acct === 'default' && <Text size="footnote" dimColor>Checking…</Text>}
        {auto && (
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
            <Text size="footnote" dimColor>Auto-place new chats</Text>
            <Button key="auto-place" label={auto === 'on' ? 'On' : auto === 'off' ? 'Off' : 'unknown'} variant="secondary" onPress={flipAuto} />
          </Box>
        )}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
          <Text size="footnote" dimColor>{checked > 0 ? `Checked at ${when(checked)}` : ''}</Text>
          <Button key="add-subscription" label="Add subscription" variant="secondary" onPress={addSubscription} />
        </Box>
      </Box>
    )
  })
}
