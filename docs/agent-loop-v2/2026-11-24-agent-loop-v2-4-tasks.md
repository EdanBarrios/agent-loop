# agent-loop v2.4 reliability and measurement: ordered task list (draft 1)

Date: 2026-11-24. Source: the red team in `docs/RED-TEAM.md` (findings 1, 2, 3, 5, 6, 9 and 11). Execution model: as
v2. Waves; tasks in a wave run in parallel unless a task names a dependency; each wave ends with a tail task that runs
alone. A choice inside the **decision envelope** below is made by the loop, not by a human.

## End goal

A wave cannot spend tokens it is certain to waste, and its numbers say what they claim:

1. A wave whose merges the permission system will refuse fails in preflight, before any worker starts.
2. A usage limit that resets too far out pauses the wave: no new task starts, and the tasks it stopped come back as
   `paused`, not as a dozen parked tasks with escalations.
3. The session sees a token estimate for a wave before it launches it.
4. An assertion removed or changed after the test-first commit is reported to the critic and cannot merge without a
   stated reason in the PR body.
5. The worker sees, before it starts, the existing tests that import the files it owns, and runs them.
6. The critic gives a verdict per checklist item, each with quoted evidence, and a human can label a sample of
   verdicts to measure the critic's precision.
7. Defects that escaped into later fix commits are traced back to the task PR that introduced them and counted in the
   scorecard; first-pass rates are printed with 95% intervals and can be pooled across waves.
8. CI waits use fewer relay agents.

## Invariants (v2 rules stay)

1. Never commit to main, never force push; hookify rules not weakened. Merges happen only through a PR, only when CI is
   green on the PR head.
2. Deterministic control flow decides what runs next; models decide only inside a task.
3. A critic that did not write the code reviews every PR (fast-lane exception as v2.1).
4. The check on the default branch is verified after every merge, with revert-once on red.
5. Existing `loop.local.json` files keep working: every new field is optional; the defaults are stated per task.
6. The loop never changes a permission setting, and never routes around a refused command. It only reads settings
   files to predict a refusal.

## Budget

No paid vendor calls, no new runner spend. The cost is Claude Code usage.

## Decision envelope

As v2: a recommendation is auto-accepted when it is reversible by one revert PR or one config edit, costs nothing,
touches no invariant or fixed decision, and is not in a human-only category. Human-only categories: money; creating,
rotating or sharing a secret; accounts, quotas, vendor plans; permission settings; legal or privacy wording;
irreversible production steps; changing a fixed decision or invariant.

## Fixed decisions

- **Bootstrapping.** This loop is built by a checkout it does not change: the session runs the workflow by `scriptPath`
  from `~/dev/agent-loop` (loop 2.3.1), and this repo's `.claude/` links to that checkout. Changes here take effect for
  other projects only after a human relinks them (H1).
- **Language and tests.** Node ESM, plain JavaScript with JSDoc, Vitest, Python 3 stdlib for scorecard tools
  (`python3 -I`). Tests use no network and no real agent. Test files are `*.test.ts` under `tests/` or `claude/lib/`.
- **Modules.** New logic is pure functions with injected I/O in `claude/lib/*.js`, bundled into workflow files by
  `scripts/bundle-workflows.js` between `@bundle-start` / `@bundle-end` markers; bundled regions are never edited by
  hand. CLIs in `scripts/` wire real `git`, `gh` and the file system and print one JSON line on stdout.
- **Test files.** A path is a test file when it matches the project's `testGlobs` (new optional field; default
  `["**/*.test.*", "**/*.spec.*", "test/**", "tests/**"]`). One matcher, in `claude/lib/testedits.js`, is exported and
  used by every task that needs it.
- **Assertion lines.** A line is an assertion line when, after trimming, it matches
  `/\b(expect|assert)\s*[.(]|\.(to[A-Z]\w*|should)\b|\bt\.(is|deepEqual|true|false|throws)\b/`. Exported from
  `claude/lib/testedits.js` as `isAssertionLine`.
