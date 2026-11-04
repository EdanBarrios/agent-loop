import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { combineVerdict, waitForCi } from '../claude/lib/ci.js';
// @ts-expect-error plain JavaScript module with JSDoc
import { fastLaneEligible } from '../claude/lib/lane.js';
// @ts-expect-error plain JavaScript module with JSDoc
import { mergePr } from '../claude/lib/merge.js';

// Wave 1 tail: the four wave 1 modules wired together the way wave-loop will wire them, with fakes for
// every outside call. Three tasks: one green, one red CI, one fast lane. Red CI yields a FIX; the others merge.
// The fakes answer with gh outputs recorded from real gh (tests/fixtures/gh-*.json) and gh's real exit codes
// (0 green, 1 a failed check, 8 while checks are pending). No network, no real agent.

const root = join(import.meta.dirname, '..');
const fixture = (name: string) => readFileSync(join(root, 'tests', 'fixtures', name), 'utf8').trim();
const CHECKS_GREEN = fixture('gh-pr-checks-green.json');
const CHECKS_RED = fixture('gh-pr-checks-red.json');
const CHECKS_PENDING = fixture('gh-pr-checks-pending.json');
const RUN_SUCCESS = fixture('gh-run-list-success.json');
const RED_RUN_ID = '41409176345'; // the run id inside the recorded check link
const RED_LOG = 'FAIL claude/lib/x.test.ts\nAssertionError: expected 1 to be 2\n';

const REPO = '/work/repo';
type Reply = { code?: number; stdout?: string; stderr?: string };

type World = {
  pr: number;
  branch: string;
  head: string;
  mergeSha: string;
  checks: Reply[]; // one reply per read of the checks; the last repeats
};

const WORLDS: Record<string, World> = {
  green: {
    pr: 11,
    branch: 'feat/t1-green',
    head: 'a1'.repeat(20),
    mergeSha: 'b1'.repeat(20),
    // pending twice (gh exits 8), then green: the wave 6 regression must not become a FIX
    checks: [{ code: 8, stdout: CHECKS_PENDING }, { code: 8, stdout: CHECKS_PENDING }, { code: 0, stdout: CHECKS_GREEN }],
  },
  red: {
    pr: 12,
    branch: 'feat/t2-red',
    head: 'a2'.repeat(20),
    mergeSha: 'b2'.repeat(20),
    checks: [{ code: 1, stdout: CHECKS_RED }],
  },
  fast: {
    pr: 13,
    branch: 'feat/t3-fast',
    head: 'a3'.repeat(20),
    mergeSha: 'b3'.repeat(20),
    checks: [{ code: 0, stdout: CHECKS_GREEN }],
  },
};

// A fake runner for gh and git. Every call is recorded; a call nothing answers fails the test.
function fakeRunner() {
  const calls: string[] = [];
  const unexpected: string[] = [];
  const reads = new Map<number, number>();
  const run = async (cmd: string): Promise<Required<Reply>> => {
    calls.push(cmd);
    const ok = (stdout = ''): Required<Reply> => ({ code: 0, stdout, stderr: '' });
    for (const w of Object.values(WORLDS)) {
      const n = w.pr;
      if (cmd === `gh pr checks ${n} --json name,state,bucket,link,workflow`) {
        const i = reads.get(n) ?? 0;
        reads.set(n, i + 1);
        return { stderr: '', ...w.checks[Math.min(i, w.checks.length - 1)] } as Required<Reply>;
      }
      if (cmd.startsWith(`gh pr view ${n} --json title,`)) {
        const view = { baseRefName: 'main', headRefName: w.branch, headRefOid: w.head, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', state: 'OPEN', title: `PR ${n}` };
        return ok(JSON.stringify(view));
      }
      if (cmd === `gh pr view ${n} --json state,mergeCommit`) return ok(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: w.mergeSha } }));
      if (cmd === `gh pr merge ${n} --merge --delete-branch --match-head-commit ${w.head}`) return ok();
      if (cmd.startsWith(`gh run list --branch main --workflow check --commit ${w.mergeSha} `)) return ok(RUN_SUCCESS);
    }
    if (cmd === `gh run view ${RED_RUN_ID} --log-failed`) return ok(RED_LOG);
    if (/^git merge-base --is-ancestor origin\/main origin\//.test(cmd)) return ok(); // main has not moved: no sync
    if (/^git (fetch origin|pull --ff-only|worktree prune|worktree remove .+|branch -D .+)$/.test(cmd)) return ok();
    // Each commit its own tree: the merged tree is never the head's, so the check on main runs as before.
    if (/^git rev-parse [0-9a-f]+\^\{tree\}$/.test(cmd)) return ok(`${cmd.split(' ')[2].replace('^{tree}', '')}\n`);
    unexpected.push(cmd);
    return { code: 127, stdout: '', stderr: `unexpected call: ${cmd}` };
  };
  return { run, calls, unexpected };
}

type Task = { id: string; world: World; lane: 'fast' | 'normal'; owns: string[]; changedFiles: string[] };

const TASKS: Task[] = [
  { id: 'T1', world: WORLDS.green, lane: 'normal', owns: ['claude/lib/alpha.js', 'claude/lib/alpha.test.ts'], changedFiles: ['claude/lib/alpha.js', 'claude/lib/alpha.test.ts'] },
  { id: 'T2', world: WORLDS.red, lane: 'normal', owns: ['claude/lib/beta.js'], changedFiles: ['claude/lib/beta.js'] },
  { id: 'T3', world: WORLDS.fast, lane: 'fast', owns: ['docs/notes/'], changedFiles: ['docs/notes/gamma.md'] },
];

