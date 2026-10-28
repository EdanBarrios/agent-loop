#!/bin/sh
# slot.sh: run a command while holding one of SLOT_MAX machine-wide slots.
#
# The loop runs many agents at once, but an agent only needs real memory while it runs the
# project's install and check commands. Those go through this wrapper, so every session on the
# machine (any project, any wave) shares the same small number of heavy processes while the
# agents themselves, which mostly wait on the model API, are not limited.
#
#   SLOT_MAX=2 slot.sh npm run check
#
# SLOT_MAX   slots (default 2, right for an 8 GB machine)
# SLOT_DIR   lock directory (default $TMPDIR/agent-loop-slots)
# SLOT_POLL  seconds between attempts (default 5)
#
# A slot is a directory made with mkdir, which is atomic. A slot whose holder is gone (the pid
# inside it no longer exists) is reclaimed. The command's exit code is passed through.
set -u
max=${SLOT_MAX:-2}
dir=${SLOT_DIR:-${TMPDIR:-/tmp}/agent-loop-slots}
poll=${SLOT_POLL:-5}
mkdir -p "$dir"
held=""
release() { if [ -n "$held" ]; then rm -rf "$held"; held=""; fi; }
trap 'release; exit 143' TERM
trap 'release; exit 130' INT
trap release EXIT
while [ -z "$held" ]; do
  i=0
  while [ "$i" -lt "$max" ]; do
    s="$dir/$i"
    if mkdir "$s" 2>/dev/null; then
      echo $$ > "$s/pid"
      held=$s
      break
    fi
    pid=$(cat "$s/pid" 2>/dev/null || true)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$s"; fi
    i=$((i + 1))
  done
  [ -n "$held" ] || sleep "$poll"
done
"$@"
rc=$?
release
exit $rc