- **Permission rules.** Only the documented `permissions.allow` and `permissions.deny` rule forms are evaluated:
  `Bash(<exact command>)`, `Bash(<prefix>:*)` and `Bash(<prefix> *)`. A matching deny rule wins over any allow rule.
  Auto-mode prose rules (`autoMode.allow`) cannot be evaluated by code; they are counted and reported, never treated
  as an allow.
- **Escaped defect.** A later commit on the default branch, not from a task branch of the same project, that changes or
  deletes a line whose last change before it came from a task PR's commits. Counted once per (fix commit, task PR) pair.
- **Intervals.** 95% Wilson score intervals, printed as `72% (55–84%, n=30)`.

## Human checklist

| id | before | what | why |
|---|---|---|---|
| H1 | after the last wave | Relink projects (`install.sh`) to this checkout and point `~/.claude/CLAUDE.md` at it | the loop must not change itself mid-run; Edan's machine |
| H2 | before the first wave on 2.4 | Add a `permissions.allow` rule for the merge script, e.g. `Bash(node /path/to/repo/.claude/scripts/merge-pr.js:*)`, in `~/.claude/settings.json` | 2.1's preflight fails without it; permission settings are human-only |

## Wave 1: pure modules (all in parallel)

- **1.5 Test-impact map.** Owns `claude/lib/impact.js`, `claude/lib/impact.test.ts`, `scripts/impact.js`. A CLI
  `node scripts/impact.js --repo <path> --owns <path>... [--spec <spec.md>]` prints `{ tests: [{ path, via, owner }] }`:
  every test file in the repo (`git ls-files`, filtered by the test-file matcher) that imports an owned path directly,
  or through one intermediate non-test module (`via` names it, or is null when direct). Imports are found by regex on
  `import ... from '<p>'`, `import('<p>')`, `require('<p>')` and `export ... from '<p>'`, resolving relative specifiers
  against the importing file with the extensions `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` and `/index.*`; bare package
  specifiers are ignored. An owned path that is a directory prefix matches every file under it. `owner` is the task id
  whose `Owns` line in `--spec` lists that test file, or null. Reads or writes: reads. Test: a temp repo with a direct
  importer, an importer through one module, an importer through two modules (not listed), a dynamic import, a
  `require`, a bare package import (ignored), an owned directory, an `index.ts` resolution, and a spec whose 2.T owns
  one of the tests (owner `2.T`).
- **1.2 Test-edit report.** Owns `claude/lib/testedits.js`, `claude/lib/testedits.test.ts`, `scripts/test-edits.js`.
  A CLI `node scripts/test-edits.js <pr> --repo <path> [--base <branch>]` prints `{ testFirstCommit, files: [{ path,
  removed: [line], changed: [{ before, after }] }], assertionsRemoved, assertionsChanged, bodySection, note }`. The
  branch's commits come from `gh pr view <pr> --json commits,body,baseRefName,headRefOid`; merge commits are skipped.
  `testFirstCommit` is the first non-merge commit that adds or changes a test file. For each test file that exists at
  `testFirstCommit`, the diff `testFirstCommit..headRefOid` for that file is read, minus the hunks the branch took from
  the base branch through merge commits (a hunk whose removed and added lines both appear in `git diff <merge
  parent 1>..<merge commit>` for that file is dropped). A removed assertion line with no replacement in the same hunk
  counts in `assertionsRemoved`; a removed assertion line replaced in the same hunk by a different line counts in
  `assertionsChanged` and is listed in `changed` as a pair. `bodySection` is true when the PR body has a line starting
  with `Test edits:`. No test commit on the branch prints `testFirstCommit: null` and zero counts with a `note`. Reads
  or writes: reads. Test: a temp git repo with a fake `gh` shim on `PATH`: an unchanged test (zero counts); a deleted
  `expect(` line (removed 1); `toBe(3)` changed to `toBeGreaterThan(0)` (changed 1); a test file changed only by a merge
  from main (zero counts); a new test file added after `testFirstCommit` (not counted: it did not exist then); a body
  with `Test edits:`; a branch with no test commit; `isAssertionLine` on 12 sample lines.
