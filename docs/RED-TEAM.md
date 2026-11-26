# Red team: where agent-loop is weak

Date: 24 Nov 2026; status updated 26 Nov 2026. Two sources: the loop's own records (every saved Warden run: agent timings, tokens, verdicts,
escalations, and the PRs merged afterwards) and a literature pass over 2024–2026 papers and engineering posts. The
literature pass was automated (search plus page reads); its figures are as the sources report them, and most are
2026 preprints or vendor posts, so read them as indicative.

The short version: the design ideas hold up (separate critic, owned paths, deterministic control flow), but three
things are weak. Single points of failure waste whole waves; the same work is done twice; and the accuracy numbers
measure less than their names suggest. The fixes are planned as waves the loop builds on itself
([spec](agent-loop-v2/2026-11-24-agent-loop-v2-4-tasks.md)); the status column tracks them.

## Findings

| # | Area | Finding | Evidence | Fix | Status |
|---|---|---|---|---|---|
| 1 | Accuracy | The acceptance test can be weakened after it is written. The critic checks that the test came first, nothing is skipped and the count did not drop; it does not see loosened assertions. | ImpossibleBench: Claude models cheat mainly by editing tests. METR's Q4 2026 update names current frontier models for subtle reward hacking. | Report every assertion removed or changed after the test-first commit; the critic sees it and the merge needs a stated reason. Later: a mutation-testing gate. | **done** (2.4.0): `test-edits.js` reports each removed or changed assertion, and the critic sends a PR back without a `Test edits:` section that names them. Wave 3's 3.5 changed 26 assertions, all named. Mutation testing later. |
| 2 | Accuracy | "0 critic misses" counts reverts only. Escaped defects were never counted, yet later PRs fixed loop-built code (database TLS, a dropped connection on a 244k-row import, a statement timeout, unbatched writes). Tests run on small in-memory fixtures and no project has a `realityCheck` set. | Warden PR history after waves 1–3. METR: about half of test-passing SWE-bench PRs would not be merged by maintainers. | Trace fix commits back to the task PR that introduced the lines; put the count in the scorecard. Turn on `realityCheck` with a production-size run. | **tracer done** (2.4.0): `escaped.js` found 0 escaped defects over 17 task PRs and 39 later commits. `realityCheck` still unset on every project. |
| 3 | Accuracy | Critic and worker are the same model family (Fable reviews Sonnet). False alarms are not measured. | 2026 rubric-judge studies: judges pass failed items for their own family >50% more often; stronger judges can be more biased. A blind benchmark: a frontier reviewer asked for changes on 20.7% of correct PRs. | Per-item verdicts with quoted evidence; a labelling sheet to measure critic precision per wave. Later: one execution-based or cross-family check before MERGE. | **partly done** (2.4.0): per-item verdicts with quoted evidence; `label-sheet.py` makes the labelling sheet, but none has been labelled, so precision is still unmeasured. Cross-family check later. |
| 4 | Accuracy | Half of fix items are spec misses (10 of 21 in Warden wave 3), after spec review. | MAST (2025): 44% of multi-agent failures are specification and design. 2026: models silently commit to one reading of an ambiguous spec. | Later: spec review reads each task's Test line for a second reading. | later |
| 5 | Reliability | Warden wave 4 spent 2.75M tokens and merged nothing. The permission system refused the merge script (a dry-run preflight had passed, because a dry run is judged differently), then the weekly usage limit stopped 9 workers. Wave 1d failed on the same merge block. | Wave 4 and 1d run records. | Preflight checks for a permission rule that allows the merge command, not a dry run. A far-off usage limit pauses the wave (no new tasks) instead of parking every task. `wave-args.js` prints a token estimate for the wave. | **done** (2.4.0): the preflight checks for an allow rule and fails before any work if there is none; a far-off limit pauses the wave; `wave-args.js` prints an estimate. One more cause found and fixed: a relay that ran `cd <repo> && node ...` was refused even with the rule, so relays now run the script alone. The loop's own pause has not been exercised yet (in wave 3 the Workflow runtime held the waiting agent through the reset). |
| 6 | Reliability | Relaunches cost 45% of Warden wave 3 (7.6M tokens, 383 min), caused by tests owned by earlier tasks. | Wave 3 session notes. TDAD (2026): giving agents a map of the tests their change affects cut regressions 70%; TDD instructions without it made things worse. | A test-impact map per task (tests that import its owned files), which the worker runs before opening the PR. | **done** (2.4.0): an impact relay lists the tests that import a task's files and the worker runs them before the PR. Waves 3 and 4 had no relaunch. |
| 7 | Speed | Every task's check runs twice: locally (median 9.4 min, worst 25.6) and in CI (median 6.6 min). | Warden wave 3 timings; `quickCheck` unset. | Set `quickCheck` per project (config). | **done** (config): `quickCheck` here runs the related tests only (seconds instead of about 3.5 minutes); CI runs the full suite. |
| 8 | Speed | Parallel slots sit idle: 3.1 workers on average of 6 allowed in the 30-task wave, 1–2 in the others. Dependency hops wait about 15 min each. | Agent records, all Warden runs. Stacked PRs (GitHub, Devin) and speculative merge queues report waits falling from about 60 to under 5 min. | Later: start a dependent task on its parent's branch. | later |
| 9 | Cost | 27% of all tokens went to relay agents that run one shell command (179 CI relays: 6.0M tokens, about 34K each, mostly prompt overhead). Relays run on Haiku, so the dollar share is smaller. | Agent records. | Longer CI wait per relay call (fewer relays per wait). | **option added** (2.4.0): `ciChunkMin` sets the minutes per relay call; off by default, not yet measured. |
| 10 | Cost | A critic review (107K tokens) costs more than a worker run (90K). | Agent records. 2026 cascade study: cheap model first, escalate on failure, saved 16–33% at equal accuracy. | Later, as a measured A/B: Sonnet first-round critic, Fable on round 2 and security tasks. | later |
| 11 | Measurement | The tuning rule ("two waves in a row") reacts to noise. With 6–30 tasks per wave, a 72% first-pass rate has a 95% interval of about ±16 points. | 2026 studies: agent runs vary 2–6 points run to run; small comparisons need many runs. | Pool scorecards across waves and print intervals; move a model only when the interval clears the threshold. | **done** (2.4.0): `loop-scorecard.py` prints Wilson intervals and pools runs with `--pool`; a role moves only when the pooled interval clears the threshold. |

