// Loaded into Claude Desktop's main process by the patched copy of Claude.app.
// Thin and stable on purpose: the choosing logic is in logic.js, loaded afresh on every
// call, so changing it needs no Claude restart. State that must outlive a reload is here.
// The user's accounts, tokens and state live in HOME (~/.claude-accounts), never in the code.
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = __dirname;
const HOME = process.env.CLAUDE_ACCOUNTS_HOME || path.join(os.homedir(), ".claude-accounts");
const LOGIC = path.join(DIR, "logic.js");
const RESTART = path.join(HOME, "state/restart"); // one empty file per session to restart
const state = { chosen: new Map(), desktopToken: undefined }; // chosen: session id -> account
const REFRESH_MS = 10 * 60 * 1000;
const RESTART_GIVE_UP_MS = 30 * 60 * 1000;

function logic() {
  delete require.cache[require.resolve(LOGIC)];
  return require(LOGIC);
}

function log(msg) {
  try {
    fs.mkdirSync(path.join(HOME, "state"), { recursive: true });
    fs.appendFileSync(path.join(HOME, "state/hook.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

let refreshing, lastRefresh = 0;
function refresh() {
  if (refreshing) return;
  lastRefresh = Date.now();
  refreshing = logic().refreshLimits(state).catch((e) => log(`limits: ${e.message}`)).finally(() => { refreshing = undefined; });
}

// Called right after the session env is built. Returns nothing; mutates env.
globalThis.__ccAcct = (sessionId, cwd, env) => {
  try {
    logic().acct(state, sessionId, cwd, env);
  } catch (e) {
    log(`error ${sessionId}: ${e && e.stack}`);
  }
  if (Date.now() - lastRefresh > REFRESH_MS) refresh();
};

// True when the session runs on a borrowed token: the desktop must not push
// or refresh its own account's token into it.
globalThis.__ccAcctOv = (sessionId) => {
  const c = state.chosen.get(sessionId);
  return c !== undefined && c !== "default";
};

// ["<accountDir>", "<orgDir>"] of the shared Code session folder, or undefined
// to keep the desktop's per-login folder.
globalThis.__ccStore = () => {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, "accounts.json"), "utf8")).sessionStore?.split("/"); } catch { return undefined; }
};

// A switch of subscription (`acct`, the pane's "Move chat here") leaves a request file; the
// session's process is restarted the app's own quiet way (__ccRestart, captured by the patch:
// the path it uses to apply a new output style), which waits until the session is idle and
// keeps what was typed. The new process starts on the new subscription.
async function restartPending() {
  let files = [];
  try { files = fs.readdirSync(RESTART); } catch { return; }
  for (const sid of files) {
    const file = path.join(RESTART, sid);
    try {
      if (!globalThis.__ccRestart) return;
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (await globalThis.__ccRestart(sid)) {
        fs.rmSync(file, { force: true });
        log(`${sid} restarted onto its new subscription`);
      } else if (age > RESTART_GIVE_UP_MS) {
        fs.rmSync(file, { force: true });
        log(`${sid} restart given up: busy for ${Math.round(age / 60000)} min; the next app start applies it`);
      }
    } catch (e) {
      log(`restart ${sid}: ${e.message}`);
    }
  }
}

setTimeout(refresh, 5000);
setInterval(refresh, REFRESH_MS).unref?.();
setInterval(() => void restartPending(), 1000).unref?.();

// Optional page tweaks of the user's own: HOME/inject.js runs in every page of the app on
// load and again whenever the file is saved.
try {
  const { app, webContents } = require("electron");
  const INJECT = path.join(HOME, "inject.js");
  const inject = (wc) => {
    if (!fs.existsSync(INJECT)) return;
    try { wc.executeJavaScript(fs.readFileSync(INJECT, "utf8")).catch((e) => log(`inject: ${e.message}`)); } catch (e) { log(`inject: ${e.message}`); }
  };
  app.on("web-contents-created", (_, wc) => wc.on("dom-ready", () => inject(wc)));
  let pending;
  fs.mkdirSync(HOME, { recursive: true });
  fs.watch(HOME, (_, name) => {
    if (name !== "inject.js") return;
    clearTimeout(pending);
    pending = setTimeout(() => webContents.getAllWebContents().forEach(inject), 200);
  });
} catch (e) {
  log(`ui inject setup: ${e.message}`);
}

log("hook loaded");
