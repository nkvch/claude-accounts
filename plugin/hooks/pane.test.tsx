import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subscriptions', component: 'Pane', requestId: 'subscriptions',
  props: { title: 'Subscriptions', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const now = Date.now()
const PROBES = {
  personal: { label: 'Personal', five: null, seven: 10, fiveReset: null, sevenReset: now + 3 * 864e5 },
  side: { label: 'Side project', five: 17, seven: 33, fiveReset: now + 2 * 36e5, sevenReset: now + 5 * 864e5 },
}
const ACCOUNTS = { accounts: { default: { proX: 6.25, label: 'Work' }, personal: { proX: 10, plan: 'Ultra', label: 'Personal' }, side: { proX: 5, label: 'Side project', note: 'used by the bot' } } }
const ENV: Record<string, string> = { CLAUDE_ACCOUNTS_APP: '/opt/ca/app', CLAUDE_ACCOUNTS_HOME: '/home/.claude-accounts' }

test('each subscription shows what is left and the dropdown moves the chat onto the picked one', async ($, on) => {
  const runs: string[][] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: ENV[e.name] }))
  on('session.usage', () => ({ value: { rateLimits: [{ kind: 'five_hour', percentUsed: 29, resetsAt: new Date(now + 36e5).toISOString() }, { kind: 'seven_day', percentUsed: 7, resetsAt: new Date(now + 6 * 864e5).toISOString() }] } }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('accounts.json') ? JSON.stringify(ACCOUNTS) : undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: e.argv[0] === '/usr/bin/python3' ? JSON.stringify(PROBES) : 'this session -> personal (Personal)', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^71%$/ }))?.text).toMatch(/^71%$/)
  expect((await ui.find({ type: 'Text', text: /^90%$/ }))?.text).toMatch(/^90%$/)
  expect((await ui.find({ type: 'Text', text: /used by/ }))?.text).toMatch(/used by the bot/)
  expect(await ui.find({ type: 'Button', key: 'add-subscription' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /This chat runs on/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^Work/ }))?.text).toMatch(/^Work\s+6\.25x/)
  expect(await ui.find({ type: 'Text', text: /Switching to/ })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /Ultra · 10x/ }))?.text).toMatch(/Personal\s+Ultra · 10x/)
  expect(await ui.find({ type: 'Button', key: 'move-personal' })).toBeFalsy()
  const picker = await ui.find({ type: 'Select', key: 'account' })
  expect(picker?.props).toMatchObject({ value: 'default', options: [{ value: 'default' }, { value: 'personal' }, { value: 'side' }] })
  const acctRuns = () => runs.filter(a => a[0] === '/opt/ca/app/acct' && a[1] !== 'auto')
  await ui.select({ key: 'account', value: 'default' })
  expect(acctRuns()).toEqual([])
  await ui.select({ key: 'account', value: 'personal' })
  expect(acctRuns()).toEqual([['/opt/ca/app/acct', 'personal']])
  expect((await ui.find({ type: 'Select', key: 'account' }))?.props).toMatchObject({ value: 'personal' })
  expect((await ui.find({ type: 'Text', text: /Switching to/ }))?.text).toMatch(/Switching to Personal when this chat is idle/)
  expect((await ui.find({ type: 'Text', text: /^Work/ }))?.text).toMatch(/^Work/)
  await ui.select({ key: 'account', value: 'default' })
  expect(acctRuns()).toEqual([['/opt/ca/app/acct', 'personal'], ['/opt/ca/app/acct', 'default']])
  expect(await ui.find({ type: 'Text', text: /Switching to/ })).toBeFalsy()
  await ui.unmount()
})

test('a demo.json in the config folder replaces every name and number', async ($, on) => {
  const DEMO = {
    account: 'work',
    accounts: { work: { label: 'Work', proX: 5 }, personal: { label: 'Personal', proX: 10 } },
    mine: [{ kind: 'seven_day', percentUsed: 41, resetsInHours: 70 }],
    others: { personal: { label: 'Personal', five: null, seven: 22, sevenInHours: 101 } },
  }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: ENV[e.name] }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('demo.json') ? JSON.stringify(DEMO) : JSON.stringify(ACCOUNTS) }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(PROBES), stderr: '' } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^59%$/ }))?.text).toMatch(/^59%$/)
  expect((await ui.find({ type: 'Text', text: /^78%$/ }))?.text).toMatch(/^78%$/)
  expect(await ui.find({ type: 'Text', text: /Side project/ })).toBeFalsy()
  await ui.unmount()
})