## Outside review: six unchecked assumptions (25 Nov 2026)

An outside architecture review named six things the loop assumed instead of checking, and one evaluation gap. Wave 3
of the v2.4 spec turned each into a check or an explicit opt-in (loop 2.5.0); wave 4 built the harness for the gap.

| Assumption | What could go wrong | Now (2.5.0) |
|---|---|---|
| A dependency outside the run is merged | A relaunch builds on a task that was reverted or never reached main | `dep-state.js` checks each one against merged PRs, reverts and the default branch; an unmerged one parks its dependents (fails closed) |
| The caller serializes merges | Two merge scripts racing on the default branch | `merge-pr.js` takes a lock directory itself; a live holder is never treated as stale; takeover goes through a second lock |
| Main is green before the next merge | A merge lands on top of an unverified (maybe red) main | settle main: no merge starts while the previous merge's check on main is running; a red main is reverted first |
| The PR's CI tree equals main's | Skipping the check on main because the trees match, while the workflow behaves differently on `push` | opt-in (`reuseTreeCi`, off by default), and only when a scan of the workflow file shows no event-dependent behaviour |
| Agents only touch what they should | An agent reads credentials or acts on another repository | a hookify rule blocks credential reads in Bash; a per-repo rule blocks `gh` on other repositories; `isolation.js` reports the sandbox and deny-read settings at preflight. The settings themselves are a human step (H4, H5) |
| Integration findings are advisory | A high-severity cross-task problem passes the gate | high findings fail the wave gate by default (`integrationGate`) |
| Results are observational | No way to tell whether a loop change helped | a local benchmark (fake `gh`, local CI, fixed scenarios, intervals for the difference between configurations). The comparisons are not run yet: about 1.7M tokens per replay |

Still assumed: a reused process id makes a crashed lock holder look alive (the error names the lock path for a human;
see the [operating manual](OPERATING.md)); `dep-state.js` finds the default branch through `origin/HEAD` only; and
the v24-wave-1 benchmark scenario can only compare configurations, not score correctness, because the loop's own
files contain that wave's answers.

## Sources

- ImpossibleBench (2025): https://lesswrong.com/posts/qJYMbrabcQqCZ7iqm/impossiblebench-measuring-reward-hacking-in-llm-coding-1
- METR, reward hacking (2025): https://metr.org/blog/2025-06-05-recent-reward-hacking ; Q4 2026 update: https://metr.org/blog/2026-11-20-q4-2026-capability-update
- METR, test-passing PRs that would not be merged (2026): https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main
- Same-family bias in rubric judging (2026): https://arxiv.org/abs/2604.06996 ; self-preference across 20 judges (2026): https://arxiv.org/html/2604.22891 ; preference leakage (2025): https://arxiv.org/pdf/2502.01534v2.pdf
- Blind code-review benchmark (2026, vendor-run): https://cross-review.tlelabs.com/benchmark
- MAST, why multi-agent LLM systems fail (2025): https://proceedings.neurips.cc/paper_files/paper/2025/file/b1041e52d3be19f0a9bc491657488e4a-Paper-Datasets_and_Benchmarks_Track.pdf
- Silent commitment to one reading of an ambiguous spec (2026): https://doi.org/10.48550/arxiv.2607.01953
- TDAD, test-impact context for agents (2026): https://arxiv.org/html/2603.17973
- Stacked PRs and CI (2026): https://circleci.com/blog/stacked-prs-and-ci ; optimistic merging: https://docs.trunk.io/merge-queue/optimistic-merging
- Model cascades on SWE-bench Verified (2026): https://arxiv.org/abs/2611.24324
- Run-to-run variance in agent evaluation (2026): https://doi.org/10.48550/arxiv.2602.07150
- Anthropic, multi-agent research system (2025): https://anthropic.com/engineering/multi-agent-research-system ; demystifying evals for agents (2026): https://anthropic.com/engineering/demystifying-evals-for-ai-agents
