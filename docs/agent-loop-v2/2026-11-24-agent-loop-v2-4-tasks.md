# agent-loop v2.4 reliability and measurement: ordered task list (draft 5: after the wave 3 review)

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
  other projects only after a human relinks them (H1). Waves 3 and 4 are built by a frozen copy of this repo at the end of wave 2
  (v2.4.0, a detached worktree), linked into this repo only; the session runs that copy's workflow by `scriptPath`.
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
| H1 | after the last wave | Add `permissions.allow` rules for `dep-state.js` and `isolation.js` as for H2, then relink projects (`install.sh`) to this checkout and point `~/.claude/CLAUDE.md` at it | the loop must not change itself mid-run; Edan's machine |
| H2 | before wave 1 | Add a `permissions.allow` rule for each script a relay runs (`merge-pr.js`, `wait-ci.js`, `ci-only.js` and, from wave 2, `impact.js` and `test-edits.js`), then confirm once by running one relay in auto mode that the classifier is not consulted, e.g. `Bash(node /path/to/repo/.claude/scripts/merge-pr.js *)` (the path exactly as `project.repo` plus `/.claude/scripts` spells it, absolute and not the link's target), in `~/.claude/settings.json` | every wave merges through that script, and Warden wave 4 was refused there; 2.1's preflight fails without it; permission settings are human-only |
| H3 | before wave 3 | Freeze v2.4.0 (a detached worktree of this repo at the wave 2 tail's merge), relink this repo only to it, and add `permissions.allow` rules for `impact.js`, `test-edits.js` and `ci-only.js` as for H2 | waves 3 and 4 run on the new loop, so its preflight, pause, impact map and test-edits gate are tried on real work; permission settings are human-only |
| H4 | after wave 3 | Add the `permissions.deny` read rules `isolation.js` lists. Then turn on Claude Code's Bash sandbox in one project first: add the `project.worktrees` directory to `sandbox.filesystem.allowWrite` (a sibling of the repo is not writable by default), run the preflight and one small wave, and add what fails (either `api.github.com` to `sandbox.network.allowedDomains`, or `gh *` and `git push *` to `sandbox.excludedCommands`) before turning it on in other projects | agents run with your privileges; the loop can only check and warn (invariant 6); the relays write outside the repository and call gh, so an unrehearsed sandbox can stop every merge |
| H5 | when convenient | Give each wave a GitHub token limited to the one repository (a fine-grained token), in the session's environment | a shared `gh` login reaches every repository you own; creating a token is human-only |
| H6 | after wave 4 | Run the benchmark comparisons in `docs/BENCHMARK.md` (each costs Claude Code usage) | the before/after needs controlled runs |

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
  preflight, failure handling and constants; no prompt text), `package.json`, `docs/OPERATING.md`, `claude/workflows/chain-loop.js` (its `LOOP_VERSION` line only, which must equal `package.json`), `tests/wave-loop-v24.test.ts`, and `tests/wave-loop-relay.test.ts`, `tests/loop-perf.test.ts`, `tests/speed-e2e.test.ts` (in those three only the stubbed `loopVersion` literal, read from `package.json`, and the CI chunk assertions if the default changes), and, for the tests its pause handling changes (answers to the wave 2 worker's questions): `claude/lib/pause.test.ts` (its scan of `wave-loop.js` skips the `@bundle-start pause` region), `tests/wave-loop-gates.test.ts` (the null-worker case answers its `probe:<label>` with a passing relay and keeps today's expectation; the critic-fallback-null case expects the pause), and the null-stub cases in `tests/wave-loop-relay.test.ts` and `tests/loop-perf.test.ts` (each answers its `probe:<label>` with a passing relay; the probe covers every agent but the critic, decision D1). Depends on 1.1 and 1.3.
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
  schema, the impact relay before the worker, and the test-edits relay and gate of (b) in `reviewRound`, after 2.1 has merged), `claude/agents/critic.md`, `claude/agents/producer.md`, `tests/wave-loop-prompts.test.ts`, `claude/lib/impact.js`, `claude/lib/impact.test.ts`, `scripts/impact.js`, `tests/wave-loop.test.ts`, `tests/wave-loop-gates.test.ts`, `tests/wave-loop-relay.test.ts`, `tests/loop-perf.test.ts`, `tests/loop-version.test.ts`, `tests/chain-e2e.test.ts` (in the last six only the exact `calls` lists and the lists of agents a wave started, such as `taskAgents` in chain-e2e).
  Depends on 2.1, 1.2 and 1.5. (a) Before the worker starts, one relay runs `impact.js` for the task's `owns` (with
  `--spec` when the project has one); `impact.js` also lists, with `via: "name"`, every test file with a quoted string holding an owned file's repo-relative path or its basename (tests of this repo read `wave-loop.js` with `readFileSync` and run `loop-scorecard.py` with `execFile`, which no import shows; `impact.test.ts` gets a case, and the other fields keep their shape); the worker prompt lists the tests and their owners and tells the worker to run
  them before opening the PR and to stop with a question when a change breaks a test another task owns (the existing
  ownership rule, now with the list). An impact relay that fails or returns nothing leaves the prompt as before and
  logs it. (b) Before each critic round, one relay runs `test-edits.js` (once more when it prints no JSON line; if it is still blocked or empty the round records `testEdits: "unavailable"`, the critic prompt tells the critic to run `git diff` over the test files itself, and it is logged); the critic prompt gets the report under
  "Test edits after the test-first commit", and checklist item 3 adds: an assertion removed or changed after the
  test-first commit is a FIX unless the PR body's `Test edits:` section justifies each one and the justification
  holds. Deterministic gate: `assertionsRemoved + assertionsChanged > 0` with `bodySection` false makes the verdict FIX
  (cause `defect`, item "restore the assertion or justify it under Test edits:") whatever the critic said; the same report is read in the fast-lane facts step, where a non-zero count with `bodySection` false makes the task not eligible (the critic reviews it), and a round whose critic is skipped as CI-only reuses the report of the round it follows; the worker
  prompt and `producer.md` describe the `Test edits:` section. The relay prompt runs its command alone, with no `cd` before it and nothing joined by `&&` or `;` (every relay command takes `--repo`): an allow rule matches only the command on its own, and in wave 2 the compound `cd <repo> && node .../merge-pr.js ...` went to the auto-mode classifier, which refused three merges. The loop that builds this repo already has the fix. (c) The critic schema's existing `checklist: [{ item, pass, evidence
  }]` (one entry per checklist item, `evidence` a quote from the diff, a file:line or a command output) is checked for completeness: a
  `checklist` that misses a checklist number gets one more critic call on the same model with the missing numbers named (never the swap to `CRITIC_FALLBACK`); a second miss is recorded as is and logged. Rounds with `lane: 'fast'` or `criticSkipped` are not checked. A critic that ran and returned `checklist: []` is not retried (the stubs of existing tests return it), but the round records `checklistEmpty: true` and logs a line starting `note:` (not `WARNING`, which tests/loop-perf.test.ts:88 rejects). Test: prompt
  snapshots for each case; the relay prompt contains no `cd`; the gate turns a MERGE into FIX; a critic result missing item 9 gets one more call on the same model and `models.critic` is unchanged; an empty checklist is recorded with `checklistEmpty: true`.
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

## Wave 3: close the assumptions a review named (3.5 after 3.1, 3.2 and 3.4; the rest in parallel)

Source: an outside architecture review of the loop (2026-11-25) named six assumptions the loop relies on but does not
check. Each task makes one of them checked, or makes it a stated, opt-in choice. Waves 3 and 4 are built by a frozen
copy of v2.4.0, not by loop 2.3.1 (see Bootstrapping).

- **3.1 Dependency state.** Owns `claude/lib/deps.js`, `claude/lib/deps.test.ts`, `scripts/dep-state.js`. A CLI
  `node scripts/dep-state.js --repo <path> --task <id>... [--prefix task/]` prints `{ tasks: { "<id>": { merged, pr,
  mergeSha, onDefault, reason } } }`: the task's PR is the merged PR whose head branch starts with `<prefix><id>-`
  (`gh pr list --state merged --limit 1000 --json number,headRefName,mergeCommit`; a task with several, such as a
  reopen after a revert, uses the latest); `onDefault` is true when `git merge-base --is-ancestor <mergeSha>
  origin/<default branch>` exits 0 after a `git fetch` (the default branch is `git symbolic-ref --short refs/remotes/origin/HEAD`; a failed fetch gives `onDefault: false`, reason `fetch failed`; a null `mergeCommit` gives `onDefault: false`, reason `no merge commit`); a task with no merged PR has `merged: false` and a `reason` (one of `no merged PR`, `reverted`, `not on default branch`, `no merge commit`, `fetch failed`, `gh failed`, or `not in the newest 1000 merged PRs` with a `note` when exactly 1000 rows come back and none matches; the tool does not assume `gh` returns more than 1000).
  A task whose latest merged PR was later reverted by a merged PR that merged after it and whose head branch is `revert/<id>` (the merger's red-on-main step in `wave-loop.js`) or `revert/pr-<that PR's number>` (the branch `merge.js` makes) has `merged: false`,
  reason `reverted`. Reads or writes: reads. Test: a temp repo with a fake `gh`: a merged task (true, true); no PR
  (false); a PR merged but its merge commit not on the default branch (onDefault false); a reopen with two PRs (the
  latest); a task reverted through a `revert/<id>` PR and one through a `revert/pr-<n>` PR (both false, `reverted`); a fetch failing (`fetch failed`); 1000 rows with no match (the cap reason); `gh` failing (exit 1, nothing printed as merged).
