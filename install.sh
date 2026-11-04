#!/bin/bash
# Install claude-accounts: a patched copy of Claude Desktop where every Code session can run on
# its own Claude subscription, plus the Subscriptions pane. Safe to run again.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
APP="$REPO/app"
CONF="${CLAUDE_ACCOUNTS_HOME:-$HOME/.claude-accounts}"
LAUNCHER="$HOME/Applications/Claude Launcher.app"

say_step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nerror: %s\n' "$1" >&2; exit 1; }

[ "$(uname)" = Darwin ] || fail "macOS only."
[ -d /Applications/Claude.app ] || fail "Claude Desktop is not in /Applications. Install it from https://claude.ai/download first."
NODE=$(command -v node || ls "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1 || true)
[ -n "$NODE" ] || fail "Node.js is needed to patch the app: brew install node"
NPM="$(dirname "$NODE")/npm"

say_step "Installing the patcher's dependencies"
(cd "$APP" && "$NPM" ci --omit=dev --no-audit --no-fund >/dev/null)

say_step "Config in $CONF"
mkdir -p "$CONF/state"
if [ ! -f "$CONF/accounts.json" ]; then
  cat > "$CONF/accounts.json" <<'EOF'
{
  "accounts": {
    "default": { "label": "Desktop login", "plan": "Pro", "proX": 1 }
  },
  "rules": []
}
EOF
  echo "created accounts.json (the account Claude Desktop is signed in to)"
fi
[ -f "$CONF/tokens.env" ] || { touch "$CONF/tokens.env"; chmod 600 "$CONF/tokens.env"; }

say_step "Claude Launcher in ~/Applications"
mkdir -p "$HOME/Applications"
rm -rf "$LAUNCHER"
osacompile -o "$LAUNCHER" -e "do shell script quoted form of \"$APP/launch.sh\" & \" >/dev/null 2>&1 &\""
cp /Applications/Claude.app/Contents/Resources/electron.icns "$LAUNCHER/Contents/Resources/applet.icns" 2>/dev/null || true
touch "$LAUNCHER"

say_step "Building the patched copy (~/Applications/Claude Accounts.app)"
"$APP/build.sh" --force

say_step "Installing the Subscriptions pane"
CLAUDE=$(ls -t "$HOME"/Library/Application\ Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -1 || true)
[ -n "$CLAUDE" ] || CLAUDE=$(command -v claude || true)
if [ -n "$CLAUDE" ]; then
  "$CLAUDE" plugin marketplace add "$REPO" >/dev/null 2>&1 || "$CLAUDE" plugin marketplace update claude-accounts >/dev/null
  "$CLAUDE" plugin install subscriptions@claude-accounts >/dev/null 2>&1 || "$CLAUDE" plugin update subscriptions@claude-accounts >/dev/null
  echo "installed subscriptions@claude-accounts"
else
  echo "Claude Code not found: open Claude once, then run this again (or: claude plugin marketplace add $REPO)"
fi

cat <<EOF

Done. Next:
  1. Quit Claude and open "Claude Launcher" from ~/Applications (drag it to the Dock; use it instead
     of Claude from now on). It rebuilds the patched copy after every Claude update.
  2. In a Code session, the Subscriptions pane shows your limits. "Add subscription" signs in
     another Claude account; "Move chat here" moves a chat onto it.
  3. Set the plan of your desktop login in $CONF/accounts.json ("plan", "proX" = times Pro usage).
EOF
