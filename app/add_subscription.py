"""Add a Claude subscription to cc-accounts without a terminal.

Native macOS dialogs ask for a name, the plan and where to sign in (a Chrome profile, the
default browser, or a copied link for any browser); the official `claude setup-token` runs in
a pseudo-terminal, its sign-in link opens there, the code the page shows goes back through a
dialog, and the long-lived token it prints is written to the config's token file as CC_TOKEN_<NAME> (never printed). The account
is then added to accounts.json (see config.py). Prints only status lines.
"""
import fcntl
import glob
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

import config

HOME = os.path.expanduser("~")
CHROME_STATE = f"{HOME}/Library/Application Support/Google/Chrome/Local State"
PLANS = {"Pro": 1, "Max 5x": 5, "Team Premium": 6.25, "Ultra": 10, "Max 20x": 20}
DEFAULT_BROWSER = "Default browser"
COPY_LINK = "Copy the link (I'll open it in any browser)"
LOG = os.path.join(config.STATE, "add_subscription.log")
TOKEN = re.compile(r"sk-ant-oat01-[A-Za-z0-9_-]{20,}")
URL = re.compile(r"https://claude\.com/cai/oauth/authorize\?[^\s\x07\x1b]+")


def osa(script):
    r = subprocess.run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def quoted(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def ask(prompt, hidden=False):
    extra = " with hidden answer" if hidden else ""
    return osa(f'display dialog {quoted(prompt)} default answer "" with title "Add subscription"{extra}\n'
               'text returned of result')


def choose(prompt, items):
    listed = "{" + ", ".join(quoted(i) for i in items) + "}"
    got = osa(f'choose from list {listed} with prompt {quoted(prompt)} with title "Add subscription"')
    return None if not got or got == "false" else got


def say(text):
    osa(f'display dialog {quoted(text)} buttons {{"OK"}} default button 1 with title "Add subscription"')


def claude_binary():
    found = sorted(glob.glob(f"{HOME}/Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude"),
                   key=os.path.getmtime)
    return found[-1] if found else None


def chrome_profiles():
    """Chrome's profiles by a readable name; none when Chrome is not installed."""
    try:
        cache = json.load(open(CHROME_STATE))["profile"]["info_cache"]
    except (OSError, ValueError, KeyError):
        return {}
    return {f"Chrome: {v.get('user_name') or v.get('name')} ({v.get('name')})": k for k, v in cache.items()}


def read_until(fd, pattern, timeout, buf=""):
    end = time.time() + timeout
    while time.time() < end:
        if select.select([fd], [], [], 0.5)[0]:
            try:
                buf += os.read(fd, 65536).decode("utf-8", "replace")
            except OSError:
                break
            # Colour codes out, line breaks to spaces (the terminal is wide enough not to wrap).
            flat = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", buf).replace("\r", " ").replace("\n", " ")
            m = pattern.search(flat)
            if m:
                return m.group(0), buf
    return None, buf


def log(text):
    """What setup-token printed, for a failed run: tokens masked, escape codes out."""
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "", text)
    clean = TOKEN.sub("sk-ant-oat01-<masked>", re.sub(r"(code_challenge|state)=[^&\s]+", r"\1=…", clean))
    with open(LOG, "a") as fh:
        fh.write(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')}\n{clean}\n")


def main():
    name = ask("Name for the new subscription (as it should appear in the pane):")
    if not name:
        return print("cancelled")
    key = re.sub(r"[^a-z0-9]+", "", name.lower()) or "sub"
    plan = choose("Which plan is it?", list(PLANS))
    if not plan:
        return print("cancelled")
    profiles = chrome_profiles()
    where = choose("Where to sign in? Pick the browser (or Chrome profile) logged into this Claude account.",
                   list(profiles) + [DEFAULT_BROWSER, COPY_LINK])
    if not where:
        return print("cancelled")

    claude = claude_binary()
    if not claude:
        return say("Couldn't find the Claude Code binary of the desktop app.")
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(BROWSER="/usr/bin/true", COLUMNS="1000", LINES="50", TERM="xterm-256color")
        os.execv(claude, [claude, "setup-token"])
    # A wide terminal, so the 100-character token is printed on one line, not wrapped.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))
    try:
        url, buf = read_until(fd, URL, 40)
        if not url:
            return say("Claude Code did not give a sign-in link. Nothing was changed.")
        if where in profiles:
            subprocess.run(["/usr/bin/open", "-na", "Google Chrome", "--args",
                            f"--profile-directory={profiles[where]}", "--new-window", url])
            prompt = "Sign in on the page that just opened, then paste the code it shows here:"
        elif where == DEFAULT_BROWSER:
            subprocess.run(["/usr/bin/open", url])
            prompt = "Sign in on the page that just opened, then paste the code it shows here:"
        else:
            subprocess.run(["/usr/bin/pbcopy"], input=url.encode())
            prompt = ("The sign-in link is copied. Paste it into the browser where this Claude account is "
                      "signed in, sign in, then paste the code the page shows here:")
        code = ask(prompt, hidden=True)
        if not code:
            return print("cancelled")
        # Enter goes separately: sent in the same chunk, a long code reads as a paste and the
        # Enter inside it never submits.
        os.write(fd, code.strip().encode())
        time.sleep(0.8)
        os.write(fd, b"\r")
        token, out = read_until(fd, TOKEN, 90)
        if not token:
            log(buf + out)
            if "OAuth error" in out:
                return say("Claude did not accept that code (it works once and only for the sign-in "
                           "that was just opened). Nothing was changed; try Add subscription again.")
            return say("No token came back. Nothing was changed. What Claude Code printed is in "
                       f"{LOG} (the token, if any, masked).")
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass

    env_key = f"CC_TOKEN_{key.upper()}"
    env_file = config.env_file()
    old = open(env_file).read().splitlines() if os.path.exists(env_file) else []
    lines = [l for l in old if not l.startswith(env_key + "=")] + [f"{env_key}={token}"]
    fd_ = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd_, "w") as fh:
        fh.write("\n".join(lines) + "\n")

    cfg = config.load()
    cfg["accounts"][key] = {
        "label": name, "tokenKey": env_key, "plan": plan, "proX": PLANS[plan],
        "env": {"CLAUDE_CODE_SUBSCRIPTION_TYPE": "pro" if plan == "Pro" else "max"},
    }
    with open(config.ACCOUNTS, "w") as fh:
        json.dump(cfg, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(f"added {key}")
    say(f"«{name}» added. It shows in the Subscriptions pane in about 20 seconds.")


if __name__ == "__main__":
    sys.exit(main())