- **3.2 Merge lock and tree-reuse evidence.** Owns `claude/lib/merge.js`, `claude/lib/merge.test.ts`, `scripts/merge-pr.js`.
  `mergePr` takes the lock before it reads the PR state it acts on (the PR is read, or read again, after the lock, so
  the sync decision and the pinned head come from after any wait), holds it through the merge, the main check when it
  is not deferred, and a revert, and releases it on every exit path, so the guarantee no longer depends
  on the caller: the lock is a directory `<git common dir>/agent-loop-merge.lock` made with an atomic `mkdir`,
  holding `owner.json` `{ pid, host, pr, startedAt }`. A lock is stale when its host is this host and its pid is not
  alive, or when its host is another host or `owner.json` is missing or unparseable, and the lock directory is older
  than `project.mergeLockStaleMin` (default 30). A live pid on this host is never stale: a revert after a red main
  legitimately holds the lock for more than 30 minutes. `owner.json` is written under a temporary name and renamed into
  the lock directory, and a lock younger than 10 s with no `owner.json` counts as held. A takeover takes a second
  atomic `mkdir` (`agent-loop-merge.lock.takeover`), re-reads `owner.json` under it, replaces the lock only when it
  still shows the owner judged stale, and removes the takeover directory; it is logged in `message`. Known limit: a
  crashed holder whose pid was reused looks live, so `locked` names the lock path for a human to remove. A held lock is waited for, polling every 5 s, up to `project.mergeLockWaitMin` (default 5, a larger value is lowered to 8: a merge relay's Bash call ends at 10 minutes); then
  the outcome is `locked`, exit 2, with the holder in `message`. `--dry-run`, `--state` and `--verify-main` do not take
  the lock (they make no write; a revert inside verify mode does take it). The lock operations are injected deps
  (`lock.acquire`, `lock.release`), wired to the file system in `merge-pr.js`. The `merge.js` comment "Assumes the
  caller holds the merge lock" is replaced by the rule. Reads or writes: writes-files (the lock). Test: two
  concurrent `mergePr` calls on fakes run one after the other; a stale lock (dead pid) is taken over; an old lock is
  taken over; a held lock past the wait gives `locked`; a throw inside the merge still releases; dry run, state and
  verify make no lock call.
  Tree reuse (formerly 3.3): Skipping the check on the default branch because the merged tree equals the PR head's tree becomes
  opt-in: `project.reuseTreeCi` (default false; invariant 4 then holds without exception). When it is true, the skip
  also needs the main CI workflow file (`.github/workflows/<mainCi>.yml` or `.yaml`, else the one file in that directory whose top-level `name:` equals `mainCi`, found with `git ls-tree` and read with `git show` at the merge commit; with `mainCi` empty there is no file, so the check runs) to show
  no event-dependent behaviour: no `github.event_name`, `github.event.`, `github.ref`, `secrets.`, `vars.` or
  `schedule:`, and an `on:` block that has both `push` and `pull_request`, with no `paths`, `paths-ignore`, `branches-ignore` or `tags` filter on either, a `branches` filter only on `push` and only when it lists the default branch, and no job-level `if:` (a text scan; no YAML parser is added). A
  file that fails the scan, or cannot be read, means the check on main runs, and `message` names the reason; the
  result gains `treeReuse: { allowed, reason }`. Test: default off runs the check on main; on with a plain workflow
  skips; each listed pattern prevents the skip; a missing workflow file prevents the skip.
- **3.4 Isolation checks and rules.** Owns `claude/lib/isolation.js`, `claude/lib/isolation.test.ts`,
  `scripts/isolation.js`, `claude/hookify.block-credential-reads.local.md`, `install.sh`, `tests/install.test.ts`, `tests/hookify.test.ts` (the new rule joins its `rules` list).
  `node scripts/isolation.js --repo <path>` prints `{ sandbox: { enabled, source }, denyReads: { present, missing },
  warnings }` from the same four settings files as 1.1's check (user, project, project local, managed), read by `isolation.js` itself with the fixed `missing` and `unparseable` error strings (`permission.js` exports no reader and is not owned here): `sandbox.enabled` is
  the settings key `sandbox.enabled` (spike, from code.claude.com/docs/en/sandboxing), `source` is the first file that sets it in the order managed, project local, project, user, and a `warnings` entry is one of the fixed strings `sandbox is not enabled`, `deny rule missing: <rule>` or `settings file unparseable: <path>`; `denyReads` lists which of `Read(~/.ssh/**)`, `Read(~/.aws/**)`,
  `Read(~/.config/gh/**)`, `Read(~/.netrc)` and `Read(**/.env*)` are present as `permissions.deny` rules. It never
  writes a setting (invariant 6). The new hookify rule (`event: bash`, one single-line `pattern:` that is also a valid JavaScript regular expression, with no inline flags, because `claude/lib/merge.test.ts` and `tests/hookify.test.ts` read every rule that way) blocks Bash commands that read credentials: paths under
  `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `gh auth token`, and `security find-generic-password` or
  `find-internet-password`. `install.sh` also writes (not links) `.claude/hookify.gh-this-repo.local.md` (reading `github` with `node`, accepting only `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`, with `.` escaped in the pattern) from the
  project's `github` field: it blocks `gh` commands whose `--repo`/`-R` value, or whose `gh api repos/<owner>/<name>`
  path, names another repository; with no `github` field it writes nothing and says so; the file is added to the
  exclude list. Reads or writes: writes-files (`install.sh` only). Test: settings with and without each deny rule and
  the sandbox key; a malformed file listed, not fatal; the credential rule's pattern on 10 sample commands (5 blocked,
  5 allowed, such as `ssh -V` and `git push`); `install.sh` into a temp repo writes the gh rule for `owner/name`, which
  blocks `gh pr view 1 -R other/repo`, `gh pr view 1 -R=other/repo`, `gh pr view 1 --repo other/repo`, `gh pr view https://github.com/other/repo/pull/1`, `gh api repos/other/repo/pulls` and `gh repo clone other/repo`, and allows `gh pr view 1 -R owner/name`, `gh api repos/owner/name/pulls` and a bare `gh pr view 1`.
- **3.5 Wave-loop wiring.** Owns `claude/workflows/wave-loop.js`, `package.json`, `claude/workflows/chain-loop.js` (its
  `LOOP_VERSION` line only), `docs/OPERATING.md`, `tests/wave-loop-v25.test.ts`, and, in these tests only, the edits the 2.5.0 changes force: the exact calls lists and agent lists in every test that pins preflight:merge or a task's agent list (`tests/loop-version.test.ts`, `tests/loop-perf.test.ts`, `tests/speed-e2e.test.ts`, `tests/wave-loop-relay.test.ts`, `tests/wave-loop-v24.test.ts`, `tests/wave-loop-prompts.test.ts`, `tests/wave-loop-findings.test.ts`, `tests/wave-loop.test.ts`, `tests/wave-loop-gates.test.ts`, `tests/chain-e2e.test.ts`, `tests/v24-e2e.test.ts`); the version literals of the case 'the loop version is 2.4.0 everywhere' in wave-loop-v24 and of v24-e2e, which read package.json instead; the result key list in wave-loop-gates; the two outside-dependency cases in wave-loop-relay, whose stubs answer the dep-state relay; the preflight loopVersion literal in wave-loop-prompts, read from package.json; the loop-perf case 'the merge lock is released before main is watched', which runs with settleMain false (the 2.4 behaviour it tests; under settleMain it would deadlock); and the wave-loop-findings case 'never blocks the gate', which runs with integrationGate off. These are assertion changes after the test-first commit, so the PR body carries a Test edits section naming each. Depends on 3.1, 3.2 and 3.4. (a) Dependencies outside the run (ids `wave-args.js` keeps, which means same-wave dependencies that a relaunch left out; `wave-args.js` drops dependencies on earlier waves, which stay assumed merged, a stated limit; the relay passes `--prefix` as the run's task branches spell it, the text before `<id>-`): before the build loop, one relay runs
  `dep-state.js` for every dependency that is not in the run; a task whose such dependency is not `merged` and
  `onDefault` is parked with the escalation `dependency <id> not merged on the default branch: <reason>`, and so are its
  dependents; a relay that fails, is blocked or prints no JSON parks every such task (fail closed; the escalation says why); the log line "treated as
  merged in an earlier run" now says which PR and merge commit proved it. (b) Settle main: a merge does not start while
  an earlier merge's deferred check on the default branch is still running (workers and critics keep running);
  `project.settleMain: false` restores 2.4's behaviour. A red check is reverted before the next merge starts. A deferred check that ends without a verdict (still pending after its watch calls, a blocked relay, no JSON) ends the wait and starts no further merge: each task waiting to merge is parked with `main not verified after <task>`.
  (c) Integration gate: `project.integrationGate` is `"high"` (default), `"medium"` or `"off"`; a finding at or above
  the level fails the machine gate with one escalation per finding, `integration: <what> (<where>)` (the question says a finding is cleared by a follow-up task, or accepted by
  relaunching the wave with `integrationGate` lowered, because a relaunch passes no task for it); a review that did not
  run while the level is not `"off"` logs a line starting `WARNING: integration review did not run:` and does not gate;
  `project.integrationReview: false` with a level other than `"off"` logs a warning; `"off"` keeps it
  advisory as in 2.4. (d) Preflight runs `isolation.js` once, in its own relay after the merge dry run (a relay runs one command alone); this relay and the `dep-state.js` relay of (a) are called with `probe: false`, so a null answer is not read as a usage limit and a stub that answers nothing does not pause the wave; `result.isolation` is `{ sandbox, denyReads, warnings }` as the script printed it, or null when it did not run, and the key is always present; each warning is logged as a line
  starting `WARNING: isolation:` and recorded in `result.isolation`; it never fails the wave. (e) `LOOP_VERSION` and
  `package.json` become `2.5.0`; `docs/OPERATING.md` documents `mergeLockStaleMin`, `mergeLockWaitMin`, `reuseTreeCi`,
  `settleMain`, `integrationGate`, `isolation.js`, `dep-state.js` and H4 and H5 (and the H2 allow rules for `dep-state.js` and `isolation.js`). (f) A merge result with `outcome: "locked"` is a wait, not a refusal: the merge relay is run again, at most twice more, and the task is then parked naming the holder from `message`; it starts no FIX round. Test: a `locked` result then a merged one merges; three `locked` results park. A relaunch whose missing
  dependency `dep-state` reports merged starts it; not merged parks it and its dependent; a failed relay parks them; a
  second merge waits for the first merge's deferred check (the call order shows it) and does not wait with
  `settleMain: false`; one high integration finding fails the gate, and passes with `integrationGate: "off"`; isolation
  warnings are logged and the gate unchanged.
