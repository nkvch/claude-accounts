#!/bin/bash
# Entry point of "Claude Launcher.app": update Claude (when it came from Homebrew), rebuild the
# patched copy if Claude changed, then open it. The official Claude is never opened: if patching
# fails (an update moved what the patch looks for), the previous patched copy is opened instead.
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
# Fails when it is still alive afterwards (unsaved dialog, hang), so nothing else may start.
quit_official() {
  pgrep -f "^/Applications/Claude.app/Contents/MacOS/Claude" >/dev/null || return 0
  osascript -e 'tell application "/Applications/Claude.app" to quit'
  for _ in $(seq 1 30); do pgrep -f "^/Applications/Claude.app/Contents/MacOS/Claude" >/dev/null || return 0; sleep 1; done
  echo "official Claude is still running"
  osascript -e 'display notification "Quit the official Claude first, then open Claude Accounts again." with title "Claude Accounts"'
  return 1
}
quit_official || exit 1

# The patched copy never updates itself; when Claude came from Homebrew, update the official
# app first so the rebuild below always starts from the latest version.
BREW=$(command -v brew || ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -1)
if [ -z "$BREW" ]; then
  echo "update skipped: brew not found"
elif ! "$BREW" list --cask claude >/dev/null 2>&1; then
  echo "update skipped: Claude is not a Homebrew cask"
else
  # brew outdated may exit non-zero when something is outdated: judge by its output first.
  outdated=$("$BREW" outdated --cask --greedy --quiet claude)
  status=$?
  if [ -n "$outdated" ]; then
    osascript -e 'display notification "Updating Claude to the latest version…" with title "Claude Accounts"'
    if "$BREW" upgrade --cask --greedy claude; then
      echo "brew: upgraded"
    else
      echo "brew: upgrade failed, continuing with the installed Claude"
      osascript -e "display notification \"Claude update failed; using the installed version. Details: $LOG\" with title \"Claude Accounts\""
    fi
    quit_official || exit 1
  elif [ "$status" -ne 0 ]; then
    echo "brew: outdated check failed (exit $status), continuing with the installed Claude"
    osascript -e "display notification \"Could not check for a Claude update; using the installed version. Details: $LOG\" with title \"Claude Accounts\""
  else
    echo "brew: Claude is up to date"
  fi
fi

if "$HERE/build.sh"; then
  # Claude is not running here, so the session folders are safe to touch (no-op unless configured).
  /usr/bin/python3 "$HERE/merge_sessions.py"
  open -a "$DST"
elif [ -d "$DST" ]; then
  osascript -e 'display notification "The new Claude version did not take the patch yet; opened the previous version." with title "Claude Accounts"'
  open -a "$DST"
else
  osascript -e "display notification \"The patch did not apply to this Claude version. Details: $LOG\" with title \"Claude Accounts\""
fi
