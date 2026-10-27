---
name: block-force-push
enabled: true
event: bash
pattern: git\s+push\b.*(--force|\s-f\b|--force-with-lease)
action: block
---

Force pushes are never allowed in this repository.

Push a new commit instead, or rebase locally and open a fresh PR. If a force push is truly needed, a human does it outside the agent.
