# agent-loop v2.4 reliability and measurement: ordered task list (draft 3, after the wave 2 review)

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
  `["**/*.test.*", "**/*.spec.*", "test/**", "tests/**"]`). One matcher, `isTestFile(path, globs)` in `claude/lib/testedits.js`, and a reader `testGlobsOf(project)` that returns the field or the default, are exported (globs are matched with `node:path` `matchesGlob` against repo-relative POSIX paths; `**/` matches zero or more directories; the CLIs of 1.2 and 1.5 read the field from `<repo>/.claude/loop.local.json`, and a missing file or field gives the default), and are
  used by every task that needs it.
- **Assertion lines.** A line is an assertion line when, after trimming, it does not start with `//`, `/*` or `*` and it matches
  `/\b(expect|assert)\s*[.(]|\.(to(Be|Equal|StrictEqual|Match|Contain|Have|Throw|Satisfy)\w*|should)\b|\bt\.(is|deepEqual|true|false|throws)\b/`. Exported from
  `claude/lib/testedits.js` as `isAssertionLine`.
- **Permission rules.** Only the documented `permissions.allow` and `permissions.deny` rule forms are evaluated:
  `Bash(<exact command>)`, `Bash(<prefix>:*)` and `Bash(<prefix> *)`. Rules are matched with Claude Code's wildcard semantics: `*` matches any sequence, and a trailing ` *` or `:*` also matches the bare prefix. Evaluation order is deny, then ask, then allow; a matching deny rule sets `denied`, a matching ask rule sets `ask` (a relay cannot answer a prompt), and either makes `allowed` false. An allow rule counts only when the text before its first `*` names the merge script's path; `Bash`, `Bash(*)` and rules that name only an interpreter (`Bash(node *)`, `Bash(node*)`) are returned as `broad` and never make `allowed` true, because auto mode drops them. `checkPermission` returns `{ allowed: boolean, rule: string|null, source: string|null, denied: string|null, ask: string|null, broad: string[], autoModeRules: number, checked: [{ path, error }] }`. Managed settings (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux) are read when present, for their deny and ask rules.
  Auto-mode prose rules (`autoMode.allow`) cannot be evaluated by code; they are counted and reported, never treated
  as an allow.
