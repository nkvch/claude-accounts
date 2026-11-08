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

const record = (sid, createdAt) => {
  const dir = path.join(SESSIONS, "a/b");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ createdAt }));
};

test("autoPlace missing: a new chat is placed on the best account", () => {
  const env = run("s1", { chosen: new Map() });
  assert.strictEqual(env.CC_ACCOUNT, "cr");
  assert.strictEqual(overrides().s1, "cr");
});

test("autoPlace true: a new chat is placed on the best account", () => {
  config({ autoPlace: true });
  assert.strictEqual(run("s1", { chosen: new Map() }).CC_ACCOUNT, "cr");
});

test("autoPlace false: a new chat stays on the desktop login and nothing is remembered", () => {
  config({ autoPlace: false });
  const state = { chosen: new Map() };
  const env = run("s1", state);
  assert.strictEqual(env.CC_ACCOUNT, undefined);
  assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, "desktop-token");
  assert.strictEqual(state.chosen.get("s1"), "default");
  assert.strictEqual(overrides().s1, undefined);
});

test("an old chat is not placed in either mode", () => {
  record("s1", Date.now() - 2 * DAY);
  for (const autoPlace of [true, false]) {
    config({ autoPlace });
    assert.strictEqual(run("s1", { chosen: new Map() }).CC_ACCOUNT, undefined);
  }
});

test("a failed subscription falls back to the best working one with autoPlace, to default without", () => {
  write("state/overrides.json", { s1: "cr" });
  write("state/limits.json", { cr: { error: "org_disabled", at: Date.now() }, bk: good() });
  assert.strictEqual(run("s1", { chosen: new Map() }).CC_ACCOUNT, "bk");

  config({ autoPlace: false });
  const state = { chosen: new Map() };
  const env = run("s1", state);
  assert.strictEqual(env.CC_ACCOUNT, undefined);
  assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, "desktop-token");
  assert.strictEqual(state.chosen.get("s1"), "default");
  assert.strictEqual(overrides().s1, "cr");
});

test("an explicit override works in both modes", () => {
  for (const autoPlace of [true, false]) {
    config({ autoPlace });
    write("state/overrides.json", { s1: "bk" });
    assert.strictEqual(run("s1", { chosen: new Map() }).CC_ACCOUNT, "bk");
  }
});

test("a folder rule works in both modes", () => {
  for (const autoPlace of [true, false]) {
    config({ autoPlace, rules: [{ folder: "/tmp/pinned", account: "bk" }] });
    assert.strictEqual(run("s1", { chosen: new Map() }, "/tmp/pinned/sub").CC_ACCOUNT, "bk");
  }
});

test("flipping autoPlace takes effect on the next pick without reloading", () => {
  config({ autoPlace: false });
  assert.strictEqual(run("s1", { chosen: new Map() }).CC_ACCOUNT, undefined);
  config({ autoPlace: true });
  assert.strictEqual(run("s2", { chosen: new Map() }).CC_ACCOUNT, "cr");
});

const { spawnSync } = require("node:child_process");
const ACCT = path.join(__dirname, "acct");
const acct = (home, ...args) => spawnSync("bash", [ACCT, ...args], {
  env: { ...process.env, CLAUDE_ACCOUNTS_HOME: home }, encoding: "utf8",
});
const cliHome = (text) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acct-cli-"));
  if (text !== undefined) fs.writeFileSync(path.join(home, "accounts.json"), text);
  return home;
};

test("acct auto reads on when the flag is missing and round-trips on/off keeping the rest", () => {
  const original = '{\n  "accounts": { "default": {} },\n  "rules": [\n    { "folder": "/x", "account": "default" }\n  ]\n}\n';
  const home = cliHome(original);
  const file = path.join(home, "accounts.json");
  assert.strictEqual(acct(home, "auto").stdout, "on\n");

  assert.strictEqual(acct(home, "auto", "off").stdout, "off\n");
  assert.strictEqual(acct(home, "auto").stdout, "off\n");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ...JSON.parse(original), autoPlace: false });
  assert.ok(fs.readFileSync(file, "utf8").includes('  "accounts": { "default": {} },\n  "rules": [\n    { "folder": "/x"'));

  assert.strictEqual(acct(home, "auto", "on").stdout, "on\n");
  assert.strictEqual(acct(home, "auto").stdout, "on\n");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ...JSON.parse(original), autoPlace: true });
  assert.deepStrictEqual(fs.readdirSync(home), ["accounts.json"]);
});

test("acct auto on an existing flag changes only its value", () => {
  const home = cliHome('{\n  "autoPlace": true,\n  "accounts": {}\n}\n');
  acct(home, "auto", "off");
  assert.strictEqual(fs.readFileSync(path.join(home, "accounts.json"), "utf8"), '{\n  "autoPlace": false,\n  "accounts": {}\n}\n');
});

test("acct auto fails loudly on invalid or missing JSON and leaves the file alone", () => {
  const home = cliHome("{ not json");
  for (const args of [["auto"], ["auto", "off"]]) {
    const r = acct(home, ...args);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /cannot read .*accounts\.json/);
  }
  assert.strictEqual(fs.readFileSync(path.join(home, "accounts.json"), "utf8"), "{ not json");
  assert.deepStrictEqual(fs.readdirSync(home), ["accounts.json"]);

  const missing = acct(cliHome(), "auto", "on");
  assert.notStrictEqual(missing.status, 0);
  assert.match(missing.stderr, /cannot read/);
});

test("acct auto rejects a bad argument", () => {
  const home = cliHome('{"accounts":{}}');
  const r = acct(home, "auto", "maybe");
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /usage/);
});
