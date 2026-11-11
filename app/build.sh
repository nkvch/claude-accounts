#!/bin/bash
# (Re)build the patched copy of Claude.app when the official one changed.
# Exit 0 = the copy is current, non-zero = patching failed (copy left as it was).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC=/Applications/Claude.app
DST="$HOME/Applications/Claude Accounts.app"
STATE="${CLAUDE_ACCOUNTS_HOME:-$HOME/.claude-accounts}/state"
STAMP="$STATE/built-from"
mkdir -p "$STATE" "$HOME/Applications"

ver=$(defaults read "$SRC/Contents/Info" CFBundleVersion)
sig="$ver $(stat -f %m "$HERE/patch.js") $HERE"
if [ -d "$DST" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$sig" ] && [ "${1:-}" != "--force" ]; then
  exit 0
fi

TMP="${DST%.app}.building.app"   # must end in .app: electron-fuses finds the framework by it
rm -rf "$TMP"
cp -Rc "$SRC" "$TMP"
xattr -cr "$TMP" 2>/dev/null || true
NODE=$(command -v node || ls "$HOME"/.nvm/versions/node/*/bin/node | tail -1)
if ! "$NODE" "$HERE/patch.js" "$TMP"; then
  rm -rf "$TMP"; exit 1
fi
# Electron 44 (Claude 4.4212) refuses a repacked app.asar even with a matching plist hash
# ("Failed to get integrity for validatable asar archive"); the copy is ad-hoc signed anyway.
"$NODE" "$HERE/node_modules/@electron/fuses/dist/bin.js" write --app "$TMP" EnableEmbeddedAsarIntegrityValidation=off >/dev/null
codesign --force --deep --sign - "$TMP" 2>/dev/null
rm -rf "$DST"; mv "$TMP" "$DST"
echo "$sig" > "$STAMP"
echo "built $DST from $ver"