test('each bar is drawn to its plan size: twice the plan, twice the width, the biggest fills the track', async ($, on) => {
  const accounts = { accounts: { default: { proX: 10, label: 'Big' }, side: { proX: 5, label: 'Side' }, tiny: { proX: 0.1, label: 'Tiny' } } }
  const probes = {
    side: { label: 'Side', five: 17, seven: 33, fiveReset: now + 2 * 36e5, sevenReset: now + 5 * 864e5 },
    tiny: { label: 'Tiny', five: 5, seven: 5, fiveReset: now + 2 * 36e5, sevenReset: now + 5 * 864e5 },
  }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: ENV[e.name] }))
  on('session.usage', () => ({ value: { rateLimits: [{ kind: 'seven_day', percentUsed: 7, resetsAt: new Date(now + 6 * 864e5).toISOString() }] } }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('accounts.json') ? JSON.stringify(accounts) : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(probes), stderr: '' } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const width = async (key: string) => (await ui.find({ type: 'Box', key }))?.props.width
  expect(await width('track-mine-7')).toBe('100%')
  expect(await width('track-side-7')).toBe('50%')
  expect(await width('track-side-5')).toBe('50%')
  expect(await width('track-tiny-7')).toBe('20%')
  await ui.unmount()
})

test('the pane shows what `acct auto` reports and the switch runs the opposite command', async ($, on) => {
  const runs: string[][] = []
  let state = 'on'
  let failNext = false
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: ENV[e.name] }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('accounts.json') ? JSON.stringify(ACCOUNTS) : undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === '/usr/bin/python3') return { value: { exitCode: 0, stdout: JSON.stringify(PROBES), stderr: '' } }
    if (failNext && e.argv[2]) return { value: { exitCode: 1, stdout: '', stderr: 'accounts.json is read-only' } }
    if (e.argv[2]) state = e.argv[2]
    return { value: { exitCode: 0, stdout: `${state}\n`, stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Auto-place new chats/ })).toBeTruthy()
  expect((await ui.find({ type: 'Button', key: 'auto-place' }))?.props).toMatchObject({ label: 'On' })
  await ui.press({ key: 'auto-place' })
  expect(runs.filter(a => a[2])).toEqual([['/opt/ca/app/acct', 'auto', 'off']])
  expect((await ui.find({ type: 'Button', key: 'auto-place' }))?.props).toMatchObject({ label: 'Off' })
  await ui.press({ key: 'auto-place' })
  expect(runs.filter(a => a[2]).at(-1)).toEqual(['/opt/ca/app/acct', 'auto', 'on'])
  expect((await ui.find({ type: 'Button', key: 'auto-place' }))?.props).toMatchObject({ label: 'On' })
  failNext = true
  await ui.press({ key: 'auto-place' })
  expect((await ui.find({ type: 'Button', key: 'auto-place' }))?.props).toMatchObject({ label: 'On' })
  await ui.unmount()
})

type Run = { exitCode: number; stdout: string; stderr: string }
type World = {
  env?: Record<string, string>
  accounts?: unknown
  probes?: unknown
  limits?: { kind: string; percentUsed: number; resetsAt: string }[]
  acct?: (argv: string[]) => Run
}
const OK = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '' })
const SEVEN = (percentUsed: number, days = 3.5) => [{ kind: 'seven_day', percentUsed, resetsAt: new Date(now + days * 864e5).toISOString() }]

