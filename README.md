# agent-loop

Edan's method for building a codebase with Claude Code agents. This repo holds the method. The
repos it is used on hold only their own code: the loop is linked into their `.claude/` directory
and excluded from git there.

If you are a Claude Code session in a repo that has `.claude/loop.local.json`, this file is your
operating manual. Read it fully before running a wave.

## How a project is built

1. A human writes a task spec: fixed decisions, then waves of tasks. Every task has an id, a title,
   an acceptance test written out, the paths it owns, and (for later waves) the ids it depends on.
   One task per wave is the tail: it integrates the others and runs alone after them.

   Shape waves wide, not deep. Each dependency hop costs about 15 minutes of review, CI and merge before the next
   worker can start (Pilot waves 9 and 12, 4 to 5 hops, ran 24 to 25 minutes per merged task against 10 for the wide
   wave 7). So:
   - Keep waves for 3 or more independent tasks, with dependency chains at most 2 tasks deep before the tail.
   - Chain-shaped work (each task needs the one before) goes out as one task with stacked commits, or as single PRs
     outside a wave. So does a wave of 1 or 2 tasks: a single PR through the producer and critic agents is faster.
   - Keep tasks small: about 6 owned paths at most, and at most one migration per task.
   - `node scripts/spec-lint.js <spec>` warns on a chain deeper than 2, a wave of 2 or fewer tasks, a task owning more
     than 6 paths, and a task adding more than one migration. Warnings do not fail the lint.
2. Before each wave the session reviews the wave's tasks against the spec for ambiguity and asks
   the human the questions that would change the work. Answers go into the spec, not into prompts.
3. The session runs the `wave-loop` workflow once for the wave. For each task: a worker builds it
   in its own git worktree and opens a PR; a critic that did not write the code reviews the PR
   against a fixed checklist and returns MERGE, FIX or STOP; a merger syncs, waits for CI, merges,
   and runs the check on main. The check on main is skipped when the merged tree is the tree CI checked on the PR
   (main had not moved past the branch: `mainCheck: "skipped:unchanged"` in the merge result); otherwise, with
   `mainCi` set, main's run is watched after the merge lock is released, so the next PR can sync and merge meanwhile.
   FIX returns to the worker, at most three rounds. When the critic already said MERGE and the only later changes are
   CI-only (formatting, a lint autofix, or a sync merge with no conflict; `scripts/ci-only.js` decides from the diff),
   the next round reuses that MERGE instead of a second critic (`critic round 2: skipped (CI-only change)`). A red main is
   reverted once and the task reopened once. A worker that returns before its check has finished
   (`checkExitCode` -1) is sent back to finish it, at most two times, instead of escalating.
   Anything else parks the task with an escalation.
4. The wave gate: every task merged or parked, check green on main, the wave's replay passes,
   no open escalations. The session reports the gate and the escalations; the human decides.
5. The session writes the wave scorecard and reads it before changing any role's model or effort.

## Running a wave

Read `.claude/loop.local.json` in the repo and pass it whole as `args.project`:

```
Workflow({ name: 'wave-loop', args: { project: <loop.local.json>, wave: '2', tasks: [...], tail: {...} } })
```

Each task: `{ id, title, branch, deps: [ids], text, owns, notes }`, with `text` and `owns` copied
verbatim from the spec. `tail` has the same shape or is `null`. A parked task is relaunched by
passing only the parked tasks again; a task whose draft PR should be continued after an escalation
was answered gets `resume: { prNumber, prUrl, worktree, items: [what to do], notes }`.

The result is `{ project, wave, gate, models, state, tasks, escalations }`. Save it as JSON in the
session scratchpad, then write the scorecard:

```
python3 -I ~/dev/agent-loop/scripts/loop-scorecard.py <wave> <date> <result.json>... > ~/dev/agent-loop/docs/<project>/<date>-wave-<n>-loop.md
```

Several result files for one wave (a relaunch after an escalation) merge into one scorecard.

## Rules the session keeps

- Roles: worker Sonnet/high, critic Fable/high, merger Sonnet/low. Change one role one notch at a
  time, one role per wave, and only after a scorecard shows why. `project.models` overrides.
- Up to `project.maxChains` tasks are in flight at once (default 6). Memory is bounded separately: the
  install and check commands run through `.claude/slot.sh`, a machine-wide counting semaphore with
  `project.maxBuilders` slots (default 2 on an 8 GB machine; one check peaks near 1.7 GB). Every
  session on the machine shares those slots, so two projects cannot stack checks on each other.
  Agents that are thinking or waiting on CI hold no slot. Workers' quick checks run through the same wrapper.
- Keep the machine quiet during a wave: no other heavy jobs (builds, test suites, other checks, a rescue agent running
  full checks) while a wave runs. Anything that must run then goes through `.claude/slot.sh` so it waits for a slot.
  In Pilot wave 12 one worker took 58.9 minutes and 15.9M tokens at a load average of 200 to 480 while a rescue ran
  checks beside it, against 25.7 minutes and 2.1M for a task of the same size. The preflight logs a warning when the
  1-minute load average is above `project.loadWarnFactor` (default 4) times the core count; it does not block.
