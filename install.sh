#!/usr/bin/env bash
# Link the agent-loop files into a target repo's .claude directory without tracking them there.
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
for f in "$here"/claude/hookify.*.local.md; do
  link "$f" "$target/.claude/$(basename "$f")"
done

cat <<'EOF'

Add to the repo's .gitignore (the loop is not part of the product):
.claude/workflows/
.claude/agents/
.claude/hookify.*.local.md
EOF
