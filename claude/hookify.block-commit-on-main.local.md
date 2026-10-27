---
name: block-commit-on-main
enabled: true
event: bash
pattern: git\s+commit\b(?![^\n]*(?:origin/main|\bMerge\b))[^\n]*\bmain\b|git\s+push\b(?![^\n]*(?:origin/main|\bMerge\b))[^\n]*\bmain\b
action: block
---

Never commit or push to main. Create a branch (`git switch -c <type>/<id>-<slug>`) and open a PR.

Limitation: a bash rule only sees the command text, so this blocks commands that name `main`, not a plain `git commit` while main is checked out. Agents must check `git branch --show-current` before committing. Commands that mention `origin/main` or `Merge` are sync merges into a branch and are allowed (false positive found 2026-10-27 when a merger committed a main-into-branch merge).
