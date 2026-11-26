# Benchmark: comparing loop configurations

Results so far are observational: different tasks, machine load and mid-run fixes. The benchmark replays one task graph
from one starting commit under different loop configurations, with no GitHub repository and no CI minutes, and reports
makespan, tokens, merge rate, correctness and human interventions, each with a 95% interval once a configuration has two
or more runs. Running the comparisons is a human step (H6 of the v2.4 spec): every replay spends Claude Code usage.

## What is in the box

| Piece | What it does |
|---|---|
| `bench/fake-gh.js`, `bench/bin/gh` | A `gh` replacement backed by a local bare remote and a state directory (`$BENCH_STATE`). It answers the subcommands, flags and `--json` fields the loop uses and exits 1, naming it, for anything else. |
| `bench/ci.js` | Local CI. A `post-receive` hook in the bare remote records one run per pushed sha and runs the project's install and check in a clean clone, at most `BENCH_CI_JOBS` at once (default 2). |
| `scripts/bench.js` | `prepare`, `doctor`, `sample`, `collect` and `compare`. |
| `bench/scenarios/` | `v24-wave-1` (this repo's v2.4 wave 1, from its starting commit, with wave 1's tail test as the held-out test) and `synthetic-6` (a six-task graph with two dependency chains, a seed repo and a held-out test). |

`tests/bench-e2e.test.ts` replays `synthetic-6` through the whole pipeline with stub agents, so the harness itself is
tested without spending anything.

## Running a comparison

A comparison is two or more configurations of the same scenario. A configuration is the loop checkout under test plus
overrides of the scenario's `loop.local.json` fields (`maxBuilders`, `maxChains`, `models`, `syncPolicy`, `check`, and so
on). `repo`, `worktrees` and `github` cannot be overridden: `prepare` sets `github` to `bench.invalid/bench`, a name
GitHub cannot hold, so a replay never reaches a real repository.

1. **Write the overrides** for each configuration, for example `a.json` with `{}` and `b.json` with
   `{ "maxBuilders": 3 }`. Fields are merged over the scenario's project field by field.
2. **Prepare one directory per run.** Use a fresh `--out` each time, and the same `--ci-jobs` for every run you compare
   (it is part of the configuration key):

   ```
   node scripts/bench.js prepare v24-wave-1 --loop <loop checkout> --config a.json --out <dir> --ci-jobs 2
   ```

   `prepare` makes a bare remote holding only the history up to the scenario's base commit, a clone whose `origin` is that
   remote, the loop links (`install.sh`), `loop.local.json` with the overrides, and the held-out tests moved out of the
   clone. It prints one JSON line: the allow rules, the environment, the `wave-args` command and the configuration key.
   It never writes a settings file (the loop never changes a permission setting).
3. **Add the allow rules it printed (H7)** to `~/.claude/settings.json`: one
   `Bash(node <dir>/clone/.claude/scripts/<script> *)` per relay script, for exactly that `--out`. If the Bash sandbox is
   on, add `<dir>` to `sandbox.filesystem.allowWrite`. The preflight of the wave fails without the rules.
4. **Start the session's shell the way `prepare` said**: `PATH=<dir>/bin:$PATH`, `BENCH_STATE` and `BENCH_CI_JOBS`. Then,
   in the same Bash call as the wave, run the doctor:

   ```
   node scripts/bench.js doctor <dir>
   ```

   It exits 1 unless `command -v gh` is `<dir>/bin/gh`, `gh pr list` answers from `BENCH_STATE`, and both variables are
   set. The fake `gh` also refuses to run when `BENCH_STATE` is unset, so a wave never falls through to the real `gh`.
5. **Sample the load** in the background, once per run, so a busy machine shows up in the record:

   ```
   node scripts/bench.js sample <dir> --every-s 30
   ```

   It appends `{ t, load1 }` lines to `$BENCH_STATE/load.jsonl` until `<dir>/state/sample.pid` is removed. Remove that
   file when the wave ends.
6. **Run the wave** with the `wave-loop` workflow of the loop checkout under test, from the clone: the arguments come
   from the `wave-args` command `prepare` printed, as for any project. If the run stops (a usage-limit pause, a
   relaunch), keep every run output file in launch order.
