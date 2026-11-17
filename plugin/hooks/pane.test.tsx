import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subscriptions', component: 'Pane', requestId: 'subscriptions',
  props: { title: 'Subscriptions', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const now = Date.now()
// state/limits.json as the app's main process writes it: one entry per account, `at` = when it was checked.
const PROBES = {
  personal: { five: null, seven: 10, fiveReset: null, sevenReset: now + 3 * 864e5, status: 'allowed', at: now },
  side: { five: 17, seven: 33, fiveReset: now + 2 * 36e5, sevenReset: now + 5 * 864e5, status: 'allowed', at: now },
}
const ACCOUNTS = { accounts: { default: { proX: 6.25, label: 'Work' }, personal: { proX: 10, plan: 'Ultra', label: 'Personal' }, side: { proX: 5, label: 'Side project', note: 'used by the bot' } } }
const ENV: Record<string, string> = { CLAUDE_ACCOUNTS_APP: '/opt/ca/app', CLAUDE_ACCOUNTS_HOME: '/home/.claude-accounts' }

test('each subscription shows what is left and the dropdown moves the chat onto the picked one', async ($, on) => {
  const runs: string[][] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: ENV[e.name] }))
  const file = { ...PROBES, default: { five: 29, seven: 7, fiveReset: now + 36e5, sevenReset: now + 6 * 864e5, status: 'allowed', at: now } }
  on('fs.read', (_, e) => ({ value: e.path.endsWith('accounts.json') ? JSON.stringify(ACCOUNTS) : e.path.endsWith('state/limits.json') ? JSON.stringify(file) : undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'this session -> personal (Personal)', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^71%$/ }))?.text).toMatch(/^71%$/)
  expect((await ui.find({ type: 'Text', text: /^90%$/ }))?.text).toMatch(/^90%$/)
  expect((await ui.find({ type: 'Text', text: /used by/ }))?.text).toMatch(/used by the bot/)
  expect(await ui.find({ type: 'Button', key: 'add-subscription' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /This chat runs on/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /This chat runs on/ }))?.text).toMatch(/^This chat runs on\s+Work\s+6\.25x/)
  expect(await ui.find({ type: 'Text', text: /Switching to/ })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /Ultra · 10x/ }))?.text).toMatch(/Personal\s+Ultra · 10x/)
  const card = async (k: string) => (await ui.find({ type: 'Box', key: `card-${k}` }))?.props
  expect(await card('default')).toMatchObject({ borderStyle: 'round', borderColor: 'claude', borderDimColor: false })
  expect(await card('personal')).toMatchObject({ borderStyle: 'round', borderDimColor: true })
  expect((await card('personal'))?.borderColor).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'move-default' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'move-personal' })).toMatchObject({ props: { label: 'Use' } })
  const picker = await ui.find({ type: 'Select', key: 'account' })
  expect(picker?.props).toMatchObject({ value: 'default', options: [{ value: 'default' }, { value: 'personal' }, { value: 'side' }] })
  const acctRuns = () => runs.filter(a => a[0] === '/opt/ca/app/acct' && a[1] !== 'auto')
  await ui.select({ key: 'account', value: 'default' })
  expect(acctRuns()).toEqual([])
  await ui.select({ key: 'account', value: 'personal' })
  expect(acctRuns()).toEqual([['/opt/ca/app/acct', 'personal']])
  expect((await ui.find({ type: 'Select', key: 'account' }))?.props).toMatchObject({ value: 'personal' })
  expect((await ui.find({ type: 'Text', text: /Switching to/ }))?.text).toMatch(/Switching to Personal when this chat is idle/)
  expect((await ui.find({ type: 'Text', text: /This chat runs on/ }))?.text).toMatch(/^This chat runs on\s+Work/)
  expect(await card('personal')).toMatchObject({ borderColor: 'claude', borderDimColor: false })
  expect(await card('default')).toMatchObject({ borderDimColor: true })
  expect(await ui.find({ type: 'Button', key: 'move-default' })).toMatchObject({ props: { label: 'Use' } })
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
  on('fs.read', (_, e) => ({ value: e.path.endsWith('demo.json') ? JSON.stringify(DEMO) : e.path.endsWith('limits.json') ? JSON.stringify({ ...PROBES, work: { five: null, seven: 99, fiveReset: null, sevenReset: now + 864e5, at: now } }) : JSON.stringify(ACCOUNTS) }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
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
    default: { five: null, seven: 7, fiveReset: null, sevenReset: now + 6 * 864e5, at: now },
    side: { five: 17, seven: 33, fiveReset: now + 2 * 36e5, sevenReset: now + 5 * 864e5, at: now },
    tiny: { five: 5, seven: 5, fiveReset: now + 2 * 36e5, sevenReset: now + 5 * 864e5, at: now },
  }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: ENV[e.name] }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('accounts.json') ? JSON.stringify(accounts) : e.path.endsWith('limits.json') ? JSON.stringify(probes) : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const width = async (key: string) => (await ui.find({ type: 'Box', key }))?.props.width
  expect(await width('track-mine-7')).toBe('100%')
  expect(await width('track-side-7')).toBe('50%')
  expect(await width('track-side-5')).toBe('50%')
  expect(await width('track-tiny-7')).toBe('4%')
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
  on('fs.read', (_, e) => ({ value: e.path.endsWith('accounts.json') ? JSON.stringify(ACCOUNTS) : undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
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
  // the content of state/limits.json: an object, a string (verbatim, e.g. broken JSON) or undefined (no file)
  limits?: unknown
  acct?: (argv: string[]) => Run | Promise<Run>
}
const OK = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '' })
const SEVEN = (seven: number, days = 3.5) => ({ five: null, seven, fiveReset: null, sevenReset: now + days * 864e5, at: now })