// Mounts the pane with scripted file and process answers; `w` is read on every call, so a test can change it between steps.
async function boot($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], w: World) {
  const runs: string[][] = []
  const toasts: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: { ...ENV, ...w.env }[e.name] }))
  on('session.usage', () => ({ value: { rateLimits: w.limits ?? [] } }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('accounts.json') ? JSON.stringify(w.accounts ?? ACCOUNTS) : undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === '/usr/bin/python3') return { value: OK(JSON.stringify(w.probes ?? PROBES)) }
    return { value: w.acct ? w.acct(e.argv) : OK('this session -> x') }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  return { ui, runs, toasts, clock }
}

test('a bar without a usable size is full width and never poisons the others', async ($, on) => {
  const accounts = { accounts: { default: { proX: 10, label: 'Big' }, none: { label: 'None' }, junk: { proX: 'big', label: 'Junk' }, zero: { proX: 0, label: 'Zero' } } }
  const p = (label: string) => ({ label, five: null, seven: 5, fiveReset: null, sevenReset: now + 3 * 864e5 })
  const { ui } = await boot($, on, { accounts, probes: { none: p('None'), junk: p('Junk'), zero: p('Zero') }, limits: SEVEN(7) })
  const width = async (key: string) => (await ui.find({ type: 'Box', key }))?.props.width
  expect(await width('track-mine-7')).toBe('100%')
  expect(await width('track-none-7')).toBe('100%')
  expect(await width('track-junk-7')).toBe('100%')
  expect(await width('track-zero-7')).toBe('100%')
  await ui.unmount()
})

test('the current account is drawn to its own plan size too', async ($, on) => {
  const accounts = (small: object) => ({ accounts: { default: { proX: 10, label: 'Big' }, side: { label: 'Side', ...small } } })
  const half = await boot($, on, { env: { CC_ACCOUNT: 'side' }, accounts: accounts({ proX: 5 }), probes: {}, limits: SEVEN(7) })
  expect((await half.ui.find({ type: 'Box', key: 'track-mine-7' }))?.props.width).toBe('50%')
  await half.ui.unmount()
})

test('the current account without a size gets the full width', async ($, on) => {
  const accounts = { accounts: { default: { proX: 10, label: 'Big' }, side: { label: 'Side' } } }
  const { ui } = await boot($, on, { env: { CC_ACCOUNT: 'side' }, accounts, probes: {}, limits: SEVEN(7) })
  expect((await ui.find({ type: 'Box', key: 'track-mine-7' }))?.props.width).toBe('100%')
  await ui.unmount()
})

// Half of the week is left, so an even spend leaves 50%; amber starts at 70% of that.
for (const [used, colour] of [[49, 'success'], [51, 'warning'], [64, 'warning'], [66, 'error']] as const) {
  test(`the fill colour at ${100 - used}% left of the week with half of it to go is ${colour}`, async ($, on) => {
    const { ui } = await boot($, on, { limits: SEVEN(used) })
    expect((await ui.find({ type: 'Box', key: 'a' }))?.props.backgroundColor).toBe(colour)
    await ui.unmount()
  })
}

const autoButton = async (ui: Awaited<ReturnType<typeof boot>>['ui']) => (await ui.find({ type: 'Button', key: 'auto-place' }))?.props

test('when `acct auto` cannot be read the row says unknown, has no On/Off, and pressing it reads again', async ($, on) => {
  let broken = true
  const { ui, runs } = await boot($, on, {
    acct: argv => (broken ? { exitCode: 1, stdout: 'on\n', stderr: 'no accounts.json' } : OK('off\n')),
  })
  expect(await ui.find({ type: 'Text', text: /Auto-place new chats/ })).toBeTruthy()
  expect(await autoButton(ui)).toMatchObject({ label: 'unknown' })
  await ui.press({ key: 'auto-place' })
  expect(await autoButton(ui)).toMatchObject({ label: 'unknown' })
  broken = false
  await ui.press({ key: 'auto-place' })
  expect(runs.filter(a => a[0] === '/opt/ca/app/acct' && a[1] === 'auto' && a[2])).toEqual([])
  expect(await autoButton(ui)).toMatchObject({ label: 'Off' })
  await ui.unmount()
})

