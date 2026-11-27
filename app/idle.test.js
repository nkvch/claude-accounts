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
