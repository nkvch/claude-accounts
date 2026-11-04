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
const ACCOUNTS = { accounts: { default: { proX: 6.25, label: 'Work' }, personal: { proX: 10, label: 'Personal' }, side: { proX: 5, label: 'Side project', note: 'used by the bot' } } }
const ENV: Record<string, string> = { CLAUDE_ACCOUNTS_APP: '/opt/ca/app', CLAUDE_ACCOUNTS_HOME: '/home/.claude-accounts' }

test('each subscription shows what is left and a button moves the chat onto it', async ($, on) => {
  const runs: string[][] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: ENV[e.name] }))
  on('session.usage', () => ({ value: { rateLimits: [{ kind: 'five_hour', percentUsed: 29, resetsAt: new Date(now + 36e5).toISOString() }, { kind: 'seven_day', percentUsed: 7, resetsAt: new Date(now + 6 * 864e5).toISOString() }] } }))
  on('fs.read', () => ({ value: JSON.stringify(ACCOUNTS) }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: e.argv[0] === '/usr/bin/python3' ? JSON.stringify(PROBES) : 'this session -> personal (Personal)', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /71% left/ }))?.text).toMatch(/71% left/)
  expect((await ui.find({ type: 'Text', text: /90% left/ }))?.text).toMatch(/90% left/)
  expect((await ui.find({ type: 'Text', text: /used by/ }))?.text).toMatch(/used by the bot/)
  expect(await ui.find({ type: 'Button', key: 'add-subscription' })).toBeTruthy()
  await ui.press({ key: 'move-personal' })
  expect(runs.some(a => a[0] === '/opt/ca/app/acct' && a[1] === 'personal')).toBe(true)
  await ui.unmount()
})