- **3.T Wave 3 tail.** Owns `tests/v25-e2e.test.ts`. Depends on 3.1, 3.2, 3.4 and 3.5. Test: a stubbed wave with
  a fake `gh` and a temp repo: two merges from two concurrent `merge-pr.js` processes are serialized by the lock; a
  relaunch with an unmerged outside dependency parks; `reuseTreeCi` off runs the check on main; a high integration
  finding fails the gate. Done: `npm run check` green on main; `LOOP_VERSION` is 2.5.0.

## Wave 4: controlled benchmark (4.3 after 4.1 and 4.2)

Source: the same review. Results so far are observational (different tasks, machine load, mid-run fixes). Wave 4
builds a harness that replays one task graph from one starting commit under different loop configurations, with no
GitHub repository and no CI minutes, and reports makespan, tokens, merge rate, correctness and human interventions.
Running the comparisons is a human step (H6): each costs Claude Code usage.

- **4.1 Fake GitHub.** Owns `bench/fake-gh.js`, `bench/fake-gh.test.ts`, `bench/bin/gh`. A `gh` replacement backed by a
  local bare remote and a state directory (`$BENCH_STATE`), covering exactly the subcommands, flags and `--json` fields
  the loop's scripts, workflows and agent prompts use (the spec review lists them from a grep; at least `pr create`,
  `pr view`, `pr list`, `pr edit`, `pr ready`, `pr diff`, `pr checks`, `pr merge`, `run list`, `run view`, `run watch`).
  PRs are JSON files; `pr merge --merge` makes a real `git merge --no-ff` into the bare remote's default branch and
  refuses with GitHub's message when the branch conflicts; checks and runs come from 4.2's records. An unsupported
  subcommand or field exits 1 naming it. Reads or writes: writes-files (the state directory and the bare remote).
  Test: create, view, list, edit, ready, diff, merge (clean and conflicting), checks with pending, green and red runs,
  `--json` field selection and `-q` jq expressions as the loop uses them; an unknown subcommand.
