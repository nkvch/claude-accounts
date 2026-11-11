#!/usr/bin/env bash
# claude-nudge splices agent-written text into Lua code that Hammerspoon runs.
# Check that every input comes back byte for byte as a string argument and
# never escapes the literal. Needs `lua` (brew install lua).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# A fake `hs` that saves the Lua it was asked to run.
mkdir "$TMP/bin"
printf '#!/bin/sh\nprintf "%%s" "$2" > "%s/call.lua"\n' "$TMP" > "$TMP/bin/hs"
chmod +x "$TMP/bin/hs"

fails=0
check() {  # check NAME TITLE BODY SESSION_ENV EXPECTED_SESSION
  printf '%s' "$2" > "$TMP/title"; printf '%s' "$3" > "$TMP/body"; printf '%s' "$5" > "$TMP/session"
  PATH="$TMP/bin:$PATH" CLAUDE_CODE_HOST_SESSION_ID="$4" "$HERE/claude-nudge" "$2" "$3"
  if lua - "$TMP" <<'LUA'
local dir = arg[1]
local function slurp(n) local f = assert(io.open(dir .. "/" .. n, "rb")); local s = f:read("a"); f:close(); return s end
pwned = false
os.execute = function() pwned = true end
local got
function claudeNudge(t, b, s) got = { t, b, s } end
assert(load(slurp("call.lua")))()
assert(not pwned, "code ran")
assert(got, "claudeNudge not called")
assert(got[1] == slurp("title"), "title differs")
assert(got[2] == slurp("body"), "body differs")
assert(got[3] == slurp("session"), "session differs")
LUA
  then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}

SID=local_0123abcd-4567-89ef-0123-456789abcdef
check "plain"            "Title" "Body" "$SID" "$SID"
check "quotes"           'a"b' '"quoted"' "$SID" "$SID"
check "backslashes"      'back\slash' 'lone \ and literal \n' "$SID" "$SID"
check "newline in body"  "T" $'line one\nline two' "$SID" "$SID"
check "CR and tab"       $'a\rb' $'c\td' "$SID" "$SID"
check "backslash+quote"  $'\\\n"' '\"' "$SID" "$SID"
check "empty body"       "T" "" "$SID" "$SID"
check "cyrillic"         "Тест" "Залогинься в mBank" "$SID" "$SID"
check "injection"        '"); os.execute("x"); ("' '\"); os.execute("x"); --' "$SID" "$SID"
check "bad session id"   "T" "B" 'local_x"); os.execute("x' ""
check "no session"       "T" "B" "" ""

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
