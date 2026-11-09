// How a Code session's subscription is chosen. hook.js loads this file afresh on every
// call, so edits here take effect without restarting Claude. State that must outlive a
// reload (`chosen`, the desktop's token) lives in the `state` object hook.js passes in.
const fs = require("fs");
const path = require("path");
const os = require("os");

// Code lives here; the user's accounts, tokens and state live in HOME (~/.claude-accounts).
const DIR = __dirname;
const HOME = process.env.CLAUDE_ACCOUNTS_HOME || path.join(os.homedir(), ".claude-accounts");
const LOG = path.join(HOME, "state/hook.log");
const LIMITS = path.join(HOME, "state/limits.json");
const OVERRIDES = path.join(HOME, "state/overrides.json");

const NEW_SESSION_MS = 30 * 60 * 1000; // a record younger than this is a new chat
const LIMITS_FRESH_MS = 30 * 60 * 1000; // older numbers are not trusted for a choice
const MAX_FIVE = 90; // percent used: above this a subscription is not picked
const MAX_SEVEN = 95;

// Identity the desktop stamps for its own account; wrong for a borrowed token.
const DESKTOP_IDENTITY = [
  "CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_USER_EMAIL", "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_ACCOUNT_TAGGED_ID", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_RATE_LIMIT_TIER",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
];

