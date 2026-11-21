import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Probe } from '../types'

// The patched app (claude-accounts) tells every session where its code and config are
// (CLAUDE_ACCOUNTS_APP / CLAUDE_ACCOUNTS_HOME) and which subscription it runs on (CC_ACCOUNT;
// unset = the desktop login).
const PANE = 'subscriptions'
const TITLE = 'Subscriptions'
const where = { app: '', home: '' }
const ACCT = () => `${where.app}/acct`
const ACCOUNTS = () => `${where.home}/accounts.json`
const ADD_PY = () => `${where.app}/add_subscription.py`
// The one shared source of the numbers: the app's main process probes every subscription and writes this file.
const LIMITS = () => `${where.home}/state/limits.json`
export const WATCH_EVERY_MS = 20 * 1000
// Numbers older than this are shown as not live. Same value as LIMITS_FRESH_MS in app/logic.js, which the plugin cannot import.
export const LIMITS_FRESH_MS = 30 * 60 * 1000
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
// state/limits.json as last read (by account name), and its text, to see whether the file changed.
const limits = atom({ plugin: 'subscriptions', key: 'limits' } as const, {})
const limitsText = atom({ plugin: 'subscriptions', key: 'limitsText' } as const, '')
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
// How wide each bar is drawn (accounts.json `barScale`): "adaptive" (default) to the plan's size, "independent" every bar full width.
const barScale = atom({ plugin: 'subscriptions', key: 'barScale' } as const, 'adaptive')
const autoPlace = atom({ plugin: 'subscriptions', key: 'autoPlace' } as const, '')

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
// 16:00 · Wed 03:00
const when = (ms: number) => {
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString() ? hm(d) : `${DAYS[d.getDay()]} ${hm(d)}`
}

