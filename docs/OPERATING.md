# agent-loop operating manual

This is the manual the Claude Code session reads before it runs a wave, and the reference for every knob. For what
the loop is and why it is built this way, start with the [README](../README.md).

The loop lives in one checkout (`~/dev/agent-loop` below) and is linked into each project's `.claude/` directory,
excluded from git there, so the project repo holds only its own code. If you are a Claude Code session in a repo that
has `.claude/loop.local.json`, read this file fully before running a wave.

## How a project is built

1. A human writes a task spec: fixed decisions, then waves of tasks. Every task has an id, a title,
   an acceptance test written out, the paths it owns, and (for later waves) the ids it depends on.
   One task per wave is the tail: it integrates the others and runs alone after them.

   Shape waves wide, not deep. Each dependency hop costs about 15 minutes of review, CI and merge before the next
   worker can start (on the pilot project, waves 9 and 12, 4 to 5 hops deep, ran 24 to 25 minutes per merged task
   against 10 for the wide wave 7). So:
   - Keep waves for 3 or more independent tasks, with dependency chains at most 2 tasks deep before the tail.
   - Chain-shaped work (each task needs the one before) goes out as one task with stacked commits, or as single PRs
     outside a wave. So does a wave of 1 or 2 tasks: a single PR through the producer and critic agents is faster.
   - Keep tasks small: about 6 owned paths at most, and at most one migration per task.
   - `node scripts/spec-lint.js <spec>` warns on a chain deeper than 2, a wave of 2 or fewer tasks, a task owning more
     than 6 paths, and a task adding more than one migration. Warnings do not fail the lint.
2. Before each wave the session reviews the wave's tasks against the spec for ambiguity and asks
   the human the questions that would change the work. Answers go into the spec, not into prompts.
   The `spec-review` workflow does this: a reviewer, one spike per external fact, a targeted second reviewer pass that
   revises only the recommendations relying on a fact (since 2.3.1; before, it re-ran the whole review), and an
   adversary. The reviewer also checks whether a task's change breaks a test file another task owns (often an earlier
   wave's tail test that pins an exact result shape with `toEqual`); a worker may edit only its owned paths, so such a
   test needs a named editor in the spec's owner table before the wave. Warden wave 3 parked four tasks on this.
   Workflows cannot write files: by default (2.3.1) the result carries `reviewPath` and `writeBy: "session"`, and the
   session writes the file with `node ~/dev/agent-loop/scripts/write-review.js <the run's output file>`, byte for byte
   what the old writer agent wrote. `project.reviewWriter: "agent"` keeps the Haiku writer agent.
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
   Since 2.3.0 the critic also returns `findings`, every problem it saw with a severity (`high`, `medium`, `low`) and a
   file:line. A high finding is a FIX item: a MERGE that carries one is turned into FIX by the workflow. Medium and low
   findings do not change the verdict; they go into the result and the scorecard instead of being lost in the notes.
   The checklist's item 9 is security, for tasks that touch the network, a database, env, auth or secrets: TLS on every
   connection, least-privilege roles, no secrets in logs or URLs, parameterized SQL, an allowlist before any fetch.
   After the tail, one read-only integration review on the critic model reads `git diff <wave base>..origin/main` (the
   base is origin's head, recorded by the preflight dry run) for duplication across tasks, layering, security,
   performance at real data sizes and dead code. It never edits and never changes the gate; its findings are
   `result.integration`. `project.integrationReview: false` turns it off.
4. The wave gate: every task merged or parked, check green on main, the wave's replay passes,
   no open escalations. The session reports the gate and the escalations; the human decides.
5. The session writes the wave scorecard and reads it before changing any role's model or effort.

## Running a wave

Start the session in the project repo. `Workflow({ name: 'wave-loop' })` resolves the name from the
`.claude/workflows` of the directory the session started in, and the agents the same way. A session
started in `~/dev/agent-loop` gets that repo's own pinned copy (`.claude/` there links to
`~/dev/agent-loop-stable`), not the loop the project links. The preflight compares the workflow's
`LOOP_VERSION` with the version the project's linked scripts print and fails the wave when they
differ; a wave-loop older than 2.2.0 has no such check, and its scorecard carries a LOOP VERSION flag.
From `~/dev/agent-loop`, launch the loop workflows by `scriptPath` (`~/dev/agent-loop/claude/workflows/<name>.js`).
`chain-loop` runs each wave through `workflow({ scriptPath: '<repo>/.claude/workflows/wave-loop.js' })`, the copy
linked into the project, not by name (`args.waveLoop` overrides it), and stops with an error that names both versions
when a wave reports another `loopVersion` than its own.

