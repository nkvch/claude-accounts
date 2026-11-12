#!/usr/bin/env bash
# user-browser-notify hands agent-written text and a one-time click token to Hammerspoon.
# With a fake `hs` that applies the same directory rules as claude_nudge.lua, check that
# every field arrives byte for byte, that the token reaches neither stdout nor stderr,
# that no directory is left behind and that the hook stays under 3 s. Needs `lua`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/bin" "$TMP/tmpdir" "$TMP/got"

# Fake hs: pulls FN("DIR") out of -c, refuses a DIR Lua would refuse, moves the files to got/.
cat > "$TMP/bin/hs" <<'FAKE'
#!/bin/bash
[ "$1" = -t ] && shift 2
[ "$1" = -c ] || exit 9
[[ "$2" =~ ^(claudeNudge(Dismiss)?FromDir)\(\"([^\"]*)\"\)$ ]] || exit 9
fn="${BASH_REMATCH[1]}"; dir="${BASH_REMATCH[3]}"
[[ "$dir" =~ ^[A-Za-z0-9/._-]+$ && "$dir" == */ub-notify.* ]] || exit 8
[ "$(stat -f %Lp "$dir")" = 700 ] || exit 7
echo "$fn" > "$GOT/fn"
for n in key title body argv session return; do
  if [ -e "$dir/$n" ]; then
    [ "$(stat -f %Lp "$dir/$n")" = 600 ] || exit 7
    mv "$dir/$n" "$GOT/$n"
  fi
done
rmdir "$dir"
[ -z "${FAKE_HS_FAIL:-}" ] || exit 1
FAKE
chmod +x "$TMP/bin/hs"

fails=0
ok()   { echo "ok   $1"; }
fail() { echo "FAIL $1${2:+: $2}"; fails=$((fails + 1)); }
run() {  # run ARGS... ; sets OUT (stdout+stderr), RC, ELAPSED
  rm -rf "$TMP/got"; mkdir "$TMP/got"
  local t0=$SECONDS
  set +e
  OUT=$(PATH="$TMP/bin:$PATH" GOT="$TMP/got" TMPDIR="$TMP/tmpdir" "$HERE/user-browser-notify" "$@" 2>&1)
  RC=$?
  set -e
  ELAPSED=$((SECONDS - t0))
}
same() {  # same FILE EXPECTED
  printf '%s' "$2" | cmp -s - "$TMP/got/$1"
}

TOKEN='tok_9f8e7d6c5b4a3210_SECRET'
show() {  # show NAME KEY TITLE BODY
  local name=$1 key=$2 title=$3 body=$4
  local click=(/usr/local/bin/node /p/user-browser.js approve --token "$TOKEN" --note $'a "b"\n$(touch x)' --data-dir /d)
  run show "$key" "$title" "$body" "${click[@]}"
  local bad=""
  [ "$RC" = 0 ] || bad="exit $RC"
  [ "$(cat "$TMP/got/fn")" = claudeNudgeFromDir ] || bad="$bad fn"
  same key "$key" || bad="$bad key"
  same title "$title" || bad="$bad title"
  same body "$body" || bad="$bad body"
  [ ! -e "$TMP/got/session" ] || [ ! -s "$TMP/got/session" ] || bad="$bad session"
  local want got
  want=$(printf '%s\0' "${click[@]}" | od -An -tx1)
  got=$(od -An -tx1 < "$TMP/got/argv")
  [ "$want" = "$got" ] || bad="$bad argv"
  # The way claude_nudge.lua splits argv gives the arguments back.
  lua - "$TMP/got/argv" "${#click[@]}" "${click[5]}" "${click[7]}" <<'LUA' || bad="$bad lua-argv"
local f = assert(io.open(arg[1], "rb")); local s = f:read("a"); f:close()
local argv = {}
for part in s:gmatch("([^\0]*)\0") do table.insert(argv, part) end
assert(#argv == tonumber(arg[2]), "count " .. #argv)
assert(argv[6] == arg[3] and argv[8] == arg[4], "elements differ")
LUA
  case "$OUT" in *"$TOKEN"*) bad="$bad token-leaked" ;; esac
  [ -z "$OUT" ] || bad="$bad output"
  [ -z "$(ls -A "$TMP/tmpdir")" ] || bad="$bad dir-left"
  [ "$ELAPSED" -lt 3 ] || bad="$bad slow"
  if [ -z "$bad" ]; then ok "$name"; else fail "$name" "$bad"; fi
}

show "plain"           k1 "Title" "Body"
show "quotes"          k2 'a"b' "it's \"quoted\""
show "newlines"        k3 $'line\none' $'two\r\nthree\ttab'
show "command subst"   k4 '$(touch pwned)' '`touch pwned` ${HOME}'
show "backslashes"     k5 'back\slash' 'lone \ and literal \n'
show "lua injection"   k6 '"); os.execute("x"); ("' '\"); os.execute("x"); --'
show "cyrillic"        k7 "Тест" "Залогинься в mBank"
show "empty body"      k8 "T" ""
show "odd key"         'approval:req-1/tab 3' "T" "B"
[ ! -e pwned ] && [ ! -e x ] && ok "nothing executed" || fail "nothing executed"

dismiss() {  # dismiss NAME EXPECTED_RETURN ARGS...
  local name=$1 want=$2; shift 2
  run dismiss "$@"
  local bad=""
  [ "$RC" = 0 ] || bad="exit $RC"
  [ "$(cat "$TMP/got/fn")" = claudeNudgeDismissFromDir ] || bad="$bad fn"
  same key "$1" || bad="$bad key"
  if [ -n "$want" ]; then same return "$want" || bad="$bad return"; else [ ! -e "$TMP/got/return" ] || bad="$bad return-present"; fi
  [ -z "$OUT" ] || bad="$bad output"
  [ -z "$(ls -A "$TMP/tmpdir")" ] || bad="$bad dir-left"
  if [ -z "$bad" ]; then ok "$name"; else fail "$name" "$bad"; fi
}
dismiss "dismiss"        ""     'approval:req-1/tab 3'
dismiss "dismiss return" "true" k1 return
dismiss "dismiss other word is not return" "" k1 nonsense

run dismiss k1; [ -z "$(ls -A "$TMP/tmpdir")" ] && ok "dir removed" || fail "dir removed"

export FAKE_HS_FAIL=1
run show k1 T B /bin/true
{ [ "$RC" != 0 ] && [ -z "$(ls -A "$TMP/tmpdir")" ]; } && ok "hs failure: nonzero, no dir left" || fail "hs failure" "rc=$RC"
unset FAKE_HS_FAIL

run bogus; [ "$RC" = 2 ] && ok "unknown command refused" || fail "unknown command refused"
run show k T B; [ "$RC" = 2 ] && ok "show without click command refused" || fail "show without click command refused"

[ "$fails" = 0 ] || { echo "$fails failed"; exit 1; }
echo "all passed"