- **1.1 Permission check.** Owns `claude/lib/permission.js`, `claude/lib/permission.test.ts`, `scripts/merge-pr.js`.
  `checkPermission(command, settingsDocs)` returns `{ allowed, rule, source, denied, autoModeRules, checked }` per the
  Permission-rules decision, where `settingsDocs` is a list of `{ path, json }` (a missing or unparseable file is listed
  in `checked` with an error and skipped). `scripts/merge-pr.js --dry-run` adds `permission` to its JSON line: the
  result of `checkPermission` for the command form the workflow runs (`node <scripts dir>/merge-pr.js <n> --repo
  <repo>`, with `<n>` standing for any number), over `$HOME/.claude/settings.json`, `<repo>/.claude/settings.json` and
  `<repo>/.claude/settings.local.json`. Nothing else in `merge-pr.js` changes. Reads or writes: reads. Test: exact
  rule; `:*` prefix rule; ` *` prefix rule; a prefix rule for another path (not allowed); a deny rule that overrides an
  allow; prose `autoMode.allow` entries counted, not allowed; a missing file and a malformed file listed in `checked`;
  the dry run of `merge-pr.js` in a temp repo with a temp `HOME` prints `permission.allowed` true with a matching rule
  and false without.
- **1.3 Usage-limit classification.** Owns `claude/lib/pause.js`, `claude/lib/pause.test.ts`.
  `classifyFailure(errorOrText, nowMs)` returns `{ kind: 'usage_limit'|'other', resetsAt, farOut }`: `usage_limit` when
  the text matches the existing `isUsageLimit` pattern in `wave-loop.js` or `weekly limit`; `resetsAt` parsed from
  `resets <Mon> <d> at <h>[:mm]am|pm (<IANA zone>)` or `resets at <h>[:mm]am|pm (<zone>)` (today or tomorrow, whichever
  is next) as epoch ms, null when absent; `farOut` true when the text says `too far out` or `resetsAt - nowMs` is over
  30 minutes. `pausePlan({ tasks, state, failedOnLimit })` returns `{ paused: [ids], parked: [ids] }`: tasks not
  started and tasks whose agent failed on the limit are paused; tasks parked for any other reason stay parked; merged
  tasks are in neither. Reads or writes: reads. Test: the exact Warden wave 4 message (`failed: usage limit; resets Nov
  19 at 12pm (America/Los_Angeles), too far out to wait for: You've hit your weekly limit · resets Nov 19 at 12pm
  (America/Los_Angeles)`) with a fixed clock; a short reset 10 minutes out (not far out); a message with no reset
  time; a non-limit error; a plan with merged, parked, failed-on-limit and unstarted tasks.
- **1.4 Wave token estimate.** Owns `scripts/wave-args.js`, `tests/wave-args.test.ts`. `wave-args.js` gains
  `--scorecards <dir>`: it reads the `*-loop.md` scorecards there, takes tokens per task as the `Total tokens` signal
  divided by the number of rows in the `Tasks` table, skips scorecards whose total is 0, and adds
  `budget: { tasks, tokensPerTask, estimate, basis }` to the args (median of the newest three by file name; `basis`
  lists them). It prints `wave-args: estimated <n>M tokens for <k> tasks (median of <files>)` on stderr. Without
  `--scorecards`, or with no usable scorecard, `budget` is null and nothing is printed. Reads or writes: reads. Test:
  three fixture scorecards give the expected median; a zero-token scorecard is skipped; no flag gives `budget: null`;
  existing wave-args tests pass.
- **1.T Wave 1 tail.** Owns `tests/v24-wave1.test.ts`. Depends on 1.1, 1.2, 1.3, 1.4 and 1.5. Test: the five modules
  together on fixtures: a settings file without the rule makes the merge dry run report `allowed: false`; a temp repo
  whose PR branch weakens an assertion reports `assertionsChanged: 1` and `bodySection: false`; the Warden wave 4
  message classifies as a far-out usage limit; wave-args prints an estimate from fixture scorecards; impact lists the
  test that imports a changed module. Done: `npm run check` green on main.

