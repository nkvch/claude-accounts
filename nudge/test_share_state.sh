#!/usr/bin/env bash
# Builds the screen-capture detector and checks its output format and exit codes.
# --live also records the screen for a few seconds and expects idle -> sharing -> idle
# (needs Screen Recording permission for the terminal; run it on a machine nobody shares).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# Only the recording this test starts is stopped; a recording of the user's stays alive.
REC=""
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; [ -z "$REC" ] || kill -9 "$REC" 2>/dev/null || true' EXIT
swiftc -O "$HERE/share_state.swift" -o "$TMP/state"

fails=0
expect() {  # expect NAME WORD CODE
  out=$("$TMP/state" 2>/dev/null) && code=0 || code=$?
  if [ "$out" = "$2" ] && [ "$code" = "$3" ]; then echo "ok   $1 ($out, exit $code)"
  else echo "FAIL $1: got '$out' exit $code, want '$2' exit $3"; fails=$((fails+1)); fi
}

expect "idle at rest" idle 1

verr=$("$TMP/state" --verbose 2>&1 >/dev/null || true)
if printf '%s' "$verr" | grep -q '^CGSIsScreenWatcherPresent='; then echo "ok   --verbose names the signal"
else echo "FAIL --verbose prints no signal"; fails=$((fails+1)); fi

# Timed inside one python process, so the interpreter's own start-up is not counted.
ms=$(python3 -c 'import subprocess,sys,time;t=time.monotonic();subprocess.run([sys.argv[1]],capture_output=True);print(int((time.monotonic()-t)*1000))' "$TMP/state")
if [ "$ms" -lt 100 ]; then echo "ok   call took ${ms} ms"; else echo "FAIL call took ${ms} ms"; fails=$((fails+1)); fi

if [ "${1:-}" = "--live" ]; then
  screencapture -v -V 8 "$TMP/rec.mov" & REC=$!; sleep 2
  expect "sharing while recording" sharing 0
  kill -9 "$REC"; REC=""; sleep 2
  expect "idle after recording" idle 1
fi

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