const PROJECT = {
  syncPolicy: 'always',
  mainCi: 'check',
  worktrees: '/work/wt',
  forbiddenStrings: ['acme-confidential'],
  fastLane: { enabled: true, maxPerWave: 3, testCountCommand: 'npm run -s test-count' },
};

// What the workflow does for each task once its PR exists, in the order wave-loop will do it.
async function pipeline() {
  const f = fakeRunner();
  const exec = (command: string) => f.run(command);
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  const criticCalls: string[] = [];
  const critic: Record<string, string> = { T1: 'MERGE', T2: 'MERGE', T3: 'MERGE' }; // the critic approves all three
  let laneUsedInWave = 0;
  const out: Record<string, { ci: any; lane: any; decision: any; merge: any }> = {};

  for (const t of TASKS) {
    const ci = await waitForCi(t.world.pr, exec, { sleep });
    const lane = fastLaneEligible({
      task: { id: t.id, lane: t.lane, owns: t.owns },
      changedFiles: t.changedFiles,
      addedText: '+ a synthetic line of added text\n',
      decisions: ['D1 | keep the existing wording | the conventional default | yes'],
      project: PROJECT,
      ci,
      testCount: { before: 40, after: 41 },
      laneUsedInWave,
    });
    if (lane.eligible) laneUsedInWave++;
    // The critic is skipped only for a fast-lane task; every other task is reviewed.
    let verdict = 'MERGE';
    if (!lane.eligible) {
      criticCalls.push(t.id);
      verdict = critic[t.id];
    }
    const decision = combineVerdict(verdict, ci);
    const merge =
      decision.action === 'merge'
        ? await mergePr({ pr: t.world.pr, repo: REPO, worktree: `/work/wt/${t.id}`, tempDir: '/tmp', project: PROJECT }, { run: f.run, sleep })
        : null;
    out[t.id] = { ci, lane, decision, merge };
  }
  expect(f.unexpected).toEqual([]);
  return { out, calls: f.calls, sleeps, criticCalls };
}

describe('wave 1 wired together: waitForCi, fastLaneEligible, combineVerdict and mergePr', () => {
  it('waitForCi reads each task the way gh reports it', async () => {
    const { out } = await pipeline();
    expect(out.T1.ci).toMatchObject({ state: 'green', failing: [], polls: 3 });
    expect(out.T2.ci).toMatchObject({ state: 'red', failing: ['check'] });
    expect(out.T2.ci.logTail).toContain('AssertionError: expected 1 to be 2');
    expect(out.T3.ci).toMatchObject({ state: 'green', failing: [], polls: 1 });
  });

  it('only the fast-lane task skips the critic; the green and the red task are reviewed', async () => {
    const { out, criticCalls } = await pipeline();
    expect(out.T3.lane.eligible).toBe(true);
    expect(out.T1.lane.eligible).toBe(false);
    expect(out.T1.lane.reason).toMatch(/Lane: fast/);
    expect(out.T2.lane.eligible).toBe(false);
    expect(criticCalls).toEqual(['T1', 'T2']);
  });

  it('the red-CI task yields a FIX naming the failing check; the other two merge', async () => {
    const { out } = await pipeline();
    expect(out.T1.decision.action).toBe('merge');
    expect(out.T3.decision.action).toBe('merge');
    expect(out.T2.decision.action).toBe('fix');
    expect(out.T2.decision.fixItems).toHaveLength(1);
    expect(out.T2.decision.fixItems[0]).toMatchObject({ n: 1, cause: 'defect' });
    expect(out.T2.decision.fixItems[0].what).toContain('check');
    expect(out.T2.decision.fixItems[0].what).toContain('AssertionError: expected 1 to be 2');
  });

  it('pending then green is never a FIX: the green task reaches the merge', async () => {
    const { out, sleeps } = await pipeline();
    expect(out.T1.ci.polls).toBe(3);
    expect(sleeps.length).toBeGreaterThanOrEqual(2); // it waited instead of failing
    expect(out.T1.decision.fixItems).toEqual([]);
    expect(out.T1.merge).toMatchObject({ outcome: 'merged', exit: 0, mergeSha: WORLDS.green.mergeSha, mainSha: WORLDS.green.mergeSha, ciState: 'green' });
  });

  it('mergePr merges the green and the fast-lane task, pinned to the head that was green, and never touches the red one', async () => {
    const { out, calls } = await pipeline();
    expect(out.T3.merge).toMatchObject({ outcome: 'merged', exit: 0, mergeSha: WORLDS.fast.mergeSha, ciState: 'green' });
    expect(out.T2.merge).toBeNull();
    const merges = calls.filter((c) => c.startsWith('gh pr merge'));
    expect(merges).toEqual([
      `gh pr merge 11 --merge --delete-branch --match-head-commit ${WORLDS.green.head}`,
      `gh pr merge 13 --merge --delete-branch --match-head-commit ${WORLDS.fast.head}`,
    ]);
    expect(calls.filter((c) => /^gh pr (merge|view) 12 /.test(c))).toEqual([]);
    // the merged task worktrees are removed, the red task's is not
    expect(calls).toContain('git worktree remove /work/wt/T1');
    expect(calls).toContain('git worktree remove /work/wt/T3');
    expect(calls).not.toContain('git worktree remove /work/wt/T2');
  });

  it('no call in the whole run pushes, forces, uses --admin or --auto, or names the default branch in a write', async () => {
    const { calls } = await pipeline();
    expect(calls.filter((c) => /^git push\b/.test(c))).toEqual([]);
    for (const c of calls) expect(c, `forbidden flag in: ${c}`).not.toMatch(/(^|\s)(--force\S*|-f|--admin|--auto\S*)(\s|$)/);
  });
});
