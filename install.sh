#!/usr/bin/env bash
# Link the agent loop into a repo's .claude directory without tracking anything there.
# Usage: ./install.sh /path/to/repo
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:?usage: install.sh /path/to/repo}"
target="$(cd "$target" && pwd)"
mkdir -p "$target/.claude"

link() {
  local src="$1" dst="$2"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "skip: $dst exists and is not a symlink" >&2
    return
  fi
  ln -sfn "$src" "$dst"
  echo "linked $dst -> $src"
}

link "$here/claude/workflows" "$target/.claude/workflows"
link "$here/claude/agents" "$target/.claude/agents"
link "$here/scripts/slot.sh" "$target/.claude/slot.sh"
# The CI and merge relays run wait-ci.js and merge-pr.js from here (project.loopScripts, default .claude/scripts).
link "$here/scripts" "$target/.claude/scripts"
for f in "$here"/claude/hookify.*.local.md; do
  link "$f" "$target/.claude/$(basename "$f")"
done

if [ ! -e "$target/.claude/loop.local.json" ]; then
  cp "$here/templates/loop.local.json" "$target/.claude/loop.local.json"
  echo "wrote $target/.claude/loop.local.json from the template; fill it in"
fi

# Per-clone excludes: nothing the loop adds is ever tracked, and no .gitignore line is needed.
# No trailing slashes: git sees the symlinks as files, and "dir/" patterns would not match them.
exclude="$target/.git/info/exclude"
if [ -d "$target/.git" ] || [ -f "$target/.git" ]; then
  gitdir="$(git -C "$target" rev-parse --git-common-dir)"
  case "$gitdir" in /*) ;; *) gitdir="$target/$gitdir" ;; esac
  exclude="$gitdir/info/exclude"
  mkdir -p "$(dirname "$exclude")"
  touch "$exclude"
  for line in '.claude/workflows' '.claude/agents' '.claude/slot.sh' '.claude/scripts' '.claude/hookify.*.local.md' '.claude/loop.local.json' 'CLAUDE.local.md'; do
    grep -qxF "$line" "$exclude" || echo "$line" >> "$exclude"
  done
  echo "excluded the linked paths in $exclude"
fi

cat <<'MSG'

Next: fill in .claude/loop.local.json, write the task spec it points at, then open Claude Code in the repo
and ask for a wave. The session reads ~/dev/agent-loop/README.md first (see ~/.claude/CLAUDE.md).
MSG
