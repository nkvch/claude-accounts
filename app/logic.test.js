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
  accounts: { default: {}, cr: { tokenKey: "CC_TOKEN_CR", proX: 10 }, bk: { tokenKey: "CC_TOKEN_BK", proX: 1 } },
  sessionStore: "a/b", ...extra,
});
const good = () => ({ five: 0, seven: 0, sevenReset: Date.now() + 30 * DAY, status: "allowed", at: Date.now() });
const desktopEnv = () => ({ CLAUDE_CODE_OAUTH_TOKEN: "desktop-token", CLAUDE_CODE_USER_EMAIL: "me@example.com" });
const run = (sid, state, cwd = "/tmp/proj") => {
  const env = desktopEnv();
  logic.acct(state, sid, cwd, env);
  return env;
};
const child = (sid, parent) => {
  const dir = path.join(SESSIONS, "a/b");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ spawnedFrom: { sessionId: parent }, createdAt: Date.now() }));
};

beforeEach(() => {
  fs.rmSync(path.join(HOME, "state"), { recursive: true, force: true });
  fs.rmSync(path.join(SESSIONS, "a"), { recursive: true, force: true });
  config();
  write("tokens.env", "CC_TOKEN_CR=fake-cr\nCC_TOKEN_BK=fake-bk\n");
  write("state/limits.json", { cr: good(), bk: good() });
});

test("a sub-session inherits a healthy override of its parent and remembers it", () => {
  write("state/overrides.json", { parent: "cr" });
  child("child", "parent");
  const state = { chosen: new Map() };
  run("parent", state);
  const env = run("child", state);
  assert.strictEqual(env.CC_ACCOUNT, "cr");
  assert.strictEqual(overrides().child, "cr");
});

test("a sub-session does not pin the fallback its parent was moved to", () => {
  write("state/overrides.json", { parent: "cr" });
  write("state/limits.json", { cr: { error: "org_disabled", at: Date.now() }, bk: good() });
  child("child", "parent");
  const state = { chosen: new Map() };
  assert.strictEqual(run("parent", state).CC_ACCOUNT, "bk");
  assert.strictEqual(run("child", state).CC_ACCOUNT, "bk");
  assert.notStrictEqual(overrides().child, "bk");
  assert.ok([undefined, "cr"].includes(overrides().child));

  write("state/limits.json", { cr: good(), bk: good() });
  assert.strictEqual(run("child", { chosen: new Map() }).CC_ACCOUNT, "cr");
});

test("a sub-session of a default parent leaves no permanent default override", () => {
  config({ rules: [{ folder: "/tmp/pinned", account: "cr" }] });
  write("state/limits.json", {});
  child("child", "parent");
  const state = { chosen: new Map() };
  run("parent", state, "/tmp/other");
  const env = run("child", state, "/tmp/pinned");
  assert.strictEqual(env.CC_ACCOUNT, undefined);
  assert.strictEqual(overrides().child, undefined);
});