- Edits outside a task's owned files follow the project's own rule (in its `CLAUDE.md`). Where the project allows
  small mechanical edits (a test, replay script or generated block that breaks only because of the task's change),
  the worker makes them and lists each under "Edits outside owned files" in the PR body, and the critic checks that
  each one is mechanical, within the project's limit, and weakens no assertion. Anything else outside the owned paths
  still stops the worker and becomes an escalation. A project without such a rule keeps the strict ownership rule.
- List a wave's tasks longest first; the scheduler takes list order as priority, and longest-first
  minimises the wave's finish time.
- Never commit to main. Never force push. Never push to main. The hookify rules enforce this for
  every agent, and they also apply to the session's own shell commands: a `git commit` or `git push`
  command line must not contain the word `main` (use `-F msgfile` for messages that need it).
- Never edit the linked loop files from inside a project session unless the human asks. Changes
  to the loop are commits in `~/dev/agent-loop`, which every linked repo sees at once.
- Stop finished agents. Each worker gets one task and runs the full check once per round.
- The human reads the merged PRs between early waves. Later waves chain on the machine gate only
  when the human has said so.

## Project config

`.claude/loop.local.json` (copied from `templates/loop.local.json` by `install.sh`, never tracked):

| field | meaning |
|---|---|
| `name`, `repo`, `github`, `worktrees`, `spec` | required: project name, absolute repo path, `owner/repo`, absolute worktree parent, spec path in the repo |
| `readFirst` | files or sections every agent reads before its task (default `CLAUDE.md`). Keep long reference files sectioned: an entry `"CONTRACT.md#Owner map"` or `{ "path": "CONTRACT.md", "sections": ["Owner map"] }` is read only in those sections plus the sections the task names, never whole; a plain entry is read as written |
| `install`, `check` | the install and the one check command (defaults `npm ci`, `npm run check`) |
| `forbiddenStrings` | strings that must not appear in any diff (confidential names) |
| `extraRules` | sentences appended to the hard rules |
| `sideFiles` | which generated files may change in any PR (lockfile, test-count ratchet) |
| `syncConflicts` | the only files a sync merge may resolve, and how |
| `checkMutates` | files the check rewrites on main that the merger restores |
| `criticChecks` | project invariants appended to the critic checklist |
| `workerNotes`, `notes` | text added to worker prompts, or to every prompt |
| `maxBuilders`, `maxChains`, `fixRounds`, `finishRounds`, `models`, `trailer` | loop knobs; defaults 2 check slots, 6 chains, 3 fix rounds, 2 finish rounds, the roles above, `Co-Authored-By: Claude <noreply@anthropic.com>` |
| `mainCi` | name of the CI workflow that runs the check on pushes to main; when set, the merger waits for that run instead of running the check on this machine |
| `syncPolicy` | `always` (merge main into the branch before every merge) or `conflict` (only when GitHub reports a conflict; needs branch protection without the up-to-date rule and `mainCi`) |
| `loadWarnFactor` | the preflight warns when the 1-minute load average is above this many times the core count (default 4) |

## What is here

- `claude/workflows/wave-loop.js`: the workflow. Deterministic scheduling and gates; models decide
  only inside a task.
- `claude/agents/`: producer, critic and merger role definitions, for use through the Agent tool
  outside a wave (a single task, a single review).
- `claude/hookify.*.local.md`: hookify rules that block force pushes, secrets in file writes, and
  commits or pushes that name the default branch.
- `scripts/slot.sh`: the machine-wide check semaphore, linked into each repo as `.claude/slot.sh`.
- `scripts/merge-pr.js`, `scripts/wait-ci.js`, `scripts/ci-only.js`: the merge, the CI wait and the CI-only delta check,
  run by relay agents from `.claude/scripts`. `merge-pr.js --defer-main` merges and leaves main's run to
  `merge-pr.js --verify-main <sha>`, which waits for it and reverts once on red.
- `scripts/spec-lint.js`: structural check of a spec, plus the wave and task shape warnings above.
- `scripts/loop-scorecard.py`: per-wave scorecard (rounds, fix items by cause, tokens and minutes
  per role, and the decision rule for moving a role's model or effort).
- `tests/hookify.test.ts`: checks that the three rules exist and are well formed.
- `templates/loop.local.json`: the project config template.
- `docs/<project>/`: records from each project (spec reviews, scorecards, handoffs, the loop
  appendices as first written for Pilot).

## Installing into a repo

```
~/dev/agent-loop/install.sh /path/to/repo
```

Symlinks the workflow, the agents, the slot wrapper and the hookify rules into `.claude/`, copies the config
template if there is none, and lists all of them plus `CLAUDE.local.md` in the repo's
`.git/info/exclude`, so nothing the loop adds can be committed and no `.gitignore` line is needed.
Claude Code and the hookify plugin read these from disk, so the loop runs exactly as if the files
were in the repo.

## Principles the loop encodes

1. Every task has a pre-written acceptance test, committed before the implementation, and one owner
   per file. A worker that finds a choice takes the conventional default and writes it to the PR
   body; a worker that finds two materially different readings stops.
2. A critic that did not write the code reviews every PR against a fixed checklist and names the
   check that proves each fix item. Verdicts are MERGE, FIX or STOP; STOP names the spec section.
3. Deterministic control flow decides what runs next; models decide only inside a task.
4. Machine gate per wave; humans read between early waves, then the gate chains.
5. Measure each role (first-pass merge rate, fix causes, critic misses, tokens) and move models one
   notch at a time, one role per wave, so the baseline stays readable.
