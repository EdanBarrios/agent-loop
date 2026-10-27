---
name: block-secrets
enabled: true
event: file
conditions:
  - field: content
    operator: regex_match
    pattern: (sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|postgres(ql)?://[^:\s/@]+:[^@\s]+@)
action: block
---

This content looks like a secret (Anthropic key, GitHub token, AWS access key id, or a Postgres URL with a password).

Secrets come from the environment only. Reference the variable name (for example `DATABASE_URL`) and never write the value into the repository.
