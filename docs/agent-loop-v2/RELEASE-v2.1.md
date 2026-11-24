# agent-loop v2.1 (speed) release record

Date: 2026-11-02. Spec: `docs/agent-loop-v2/2026-11-01-agent-loop-v2-1-tasks.md`. Waves 1 to 3 are merged (tasks 1.1 to 1.4, 1.T, 2.1, 2.2, 2.T, 3.1); this file is the release tail (3.T). Human step ids (H1 to H3) in this file are the v2.1 spec's own checklist, not the ids in `docs/agent-loop-v2/gates.json`.

What changed, in one paragraph: CI is awaited by code (`scripts/wait-ci.js`, `claude/lib/ci.js`) and the merge is a script (`scripts/merge-pr.js`, `claude/lib/merge.js`), each run by one relay agent; pending CI is never a FIX round; an opt-in fast lane (`claude/lib/lane.js`) lets a marked low-risk task skip the critic; workers run `quickCheck` instead of the full check; `scripts/loop-scorecard.py --timings` prints minutes per phase; `spec-review` skips a clean all-fast wave of at most 3 tasks (`claude/lib/review.js`). Every new config field is optional and defaults to v2 behaviour.

## Tag to cut (H1)

- Tag to cut: `v2.1`, on the merge commit of the 3.T pull request (or the later main commit the human has read), then move the stable link: `git -C ~/dev/agent-loop-stable checkout v2.1`. The existing tags are `v1` and `v1.1`.
- The tag is not made by the loop, and the stable link is not moved by the loop: this is human step H1 ("the loop must not change itself mid-run"). `~/dev/agent-loop-stable` stays on `v1.1` until then, so every project keeps running the v1.1 workflow, without the CI relay or the merge script, until H1 is done. Do H1 together with the held items below, because several of them are what lets the new workflow run at all.
- Naming: the spec said this build becomes `v2` if it ships before v2 wave 5 and `v2.1` if v2 ships first. Wave 5 has not run, and the spec's open point 2 (build before or after wave 5) is not answered, so this record uses `v2.1`, which is the name of this spec and of this file. If Edan decides the README, template and `install.sh` of wave 5 should land first, cut `v2.1` after wave 5 instead; if he prefers one `v2` tag after wave 5, cut `v2` then. Either is one tag name; nothing in the code depends on it.

## Check on main

- Command: `npm run check` (syntax check, `python3 -I -m py_compile`, `node scripts/bundle-workflows.js --check`, vitest).
- Required result: exit 0 on main after the 3.T merge. The test in `tests/release-v2-1.test.ts` does not run it (that would recurse); the merge script's main-CI wait and the revert-once rule are the guard, as in every wave.
- Last run in the 3.T worktree before the PR: see the PR body for the exit code and output tail.

## Timings

- Command: `python3 -I scripts/loop-scorecard.py --timings <result.json>...` (reads only, prints a markdown table of minutes per phase per task and per wave, idle time, and the share of wall time spent waiting on CI).
- Table for this build: n/a. The v2.1 waves ran under the frozen v1.1 checkout, which has no `timings` in its results, and the result JSONs of those runs are not committed under `docs/agent-loop-v2/` (the `docs/pilot/*.json` results are pilot waves from October, before the timings fields existed). `tests/release-v2-1.test.ts` fails if a `docs/agent-loop-v2/*result*.json` is added without the table being pasted here, so adding one later forces this section to be filled in.
- First real numbers: the first wave run after H1 (with the v2.1 workflow) writes `result.timings`; run the command above on it and compare with the wave 6 baseline in the speed research (not published) (a 4-task wave at 34 + 51 min; the target is under 40 min).

## README wave 5 (5.1) still needs the new config rows

- Yes, README v2 wave 5 (5.1) still needs the new config rows. `README.md` and `templates/loop.local.json` have no `merger`, `fastLane`, `quickCheck` or `loopScripts` entries as of this build; 3.T does not own those files and did not touch them.
- Rows to add to the README config table and the template at their defaults:
  - `merger`: unset by default (merge through `scripts/merge-pr.js`); `"agent"` restores the v2 merger agent for one release as the rollback.
  - `fastLane`: `{ "enabled": false, "maxPerWave": 3, "denyPaths": [], "testCountCommand": "" }`; off until a human turns it on per project (H2). With no `denyPaths` the workflow's own default deny list applies (workflow files, hookify rules, agent prompts).
  - `quickCheck`: empty by default (workers keep the full local check); a shell command with `{files}` for typecheck, lint and related tests.
  - `loopScripts`: directory holding `wait-ci.js` and `merge-pr.js`; default `<repo>/.claude/scripts`.
- The README text also still describes "a merger syncs, waits for CI, merges", the critic waiting on CI, and `mainCi` as "the merger waits for that run"; 5.1 should describe the relay and the scripts instead.

## Install: the scripts directory is not linked yet

- `install.sh` links `claude/workflows`, `claude/agents`, `scripts/slot.sh` and the hookify rules, but not the scripts directory. The workflow looks for `wait-ci.js` and `merge-pr.js` in `project.loopScripts`, default `<repo>/.claude/scripts`. Until 5.1 changes `install.sh`, a project run without that directory fails the preflight (`merge-pr.js 0 --dry-run`) before any worker starts, with an escalation that says so.
- Fix, either way: 5.1 makes `install.sh` link `scripts/` as `.claude/scripts` (and adds `.claude/scripts` to the per-clone exclude list, since the link must never be committed); or each project sets `loopScripts` to the scripts directory of the stable checkout (`~/dev/agent-loop-stable/scripts`) in its `.claude/loop.local.json`.
- Either way the scripts must come from the stable checkout after H1, not from the live repo, so that the loop being edited is never the loop that merges.

## Held for Edan

None of these was decided by the build; each is a human-only category in the spec (accounts and repo settings, money, permissions) or a fixed decision.

1. **H2, fast lane on or off, and `denyPaths`.** Per project, in `.claude/loop.local.json`: `fastLane.enabled: true`, a `denyPaths` list, and a `testCountCommand` (without one no task is eligible). Default stays off; with it off the critic reviews every PR, as in v2.
2. **H3, runner cost.** Whether the client pays for sharded or larger runners for the pilot repo. Not part of this build; it only matters for the pilot CI spec. The 3.7 min `check` run is the floor of every wave until then.
3. **A Bash allow rule for the merge script.** The relay agent runs `node <scripts>/merge-pr.js <pr> --repo <repo> --worktree <path>` and `node <scripts>/wait-ci.js <pr> --repo <repo>`. The script merges a pull request, so the permission system may block it, and by design the loop then stops and reports the block (no retry another way). To let it run unattended Edan adds a Bash allow rule scoped to those two scripts, for example `Bash(node <scripts>/merge-pr.js:*)` and `Bash(node <scripts>/wait-ci.js:*)`, in his own permission settings. Not added by the loop (the loop never changes permission settings).
4. **Moving the stable tag (H1).** Cut `v2.1` and move `~/dev/agent-loop-stable` to it, as above; also choose the tag name if the wave 5 order changes it.
5. **Spec open point 2.** Build order against v2 wave 5 (this record assumes v2.1 is merged first, as recommended).

## Known issues fixed after release

- Relay agents ran `wait-ci.js` and `merge-pr.js` with the Bash tool's default 120 s timeout and were cut off (seen in pilot waves 8 and 10): the CI wait now runs in `--timeout-min 1.5` chunks, every relay prompt opens with the `timeout=600000` rule and a moved-to-background recovery, and the preflight is retried once on a missing JSON line.