- **Escaped defect.** A later commit on the default branch, not from a task branch or a `revert/` branch of the same
  project (the loop's own revert is already counted as `reopened`), that changes or deletes a line whose last change
  before it came from a task PR's commits, and is a fix: its subject, or the title of the PR it merges, starts with
  `fix` (`fix:`, `fix(scope):`, `Fix ...`), direct pushes to the default branch included. Counted once per (fix commit,
  task PR) pair. Other later commits that touch such lines are listed with `kind: "other"` (fixes with `kind: "fix"`)
  so a human can reclassify them; they do not count.
- **Intervals.** 95% Wilson score intervals, printed as `72% (55–84%, n=30)`.

## Human checklist

| id | before | what | why |
|---|---|---|---|
| H1 | after the last wave | Relink projects (`install.sh`) to this checkout and point `~/.claude/CLAUDE.md` at it | the loop must not change itself mid-run; Edan's machine |
| H2 | before wave 1 | Add a `permissions.allow` rule for each script a relay runs (`merge-pr.js`, `wait-ci.js`, `ci-only.js` and, from wave 2, `impact.js` and `test-edits.js`), then confirm once by running one relay in auto mode that the classifier is not consulted, e.g. `Bash(node /path/to/repo/.claude/scripts/merge-pr.js *)` (the path exactly as `project.repo` plus `/.claude/scripts` spells it, absolute and not the link's target), in `~/.claude/settings.json` | every wave merges through that script, and Warden wave 4 was refused there; 2.1's preflight fails without it; permission settings are human-only |

## Wave 1: pure modules (1.5 after 1.2; the rest in parallel)

- **1.5 Test-impact map.** Depends on 1.2 (the test-file matcher). Owns `claude/lib/impact.js`, `claude/lib/impact.test.ts`, `scripts/impact.js`. A CLI
  `node scripts/impact.js --repo <path> --owns <path>... [--spec <spec.md>]` prints `{ tests: [{ path, via, owner }] }`:
  every test file in the repo (`git ls-files`, filtered by the test-file matcher) that imports an owned path directly,
  or through one intermediate non-test module (`via` names it, or is null when direct). Imports are found by regex on
  `import ... from '<p>'`, `import('<p>')`, `require('<p>')` and `export ... from '<p>'`, resolving relative specifiers
  against the importing file with the extensions `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` and `/index.*`; bare package
  specifiers are ignored, except an alias from `compilerOptions.paths` in `<repo>/tsconfig.json` (a `prefix/*` pattern mapped to a directory, relative to its `baseUrl` or the tsconfig), which resolves like a relative path. A specifier ending `.js`, `.mjs` or `.cjs` also tries the same name ending `.ts`, `.tsx`, `.mts` or `.cts`; side-effect imports (`import '<p>'`), imports that span lines, `import type` and `vi.mock('<p>')` count. An owned path that is a directory prefix matches every file under it. `owner` is the task id
  whose `Owns` line in `--spec` lists that test file, or null. Reads or writes: reads. Test: a temp repo with a direct
  importer, an importer through one module, an importer through two modules (not listed), a dynamic import, a
  `require`, a bare package import (ignored), an owned directory, an `index.ts` resolution, a tsconfig `@/` alias, a `./a.js` specifier that resolves to `a.ts`, a multi-line import, a side-effect import, and a spec whose 2.T owns
  one of the tests (owner `2.T`).
- **1.2 Test-edit report.** Owns `claude/lib/testedits.js`, `claude/lib/testedits.test.ts`, `scripts/test-edits.js`.
  A CLI `node scripts/test-edits.js <pr> --repo <path> [--base <branch>]` prints `{ testFirstCommit, files: [{ path,
  removed: [line], changed: [{ before, after }] }], assertionsRemoved, assertionsChanged, bodySection, note }`. The
  branch's commits come from `gh pr view <pr> --json commits,body,baseRefName,headRefOid`; the commit order and the merge commits (two parents; skipped) come from `git rev-list --reverse --parents origin/<baseRefName>..<headRefOid>`, because `gh` lists no parents, and a `headRefOid` missing from the repo is fetched once with `git fetch origin pull/<pr>/head`.
  `testFirstCommit` is the first non-merge commit that adds or changes a test file. For each test file that exists at
  `testFirstCommit`, the diff `testFirstCommit..headRefOid` for that file is read, minus the hunks the branch took from
  the base branch through merge commits (a removed or added line that also appears as removed or added, one for one, in `git diff <merge
  parent 1>..<merge commit>` for that file is dropped). The diff uses `-M`; a test file deleted after `testFirstCommit` counts every assertion line in it as removed; `removed` lists removed assertion lines only; within a hunk the i-th removed assertion line pairs with the i-th added line, and the pair is 'changed' only when the added line is itself an assertion line, otherwise the removed line counts as removed. A removed assertion line with no replacement in the same hunk
  counts in `assertionsRemoved`; a removed assertion line replaced in the same hunk by a different line counts in
  `assertionsChanged` and is listed in `changed` as a pair. `bodySection` is true when the PR body has a line starting
  with `Test edits:`. No test commit on the branch prints `testFirstCommit: null` and zero counts with a `note`. Reads
  or writes: reads. Test: a temp git repo with a fake `gh` shim on `PATH`: an unchanged test (zero counts); a deleted
  `expect(` line (removed 1); `toBe(3)` changed to `toBeGreaterThan(0)` (changed 1); a test file changed only by a merge
  from main that adds, removes and edits an assertion (zero counts each); a renamed test file (counts unchanged); a deleted test file (every assertion line removed); a new test file added after `testFirstCommit` (not counted: it did not exist then); a body
  with `Test edits:`; a branch with no test commit; `isAssertionLine` on 12 sample lines, at least 4 of them not assertions (`new Date(x).toISOString()`, `name.toLowerCase()`, a `// expect(a).toBe(1)` comment, `it('x', () => {`).
- **1.1 Permission check.** Owns `claude/lib/permission.js`, `claude/lib/permission.test.ts`, `scripts/merge-pr.js`.
  `checkPermission(command, settingsDocs)` returns `{ allowed, rule, source, denied, autoModeRules, checked }` per the
  Permission-rules decision, where `settingsDocs` is a list of `{ path, json }` (a missing or unparseable file is listed
  in `checked` with a fixed `error` string, `missing` or `unparseable`, never the parser's message, which can quote file content; and skipped). `scripts/merge-pr.js --dry-run` adds `permission` to its JSON line: the
  result of `checkPermission` for the command forms the workflow runs, with `<scripts dir>` the directory of `process.argv[1]` as given (never `import.meta.url`: `.claude/scripts` is a link and the relay types the link path; no `~` expansion) and `<repo>` the `--repo` value as given: the merge with `--worktree <path>` (and `--defer-main` when `project.mainCi` is set), `--verify-main <sha> --timeout-min 9`, and `--state`; `allowed` is true only when every form is allowed, `rule` and `source` come from the first form that is not, and each form begins (`node <scripts dir>/merge-pr.js <n> --repo
  <repo>`, with `<n>` standing for any number), over `$HOME/.claude/settings.json`, `<repo>/.claude/settings.json` and
  `<repo>/.claude/settings.local.json`. Nothing else in `merge-pr.js` changes. Reads or writes: reads. Test: exact
  rule; `:*` prefix rule; ` *` prefix rule; a prefix rule for another path (not allowed); a deny rule that overrides an
  allow; prose `autoMode.allow` entries counted, not allowed; a missing file and a malformed file listed in `checked` (a secret-like string inside the malformed file appears nowhere in the returned or printed JSON);
  the dry run of `merge-pr.js` in a temp repo with a temp `HOME` prints `permission.allowed` true with a matching rule
  and false without.
- **1.3 Usage-limit classification.** Owns `claude/lib/pause.js`, `claude/lib/pause.test.ts`.
  `classifyFailure(errorOrText, nowMs)` (the workflow has no clock: `nowMs` may be null, and then `resetsAt` is null and `farOut` comes only from the text `too far out`) returns `{ kind: 'usage_limit'|'other', resetsAt, farOut }`: `usage_limit` when
  the text matches `/usage limit|limit reached|rate.?limit|quota|\b429\b|weekly limit/i` (the pattern of `isUsageLimit` in `wave-loop.js`, copied, because a bundled lib cannot import from the workflow; 2.1 makes `isUsageLimit` call `classifyFailure`); `resetsAt` parsed from
  `resets <Mon> <d>[,][ at] <h>[:mm]am|pm (<zone>)` or `resets[ at] <h>[:mm]am|pm (<zone>)` or the relative `resets in <n>h` / `<n> hr <m> min` (matched case-insensitively; `<zone>` is any IANA name or `UTC`; 12am is hour 0 and 12pm is noon; a date without a year is the next such date on or after `nowMs`; a zone the runtime rejects gives `resetsAt` null; the relative form needs `nowMs`; the time-only form is the next such time) (today or tomorrow, whichever
  is next) as epoch ms, null when absent; `farOut` true when the text says `too far out` or `resetsAt - nowMs` is over
  30 minutes. `pausePlan({ tasks, state, failedOnLimit })` (`tasks` the ids including the tail, `state` a map id to `'merged'|'reverted'|'parked'|'running'` where a missing id means not started, `failedOnLimit` a list of ids) returns `{ paused: [ids], parked: [ids] }`: tasks not
  started and tasks whose agent failed on the limit are paused; tasks parked for any other reason stay parked; reverted tasks and tasks still `running` are in neither (a running task's result is recorded when it finishes), and merged
  tasks are in neither. Reads or writes: reads. Test: the exact Warden wave 4 message (`failed: usage limit; resets Nov
  19 at 12pm (America/Los_Angeles), too far out to wait for: You've hit your weekly limit · resets Nov 19 at 12pm
  (America/Los_Angeles)`) with the clock at `Date.UTC(2026, 10, 16, 20)` (`resetsAt` is 1795118400000, `farOut` true) and with a null clock (`resetsAt` null, `farOut` true from the text); a short reset 10 minutes out (not far out); a message with no reset
  time; a non-limit error; a plan with merged, parked, failed-on-limit and unstarted tasks; `bundleSource` from `scripts/bundle-workflows.js` reports no problem on the lib source, and the lib declares no top-level name that `claude/workflows/wave-loop.js` already declares.
- **1.4 Wave token estimate.** Owns `scripts/wave-args.js`, `tests/wave-args.test.ts`, `tests/fixtures/wave-scorecard-*.md`. `wave-args.js` gains
  `--scorecards <dir>`: it reads the `*-loop.md` scorecards there, takes tokens per task as the `Total tokens` signal
  (comma-grouped digits) divided by the number of rows in the `## Tasks` section only (tail row included), skips scorecards whose total is 0 or missing before it picks the newest three (by file name, descending; a name sorts by its date prefix, then by wave id compared as text), and adds
  `budget: { tasks, tokensPerTask, estimate, basis }` to the args (`tasks` is the wave's task count including the tail; `tokensPerTask` is the median of up to three values, the mean of the two when only two are usable; `estimate` is `tasks` times it, rounded to the nearest thousand; the printed `<n>` is `estimate` in millions with one decimal; `basis`
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
  preflight, failure handling and constants; no prompt text), `package.json`, `docs/OPERATING.md`, `claude/workflows/chain-loop.js` (its `LOOP_VERSION` line only, which must equal `package.json`), `tests/wave-loop-v24.test.ts`, and `tests/wave-loop-relay.test.ts`, `tests/loop-perf.test.ts`, `tests/speed-e2e.test.ts` (in those three only the stubbed `loopVersion` literal, read from `package.json`, and the CI chunk assertions if the default changes). Depends on 1.1 and 1.3.
  (a) Preflight: when the dry run reports `permission.allowed` false, the wave fails in preflight with one escalation
  that names the rule to add (H2), unless `project.mergePermission` is `"prompt"` (new optional field), which logs a
  warning and continues, but only when `permission.denied` is null (a deny rule fails preflight in either mode); the escalation names the rule as `Bash(node <scripts dir>/merge-pr.js *)` and lists `permission.broad`. A dry run without a `permission` field (an older `merge-pr.js`) logs a warning and continues.
  (b) Pause: an agent failure that `classifyFailure` reads as a far-out usage limit sets the wave to paused: no new task
  chain starts, agents already running finish, `pausePlan` decides each task's state, and one escalation
  `wave paused: usage limit, resets <time>` replaces the per-task ones, where `<time>` is the reset text copied from the failure message (`classifyFailure` is called with `nowMs` null, so `resetsAt` is null in the result and the session computes it); the result gains `paused: { resetsAt, resetText, tasks }`
  and `gate: "PAUSED"` (the `paused` key is absent from the result of a wave that did not pause). A pause also: a task whose dependency is paused is `paused`, not parked, and the tail is `paused` with no 'tail not run' escalation; the machine gate, the reality gate and the integration review do not run; each paused task has `state: "paused"` and a result entry with no rounds; the loop's `pending` is passed to `pausePlan` as a missing id and a parked task whose merge outcome is `reverted` as `reverted`; a relaunch passes `paused` tasks as it passes parked ones. The spike in the spec review settles how the Workflow runtime reports a usage-limit failure to
  the script. A thrown error whose text `classifyFailure` reads as a far-out limit pauses the wave, and is classified before any other handling, except that the critic's swap to `CRITIC_FALLBACK` stays first: the wave pauses when the fallback call also fails on a limit or returns `null`. A bare `null` from any other agent (the runtime's documented answer when a subagent dies on a terminal API error) is followed by one probe, a relay that runs `true`: when the probe also returns `null` or throws a usage-limit error, the wave pauses with `resetText` null; when the probe succeeds, the `null` is handled as today. The pattern in `claude/lib/pause.js` (wave 1, merged) is not changed. (c) CI waits: `CI_CHUNK_MIN` comes
  from `project.ciChunkMin` (new optional field, default 1.5 as today; a value that is not a number above 0 uses the default and a value above `CI_RELAY_MAX_MIN` is lowered to it; the default moves to 8 only after one wave run with `ciChunkMin: 8` shows no relay moved to the background); the relay prompt's timeout
  rule is unchanged. (d) `LOOP_VERSION` and `package.json` `version` become `2.4.0`. `docs/OPERATING.md` documents
  `mergePermission`, `ciChunkMin`, `testGlobs`, the `PAUSED` gate, H2, and `wave-args.js --scorecards <dir>` (the token estimate to read before launching a wave). Test: in `tests/wave-loop-v24.test.ts`
  (owned): preflight fails with no rule; `mergePermission: "prompt"` continues; a far-out usage limit on a worker
  pauses a wave of 5 tasks and a tail (`maxChains` 3) with one task merged, one running (it finishes and merges), one whose worker fails on the limit and two not started (the failed one, the two not started and the tail are `paused`, and one escalation is raised); a short usage limit does not
  pause; a worker `null` and a `null` probe pause the wave, a worker `null` and a passing probe do not; a deny rule fails preflight with `mergePermission: "prompt"`; an unset `ciChunkMin` keeps 1.5-minute calls and `ciChunkMin` 8 makes one relay call per 8 minutes of CI.
- **2.2 Wave-loop prompts.** Owns `claude/workflows/wave-loop.js` (worker, fix and critic prompt text, the critic
  schema, the impact relay before the worker, and the test-edits relay and gate of (b) in `reviewRound`, after 2.1 has merged), `claude/agents/critic.md`, `claude/agents/producer.md`, `tests/wave-loop-prompts.test.ts`, `claude/lib/impact.js`, `claude/lib/impact.test.ts`, `scripts/impact.js`, `tests/wave-loop.test.ts`, `tests/wave-loop-gates.test.ts`, `tests/wave-loop-relay.test.ts`, `tests/loop-perf.test.ts`, `tests/loop-version.test.ts` (in the last five only the exact `calls` lists).
  Depends on 2.1, 1.2 and 1.5. (a) Before the worker starts, one relay runs `impact.js` for the task's `owns` (with
  `--spec` when the project has one); `impact.js` also lists, with `via: "name"`, every test file with a quoted string holding an owned file's repo-relative path or its basename (tests of this repo read `wave-loop.js` with `readFileSync` and run `loop-scorecard.py` with `execFile`, which no import shows; `impact.test.ts` gets a case, and the other fields keep their shape); the worker prompt lists the tests and their owners and tells the worker to run
  them before opening the PR and to stop with a question when a change breaks a test another task owns (the existing
  ownership rule, now with the list). An impact relay that fails or returns nothing leaves the prompt as before and
  logs it. (b) Before each critic round, one relay runs `test-edits.js` (once more when it prints no JSON line; if it is still blocked or empty the round records `testEdits: "unavailable"`, the critic prompt tells the critic to run `git diff` over the test files itself, and it is logged); the critic prompt gets the report under
  "Test edits after the test-first commit", and checklist item 3 adds: an assertion removed or changed after the
  test-first commit is a FIX unless the PR body's `Test edits:` section justifies each one and the justification
  holds. Deterministic gate: `assertionsRemoved + assertionsChanged > 0` with `bodySection` false makes the verdict FIX
  (cause `defect`, item "restore the assertion or justify it under Test edits:") whatever the critic said; the same report is read in the fast-lane facts step, where a non-zero count with `bodySection` false makes the task not eligible (the critic reviews it), and a round whose critic is skipped as CI-only reuses the report of the round it follows; the worker
  prompt and `producer.md` describe the `Test edits:` section. (c) The critic schema's existing `checklist: [{ item, pass, evidence
  }]` (one entry per checklist item, `evidence` a quote from the diff, a file:line or a command output) is checked for completeness: a
  `checklist` that misses a checklist number gets one more critic call on the same model with the missing numbers named (never the swap to `CRITIC_FALLBACK`); a second miss is recorded as is and logged. Rounds with `lane: 'fast'` or `criticSkipped` are not checked. A critic that ran and returned `checklist: []` is not retried (the stubs of existing tests return it), but the round records `checklistEmpty: true` and logs a line starting `note:` (not `WARNING`, which tests/loop-perf.test.ts:88 rejects). Test: prompt
  snapshots for each case; the gate turns a MERGE into FIX; a critic result missing item 9 gets one more call on the same model and `models.critic` is unchanged; an empty checklist is recorded with `checklistEmpty: true`.
- **2.3 Escaped-defect tracer.** Owns `claude/lib/escaped.js`, `claude/lib/escaped.test.ts`, `scripts/escaped.js`.
  A CLI `node scripts/escaped.js --repo <path> [--since <YYYY-MM-DD>] [--prefix task/]` prints
  `{ tasks: { "<task id>": { pr, escaped, fixes: [{ sha, title, kind, files, lines }] } }, scanned, note }` per the
  Escaped-defect decision. Task PRs are the merged PRs listed with `gh pr list --state merged --limit 1000 --json number,headRefName,mergedAt` (`note` says so when 1000 come back; `--since` keeps those merged on or after the date; a task id with two merged PRs, such as a reopen after a revert, shows the latest as `pr`, every number in `prs`, and a line from any of them counts) whose head branch starts with the prefix (task id parsed from
  `task/<id>-<slug>`, where `<id>` is digits, dots and `T`); their commits come from `gh pr view <n> --json commits`.
  Later commits are the first-parent commits on the default branch after each task's merge that are not themselves
  merges of a task branch or a `revert/` branch. For each changed or deleted line range of a later commit, `git blame --porcelain
  <commit>^ -L <a>,<b> -- <file>` gives the origin commit. Reads or writes: reads. Test: a temp repo with a fake `gh`:
  a task PR whose line a later fix changes (escaped 1); a later commit that only adds lines (0); a later task PR that
  changes the line (not counted); a later `feat:` commit that changes the line (listed as `other`, escaped 0); a loop revert from a `revert/` branch (not listed); a `fix:` commit pushed straight to the default branch (escaped 1); a fix touching two tasks' lines (one each); a file renamed before the fix (blame
  follows the rename, which `git blame` does by default for a whole-file rename: escaped 1).
- **2.4 Pooled scorecard with intervals.** Owns `scripts/loop-scorecard.py`, `tests/scorecard.test.ts`,
  `tests/fixtures/scorecard-pool-*.json`. Every rate in the scorecard (worker first-pass MERGE, critic misses per merged
  task) is printed with its 95% Wilson interval. The critic rate is the share of merged tasks with at least one miss (a revert after MERGE or one or more escaped fixes), so k is at most n; the number of fix commits is printed beside it, not inside the interval; bounds are clamped to 0 and 1 and a lower bound under 1e-9 counts as 0. With only `--escaped <n>` there is no per-task attribution: the critic rate counts reverts only and the escaped count is printed beside it without an interval. `--escaped-from <escaped.json>` (2.3's format) fills the escaped
  count per task instead of `--escaped <n>` (both given is an error; tasks of the file that are not in the given runs are ignored and counted in a note), and the scorecard lists each fix commit. A rate leaves out only tasks that never started (`paused`, parked for a parked dependency, or a tail not run): a task whose worker ran and delivered no PR counts as not first-pass, and a fast-lane MERGE counts as first-pass. `--pool <workflow-output.json>...` (the files the scorecard already reads, whose agent records hold the tokens) prints
  one pooled table across the given runs (rates, intervals, fix items by cause, tokens per task) without a per-task
  section. The decision rule text changes: a role moves only when the pooled interval lies wholly on one side of the
  threshold (worker: an upper bound of first-pass MERGE under 50% moves the worker up; critic: a lower bound of the share of merged tasks with a miss above 5% moves the critic up, and an upper bound under 10% with only low findings moves it down). When
  results carry a non-empty critic `checklist`, the scorecard counts items failed per checklist number. Reads or writes: reads.
  Test: interval values against hand-computed Wilson bounds (0/6, 6/6, 20/30); the critic rule fires on 4 of 20 (lower bound 8%) and not on 1 of 30; a 0-of-6 lower bound prints as 0; a pool of two fixture results; an
  escaped file with two fixes; existing scorecard tests pass.
- **2.5 Critic labelling sheet.** Owns `scripts/label-sheet.py`, `tests/label-sheet.test.ts`. `python3 -I
  scripts/label-sheet.py <result.json>... [--sample <n>] [--seed <s>]` prints a Markdown sheet: one row per fix item of a FIX verdict and one row per MERGE verdict of a round whose critic ran (none for STOP, `lane: 'fast'` or `criticSkipped` rounds), each row keyed by task, round and item,
  with the verdict, the fix item (`n` and `what`) and the PR link from `result.tasks[id].pr.url`, and an empty `real? (y/n)` column
  on a fix-item row and an empty `correct? (y/n)` column on a MERGE row; `--sample` draws n verdicts (a drawn FIX verdict brings all its rows), FIX and MERGE in their observed proportion,
  reproducibly by seed. `--read <filled sheet>` prints precision: share of FIX items labelled real, share of MERGEs
  labelled correct, each with a Wilson interval, and the count left unlabelled. Reads or writes: reads. Test: a fixture
  result gives the expected rows; the same seed gives the same sample; a filled sheet gives the expected precision;
  unlabelled rows are counted, not guessed.
- **2.T Wave 2 tail.** Owns `tests/v24-e2e.test.ts` and `docs/OPERATING.md` (the sections for the impact and test-edits relays, `escaped.js` with `--escaped-from`, `--pool` and `label-sheet.py`, written after 2.2 to 2.5 merged). Depends on 2.1, 2.2, 2.3, 2.4 and 2.5. Test: a stubbed four-task
  wave: preflight fails when the fake settings lack the rule; with the rule, a task whose branch changes an assertion
  without `Test edits:` gets FIX; a far-out usage limit pauses the rest; the result renders in the scorecard with
  intervals and in the labelling sheet; `escaped.js` over a temp repo feeds `--escaped-from`. Done: `npm run check`
  green on main; `LOOP_VERSION` is 2.4.0.

## Later (not in this spec)

Red-team findings 4, 8 and 10, and the follow-ups to 1 and 3: spec review reading each Test line for a second
reading; dependent tasks started on their parent's branch; a Sonnet-first critic cascade measured as an A/B; a
mutation-testing gate; one execution-based or cross-family check before MERGE. Each needs the measurement from wave 2
first, or a human decision (accounts, cost).
