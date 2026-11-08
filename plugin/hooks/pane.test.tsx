import { expect, test } from 'claude-code/testing'

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
  const acctRuns = () => runs.filter(a => a[0] === '/opt/ca/app/acct')
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