test('after a press the switch shows what `acct auto` printed, not what was asked', async ($, on) => {
  // `acct auto off` is answered with `on`
  const { ui } = await boot($, on, { acct: () => OK('on\n') })
  expect(await autoButton(ui)).toMatchObject({ label: 'On' })
  await ui.press({ key: 'auto-place' })
  expect(await autoButton(ui)).toMatchObject({ label: 'On' })
  await ui.unmount()
})

test('a failed press toasts the error text and leaves the switch where it was', async ($, on) => {
  let fail = false
  const { ui, toasts } = await boot($, on, {
    acct: argv => (fail && argv[2] ? { exitCode: 1, stdout: '', stderr: 'accounts.json is read-only' } : OK('on\n')),
  })
  fail = true
  await ui.press({ key: 'auto-place' })
  expect(toasts).toEqual(['accounts.json is read-only'])
  expect(await autoButton(ui)).toMatchObject({ label: 'On' })
  await ui.unmount()
})

test('a failed press with no output at all still says which command failed and how', async ($, on) => {
  let fail = false
  const { ui, toasts } = await boot($, on, {
    acct: argv => (fail && argv[2] ? { exitCode: 3, stdout: '', stderr: '' } : OK('on\n')),
  })
  fail = true
  await ui.press({ key: 'auto-place' })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/auto off/)
  expect(toasts[0]).toMatch(/3/)
  await ui.unmount()
})

test('the dropdown always lists the current and the picked account, even when accounts.json does not name them', async ($, on) => {
  const w: World = { env: { CC_ACCOUNT: 'ghost' }, accounts: { accounts: { default: { label: 'Work' }, personal: { label: 'Personal' } } }, probes: {}, acct: () => OK('this session -> personal') }
  const { ui, clock } = await boot($, on, w)
  const values = async () => ((await ui.find({ type: 'Select', key: 'account' }))?.props.options as { value: string }[]).map(o => o.value).sort()
  expect(await values()).toEqual(['default', 'ghost', 'personal'])
  await ui.select({ key: 'account', value: 'personal' })
  await clock.advance(20 * 1000)
  w.accounts = { accounts: { default: { label: 'Work' } } }
  await clock.advance(20 * 1000)
  expect(await values()).toEqual(['default', 'ghost', 'personal'])
  await ui.unmount()
})

test('a failed `acct <name>` toasts the error and leaves the pick where it was', async ($, on) => {
  const answers: Run[] = [
    { exitCode: 1, stdout: '', stderr: 'no such account' },
    { exitCode: 1, stdout: 'this session -> personal', stderr: 'boom' },
    OK('nothing to do'),
  ]
  const { ui, toasts } = await boot($, on, { acct: argv => (argv[1] === 'auto' ? OK('on\n') : answers.shift() ?? OK(''))  })
  for (let i = 0; i < 3; i++) {
    await ui.select({ key: 'account', value: 'personal' })
    expect((await ui.find({ type: 'Select', key: 'account' }))?.props).toMatchObject({ value: 'default' })
  }
  expect(toasts).toEqual(['no such account', 'boom', 'nothing to do'])
  expect(await ui.find({ type: 'Text', text: /Switching to/ })).toBeFalsy()
  await ui.unmount()
})

test('a chat on a non-default account lists the other subscriptions even before any probe came back', async ($, on) => {
  const { ui } = await boot($, on, { env: { CC_ACCOUNT: 'personal' }, probes: {} })
  expect(await ui.find({ type: 'Text', text: /Other subscriptions/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /No fresh numbers yet/ })).toBeTruthy()
  await ui.unmount()
})

test('a change of accounts.json made elsewhere is picked up by the watcher, including the auto-place state', async ($, on) => {
  let state = 'on'
  const w: World = { acct: () => OK(`${state}\n`) }
  const { ui, clock } = await boot($, on, w)
  expect(await autoButton(ui)).toMatchObject({ label: 'On' })
  await clock.advance(20 * 1000)
  state = 'off'
  w.accounts = { accounts: { default: { label: 'Work' } } }
  await clock.advance(20 * 1000)
  expect(await autoButton(ui)).toMatchObject({ label: 'Off' })
  await ui.unmount()
})