// The accounts list as last read: when it changes (a subscription added), read the config and the
// numbers again at once instead of waiting for the next tick.
let seenAccounts = ''
async function watchAccounts($: EngineInterface) {
  try {
    const text = await $.fs.read(ACCOUNTS())
    if (seenAccounts && text !== seenAccounts) {
      void load($)
      void readAuto($)
    }
    seenAccounts = text
  } catch {}
  await readLimits($)
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

async function loadConfig($: EngineInterface) {
  try {
    if (!where.app) return
    const d = await readDemo($)
    if (demo && !d) {
      // Leaving demo mode: forget the made-up numbers and the file text, so the file is read again even if it did not change.
      await update($, limits, () => ({}))
      await update($, limitsText, () => '')
      await update($, checkedAt, () => 0)
    }
    demo = !!d
    const at = (h?: number) => (h == null ? null : Date.now() + h * 3600 * 1000)
    if (d) {
      await update($, account, () => d.account)
      await update($, picked, () => d.account)
      const win = (kind: string) => d.mine.find(w => w.kind === kind)
      const mineNow: Record<string, Probe> = d.mine.length === 0 ? {} : {
        [d.account]: {
          five: win('five_hour')?.percentUsed ?? null, seven: win('seven_day')?.percentUsed ?? null,
          fiveReset: at(win('five_hour')?.resetsInHours), sevenReset: at(win('seven_day')?.resetsInHours),
        },
      }
      await update($, limits, () => ({
        ...mineNow,
        ...Object.fromEntries(Object.entries(d.others).map(([k, o]) =>
          [k, { five: o.five, seven: o.seven, fiveReset: at(o.fiveInHours), sevenReset: at(o.sevenInHours) }])),
      }))
      await update($, checkedAt, () => Date.now())
    }
    const cfg = d ?? JSON.parse(await $.fs.read(ACCOUNTS())) as { barScale?: unknown; accounts: Record<string, { proX?: number; plan?: string; label?: string; note?: string }> }
    const each = <T,>(f: (k: string, a: { proX?: number; plan?: string; label?: string; note?: string }) => T) =>
      Object.fromEntries(Object.entries(cfg.accounts).map(([k, a]) => [k, f(k, a)]))
    await update($, barScale, () => ((cfg as { barScale?: unknown }).barScale === 'independent' ? 'independent' : 'adaptive'))
    await update($, sizes, () => Object.fromEntries(Object.entries(cfg.accounts).flatMap(([k, a]) => (a.proX == null ? [] : [[k, a.proX]]))))
    await update($, plans, () => Object.fromEntries(Object.entries(cfg.accounts).flatMap(([k, a]) => (a.plan ? [[k, a.plan]] : []))))
    await update($, labels, () => each((k, a) => a.label ?? (k === 'default' ? 'Desktop login' : k)))
    await update($, notes, () => each((_, a) => a.note ?? ''))
  } catch (err) {
    $.ui.log(`subscriptions: reading the config failed: ${String(err)}`, { to: 'debug' })
  }
}

// Every chat shows the same numbers because they all come from state/limits.json, which the app's main
// process refreshes for all subscriptions (logic.js refreshLimits). Atoms change only when the text did.
async function readLimits($: EngineInterface) {
  try {
    if (!where.app || demo) return
    const text = await $.fs.read(LIMITS())
    if (typeof text !== 'string') {
      $.ui.log('subscriptions: limits.json is not there yet', { to: 'debug' })
      return
    }
    if (text === (await read($, limitsText))) return
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    const file = parsed as Record<string, Probe>
    await update($, limits, () => file)
    await update($, checkedAt, () => Math.max(0, ...Object.values(file).map(p => (typeof p?.at === 'number' ? p.at : 0))))
    await update($, limitsText, () => text)
  } catch (err) {
    $.ui.log(`subscriptions: limits.json not read: ${String(err)}`, { to: 'debug' })
  }
}

async function load($: EngineInterface) {
  await loadConfig($)
  await readLimits($)
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
    void $.ui.open({ id: PANE, title: TITLE })
    void load($)
    void readAuto($)
    $.clock.every(WATCH_EVERY_MS, () => void watchAccounts($))
    return started
  })

  on('command.run', { command: 'limits' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void load($)
    return { text: 'Subscriptions pane opened.' }
  })

  // Runs locally, without the model, so it works when the current subscription is out of limit.
  on('command.run', { command: 'acct' }, async ($, e) => {
    const args = e.args.trim() ? [e.args.trim()] : []
    const { stdout, stderr } = await $.process.run([ACCT(), ...args], { timeoutMs: 15000 })
    return { text: (stdout || stderr).trim() }
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
    const probes = await read($, limits)
    const checked = await read($, checkedAt)
    const scale = await read($, sizes)
    const independent = (await read($, barScale)) === 'independent'
    const names = await read($, labels)
    const nameOf = (k: string) => names[k] ?? k
    const noteOf = await read($, notes)
    const planNames = await read($, plans)
    const sized = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
    const biggest = Math.max(1, ...Object.values(scale).filter(sized))
    // A plan with no usable size in accounts.json gets the full width rather than a guess.
    const barOf = (k: string) => {
      if (independent) return 100
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
    const flipScale = async () => {
      const next = independent ? 'adaptive' : 'independent'
      try {
        const { exitCode, stdout, stderr } = await $.process.run([ACCT(), 'scale', next], { timeoutMs: 15000 })
        if (exitCode !== 0) $.ui.toast((stderr || stdout).trim() || `acct scale ${next} exited with code ${exitCode}`)
        else await update($, barScale, () => (stdout.trim() === 'independent' ? 'independent' : 'adaptive'))
      } catch (err) {
        $.ui.toast(`Could not change the bar width: ${String(err)}`)
      }
    }
    // Dialogs take it from here (name, plan, sign-in); detached so the pane is not held while they wait.
    const addSubscription = async () => {
      await $.process.run(['/bin/sh', '-c', `nohup /usr/bin/python3 '${ADD_PY()}' >/dev/null 2>&1 &`], { timeoutMs: 5000 })
      $.ui.toast('Follow the dialogs to add a subscription.')
    }

    // One limit as a row: the window, a bar drawn to the plan's size and filled with what is left, the percent left
    // and when it resets; a thin mark stands where an even spend would be now (the share of the window still to go).
    const resetText = (reset: number | null | undefined) => (reset ? when(reset) : 'not started')
    // `resetCols`: the width of the reset column, the same for every row of a card, so all its bars start and end alike.
    const meter = (key: string, label: string, pct: number | null | undefined, reset: number | null | undefined,
      size: number, windowMs: number, resetCols: number) => {
      const left = 100 - Math.max(0, Math.min(100, Math.round(pct ?? 0)))
      const timeLeft = reset ? Math.max(0, Math.min(100, Math.round(((reset - now) / windowMs) * 100))) : 100
      const fill = pace(left, timeLeft)
      const seg = (k: string, w: number, color: string) => w > 0 && <Box key={k} width={`${w}%`} height={1} backgroundColor={color} />
      // One row: the window, the percent left right next to it, then the bar over all the width that is left,
      // and the reset time at its own width, so no fixed columns eat the bar's room.
      return (
        <Box key={key} flexDirection="row" alignItems="center" gap="sm">
          <Box width={5.5}>
            <Text size="footnote" dimColor>{label}</Text>
          </Box>
          <Box width={3} justifyContent="flex-end">
            <Text size="footnote" weight="semibold" tabular>{`${left}%`}</Text>
          </Box>
          <Box flexGrow={1}>
            <Box key={`track-${key}`} flexDirection="row" height={1} width={`${size}%`} backgroundColor={TRACK}>
              {left >= timeLeft
                ? [seg('a', timeLeft, fill), <Box key="m" width="2%" height={1} backgroundColor={MARK} />, seg('b', left - timeLeft, fill)]
                : [seg('a', left, fill), seg('b', timeLeft - left, TRACK), <Box key="m" width="2%" height={1} backgroundColor={MARK} />]}
            </Box>
          </Box>
          <Box width={resetCols} justifyContent="flex-end">
            <Text size="caption" tabular dimColor>{resetText(reset)}</Text>
          </Box>
        </Box>
      )
    }

    // One subscription as a card: its name, plan and note, "this chat" or a Use button, and its limits.
    // The card of the picked subscription has a bright border, the others a faint one.
    const card = (name: string, body: unknown) => {
      const mine = name === shown
      return (
        <Box key={`card-${name}`} flexDirection="column" gap="sm" paddingX={1} borderStyle="round"
          borderColor={mine ? 'claude' : undefined} borderDimColor={!mine}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
            <Text weight="semibold">
              {nameOf(name)}
              {planOf(name) ? <Text weight="regular" size="footnote" dimColor>{`  ${planOf(name)}`}</Text> : ''}
              {noteOf[name] ? <Text weight="regular" size="footnote" dimColor>{`  ${noteOf[name]}`}</Text> : ''}
            </Text>
            {mine
              ? <Text size="footnote" dimColor>{name === acct ? 'this chat' : 'next'}</Text>
              : <Button key={`move-${name}`} label="Use" variant="secondary" onPress={moveHere(name)} />}
          </Box>
          {body}
        </Box>
      )
    }
    const choices = [...new Set([...Object.keys(names), acct, shown])].sort((a, b) => Number(b === 'default') - Number(a === 'default'))

    // The same card body for this chat's subscription and the others; `key` keeps this chat's meters under "mine".
    const numbers = (name: string, none: string) => {
      const p = probes[name]
      const key = name === acct ? 'mine' : name
      if (!p) return <Text size="footnote" dimColor>{none}</Text>
      if (p.error) return <Box key={`error-${name}`}><Text size="footnote" dimColor>{`Couldn't check: ${p.error}`}</Text></Box>
      if (p.five == null && p.seven == null) return <Text size="footnote" dimColor>No usage numbers from this plan</Text>
      const stale = typeof p.at === 'number' && now - p.at > LIMITS_FRESH_MS
      // A layout cell is wider than a character in this font, so the column takes 0.75 of the longest text, not rounded. The reset time is in the smaller `caption` size.
      const resetCols = (0.75 * Math.max(
        ...[p.five != null ? resetText(p.fiveReset) : '', p.seven != null ? resetText(p.sevenReset) : ''].map((s) => s.length)))
      return (
        <Box flexDirection="column" gap="sm">
          {stale && <Box key={`stale-${name}`}><Text size="footnote" color="warning">{`Not live, last checked ${when(p.at!)}`}</Text></Box>}
          {p.five != null && meter(`${key}-5`, '5 hours', p.five, p.fiveReset, barOf(name), WINDOW_MS.five, resetCols)}
          {p.seven != null && meter(`${key}-7`, 'Week', p.seven, p.sevenReset, barOf(name), WINDOW_MS.seven, resetCols)}
        </Box>
      )
    }
    const rest = Object.keys(names).filter(name => name !== acct)
    const hasRest = rest.length > 0 || acct !== 'default'

    return (
      <Box flexDirection="column" gap="lg">
        <Box flexDirection="column" gap="sm">
          <Text size="footnote" weight="semibold">
            <Text weight="regular" size="footnote" dimColor>{'This chat runs on  '}</Text>
            {nameOf(acct)}
          </Text>
          {shown !== acct && <Text size="footnote" color="warning">{`Switching to ${nameOf(shown)} when this chat is idle`}</Text>}
          {Select && choices.length > 0 && (
            <Select
              key="account"
              value={shown}
              options={choices.map(k => ({ value: k, label: [nameOf(k), scale[k] != null ? `${scale[k]}x` : ''].filter(Boolean).join(' · ') }))}
              onSelect={value => { if (value !== shown) void moveHere(value)() }}
            />
          )}
        </Box>

        <Box flexDirection="column" gap="md">
          {card(acct, numbers(acct, 'Not checked yet.'))}
          {hasRest && <Text size="footnote" dimColor>Other subscriptions</Text>}
          {hasRest && rest.map(name => card(name, numbers(name, 'No fresh numbers yet')))}
        </Box>

        {rest.length === 0 && acct === 'default' && <Text size="footnote" dimColor>Checking…</Text>}
        {auto && (
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
            <Text size="footnote" dimColor>Auto-place new chats</Text>
            <Button key="auto-place" label={auto === 'on' ? 'On' : auto === 'off' ? 'Off' : 'unknown'} variant="secondary" onPress={flipAuto} />
          </Box>
        )}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
          <Text size="footnote" dimColor>Bar width</Text>
          <Button key="bar-scale" label={independent ? 'Full' : 'Plan size'} variant="secondary" onPress={flipScale} />
        </Box>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
          <Text size="footnote" dimColor>{checked > 0 ? `Checked at ${when(checked)}` : ''}</Text>
          <Button key="add-subscription" label="Add subscription" variant="secondary" onPress={addSubscription} />
        </Box>
      </Box>
    )
  })
}
