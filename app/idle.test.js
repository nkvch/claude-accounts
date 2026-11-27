const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { patchIdle } = require("./idle.js");

// Real fragment of the app's bundle (7.37095.0): the idle timeout of Code sessions.
const FRAGMENT = fs.readFileSync(path.join(__dirname, "fixtures/idle-fragment.js"), "utf8");
const once = (src, re, replace, what) => {
  const hits = src.match(new RegExp(re.source, "g"));
  if (!hits || hits.length !== 1) throw new Error(`${what}: expected 1 match, got ${hits ? hits.length : 0}`);
  return src.replace(re, replace);
};

// Runs the (patched) fragment with stubs for the app's helpers; returns idleTimeoutMs(sessionId).
function timeoutFor(src, { flag, session }) {
  let config;
  const t = { IPt: () => flag, I0: (id, held) => held(id)?.scheduledTaskId !== undefined };
  const Jt = { H: function (c) { config = c; return { getState: () => ({ unused: false }) }; } };
  const manager = { held: (id) => (session ? { ...session } : undefined) };
  new Function("t", "Jt", "manager", `${src}\nreturn i1(manager);`)(t, Jt, manager);
  return config.idleTimeoutMs("local_1");
}

const patched = patchIdle(FRAGMENT, once);
const MIN30 = 1800000;

test("normal session: 30 minutes when the server flag gives none", () => {
  assert.strictEqual(timeoutFor(patched, { flag: 0, session: {} }), MIN30);
  assert.strictEqual(timeoutFor(patched, { flag: null, session: {} }), MIN30);
});

test("normal session that is no longer held (already paused): 30 minutes", () => {
  assert.strictEqual(timeoutFor(patched, { flag: 0, session: undefined }), MIN30);
});

test("session with Remote Control on or connecting: no timer", () => {
  assert.strictEqual(timeoutFor(patched, { flag: 0, session: { remoteControlEnabled: true } }), 0);
  assert.strictEqual(timeoutFor(patched, { flag: 0, session: { remoteControlConnecting: true } }), 0);
});

test("scheduled session keeps the app's own 15 minutes", () => {
  assert.strictEqual(timeoutFor(patched, { flag: 0, session: { scheduledTaskId: "x" } }), 900000);
});

test("a positive server value wins over the 30 minutes", () => {
  assert.strictEqual(timeoutFor(patched, { flag: 600000, session: {} }), 600000);
});

test("unpatched fragment gives no timer (the test harness is not trivially true)", () => {
  assert.strictEqual(timeoutFor(FRAGMENT, { flag: 0, session: {} }), 0);
});

test("patch refuses a bundle whose structure changed", () => {
  assert.throws(() => patchIdle(FRAGMENT.replace("unused:", "idle:"), once));
  assert.throws(() => patchIdle(FRAGMENT.replace("Number.isNaN", "isNaN"), once));
});

// Remote Control switched on or off after the idle timer was armed (real WarmLifecycle class and
// the manager's emitSessionUpdated from the same bundle).
const WARM = fs.readFileSync(path.join(__dirname, "fixtures/idle-warm-class.js"), "utf8");
const MANAGER = fs.readFileSync(path.join(__dirname, "fixtures/idle-manager-fragment.js"), "utf8");
const { patchIdleRemoteChange } = require("./idle.js");

function scene(rcPatch) {
  const timers = new Set();
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const t = { IPt: () => 0, I0: () => false, OZt: log, VPt: () => false, ylt() {} };
  const h = { n() {}, r() {}, c() {} };
  const session = { sessionId: "local_1", isRunning: false };
  const held = { local_1: session };
  const fakeSetTimeout = (fn, ms) => { const id = { fn, ms }; timers.add(id); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  const manager = (rcPatch ? patchIdleRemoteChange(MANAGER, once) : MANAGER);
  const src = `${WARM}\nvar Jt={H:Ve};${patchIdle(FRAGMENT, once)}\n${manager}\nreturn M;`;
  const M = new Function("t", "h", "setTimeout", "clearTimeout", src)(t, h, fakeSetTimeout, fakeClearTimeout);
  const m = new M();
  m.held = (id) => held[id];
  m.pauseSession = () => {};
  m.sideQuery = { hasSideChat: () => false };
  m.warmLifecycle.ensureRevokeSubscription = () => {};
  m.warmLifecycle.registerSession("local_1");
  m.warmLifecycle.config.hasActiveQuery = () => true;
  m.warmLifecycle.onVisibilityChange("local_1", true);
  m.warmLifecycle.onVisibilityChange("local_1", false); // tab hidden: the app arms the timer
  session.armed = () => [...timers].filter((x) => x.ms === MIN30).length;
  return { m, session };
}

test("Remote Control switched on after the timer was armed: the timer is gone", () => {
  const { m, session } = scene(true);
  assert.strictEqual(session.armed(), 1);
  session.remoteControlConnecting = true;
  m.emitSessionUpdated(session);
  assert.strictEqual(session.armed(), 0);
  assert.strictEqual(m.warmLifecycle.isArmed("local_1"), false);
});

test("Remote Control switched off again: the timer is armed again", () => {
  const { m, session } = scene(true);
  session.remoteControlEnabled = true;
  m.emitSessionUpdated(session);
  assert.strictEqual(session.armed(), 0);
  session.remoteControlEnabled = false;
  m.emitSessionUpdated(session);
  assert.strictEqual(session.armed(), 1);
});

test("Remote Control switched off while the session is running: not armed mid-turn", () => {
  const { m, session } = scene(true);
  session.remoteControlEnabled = true;
  m.emitSessionUpdated(session);
  session.isRunning = true;
  session.remoteControlEnabled = false;
  m.emitSessionUpdated(session);
  assert.strictEqual(session.armed(), 0);
});

test("session updates without a Remote Control change leave the timer alone", () => {
  const { m, session } = scene(true);
  m.emitSessionUpdated(session);
  m.emitSessionUpdated(session);
  assert.strictEqual(session.armed(), 1);
});

test("without the Remote Control change patch the armed timer survives (harness is not trivially true)", () => {
  const { m, session } = scene(false);
  session.remoteControlEnabled = true;
  m.emitSessionUpdated(session);
  assert.strictEqual(session.armed(), 1);
});

test("Remote Control change patch refuses a bundle whose structure changed", () => {
  assert.throws(() => patchIdleRemoteChange(MANAGER.replaceAll("sessionUpdates", "updates"), once));
});
