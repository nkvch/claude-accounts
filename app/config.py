"""Where the user's accounts, tokens and state live: ~/.claude-accounts, or $CLAUDE_ACCOUNTS_HOME.

accounts.json there lists the subscriptions; tokens sit in a dotenv file (accounts.json
`envFile`, default tokens.env next to it); state/ holds logs, overrides and the last limits.
"""
import json
import os

HOME_DIR = os.environ.get("CLAUDE_ACCOUNTS_HOME") or os.path.expanduser("~/.claude-accounts")
ACCOUNTS = os.path.join(HOME_DIR, "accounts.json")
STATE = os.path.join(HOME_DIR, "state")


def load():
    return json.load(open(ACCOUNTS))


def env_file(cfg=None):
    f = (cfg or load()).get("envFile")
    return os.path.abspath(os.path.expanduser(f)) if f else os.path.join(HOME_DIR, "tokens.env")
