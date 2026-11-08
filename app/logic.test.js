const { test, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "acct-home-"));
const SESSIONS = fs.mkdtempSync(path.join(os.tmpdir(), "acct-sessions-"));
process.env.CLAUDE_ACCOUNTS_HOME = HOME;
process.env.CC_SESSIONS_ROOT = SESSIONS;
const logic = require(process.env.LOGIC_UNDER_TEST || "./logic.js");

const DAY = 24 * 3600 * 1000;
const write = (rel, data) => {
  const f = path.join(HOME, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data));
};
const overrides = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, "state/overrides.json"), "utf8")); } catch { return {}; } };
const config = (extra = {}) => write("accounts.json", {
  accounts: { default: {}, cr: { tokenKey: "CC_TOKEN_CR", proX: 10 } },
  sessionStore: "a/b", ...extra,
});
const limits = (cr) => write("state/limits.json", { cr });
const goodCr = () => ({ five: 0, seven: 0, sevenReset: Date.now() + 30 * DAY, status: "allowed", at: Date.now() });
const desktopEnv = () => ({ CLAUDE_CODE_OAUTH_TOKEN: "desktop-token", CLAUDE_CODE_USER_EMAIL: "me@example.com" });
const run = (sid, cwd = "/tmp/proj", state = { chosen: new Map() }, env = desktopEnv()) => {
  logic.acct(state, sid, cwd, env);
  return { state, env };
};

beforeEach(() => {
  fs.rmSync(path.join(HOME, "state"), { recursive: true, force: true });
  fs.rmSync(path.join(SESSIONS, "a"), { recursive: true, force: true });
  config();
  write("tokens.env", "CC_TOKEN_CR=fake-token\n");
  limits(goodCr());
});

test("new chat stays on default even when another account has far more room", () => {
  const { state, env } = run("s1");
  assert.strictEqual(env.CC_ACCOUNT, undefined);
  assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, "desktop-token");
  assert.strictEqual(state.chosen.get("s1"), "default");
  assert.strictEqual(overrides().s1, undefined);
});

test("override moves the chat to the account and drops the desktop identity", () => {
  write("state/overrides.json", { s1: "cr" });
  const { state, env } = run("s1");
  assert.strictEqual(env.CC_ACCOUNT, "cr");
  assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, "fake-token");
  assert.strictEqual(env.CLAUDE_CODE_USER_EMAIL, undefined);
  assert.strictEqual(state.chosen.get("s1"), "cr");
});

test("override to an account whose probe failed falls back to default", () => {
  config({ accounts: { default: {}, cr: { tokenKey: "CC_TOKEN_CR", proX: 10 }, bk: { tokenKey: "CC_TOKEN_BK", proX: 1 } } });
  write("tokens.env", "CC_TOKEN_CR=fake-token\nCC_TOKEN_BK=other-token\n");
  write("state/overrides.json", { s1: "cr" });
  write("state/limits.json", { cr: { error: "org_disabled", at: Date.now() }, bk: goodCr() });
  const { state, env } = run("s1");
  assert.strictEqual(env.CC_ACCOUNT, undefined);
  assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, "desktop-token");
  assert.strictEqual(state.chosen.get("s1"), "default");
  assert.strictEqual(overrides().s1, "cr");
});

test("a transient probe error does not move the chat off its account", () => {
  write("state/overrides.json", { s1: "cr" });
  limits({ error: "TypeError", at: Date.now() });
  const { env } = run("s1");
  assert.strictEqual(env.CC_ACCOUNT, "cr");
  assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, "fake-token");
});

test("a folder rule pins the project to its account", () => {
  config({ rules: [{ folder: "/tmp/pinned", account: "cr" }] });
  const { env } = run("s1", "/tmp/pinned/sub");
  assert.strictEqual(env.CC_ACCOUNT, "cr");
});

test("a sub-session inherits its parent's account", () => {
  const dir = path.join(SESSIONS, "a/b");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "child.json"), JSON.stringify({ spawnedFrom: { sessionId: "parent" } }));
  const state = { chosen: new Map([["parent", "cr"]]) };
  const { env } = run("child", "/tmp/proj", state);
  assert.strictEqual(env.CC_ACCOUNT, "cr");
  assert.strictEqual(state.chosen.get("child"), "cr");
});

const child = (sid, parent) => {
  const dir = path.join(SESSIONS, "a/b");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ spawnedFrom: { sessionId: parent }, createdAt: Date.now() }));
};

test("a sub-session inherits a healthy override of its parent and remembers it", () => {
  write("state/overrides.json", { parent: "cr" });
  child("child", "parent");
  const state = { chosen: new Map() };
  run("parent", "/tmp/proj", state);
  const { env } = run("child", "/tmp/proj", state);
  assert.strictEqual(env.CC_ACCOUNT, "cr");
  assert.strictEqual(overrides().child, "cr");
});

test("a sub-session does not pin the fallback its parent was moved to", () => {
  write("state/overrides.json", { parent: "cr" });
  limits({ error: "org_disabled", at: Date.now() });
  child("child", "parent");
  const state = { chosen: new Map() };
  assert.strictEqual(run("parent", "/tmp/proj", state).env.CC_ACCOUNT, undefined);
  assert.strictEqual(run("child", "/tmp/proj", state).env.CC_ACCOUNT, undefined);
  assert.strictEqual(state.chosen.get("child"), "default");
  assert.strictEqual(overrides().child, "cr");

  limits(goodCr());
  assert.strictEqual(run("child", "/tmp/proj", { chosen: new Map() }).env.CC_ACCOUNT, "cr");
});

test("a sub-session of a default parent leaves no permanent default override", () => {
  config({ rules: [{ folder: "/tmp/pinned", account: "cr" }] });
  child("child", "parent");
  const state = { chosen: new Map() };
  run("parent", "/tmp/other", state);
  const { env } = run("child", "/tmp/pinned", state);
  assert.strictEqual(env.CC_ACCOUNT, undefined);
  assert.strictEqual(overrides().child, undefined);
});