Build the args from the spec instead of by hand:

```
node ~/dev/agent-loop/scripts/wave-args.js --repo <repo> --wave <id> [--tail <task id>] [--notes <text>] [--scorecards <dir>] > args.json
```

It lints the spec, reads `.claude/loop.local.json` as `project`, copies each task of the wave verbatim (text, owned
paths, same-wave dependencies, lane, a `task/<id>-<slug>` branch) and takes the wave's `.T` task as the tail.

**Read the token estimate before launching a wave.** With `--scorecards <dir>` (the directory holding the project's
`*-loop.md` scorecards, for example `~/dev/agent-loop/docs/<project>/`) it adds `budget: { tasks, tokensPerTask,
estimate, basis }` to the args and prints `wave-args: estimated <n>M tokens for <k> tasks (median of <files>)` on
stderr: the median tokens per task of the newest three usable scorecards times the wave's task count, tail included.
A wave cannot spend tokens it is certain to waste, so compare the estimate with what is left of the usage window
before you start; a wave that will hit the limit is better started after the reset. Without the flag, or with no
usable scorecard, `budget` is `null` and nothing is printed.

By hand: read `.claude/loop.local.json` in the repo and pass it whole as `args.project`:

```
Workflow({ name: 'wave-loop', args: { project: <loop.local.json>, wave: '2', tasks: [...], tail: {...} } })
```

Each task: `{ id, title, branch, deps: [ids], text, owns, notes }`, with `text` and `owns` copied
verbatim from the spec. `tail` has the same shape or is `null`. A parked task is relaunched by
passing only the parked tasks again; a task whose draft PR should be continued after an escalation
was answered gets `resume: { prNumber, prUrl, worktree, items: [what to do], notes }`.

