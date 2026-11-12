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
check() {  # check NAME TITLE BODY SESSION_ENV EXPECTED_SESSION [KEY [--key placement]]
  printf '%s' "$2" > "$TMP/title"; printf '%s' "$3" > "$TMP/body"; printf '%s' "$5" > "$TMP/session"
  rm -f "$TMP/key"; [ -z "${6:-}" ] || printf '%s' "$6" > "$TMP/key"
  local args=("$2" "$3")
  case "${7:-after}" in
    after) [ -z "${6:-}" ] || args+=(--key "$6") ;;
    before) [ -z "${6:-}" ] || args=(--key "$6" "${args[@]}") ;;
    equals) [ -z "${6:-}" ] || args+=("--key=$6") ;;
  esac
  PATH="$TMP/bin:$PATH" CLAUDE_CODE_HOST_SESSION_ID="$4" "$HERE/claude-nudge" "${args[@]}"
  if lua - "$TMP" <<'LUA'
local dir = arg[1]
local function slurp(n) local f = assert(io.open(dir .. "/" .. n, "rb")); local s = f:read("a"); f:close(); return s end
pwned = false
os.execute = function() pwned = true end
local got
function claudeNudge(...) got = table.pack(...) end
assert(load(slurp("call.lua")))()
assert(not pwned, "code ran")
assert(got, "claudeNudge not called")
assert(got[1] == slurp("title"), "title differs")
assert(got[2] == slurp("body"), "body differs")
assert(got[3] == slurp("session"), "session differs")
local kf = io.open(dir .. "/key", "rb")
if kf then
  local key = kf:read("a"); kf:close()
  assert(got.n == 5, "key call must have five arguments, got " .. got.n)
  assert(got[4] == "", "the action slot must be empty")
  assert(got[5] == key, "key differs")
else
  assert(got.n == 3, "without --key the call keeps its three arguments, got " .. got.n)
end
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
check "key"              "T" "B" "$SID" "$SID" "call-123"
check "key before text"  "T" "B" "$SID" "$SID" "call-123" before
check "key=value"        "T" "B" "$SID" "$SID" "call-123" equals
check "key quotes"       "T" "B" "$SID" "$SID" 'k"1\2' after
check "key injection"    "T" "B" "$SID" "$SID" '"); os.execute("x"); ("' after
check "key newline"      "T" "B" "$SID" "$SID" $'k\n1' after
check "key no session"   "T" "B" "" "" "call-9"

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
