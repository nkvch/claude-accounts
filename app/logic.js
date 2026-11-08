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

const LIMITS_FRESH_MS = 30 * 60 * 1000; // older numbers are not trusted for a choice

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

function pick(state, cfg, sessionId, cwd) {
  const overrides = readJson(OVERRIDES, {});
  if (overrides[sessionId]) return { name: overrides[sessionId], why: "override" };
  const rec = record(cfg, sessionId);
  // A sub-session runs on its parent's subscription; remembered, so it keeps it after a restart.
  const parent = rec?.spawnedFrom?.sessionId || rec?.dispatchParentId;
  const inherited = parent && (state.chosen.get(parent) ?? overrides[parent]);
  if (inherited) {
    remember(sessionId, inherited);
    return { name: inherited, why: `parent ${parent}` };
  }
  const home = os.homedir();
  for (const r of cfg.rules || []) {
    const dir = path.resolve(r.folder.replace(/^~/, home));
    if (cwd && (cwd === dir || cwd.startsWith(dir + path.sep))) return { name: r.account, why: `rule ${r.folder}` };
  }
  // No automatic placement: a new chat stays on the desktop login until moved by hand (override).
  return { name: "default", why: "default" };
}

// Called right after the session env is built; mutates env.
exports.acct = (state, sessionId, cwd, env) => {
  // Where the code and the config are, for the session's own tools (`acct`, the Subscriptions pane).
  env.CLAUDE_ACCOUNTS_APP = DIR;
  env.CLAUDE_ACCOUNTS_HOME = HOME;
  if (env.CLAUDE_CODE_OAUTH_TOKEN && !env.CC_ACCOUNT) state.desktopToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  const cfg = config();
  let { name, why } = pick(state, cfg, sessionId, cwd);
  // A subscription whose last check failed (e.g. its org turned Claude Code off) would only
  // error out; run on the desktop login meanwhile. The override stays, for when it is back.
  const failed = readJson(LIMITS, {})[name];
  // A network error of the probe (TypeError = fetch failed, e.g. right after the Mac wakes) says nothing about the account.
  const transient = ["TypeError", "TimeoutError", "AbortError"].includes(failed?.error);
  if (name !== "default" && failed?.error && !transient && Date.now() - failed.at < LIMITS_FRESH_MS) {
    why = `${name} unavailable (${failed.error}), using default; was ${why}`;
    name = "default";
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
exports.config = config;
