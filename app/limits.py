"""Print the 5h / 7d usage of every token account in accounts.json as JSON.

One 1-token Haiku request per account; the numbers come from the response's
rate-limit headers. Tokens are read from the config's dotenv file and never printed.
"""
import json
import os
import time
import urllib.error
import urllib.request

import config

ENV_FILE = config.env_file()


def env_value(key):
    try:
        for line in open(ENV_FILE):
            if line.startswith(key + "="):
                return line[len(key) + 1:].strip().strip("'\"")
    except OSError:
        pass
    return None


def probe(token):
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": "claude-haiku-5-5", "max_tokens": 1,
            "system": "You are Claude Code, Anthropic's official CLI for Claude.",
            "messages": [{"role": "user", "content": "hi"}],
        }).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
            "x-app": "cli",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            h = r.headers
    except urllib.error.HTTPError as e:
        h = e.headers
        if not h.get("anthropic-ratelimit-unified-5h-utilization"):
            return {"error": f"HTTP {e.code}"}
    except Exception as e:  # network down, timeout
        return {"error": type(e).__name__}

    def pct(name):
        v = h.get(f"anthropic-ratelimit-unified-{name}-utilization")
        return round(float(v) * 100, 1) if v else None

    def reset(name):
        v = h.get(f"anthropic-ratelimit-unified-{name}-reset")
        return int(v) * 1000 if v else None

    return {"five": pct("5h"), "seven": pct("7d"), "fiveReset": reset("5h"), "sevenReset": reset("7d")}


accounts = config.load()["accounts"]
out = {}
for name, acct in accounts.items():
    token = env_value(acct["tokenKey"]) if acct.get("tokenKey") else None
    if token:
        out[name] = {"label": acct.get("label", name), **probe(token)}
# The desktop login has no token here: the app's hook probes it with the desktop's own token
# (logic.js refreshLimits, every 10 minutes); take its numbers while they are fresh.
LIMITS = os.path.join(config.STATE, "limits.json")
desktop = (json.load(open(LIMITS)) if os.path.exists(LIMITS) else {}).get("default")
if "default" in accounts and desktop and desktop.get("seven") is not None and time.time() * 1000 - desktop.get("at", 0) < 30 * 60 * 1000:
    out["default"] = {"label": accounts["default"].get("label", "Desktop login"), **{k: desktop.get(k) for k in ("five", "seven", "fiveReset", "sevenReset")}}
print(json.dumps(out))