function log(msg) {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function config() {
  return readJson(path.join(HOME, "accounts.json"), { accounts: {}, rules: [] });
}

// Tokens sit in a dotenv file: accounts.json `envFile`, or HOME/tokens.env.
function envFile() {
  const f = config().envFile;
  return f ? path.resolve(f.replace(/^~/, os.homedir())) : path.join(HOME, "tokens.env");
}

function envValue(key) {
  try {
    const line = fs.readFileSync(envFile(), "utf8").split("\n").find((l) => l.startsWith(key + "="));
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") : undefined;
  } catch { return undefined; }
}

function record(cfg, sessionId) {
  if (!cfg.sessionStore) return undefined;
  const root = process.env.CC_SESSIONS_ROOT || path.join(os.homedir(), "Library/Application Support/Claude/claude-code-sessions");
  return readJson(path.join(root, cfg.sessionStore, `${sessionId}.json`), undefined);
}

function remember(sessionId, name) {
  try { fs.writeFileSync(OVERRIDES, JSON.stringify({ ...readJson(OVERRIDES, {}), [sessionId]: name }, null, 1)); } catch {}
}

// Unused weekly limit per hour left until the weekly reset, in Pro-weeks (the plan's `proX`
// from accounts.json times the unused share): the subscription whose limit would otherwise go
// to waste soonest scores highest, so a bigger plan counts for more. Needs room in the 5h
// window too, where the plan has one.
function best(cfg, now = Date.now()) {
  const limits = readJson(LIMITS, {});
  let top;
  for (const name of Object.keys(cfg.accounts || {})) {
    if (cfg.accounts[name].auto === false) continue;   // reserved (the bot's subscription): only by explicit override
    const l = limits[name];
    if (!l || l.error || l.unknown || now - (l.at || 0) > LIMITS_FRESH_MS) continue;
    if (l.status === "rejected" || (l.five ?? 0) >= MAX_FIVE || l.seven >= MAX_SEVEN) continue;
    const hours = Math.max(1, ((l.sevenReset || now) - now) / 3.6e6);
    const score = ((100 - l.seven) * (cfg.accounts[name].proX ?? 1)) / hours;
    if (!top || score > top.score) top = { name, score, l };
  }
  return top;
}

const autoPlace = (cfg) => {
  const v = cfg.autoPlace;
  if (v !== undefined && typeof v !== "boolean") log(`accounts.json: autoPlace must be true or false, got ${JSON.stringify(v)}; using the default (on)`);
  return v !== false;
};

function pick(state, cfg, sessionId, cwd) {
  const overrides = readJson(OVERRIDES, {});
  if (overrides[sessionId]) return { name: overrides[sessionId], why: "override" };
  const rec = record(cfg, sessionId);
  // A sub-session runs on its parent's subscription; remembered, so it keeps it after a restart.
  // What the parent wants, not the fallback it was moved to meanwhile; "default" is never
  // remembered, it would outrank the folder rules on the child's restart.
  const parent = rec?.spawnedFrom?.sessionId || rec?.dispatchParentId;
  const inherited = parent && (overrides[parent] ?? state.wanted?.get(parent) ?? state.chosen.get(parent));
  if (inherited) {
    if (inherited !== "default") remember(sessionId, inherited);
    return { name: inherited, why: `parent ${parent}` };
  }
  const home = os.homedir();
  for (const r of cfg.rules || []) {
    const dir = path.resolve(r.folder.replace(/^~/, home));
    if (cwd && (cwd === dir || cwd.startsWith(dir + path.sep))) return { name: r.account, why: `rule ${r.folder}` };
  }
  // Only a new chat is placed automatically; an older one keeps running where it was.
  // With `autoPlace: false` in accounts.json nothing is placed: a new chat stays on the desktop login.
  const isNew = !rec || Date.now() - (rec.createdAt || 0) < NEW_SESSION_MS;
  if (autoPlace(cfg) && isNew) {
    const top = best(cfg);
    if (top) {
      remember(sessionId, top.name);
      return { name: top.name, why: `auto: 5h ${top.l.five ?? "none"}%, week ${top.l.seven}%, score ${top.score.toFixed(2)}` };
    }
  }
  return { name: "default", why: "default" };
}

// Called right after the session env is built; mutates env.
exports.acct = (state, sessionId, cwd, env) => {
  // Where the code and the config are, for the session's own tools (`acct`, the Subscriptions pane).
  env.CLAUDE_ACCOUNTS_APP = DIR;
  env.CLAUDE_ACCOUNTS_HOME = HOME;
  // The env is built afresh for every spawn, so a CC_ACCOUNT already in it came from the app's own
  // environment (Claude started from a shell of a Code session), not from this session's pick.
  delete env.CC_ACCOUNT;
  const cfg = config();
  const ours = Object.values(cfg.accounts || {}).map((a) => a?.tokenKey && envValue(a.tokenKey)).filter(Boolean);
  if (env.CLAUDE_CODE_OAUTH_TOKEN && !ours.includes(env.CLAUDE_CODE_OAUTH_TOKEN)) state.desktopToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  let { name, why } = pick(state, cfg, sessionId, cwd);
  (state.wanted ??= new Map()).set(sessionId, name);
  // A subscription whose last check failed (e.g. its org turned Claude Code off) would only
  // error out; run on the best working one (the desktop login when `autoPlace` is off) meanwhile.
  // The override stays, for when it is back.
  const failed = readJson(LIMITS, {})[name];
  // A network error of the probe (TypeError = fetch failed, e.g. right after the Mac wakes) says nothing about the account.
  const transient = ["TypeError", "TimeoutError", "AbortError"].includes(failed?.error);
  if (name !== "default" && failed?.error && !transient && Date.now() - failed.at < LIMITS_FRESH_MS) {
    const top = autoPlace(cfg) ? best(cfg) : undefined;
    why = `${name} unavailable (${failed.error}), using ${top ? top.name : "default"}; was ${why}`;
    name = top ? top.name : "default";
  }
  const acct = cfg.accounts?.[name];
  const token = acct?.tokenKey ? envValue(acct.tokenKey) : undefined;
  if (name === "default" || !token) {
    state.chosen.set(sessionId, "default");
    log(`${sessionId} -> default (${name === "default" ? why : `wanted ${name}, no token`}) cwd=${cwd}`);
    return;
  }
  for (const k of DESKTOP_IDENTITY) delete env[k];
  // A setup-token cannot read its own plan, so without these the CLI treats the plan as unknown.
  Object.assign(env, cfg.tokenEnv || {}, acct.env || {});
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.CC_ACCOUNT = name;
  state.chosen.set(sessionId, name);
  log(`${sessionId} -> ${name} (${why}) cwd=${cwd}`);
};

// One 1-token Haiku call per subscription; the numbers come from its rate-limit headers.
async function probe(token) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01", "x-app": "cli", "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-5-5", max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    const h = (k) => r.headers.get(`anthropic-ratelimit-unified-${k}`);
    // Ultra plans have no 5-hour window: they answer with the weekly headers only (five = null).
    // A plan with no usage headers at all is unknown: it serves an override but is never picked.
    if (r.ok && !h("7d-utilization")) return { unknown: true, status: "allowed", at: Date.now() };
    if (!h("7d-utilization")) {
      const body = await r.json().catch(() => ({}));
      return { error: body.error?.details?.error_code || `HTTP ${r.status}`, at: Date.now() };
    }
    const five = h("5h-utilization");
    return {
      five: five ? Math.round(parseFloat(five) * 1000) / 10 : null,
      seven: Math.round(parseFloat(h("7d-utilization")) * 1000) / 10,
      fiveReset: Number(h("5h-reset")) * 1000 || null,
      sevenReset: Number(h("7d-reset")) * 1000 || null,
      status: h("status"),
      at: Date.now(),
    };
  } catch (e) {
    return { error: e.name || "error", at: Date.now() };
  }
}

exports.refreshLimits = async (state) => {
  const cfg = config();
  const out = readJson(LIMITS, {});
  for (const [name, acct] of Object.entries(cfg.accounts || {})) {
    const token = name === "default" ? state.desktopToken : acct.tokenKey && envValue(acct.tokenKey);
    if (token) out[name] = await probe(token);
  }
  try { fs.writeFileSync(LIMITS, JSON.stringify(out, null, 1)); } catch {}
  return out;
};

exports.log = log;
exports.best = best;
exports.config = config;