// Mounts the pane with scripted file and process answers; `w` is read on every call, so a test can change it between steps.
async function boot($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], w: World) {
  const runs: string[][] = []
  const toasts: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: { ...ENV, ...w.env }[e.name] }))
  const read = (path: string) => {
    if (path.endsWith('accounts.json')) return JSON.stringify(w.accounts ?? ACCOUNTS)
    if (path.endsWith('state/limits.json') && 'limits' in w) return typeof w.limits === 'string' || w.limits === undefined ? w.limits : JSON.stringify(w.limits)
    if (path.endsWith('state/limits.json')) return JSON.stringify(PROBES)
    return undefined
  }
  const logs: string[] = []
  on('fs.read', (_, e) => ({ value: read(e.path) }))
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('process.run', async (_, e) => {
    runs.push([...e.argv])
    return { value: w.acct ? await w.acct(e.argv) : OK('this session -> x') }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  return { ui, runs, toasts, clock, logs }
}

test('a plan is drawn in proportion, not floored; one below the minimum share is drawn at exactly the minimum', async ($, on) => {
  const accounts = { accounts: { default: { proX: 20, label: 'Big' }, one: { proX: 1, label: 'One' }, speck: { proX: 0.2, label: 'Speck' } } }
  const p = (_label: string) => ({ five: null, seven: 5, fiveReset: null, sevenReset: now + 3 * 864e5, at: now })
  const { ui } = await boot($, on, { accounts, limits: { default: SEVEN(7), one: p('One'), speck: p('Speck') } })
  const width = async (key: string) => (await ui.find({ type: 'Box', key }))?.props.width
  expect(await width('track-mine-7')).toBe('100%')
  expect(await width('track-one-7')).toBe('5%')
  expect(await width('track-speck-7')).toBe('4%')
  await ui.unmount()
})

test('a bar without a usable size is full width and never poisons the others', async ($, on) => {
  const accounts = { accounts: { default: { proX: 10, label: 'Big' }, none: { label: 'None' }, junk: { proX: 'big', label: 'Junk' }, zero: { proX: 0, label: 'Zero' } } }
  const p = (_label: string) => ({ five: null, seven: 5, fiveReset: null, sevenReset: now + 3 * 864e5, at: now })
  const { ui } = await boot($, on, { accounts, limits: { default: SEVEN(7), none: p('None'), junk: p('Junk'), zero: p('Zero') } })
  const width = async (key: string) => (await ui.find({ type: 'Box', key }))?.props.width
  expect(await width('track-mine-7')).toBe('100%')
  expect(await width('track-none-7')).toBe('100%')
  expect(await width('track-junk-7')).toBe('100%')
  expect(await width('track-zero-7')).toBe('100%')
  await ui.unmount()
})

test('the current account is drawn to its own plan size too', async ($, on) => {
  const accounts = (small: object) => ({ accounts: { default: { proX: 10, label: 'Big' }, side: { label: 'Side', ...small } } })
  const half = await boot($, on, { env: { CC_ACCOUNT: 'side' }, accounts: accounts({ proX: 5 }), limits: { side: SEVEN(7) } })
  expect((await half.ui.find({ type: 'Box', key: 'track-mine-7' }))?.props.width).toBe('50%')
  await half.ui.unmount()
})

test('the current account without a size gets the full width', async ($, on) => {
  const accounts = { accounts: { default: { proX: 10, label: 'Big' }, side: { label: 'Side' } } }
  const { ui } = await boot($, on, { env: { CC_ACCOUNT: 'side' }, accounts, limits: { side: SEVEN(7) } })
  expect((await ui.find({ type: 'Box', key: 'track-mine-7' }))?.props.width).toBe('100%')
  await ui.unmount()
})

// Half of the week is left, so an even spend leaves 50%; amber starts at 70% of that.
for (const [used, colour] of [[49, 'success'], [51, 'warning'], [64, 'warning'], [66, 'error']] as const) {
  test(`the fill colour at ${100 - used}% left of the week with half of it to go is ${colour}`, async ($, on) => {
    const { ui } = await boot($, on, { limits: { default: SEVEN(used) } })
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
  const w: World = { env: { CC_ACCOUNT: 'ghost' }, accounts: { accounts: { default: { label: 'Work' }, personal: { label: 'Personal' } } }, limits: {}, acct: () => OK('this session -> personal') }
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
  const { ui } = await boot($, on, { env: { CC_ACCOUNT: 'personal' }, limits: {} })
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

const autoRuns = (runs: string[][]) => runs.filter(a => a[0] === '/opt/ca/app/acct' && a[1] === 'auto')

test('a slow read that answers after a press does not put the old state back', async ($, on) => {
  let state = 'on'
  let release: (r: Run) => void = () => {}
  let slow = false
  const w: World = {
    acct: argv => {
      if (argv[2]) { state = argv[2]; return OK(`${state}\n`) }
      if (slow) { slow = false; return new Promise<Run>(r => { release = r }) }
      return OK(`${state}\n`)
    },
  }
  const { ui, clock } = await boot($, on, w)
  expect(await autoButton(ui)).toMatchObject({ label: 'On' })
  await clock.advance(20 * 1000)
  slow = true
  w.accounts = { accounts: { default: { label: 'Work' } } }
  void clock.advance(20 * 1000)
  await new Promise(r => setTimeout(r, 50))
  await ui.press({ key: 'auto-place' })
  expect(await autoButton(ui)).toMatchObject({ label: 'Off' })
  release(OK('on\n'))
  await new Promise(r => setTimeout(r, 50))
  expect(await autoButton(ui)).toMatchObject({ label: 'Off' })
  await ui.unmount()
})

for (const [name, out] of [['empty', ''], ['whitespace', ' \n'], ['garbage', 'maybe\n'], ['a near miss', 'ON']] as const) {
  test(`${name} output from \`acct auto\` with exit code 0 is an unknown state on read, and pressing it only reads again`, async ($, on) => {
    let bad = true
    const { ui, runs } = await boot($, on, { acct: () => OK(bad ? out : 'off\n') })
    expect(await autoButton(ui)).toMatchObject({ label: 'unknown' })
    bad = false
    await ui.press({ key: 'auto-place' })
    expect(autoRuns(runs).filter(a => a[2])).toEqual([])
    expect(await autoButton(ui)).toMatchObject({ label: 'Off' })
    await ui.unmount()
  })

  test(`${name} output from a press with exit code 0 is an unknown state, not the requested value`, async ($, on) => {
    let bad = false
    const { ui } = await boot($, on, { acct: argv => (bad && argv[2] ? OK(out) : OK('on\n')) })
    expect(await autoButton(ui)).toMatchObject({ label: 'On' })
    bad = true
    await ui.press({ key: 'auto-place' })
    expect(await autoButton(ui)).toMatchObject({ label: 'unknown' })
    await ui.unmount()
  })
}

test('pressing unknown when the read fails again toasts that the state could not be read, with stderr', async ($, on) => {
  const { ui, toasts } = await boot($, on, { acct: () => ({ exitCode: 1, stdout: '', stderr: 'no accounts.json' }) })
  expect(await autoButton(ui)).toMatchObject({ label: 'unknown' })
  expect(toasts).toEqual([])
  await ui.press({ key: 'auto-place' })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/could not be read|Could not read/i)
  expect(toasts[0]).toMatch(/no accounts\.json/)
  expect(await autoButton(ui)).toMatchObject({ label: 'unknown' })
  await ui.unmount()
})

test('a retry that works toasts nothing', async ($, on) => {
  let broken = true
  const { ui, toasts } = await boot($, on, { acct: () => (broken ? { exitCode: 1, stdout: '', stderr: 'x' } : OK('on\n')) })
  broken = false
  await ui.press({ key: 'auto-place' })
  expect(toasts).toEqual([])
  expect(await autoButton(ui)).toMatchObject({ label: 'On' })
  await ui.unmount()
})

for (const [mode, expected] of [['independent', '100%'], ['adaptive', '50%'], ['nonsense', '50%']] as const) {
  test(`barScale "${mode}" draws the smaller plan's bar ${expected} wide`, async ($, on) => {
    const accounts = { barScale: mode, accounts: { default: { proX: 10, label: 'Big' }, side: { proX: 5, label: 'Side' } } }
    const limits = { side: { five: 17, seven: 33, fiveReset: now + 2 * 36e5, sevenReset: now + 5 * 864e5, at: now } }
    const { ui } = await boot($, on, { accounts, limits })
    expect((await ui.find({ type: 'Box', key: 'track-side-7' }))?.props.width).toBe(expected)
    await ui.unmount()
  })
}

test('the Bar width button flips between plan size and full width through acct scale, and shows a failure', async ($, on) => {
  const accounts = { accounts: { default: { proX: 10, label: 'Big' }, side: { proX: 5, label: 'Side' } } }
  const limits = { side: { five: 17, seven: 33, fiveReset: now + 2 * 36e5, sevenReset: now + 5 * 864e5, at: now } }
  let fail = false
  const { ui, runs, toasts } = await boot($, on, {
    accounts, limits,
    acct: async argv => (fail ? { exitCode: 1, stdout: '', stderr: 'cannot write accounts.json' } : OK(argv[2] ?? '')),
  })
  const width = async () => (await ui.find({ type: 'Box', key: 'track-side-7' }))?.props.width
  const button = async () => (await ui.find({ type: 'Button', key: 'bar-scale' }))?.props
  expect(await ui.find({ type: 'Text', text: /Bar width/ })).toBeTruthy()
  expect(await button()).toMatchObject({ label: 'Plan size' })
  expect(await width()).toBe('50%')
  await ui.press({ key: 'bar-scale' })
  expect(runs.filter(a => a[1] === 'scale')).toEqual([['/opt/ca/app/acct', 'scale', 'independent']])
  expect(await button()).toMatchObject({ label: 'Full' })
  expect(await width()).toBe('100%')
  await ui.press({ key: 'bar-scale' })
  expect(runs.filter(a => a[1] === 'scale').pop()).toEqual(['/opt/ca/app/acct', 'scale', 'adaptive'])
  expect(await width()).toBe('50%')
  fail = true
  await ui.press({ key: 'bar-scale' })
  expect(toasts).toEqual(['cannot write accounts.json'])
  expect(await button()).toMatchObject({ label: 'Plan size' })
  expect(await width()).toBe('50%')
  await ui.unmount()
})

test('the dropdown stands alone, without a "Switch to" label', async ($, on) => {
  const { ui } = await boot($, on, {})
  expect(await ui.find({ type: 'Select', key: 'account' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Switch to$/ })).toBeFalsy()
  await ui.unmount()
})

// ---- one shared source: state/limits.json, read by every chat ----

const SIDE = { five: 17, seven: 33, fiveReset: now + 2 * 36e5, sevenReset: now + 5 * 864e5, at: now }
const WORK = { five: 29, seven: 7, fiveReset: now + 36e5, sevenReset: now + 6 * 864e5, at: now }
const FILE = { default: WORK, personal: PROBES.personal, side: SIDE }
const hasText = async (ui: Awaited<ReturnType<typeof boot>>['ui'], text: string) => !!(await ui.find({ type: 'Text', text: new RegExp(`^${text}$`) }))
const left = (used: number) => `${100 - used}%`

for (const chat of ['default', 'side'] as const) {
  test(`a chat on "${chat}" draws every subscription, its own included, from the file`, async ($, on) => {
    const { ui } = await boot($, on, { env: { CC_ACCOUNT: chat }, limits: FILE })
    // 5-hour and weekly numbers of work, side and personal as the file has them; they are distinct, so each must come from its own entry
    for (const text of [left(WORK.five), left(WORK.seven), left(SIDE.five), left(SIDE.seven), left(PROBES.personal.seven)]) {
      expect(await hasText(ui, text)).toBe(true)
    }
    await ui.unmount()
  })
}

test('what this chat itself last measured does not reach the bars', async ($, on) => {
  on('session.usage', () => ({ value: { rateLimits: [{ kind: 'five_hour', percentUsed: 99, resetsAt: new Date(now + 36e5).toISOString() }, { kind: 'seven_day', percentUsed: 98, resetsAt: new Date(now + 864e5).toISOString() }] } }))
  const { ui } = await boot($, on, { limits: FILE })
  expect(await hasText(ui, left(WORK.five))).toBe(true)
  expect(await hasText(ui, left(99))).toBe(false)
  expect(await hasText(ui, left(98))).toBe(false)
  await ui.unmount()
})

test('a chat never probes the limits itself: no process is run to get the numbers', async ($, on) => {
  const w: World = { limits: FILE }
  const { ui, runs, clock } = await boot($, on, w)
  await clock.advance(11 * 60 * 1000)
  expect(runs.filter(a => a[0] === '/usr/bin/python3' || a.some(x => x.endsWith('limits.py')))).toEqual([])
  await ui.unmount()
})

test('a file the app rewrote is picked up on the next tick, and not before', async ($, on) => {
  const w: World = { limits: { ...FILE } }
  const { ui, clock } = await boot($, on, w)
  expect(await hasText(ui, left(SIDE.seven))).toBe(true)
  w.limits = { ...FILE, side: { ...SIDE, seven: 60, at: now + 1000 } }
  expect(await hasText(ui, left(60))).toBe(false)
  await clock.advance(20 * 1000)
  expect(await hasText(ui, left(60))).toBe(true)
  expect(await hasText(ui, left(SIDE.seven))).toBe(false)
  await ui.unmount()
})

test('a new subscription whose numbers the app has written shows up on the next tick', async ($, on) => {
  const w: World = { limits: { default: WORK } }
  const { ui, clock } = await boot($, on, w)
  expect(await hasText(ui, left(SIDE.seven))).toBe(false)
  w.accounts = ACCOUNTS
  w.limits = FILE
  await clock.advance(20 * 1000)
  expect(await hasText(ui, left(SIDE.seven))).toBe(true)
  await ui.unmount()
})

for (const [what, limits] of [['missing', undefined], ['not JSON', '{"default": {"five": 1'], ['not an object', '[1, 2]']] as const) {
  test(`a limits file that is ${what} leaves the pane without numbers, with no times and a reason in the debug log`, async ($, on) => {
    const { ui, logs } = await boot($, on, { limits })
    expect(await ui.find({ type: 'Box', key: 'track-mine-7' })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /Checked at/ })).toBeFalsy()
    expect(logs.some(l => l.includes('limits.json'))).toBe(true)
    await ui.unmount()
  })
}

test('a file that is torn once keeps the last good numbers and is read again on the next tick', async ($, on) => {
  const w: World = { limits: FILE }
  const { ui, clock } = await boot($, on, w)
  w.limits = '{"default": {"five": 1'
  await clock.advance(20 * 1000)
  expect(await hasText(ui, left(WORK.seven))).toBe(true)
  w.limits = { ...FILE, default: { ...WORK, seven: 50, at: now + 1000 } }
  await clock.advance(20 * 1000)
  expect(await hasText(ui, left(50))).toBe(true)
  await ui.unmount()
})

test('an account the file could not check shows its error, an account with no numbers shows no invented bar', async ($, on) => {
  const limits = { default: WORK, side: { error: 'org_disabled', at: now }, personal: { unknown: true, status: 'allowed', at: now } }
  const { ui } = await boot($, on, { limits })
  expect(await ui.find({ type: 'Text', text: /Couldn't check: org_disabled/ })).toBeTruthy()
  expect(await ui.find({ type: 'Box', key: 'track-personal-7' })).toBeFalsy()
  expect(await ui.find({ type: 'Box', key: 'track-side-7' })).toBeFalsy()
  await ui.unmount()
})

test('the checked time is the newest `at` in the file', async ($, on) => {
  const old = new Date(now - 3 * 36e5), fresh = new Date(now - 36e5)
  const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const { ui } = await boot($, on, { limits: { default: { ...WORK, at: old.getTime() }, side: { ...SIDE, at: fresh.getTime() } } })
  const text = (await ui.find({ type: 'Text', text: /Checked at/ }))?.text ?? ''
  expect(text).toContain(hm(fresh))
  expect(text).not.toContain(hm(old))
  await ui.unmount()
})

test('an account that is in the file but no longer in accounts.json is not drawn', async ($, on) => {
  const { ui } = await boot($, on, { limits: { ...FILE, removed: { ...SIDE, seven: 71 } } })
  expect(await hasText(ui, left(SIDE.seven))).toBe(true)
  expect(await hasText(ui, left(71))).toBe(false)
  await ui.unmount()
})