## Wave 2: wire it in, and measure (2.2 after 2.1; the rest in parallel)

- **2.1 Wave-loop control flow.** Owns `claude/workflows/wave-loop.js` (bundled regions via `scripts/bundle-workflows.js`,
  preflight, failure handling and constants; no prompt text), `package.json`, `docs/OPERATING.md`. Depends on 1.1 and 1.3.
  (a) Preflight: when the dry run reports `permission.allowed` false, the wave fails in preflight with one escalation
  that names the rule to add (H2), unless `project.mergePermission` is `"prompt"` (new optional field), which logs a
  warning and continues. A dry run without a `permission` field (an older `merge-pr.js`) logs a warning and continues.
  (b) Pause: an agent failure that `classifyFailure` reads as a far-out usage limit sets the wave to paused: no new task
  chain starts, agents already running finish, `pausePlan` decides each task's state, and one escalation
  `wave paused: usage limit, resets <time>` replaces the per-task ones; the result gains `paused: { resetsAt, tasks }`
  and `gate: "PAUSED"`. The spike in the spec review settles how the Workflow runtime reports a usage-limit failure to
  the script (a thrown error, or `null` with a log line); both paths are handled. (c) CI waits: `CI_CHUNK_MIN` comes
  from `project.ciChunkMin` (new optional field, default 8, at most `CI_RELAY_MAX_MIN`); the relay prompt's timeout
  rule is unchanged. (d) `LOOP_VERSION` and `package.json` `version` become `2.4.0`. `docs/OPERATING.md` documents
  `mergePermission`, `ciChunkMin`, `testGlobs`, the `PAUSED` gate and H2. Test: in `tests/wave-loop-v24.test.ts`
  (owned): preflight fails with no rule; `mergePermission: "prompt"` continues; a far-out usage limit on a worker
  pauses a 4-task wave with one task merged, one running (finishes) and two not started; a short usage limit does not
  pause; `ciChunkMin` 8 makes one relay call per 8 minutes of CI.
- **2.2 Wave-loop prompts.** Owns `claude/workflows/wave-loop.js` (worker, fix and critic prompt text and the critic
  schema, after 2.1 has merged), `claude/agents/critic.md`, `claude/agents/producer.md`, `tests/wave-loop-prompts.test.ts`.
  Depends on 2.1, 1.2 and 1.5. (a) Before the worker starts, one relay runs `impact.js` for the task's `owns` (with
  `--spec` when the project has one); the worker prompt lists the tests and their owners and tells the worker to run
  them before opening the PR and to stop with a question when a change breaks a test another task owns (the existing
  ownership rule, now with the list). An impact relay that fails or returns nothing leaves the prompt as before and
  logs it. (b) Before each critic round, one relay runs `test-edits.js`; the critic prompt gets the report under
  "Test edits after the test-first commit", and checklist item 3 adds: an assertion removed or changed after the
  test-first commit is a FIX unless the PR body's `Test edits:` section justifies each one and the justification
  holds. Deterministic gate: `assertionsRemoved + assertionsChanged > 0` with `bodySection` false makes the verdict FIX
  (cause `defect`, item "restore the assertion or justify it under Test edits:") whatever the critic said; the worker
  prompt and `producer.md` describe the `Test edits:` section. (c) The critic schema gains `items: [{ n, pass, evidence
  }]`, one entry per checklist item, `evidence` a quote from the diff, a file:line or a command output; a verdict whose
  `items` miss a checklist number is treated as the critic returning nothing (the existing retry path). Test: prompt
  snapshots for each case; the gate turns a MERGE into FIX; a critic result missing item 9 is retried.