Preflight and the permission rule (H2, 2.4.0): before any worker starts, the preflight dry run of `merge-pr.js` also
reports `permission`, its prediction of whether the permission system will let the merge relay run the merge
commands (it only reads `~/.claude/settings.json` and the project's `.claude/settings.json` and
`settings.local.json`, plus the managed settings file). When `permission.allowed` is false the wave fails in preflight
with one escalation that names the rule to add, `Bash(node <scripts dir>/merge-pr.js *)` (the path exactly as
`project.repo` plus `/.claude/scripts` spells it, absolute and not the link's target), and lists the broad rules that
exist but do not count (`Bash`, `Bash(*)`, `Bash(node *)`: auto mode drops them). Adding the rule is human checklist
item H2 and a permission setting, so the loop never does it; add one rule for each script a relay runs (`merge-pr.js`,
`wait-ci.js`, `ci-only.js`, and from wave 2 `impact.js` and `test-edits.js`), then confirm once by running one relay in auto mode
that the classifier is not consulted. A matching deny rule fails the preflight in every mode. A dry run with no
`permission` field (a `merge-pr.js` older than 2.4.0) logs a note and the wave continues.

A wave that stops on a usage limit (2.4.0): an agent failure that reads as a limit resetting far out ("too far out to wait
for"), or a bare `null` from an agent that a probe (one relay running `true`) confirms, pauses the wave. No new task
chain starts and agents already running finish and merge. Tasks that did not run, and the task whose agent failed, come
back as `paused` (state and result entry, no rounds); a task that depends on one is `paused`, not parked, and so is the
tail. A task parked for another reason stays parked with its own escalation. The wave raises one escalation,
`wave paused: usage limit, resets <time>`, where `<time>` is copied from the failure message (`unknown` when it has none). The
result gains `paused: { resetsAt, resetText, tasks }` and `gate: "PAUSED"`; the key is absent from any other result.
`resetsAt` is always `null` there: the workflow has no clock, so compute it from `resetText` with a clock and wait for it.
The machine gate, the reality gate and the integration review do not run. A short limit (one that resets soon) does not
pause: the task parks as before, and the critic's own swap to the fallback model still comes first. After the reset, relaunch
the `paused` tasks as you relaunch parked ones (below). `chain-loop` stops on any gate other than `PASS`, so `PAUSED` stops a chain.

Relaunches (2.3.1):
- A dependency that is not in the relaunch counts as merged in an earlier run of the wave and is logged once; it is not
  checked again, so pass only tasks whose missing dependencies did merge. Before 2.3.1 such a task never started and was
  parked as unschedulable.
- The critic sees a task's `resume.items` and `resume.notes` under "Session answers for this relaunch" and treats them
  as authoritative for the questions the worker asked. An answer that lets a task edit a path it does not own still
  needs a record in a read-first file (the owner table in `CONTRACT.md`, say); without it the critic fails checklist
  item 2, as it did for Warden 3.12.
- When a merge relay's output is lost (the relay returned nothing, or its shell was killed: exit 144), the merge is
  never re-run. One relay runs `merge-pr.js <pr> --state`, read only; a PR that is MERGED with a merge commit counts as
  merged (with `mainCi`, main's run is then checked by `--verify-main` as after any deferred merge; without it the
  result says `mainCheck: "unverified"`). Anything else escalates as before. Warden 3.3 (PR #45) had merged when its
  relay was killed and was parked anyway.

The result is `{ project, wave, gate, models, state, tasks, escalations, reality, decisions, timings, loopVersion, findings, integration }`
(`gate` is `PASS`, `FAIL`, `BLOCKED` or `PAUSED`; a paused wave adds `paused`).
Save it as JSON in the session scratchpad, then write the scorecard:

```
python3 -I ~/dev/agent-loop/scripts/loop-scorecard.py <wave> <date> <result.json>... [--escaped <n> | --escaped-from <escaped.json>] --out <scorecard path> > <scorecard path>
```

Several result files for one wave (a relaunch after an escalation) merge into one scorecard. `--escaped <n>` is the
number of fix commits made after the wave that trace to a task it merged: defects the critic let through. Count them
from the default branch's history (for the previous wave, when the scorecard is written late). `--escaped-from
<escaped.json>` takes the per-task counts from `scripts/escaped.js` instead (see "Escaped defects", below); the two
flags together are an error. The scorecard lists every high and medium critic finding and the integration review's
findings. Every rate it prints (worker first-pass MERGE, critic misses per merged task) carries its 95% Wilson interval,
as `72% (55–84%, n=30)`.

Decision rule (printed at the end of each scorecard): a role moves only when the pooled 95% interval lies wholly on one
side of the threshold, so one small wave rarely moves anything (pool waves with `--pool`, below). Worker: an upper bound
of first-pass MERGE under 50% with defect-cause items moves the worker up; only spec_miss items, fix the prompt. Critic:
a miss is a revert after MERGE or an escaped defect; a lower bound of the share of merged tasks with a miss above 5%
moves the critic up (or add the missed kind to the checklist), and an upper bound under 10% with only low findings moves
it down. Merger: any failure traced to the model, bump up. Loop-cause items are fixed in the workflow script, not by a
model change. Move one role one notch per wave, so the baseline stays readable.

### Impact and test-edits relays (2.4.0)

Two relays run a read-only script of the loop beside the agents, each alone (the relay prompt types the command with no
`cd` before it and nothing joined by `&&` or `;`, and every command takes `--repo`: an allow rule matches only the command
on its own, and a compound command goes to the auto-mode classifier). Each script therefore needs its own allow rule
(H2, above). Neither relay stops a task: one that fails or returns nothing is logged and the prompt goes on without its part.

- **Impact, before the worker** (label `impact:<task id>`): `node <scripts dir>/impact.js --repo <repo> --owns <paths> [--spec <spec>]`
  for the paths in the task's Owns text (a task whose Owns names no file runs no relay). It prints `{ tests: [{ path, via,
  owner }] }`: the existing test files that import an owned path directly (`via` null) or through one intermediate
  non-test module (`via` names it), and the test files that name an owned file's path or basename in a quoted string
  (`via: "name"`: tests that read a script with `readFileSync` or run it with `execFile` import nothing). `owner` is the
  task whose Owns line in the spec lists the test. Imports are found by regex, so the map errs toward one test too many.
  The worker prompt lists the tests with their owners and tells the worker to run them before opening the PR and to stop
  with a question when a change breaks a test another task owns. Test files come from `testGlobs`; path aliases from
  `compilerOptions.paths` in the repo's `tsconfig.json`.
- **Test edits, before each critic round** (label `test-edits:<task id> r<n>`): `node <scripts dir>/test-edits.js <pr> --repo <repo>`.
  It prints `{ testFirstCommit, files, assertionsRemoved, assertionsChanged, bodySection, note }`: the assertion lines
  of test files that the branch removed or changed after its test-first commit (the first non-merge commit that adds or
  changes a test file), leaving out lines the branch took from the base branch through merges, and whether the PR body has a
  line starting with `Test edits:`. The critic prompt carries the report under "Test edits after the test-first commit",
  and checklist item 3 fails an assertion removed or changed unless that section justifies each one and the
  justification holds. The gate does not depend on the critic: `assertionsRemoved + assertionsChanged > 0` with
  `bodySection` false makes the verdict FIX whatever the critic said (cause `defect`, item "restore the assertion or
  justify it under Test edits:"). The worker answers a FIX either by restoring the assertion or by adding a `Test edits:`
  section to the PR body (`gh pr edit`, one line per assertion with the reason). A relay that printed no JSON line is run
  once more; if it is still blocked or empty the round records `testEdits: "unavailable"` and the critic is told to run
  `git diff` over the test files itself. The report is in each round's record (`testEdits`). A fast-lane task with a
  non-zero count and no `Test edits:` section is not eligible, so the critic reviews it, and a round whose critic is
  skipped as CI-only reuses the report of the round it follows.

### Escaped defects: scripts/escaped.js (2.4.0)

```
node ~/dev/agent-loop/scripts/escaped.js --repo <repo> [--since <YYYY-MM-DD>] [--prefix task/] > escaped.json
```

Run it from a machine where `gh` is authenticated and the repo checkout has the default branch's full history. It reads
only (`gh pr list`, `gh pr view`, `git log`, `git diff`, `git blame`) and prints one JSON line: `{ tasks: { "<task id>":
{ pr, prs, escaped, fixes: [{ sha, title, kind, files, lines }] } }, scanned, note }`. Task PRs are the merged PRs whose head
branch starts with the prefix (task id from `task/<id>-<slug>`; `--since` keeps those merged on or after the date; `note`
says so when `gh` returned its 1000-PR cap). A later commit on the default branch counts as an escaped defect of a task
when it changes or deletes a line that, before it, last came from that task's PR commits, and it is a fix: its subject, or
the title of the PR it merges, starts with `fix` (a fix pushed straight to the default branch counts). It counts once per
(fix commit, task) pair. Merges of task branches and of the loop's own `revert/` branches are not later commits (a revert
is already counted as `reopened`), and other later commits that touch such lines are listed with `kind: "other"` so a
human can reclassify them; they do not count. Exit 0 prints the report, 1 means `gh` or `git` failed (the line carries
`note: "error: ..."`), 4 is bad usage.

Pass the file to the scorecard with `--escaped-from escaped.json`: each merged task's critic miss comes from its own
`escaped` count (a revert after MERGE is a miss as before), the scorecard lists each fix commit under "Escaped fix
commits", and a task of the file that is not in the given runs is ignored and counted in a note. Run escaped.js again
and rewrite the scorecard when more commits have landed, because fixes arrive after the wave: a wave scored the day it
merged has few escapes by construction.

### Pooling waves: --pool (2.4.0)

```
python3 -I ~/dev/agent-loop/scripts/loop-scorecard.py --pool <result.json>... [--escaped-from <escaped.json>]
```

Prints one table across the given runs, each file one run (task ids may repeat between runs and are kept apart; an
escaped file attributes a task to the last run that merged it): the rates with their intervals, reverts, fix commits and
escaped defects, fix items by cause, checklist failures per checklist number and tokens per task, with no per-task
section, and then the decision rule. Pool the waves since the last role change before reading a rate against a threshold.
A rate leaves out only tasks that never started (`paused`, parked for a parked dependency, a tail not run): a task
whose worker ran and delivered no PR counts as not first-pass, and a fast-lane MERGE counts as first-pass.

### Labelling the critic: scripts/label-sheet.py (2.4.0)

The scorecard says how often the critic's verdicts were followed, not whether they were right. A human labels a sample,
and the labels give the critic's precision:

```
python3 -I ~/dev/agent-loop/scripts/label-sheet.py <result.json>... [--sample <n>] [--seed <s>] > sheet.md
python3 -I ~/dev/agent-loop/scripts/label-sheet.py --read sheet.md
```

The first form prints a Markdown sheet: one row per fix item of a FIX verdict and one row per MERGE verdict, for every
round whose critic ran (none for a STOP verdict, a `lane: 'fast'` round or a `criticSkipped` round). Each row is keyed
by task, round and item (the fix item's `n`, or `merge`) and carries the verdict, the fix item text and the PR link.
Write `y` or `n` in `real? (y/n)` on a fix-item row (is the item a real defect?) and in `correct? (y/n)` on a MERGE row
(was merging right?). `--sample <n>` draws n verdicts, FIX and MERGE in their observed proportion, reproducibly by `--seed`
(default 0); a drawn FIX verdict brings all its rows. The second form reads the filled sheet and prints the share of FIX
items labelled real and of MERGEs labelled correct, each with its Wilson interval, and the rows left unlabelled; only
`y`/`yes` and `n`/`no` count, and an empty or other cell is counted as unlabelled, never guessed. A round's `checklist`
(one entry per critic checklist item, each with quoted evidence) is what the human checks the verdict against; the
scorecard counts the items failed per checklist number. A round whose critic returned no checklist is recorded with
`checklistEmpty: true` and a `note:` line in the log.

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
  In wave 12 of the pilot project one worker took 58.9 minutes and 15.9M tokens at a load average of 200 to 480 while a rescue ran
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
| `integrationReview` | `false` turns off the read-only integration review of the whole wave's diff after the tail (on by default since 2.3.0) |
| `reviewWriter` | `"agent"` has spec-review write its file through a Haiku agent; by default (2.3.1) the session writes it with `scripts/write-review.js` |
| `workerNotes`, `notes` | text added to worker prompts, or to every prompt |
| `maxBuilders`, `maxChains`, `fixRounds`, `finishRounds`, `models`, `trailer` | loop knobs; defaults 2 check slots, 6 chains, 3 fix rounds, 2 finish rounds, the roles above, `Co-Authored-By: Claude <noreply@anthropic.com>` |
| `mainCi` | name of the CI workflow that runs the check on pushes to main; when set, the merger waits for that run instead of running the check on this machine |
| `syncPolicy` | `always` (merge main into the branch before every merge) or `conflict` (only when GitHub reports a conflict; needs branch protection without the up-to-date rule and `mainCi`) |
| `loadWarnFactor` | the preflight warns when the 1-minute load average is above this many times the core count (default 4) |
| `quickCheck` | a shell command with `{files}` (typecheck, lint, related tests) that workers run instead of the full check, through the slot wrapper; CI runs the full check. Empty by default: workers run `check` |
| `mergePermission` | unset by default: a preflight whose dry run reports that no allow rule covers the merge relay's command fails the wave (H2, above). `"prompt"` logs a warning and continues for a missing allow rule or an ask rule, for projects whose session answers permission prompts; a deny rule fails the preflight either way |
| `ciChunkMin` | minutes one CI relay call waits (default 1.5, well under the Bash tool's 120 s default timeout). A value that is not a number above 0 uses the default; a value above 9 is lowered to 9. Longer calls use fewer relay agents but a Haiku relay that forgets `timeout=600000` is moved to the background, so the default stays 1.5 until one wave run with `ciChunkMin: 8` shows no relay moved to the background |
| `testGlobs` | the globs that say which paths are test files (default `["**/*.test.*", "**/*.spec.*", "test/**", "tests/**"]`), matched against repo-relative POSIX paths. Read from `.claude/loop.local.json` by the v2.4 scripts that need to tell a test from other code (`test-edits.js`, `impact.js`); a missing field gives the default |
| `loopScripts` | directory holding `wait-ci.js` and `merge-pr.js` (default `<repo>/.claude/scripts`, which `install.sh` links) |
| `merger` | unset by default (merge through `scripts/merge-pr.js`); `"agent"` restores the v2 merger agent as a rollback |
| `models.relay` | the model of the command relays (CI wait, merge script, preflight, PR facts); default Haiku/low since 2.2.1. `models.merger` only sets the v2 merger agent |
| `mergeMethod` | `"merge"` (default, a merge commit) or `"squash"` (one commit per PR, so a branch's intermediate commits, such as one that briefly held private data, never reach the default branch's history); script mode only, the v2 merger agent always merges. Another value fails the preflight |
| `fastLane` | `{ "enabled": false, "maxPerWave": 3, "denyPaths": [], "testCountCommand": "" }` by default; off until a human turns it on per project, and nothing is eligible without `testCountCommand` |
| `realityCheck` | `{ "command": "...", "readOnly": true }`: a read-only command run after the wave; a blocking gap it reports fails the gate |
| `gates` | path to a JSON list of human steps (`id`, `what`, `before` wave, `status`); the session parses it and passes it as `args.gates`, and a step still open before this wave stops it |

## What is here

- `claude/workflows/wave-loop.js`: the workflow. Deterministic scheduling and gates; models decide
  only inside a task.
- `claude/agents/`: producer, critic and merger role definitions, for use through the Agent tool
  outside a wave (a single task, a single review).
- `claude/hookify.*.local.md`: hookify rules that block force pushes, secrets in file writes (Anthropic, GitHub and
  AWS keys, Postgres URLs with a password, Supabase `sb_secret_`/`sb_publishable_` keys, JWTs), and commits or pushes
  that name the default branch.
- `scripts/slot.sh`: the machine-wide check semaphore, linked into each repo as `.claude/slot.sh`.
- `scripts/merge-pr.js`, `scripts/wait-ci.js`, `scripts/ci-only.js`: the merge, the CI wait and the CI-only delta check,
  run by relay agents from `.claude/scripts`. `merge-pr.js --defer-main` merges and leaves main's run to
  `merge-pr.js --verify-main <sha>`, which waits for it and reverts once on red. `merge-pr.js --state` only reads a
  PR's state and merge commit (used after a lost merge output).
- `scripts/write-review.js`: writes a spec-review run's review file from the run's output file.
- `scripts/spec-lint.js`: structural check of a spec, plus the wave and task shape warnings above.
- `scripts/wave-timeline.py`: draws a run output as an SVG timeline, one row per task and one bar per agent
  (`python3 -I scripts/wave-timeline.py <result.json> --titles > timeline.svg`).
- `scripts/loop-scorecard.py`: per-wave scorecard (rounds, fix items by cause, critic findings, the integration
  review, tokens and minutes per role, rates with 95% intervals, critic misses including escaped defects, and the
  decision rule for moving a role's model or effort); `--pool` prints one table across waves.
- `scripts/impact.js`, `scripts/test-edits.js`: the impact and test-edits relays' scripts (read only, run from
  `.claude/scripts`).
- `scripts/escaped.js`: traces fix commits on the default branch back to the task PR that introduced the lines
  (`--escaped-from` of the scorecard).
- `scripts/label-sheet.py`: the critic labelling sheet and its precision reader.
- `tests/v24-e2e.test.ts`: a stubbed four-task wave through the preflight, the test-edits gate and a usage-limit pause,
  rendered by the scorecard and the labelling sheet, with `escaped.js` over a temp repo feeding `--escaped-from`.
- `tests/hookify.test.ts`: checks that the three rules exist and are well formed, and runs the secrets pattern on samples.
- `templates/loop.local.json`: the project config template.
- `docs/<project>/`: records from each project (spec reviews, scorecards, handoffs), and the loop's own build
  specs under `docs/agent-loop-v2/`.

## Installing into a repo

```
~/dev/agent-loop/install.sh /path/to/repo
```

Symlinks the workflow, the agents, the slot wrapper, the scripts directory (`.claude/scripts`, where the CI and merge
relays find `wait-ci.js` and `merge-pr.js`) and the hookify rules into `.claude/`, copies the config
template if there is none, and lists all of them plus `CLAUDE.local.md` in the repo's
`.git/info/exclude`, so nothing the loop adds can be committed and no `.gitignore` line is needed.
Claude Code and the hookify plugin read these from disk, so the loop runs exactly as if the files
were in the repo.

npm 11.3 can crash in `npm install` with "Cannot read properties of null (reading 'edgesOut')" while
it resolves optional peer dependencies (seen with Vitest 5 on a fresh Next.js repo). Each package
installs alone; `legacy-peer-deps=true` in the project's `.npmrc` makes the full install and
`npm ci` pass.

## Principles the loop encodes

1. Every task has a pre-written acceptance test, committed before the implementation, and one owner
   per file. A worker that finds a choice takes the conventional default and writes it to the PR
   body; a worker that finds two materially different readings stops.
2. A critic that did not write the code reviews every PR against a fixed checklist and names the
   check that proves each fix item. Verdicts are MERGE, FIX or STOP; STOP names the spec section.
3. Deterministic control flow decides what runs next; models decide only inside a task.
4. Machine gate per wave; humans read between early waves, then the gate chains.
5. Measure each role (first-pass merge rate, fix causes, critic misses including escaped defects, tokens) and move models one
   notch at a time, one role per wave, so the baseline stays readable.