7. **Collect** one record per run:

   ```
   node scripts/bench.js collect <dir> <run output.json>...
   ```

   The record has the makespan (first agent start to the end of the last merge relay), agent minutes, tokens per role,
   tasks merged of tasks, fix rounds, escalations, reverts, the load summary (`load: null` without the sampler) and the
   held-out tests' pass count, measured by running them on the final default branch of the bare remote.
8. **Compare** all the records of all the configurations:

   ```
   node scripts/bench.js compare <record.json>...
   ```

   Records are grouped by configuration key, which is the hash of the merged project (without the per-run paths), the loop
   checkout's commit and version, the scenario and `BENCH_CI_JOBS`: two loop versions with the same settings never pool.
   For each metric it prints the mean with a 95% interval (Wilson for rates, a t interval for times and tokens, no
   interval for fewer than 2 records) and, for every pair of configurations, the difference of the means with a Welch 95%
   interval. It reports two separate facts: whether the two single-configuration intervals overlap, and whether the
   interval of the difference includes 0. Only the second says the configurations differ.

## What it costs

A replay of the v2.4 wave 1 scenario costs about 1.7M tokens: the wave 1 scorecard totals 1,655,730 tokens for the wave
that scenario replays. That figure is one observation of one wave, an estimate to be replaced by the pilot's measured
drop. A configuration that changes the models, the effort or the number of fix rounds can spend a different amount.

Plan in two steps, so the first spend is small:

1. **Pilot: 1 run per configuration, before 3.** For two configurations that is two replays, about 3.4M tokens by the
   estimate. Read `/usage` before and after the pilot. The drop, divided by the tokens the records report, is the cost of
   a replay in the units of your plan, and it replaces the 1.7M estimate. A pilot also shows the failures that are cheap to
   fix before the larger run: an allow rule that was missed, an environment variable that was not exported, a gh
   subcommand the fake does not have yet (it exits 1 naming it).
2. **Scale the plan from the measured drop.** Three runs per configuration is the smallest number that gives an interval
   (2 degrees of freedom, a t quantile of 4.303, so the intervals are wide). The pilot's runs are the first of the three
   when their preparation is identical, so two configurations need four more replays after the pilot. If the measured
   drop does not fit what is left of the usage window, run fewer configurations, or run the pilot on `synthetic-6`
   first (six small tasks, far fewer tokens than wave 1; not measured here).

Do not run replays in parallel on one machine: load changes the makespan, and the sampler only records it.

## What it cannot tell you: contamination

A loop under test at 2.4.0 or later carries wave 1's reference solutions in its own files: the merged code and the tail
test of wave 1 are part of the loop checkout, and the clone's `.claude` links lead into that checkout. An agent that
follows the links can read the solutions, and the held-out tests under `bench/scenarios/` too. So the `v24-wave-1`
scenario supports relative comparisons between configurations, not an absolute correctness score: a holdout pass rate of
100% does not mean the loop can build wave 1 from the spec, only that two configurations that could both see the answer
differ, or do not, in time, tokens, merge rate and interventions. The same holds for `synthetic-6`, whose held-out test
is also in the loop checkout.

Only the sandbox read rules (H4) could hide the source checkout and the loop files from agents: the
`permissions.deny` read rules `scripts/isolation.js` lists. Until they are on, read every correctness figure as a
comparison between configurations of one loop version, and never compare records of different scenarios or of loop
checkouts at different commits as if they measured the same task.

## Reading the result

- A difference whose interval includes 0 is not a finding. With 3 runs per configuration that is the usual case for
  anything but a large change; report it as "no difference seen", not as "equal".
- A configuration that merged fewer tasks may have shorter makespan and fewer tokens for that reason alone. Read the merge
  rate and the held-out pass count beside the times.
- Escalations are the human interventions the loop asked for. A replay that needed one counts it, and the time a human
  took to answer is not in the makespan.
- A high load mean in a record means the machine was busy: its times are not comparable with a quiet run.
- The fake `gh` and the local CI have no queue delay, no flaky runner and no review latency. They compare
  configurations with each other; they do not predict the wall-clock time of a real project.
