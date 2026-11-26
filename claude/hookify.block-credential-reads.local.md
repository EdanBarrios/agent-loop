---
name: block-credential-reads
enabled: true
event: bash
pattern: (?:~|\$HOME|\$\{HOME\}|/Users/[^/\s]+|/home/[^/\s]+|/root)/\.(?:ssh|aws|netrc)\b|(?:~|\$HOME|\$\{HOME\}|/Users/[^/\s]+|/home/[^/\s]+|/root)/\.config/gh\b|(?:^|[\s"'=:])\.(?:ssh|aws)/|(?:^|[\s"'=:/])\.netrc\b|\bgh\s+auth\s+token\b|\bsecurity\s+find-(?:generic|internet)-password\b
action: block
---

This command reads a credential: a path under `~/.ssh`, `~/.aws`, `~/.config/gh` or `~/.netrc`, `gh auth token`, or `security find-generic-password` / `find-internet-password`.

Agents run with the user's privileges, so a credential read is never part of a task. Use the token the environment already gives the command (for example `GH_TOKEN`), or ask a human. This rule is one layer: the `permissions.deny` read rules that `scripts/isolation.js` lists are the other.
