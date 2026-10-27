# agent-loop

Edan's orchestration method for building a codebase with Claude Code agents. This repo holds the
method; the codebases it is used on hold only their own code. Nothing here is specific to one
product: the loop takes a task list as input.

## What is here

- `claude/workflows/wave-loop.js`: one Workflow run per wave. Parallel tasks run two at a time,
  each in its own git worktree, through worker -> critic -> merger (up to 3 fix rounds, one revert
  and reopen), then a tail task runs alone. Tasks and the tail are passed as `args`; a task with
  `resume` continues a draft PR after an escalation is answered. Role models and effort are pinned
  in the `MODELS` map at the top.
- `claude/agents/`: producer, critic and merger role definitions (the critic checklist and merger
  steps in prose, for use outside the workflow).
- `claude/hookify.*.local.md`: hookify rules that block force pushes, secrets in file writes, and
  commits or pushes that name the default branch.
- `scripts/loop-scorecard.py`: per-wave scorecard (rounds, fix items by cause, tokens and minutes
  per role, and the decision rule for moving a role's model or effort up or down a notch).
- `tests/hookify.test.ts`: the Vitest check that the three rules exist and are well formed.
- `docs/<project>/`: records from each project the loop was run on (spec reviews, scorecards,
  the loop appendices as they were written for that project, handoffs).

## Using it on a repo

```
./install.sh /path/to/repo
```

Symlinks `.claude/workflows`, `.claude/agents` and the hookify rules into the repo and prints the
`.gitignore` lines to add so none of it is tracked there. The Workflow tool and the hookify plugin
read these from disk, so the loop runs the same whether or not the files are committed.

Then, per wave: `Workflow({ name: 'wave-loop', args: { wave, tasks, tail } })`, and afterwards

```
python3 -I scripts/loop-scorecard.py <wave> <date> <workflow output json>... > docs/<project>/<date>-wave-<n>-loop.md
```

## Principles the loop encodes

1. Every task has a pre-written acceptance test, committed before the implementation, and one owner
   per file. A worker that finds a choice stops and writes it to the PR body.
2. A critic that did not write the code reviews every PR against a fixed checklist and names the
   check that proves each fix item. Verdicts are MERGE, FIX or STOP; STOP names the spec section.
3. Deterministic control flow decides what runs next; models decide only inside a task.
4. Machine gate per wave: every task merged or parked, check green on the default branch, the
   wave replay passes, no open escalations. Humans read between early waves, then the gate chains.
5. Measure each role (first-pass merge rate, fix causes, critic misses, tokens) and move models one
   notch at a time, one role per wave, so the baseline stays readable.
