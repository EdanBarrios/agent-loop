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

# The gh rule is written, not linked: its pattern names this project's repository (the `github` field of
# loop.local.json). It blocks gh commands that name another repository. The template's owner/repo is a placeholder.
gh_rule="$target/.claude/hookify.gh-this-repo.local.md"
if command -v node >/dev/null 2>&1; then
  node - "$target/.claude/loop.local.json" "$gh_rule" <<'JS'
const { readFileSync, rmSync, writeFileSync } = require('node:fs');
const [config, out] = process.argv.slice(2);
let github = null;
try {
  github = JSON.parse(readFileSync(config, 'utf8')).github;
} catch {}
if (typeof github !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github) || github === 'owner/repo') {
  console.log('no gh rule written: set "github": "owner/name" in .claude/loop.local.json and run install.sh again');
  process.exit(0);
}
const repo = github.replace(/\./g, '\\.');
const tail = '(?:["\'\\s;&|)]|$)';
const other = `(?!${repo}${tail})`;
const value = `["']?${other}[^\\s"';&|)]`;
const name = '[\\w.-]+/[\\w.-]+';
const parts = [
  `\\bgh\\b[^\\n]*?(?:\\s-R\\s*=?\\s*|\\s--repo(?:=|\\s+))${value}`,
  `\\bgh\\b[^\\n]*?github\\.com[/:](?!${repo}(?:\\.git)?(?:[/"'\\s;&|)]|$))${name}`,
  `\\bgh\\s+api\\b[^\\n]*?\\brepos/(?!${repo}(?:[/?"'\\s;&|)]|$))${name}`,
  `\\bgh\\s+repo\\s+(?:clone|create|delete|edit|fork|rename|set-default|sync|view|archive|unarchive)\\s+(?:-\\S+\\s+)*["']?${other}${name}`,
  `\\bGH_REPO=${value}`,
];
const text = `---
name: gh-this-repo
enabled: true
event: bash
pattern: ${parts.join('|')}
action: block
---

This gh command names a repository other than ${github}. In this project the loop works on ${github} only: a shared gh login reaches every repository its owner has.

Leave out --repo / -R, or name ${github}. This file is written by install.sh from the github field of .claude/loop.local.json; edit that field and run install.sh again to change it.
`;
rmSync(out, { force: true });
writeFileSync(out, text);
console.log(`wrote ${out} for ${github}`);
JS
else
  echo "no gh rule written: node is not installed"
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
  for line in '.claude/workflows' '.claude/agents' '.claude/slot.sh' '.claude/scripts' '.claude/hookify.*.local.md' '.claude/hookify.gh-this-repo.local.md' '.claude/loop.local.json' 'CLAUDE.local.md'; do
    grep -qxF "$line" "$exclude" || echo "$line" >> "$exclude"
  done
  echo "excluded the linked paths in $exclude"
fi

cat <<'MSG'

Next: fill in .claude/loop.local.json, write the task spec it points at, then open Claude Code in the repo
and ask for a wave. The session reads ~/dev/agent-loop/docs/OPERATING.md first (see ~/.claude/CLAUDE.md).
MSG