- **4.2 Local CI.** Owns `bench/ci.js`, `bench/ci.test.ts`. A `post-receive` hook installed in the bare remote records a
  run per pushed sha (event `pull_request` for a PR head, `push` for the default branch) and runs the project's install
  and check in a clean clone at that sha, at most `BENCH_CI_JOBS` at once (default 2), recording `{ id, sha, event,
  status, conclusion, startedAt, durationMs, logTail }`. Reads or writes: writes-files. Test: a push records a queued
  run that turns green or red; the concurrency cap holds; a run's log tail is kept for `run view --log-failed`.
- **4.3 Scenarios, prepare, metrics and compare.** Owns `bench/scenario.js`, `bench/scenario.test.ts`, `scripts/bench.js`,
  `bench/scenarios/v24-wave-1.json`, `bench/scenarios/synthetic-6.json`, `bench/metrics.js`, `bench/metrics.test.ts`. Depends on 4.1 and 4.2. A scenario is `{ name,
  source, baseSha, spec, wave, holdout: [test files], overrides }`. `node scripts/bench.js prepare <scenario> --loop
  <loop checkout> --config <overrides.json> --out <dir>` makes the bare remote at `baseSha`, a working clone, the loop
  links (`install.sh`), `loop.local.json` with the overrides, and the holdout tests moved out of the clone (the agents
  never see them), and prints the environment for the session (`PATH=<dir>/bin:$PATH`, `BENCH_STATE`) and the wave
  args. Two scenarios: this repo's v2.4 wave 1 (base `844e886`, the commit wave 1 started from; holdout `tests/v24-wave1.test.ts`, wave 1's tail test)
  and a synthetic six-task graph with two dependency chains. Reads or writes: writes-files. Test: prepare a scenario in
  a temp dir: the clone is at `baseSha`, the holdout files are absent from it, the gh shim answers `pr list`.
  Metrics (formerly 4.4): `bench.js collect <dir> <run output.json>...` prints one
  record: makespan (first agent start to last merge), agent minutes, tokens per role, tasks merged of tasks, fix rounds,
  escalations (human interventions), reverts, the holdout tests' pass count when run on the final default branch, and
  the machine's load average samples. `bench.js compare <record.json>...` groups records by config and prints, per
  metric, the mean with a 95% interval (Wilson for rates, a t interval for times and tokens) and the difference between
  two configs, saying when the intervals overlap. Test: collect on a fixture run and state; compare two groups of three
  records with hand-computed intervals.
- **4.T Wave 4 tail.** Owns `tests/bench-e2e.test.ts`, `docs/BENCHMARK.md`. Depends on 4.1, 4.2 and 4.3. Test: prepare the
  synthetic scenario, drive a stubbed wave through the fake `gh` and local CI (no real agent), collect and compare two
  configs. `docs/BENCHMARK.md` says how to run a comparison and what it costs. Done: `npm run check` green on main.

## Later (not in this spec)

Red-team findings 4, 8 and 10, and the follow-ups to 1 and 3: spec review reading each Test line for a second
reading; dependent tasks started on their parent's branch; a Sonnet-first critic cascade measured as an A/B; a
mutation-testing gate; one execution-based or cross-family check before MERGE. Each needs the measurement from wave 2
first, or a human decision (accounts, cost).