- **2.3 Escaped-defect tracer.** Owns `claude/lib/escaped.js`, `claude/lib/escaped.test.ts`, `scripts/escaped.js`.
  A CLI `node scripts/escaped.js --repo <path> [--since <YYYY-MM-DD>] [--prefix task/]` prints
  `{ tasks: { "<task id>": { pr, escaped, fixes: [{ sha, title, files, lines }] } }, scanned, note }` per the
  Escaped-defect decision. Task PRs are the merged PRs whose head branch starts with the prefix (task id parsed from
  `task/<id>-<slug>`, where `<id>` is digits, dots and `T`); their commits come from `gh pr view <n> --json commits`.
  Later commits are the first-parent commits on the default branch after each task's merge that are not themselves
  merges of a task branch. For each changed or deleted line range of a later commit, `git blame --porcelain
  <commit>^ -L <a>,<b> -- <file>` gives the origin commit. Reads or writes: reads. Test: a temp repo with a fake `gh`:
  a task PR whose line a later fix changes (escaped 1); a later commit that only adds lines (0); a later task PR that
  changes the line (not counted); a fix touching two tasks' lines (one each); a file renamed before the fix (blame
  follows it with `-C`, or the case is noted, not counted).
- **2.4 Pooled scorecard with intervals.** Owns `scripts/loop-scorecard.py`, `tests/scorecard.test.ts`,
  `tests/fixtures/scorecard-pool-*.json`. Every rate in the scorecard (worker first-pass MERGE, critic misses per merged
  task) is printed with its 95% Wilson interval. `--escaped-from <escaped.json>` (2.3's format) fills the escaped
  count per task instead of `--escaped <n>`, and the scorecard lists each fix commit. `--pool <result.json>...` prints
  one pooled table across the given runs (rates, intervals, fix items by cause, tokens per task) without a per-task
  section. The decision rule text changes: a role moves only when the pooled interval lies wholly on one side of the
  threshold (worker: upper bound under 50% first-pass; critic: lower bound of misses per merged task above 0). When
  results carry critic `items` (2.2), the scorecard counts items failed per checklist number. Reads or writes: reads.
  Test: interval values against hand-computed Wilson bounds (0/6, 6/6, 20/30); a pool of two fixture results; an
  escaped file with two fixes; existing scorecard tests pass.
- **2.5 Critic labelling sheet.** Owns `scripts/label-sheet.py`, `tests/label-sheet.test.ts`. `python3 -I
  scripts/label-sheet.py <result.json>... [--sample <n>] [--seed <s>]` prints a Markdown sheet: one row per critic
  verdict (task, round, verdict, each fix item, PR link from `result.tasks[id].pr`), with empty columns `real? (y/n)`
  per fix item and `correct? (y/n)` per MERGE; `--sample` draws n verdicts, FIX and MERGE in their observed proportion,
  reproducibly by seed. `--read <filled sheet>` prints precision: share of FIX items labelled real, share of MERGEs
  labelled correct, each with a Wilson interval, and the count left unlabelled. Reads or writes: reads. Test: a fixture
  result gives the expected rows; the same seed gives the same sample; a filled sheet gives the expected precision;
  unlabelled rows are counted, not guessed.
- **2.T Wave 2 tail.** Owns `tests/v24-e2e.test.ts`. Depends on 2.1, 2.2, 2.3, 2.4 and 2.5. Test: a stubbed four-task
  wave: preflight fails when the fake settings lack the rule; with the rule, a task whose branch changes an assertion
  without `Test edits:` gets FIX; a far-out usage limit pauses the rest; the result renders in the scorecard with
  intervals and in the labelling sheet; `escaped.js` over a temp repo feeds `--escaped-from`. Done: `npm run check`
  green on main; `LOOP_VERSION` is 2.4.0.

## Later (not in this spec)

Red-team findings 4, 8 and 10, and the follow-ups to 1 and 3: spec review reading each Test line for a second
reading; dependent tasks started on their parent's branch; a Sonnet-first critic cascade measured as an A/B; a
mutation-testing gate; one execution-based or cross-family check before MERGE. Each needs the measurement from wave 2
first, or a human decision (accounts, cost).
