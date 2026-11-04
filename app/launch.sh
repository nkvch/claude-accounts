#!/bin/bash
# Entry point of "Claude Launcher.app": rebuild the patched copy if Claude changed, then open it.
# If patching fails (a Claude update moved what the patch looks for), open the official Claude
# and say so in a notification.
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${CLAUDE_ACCOUNTS_HOME:-$HOME/.claude-accounts}/state"
DST="$HOME/Applications/Claude Accounts.app"
LOG="$STATE/launch.log"
mkdir -p "$STATE"
exec >>"$LOG" 2>&1
echo "== $(date)"

# Already running from the patched copy: just bring it forward.
if pgrep -f "^$DST/Contents/MacOS/Claude" >/dev/null; then open -a "$DST"; exit 0; fi

# Both copies share one data folder, so only one may run: quit the official one.
if pgrep -f "^/Applications/Claude.app/Contents/MacOS/Claude" >/dev/null; then
  osascript -e 'tell application "/Applications/Claude.app" to quit'
  for _ in $(seq 1 30); do pgrep -f "^/Applications/Claude.app/Contents/MacOS/Claude" >/dev/null || break; sleep 1; done
fi

if "$HERE/build.sh"; then
  # Claude is not running here, so the session folders are safe to touch (no-op unless configured).
  /usr/bin/python3 "$HERE/merge_sessions.py"
  open -a "$DST"
else
  osascript -e "display notification \"The patch did not apply to this Claude version; opening the official app. Details: $LOG\" with title \"Claude Accounts\""
  open -a /Applications/Claude.app
fi

# The patched copy never updates itself; when Claude came from Homebrew, keep the official
# app current (at most daily) so the next launch rebuilds the copy from the new version.
STAMP="$STATE/brew-checked"
BREW=$(command -v brew || ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -1)
if [ -n "$BREW" ] && "$BREW" list --cask claude >/dev/null 2>&1 && [ -z "$(find "$STAMP" -mtime -1 2>/dev/null)" ]; then
  touch "$STAMP"
  ( "$BREW" upgrade --cask --greedy claude && echo "brew: checked" ) &
fi
