---
name: block-secrets
enabled: true
event: file
conditions:
  - field: content
    operator: regex_match
    pattern: (sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|postgres(ql)?://[^:\s/@]+:[^@\s]+@|sb_(secret|publishable)_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})
action: block
---

This content looks like a secret (Anthropic key, GitHub token, AWS access key id, a Postgres URL with a password, a Supabase `sb_secret_` or `sb_publishable_` key, or a JWT such as a Supabase anon or service-role key).

Secrets come from the environment only. Reference the variable name (for example `DATABASE_URL`) and never write the value into the repository.
