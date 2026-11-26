import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { machineLoad, makeLock, mergePr, scanWorkflow } from './merge.js';

const root = join(import.meta.dirname, '..', '..');
const fixture = (name: string) => readFileSync(join(root, 'tests', 'fixtures', name), 'utf8').trim();
const fixtureJson = (name: string) => JSON.parse(fixture(name));

// gh outputs recorded from real gh 2.95.0 (PR 24 of this repository); see tests/fixtures/gh-*.json.
const PR_CLEAN = fixtureJson('gh-pr-view-clean.json');
const PR_BEHIND = fixtureJson('gh-pr-view-behind.json');
const PR_CONFLICTING = fixtureJson('gh-pr-view-conflicting.json');
const PR_UNKNOWN = { ...fixtureJson('gh-pr-view-unknown.json'), state: 'OPEN' };
const MERGED_VIEW = fixture('gh-pr-view-merged.json');
const CHECKS_GREEN = fixture('gh-pr-checks-green.json');
const CHECKS_RED = fixture('gh-pr-checks-red.json');
const CHECKS_PENDING = fixture('gh-pr-checks-pending.json');
const RUN_SUCCESS = fixture('gh-run-list-success.json');
const RUN_FAILURE = fixture('gh-run-list-failure.json');
const RUN_CANCELLED = fixture('gh-run-list-cancelled.json');
const RUN_IN_PROGRESS = fixture('gh-run-list-in-progress.json');

const HEAD = PR_CLEAN.headRefOid as string; // the head that was green
const BRANCH = PR_CLEAN.headRefName as string;
const MERGE_SHA = fixtureJson('gh-pr-view-merged.json').mergeCommit.oid as string;
const SYNC_SHA = 'a1'.repeat(20);
const REVERT_HEAD = 'c3'.repeat(20);
const REVERT_MERGE = 'd4'.repeat(20);
const MERGE_TREE = 'e5'.repeat(20);
const HEAD_TREE = 'f6'.repeat(20);

const REPO = '/work/repo';
const WT = '/work/wt/1.2';
const REVERT_WT = '/work/wt/revert-pr-7';

type Reply = { code?: number; stdout?: string; stderr?: string };
type Rule = { when: RegExp | ((cmd: string, cwd: string) => boolean); reply: Reply | Reply[] };
type Call = { cmd: string; cwd: string };

const out = (stdout: string): Reply => ({ code: 0, stdout });
const prView = (pr: object): Reply => out(JSON.stringify(pr));

// A fake runner: the first rule that matches answers; an array of replies is consumed one per call, the last repeats.
// A call no rule answers is recorded as unexpected and fails the test that made it.
function fakeRunner(rules: Rule[]) {
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const seen = new Map<Rule, number>();
  const run = async (cmd: string, o?: { cwd?: string }) => {
    const cwd = o?.cwd ?? '';
    calls.push({ cmd, cwd });
    for (const rule of rules) {
      const hit = typeof rule.when === 'function' ? rule.when(cmd, cwd) : rule.when.test(cmd);
      if (!hit) continue;
      const n = seen.get(rule) ?? 0;
      seen.set(rule, n + 1);
      const reply = Array.isArray(rule.reply) ? rule.reply[Math.min(n, rule.reply.length - 1)] : rule.reply;
      return { code: 0, stdout: '', stderr: '', ...reply };
    }
    unexpected.push(cmd);
    return { code: 127, stdout: '', stderr: `unexpected call: ${cmd}` };
  };
  return { run, calls, unexpected };
}

// The default world: PR 7 is clean and green, main has not moved, the merge works, and the main CI run is green.
function baseRules(): Rule[] {
  return [
    { when: /^gh pr view 7 --json state,mergeCommit$/, reply: out(MERGED_VIEW) },
    { when: /^gh pr view 7 --json .*headRefOid/, reply: prView(PR_CLEAN) },
    { when: /^gh pr checks 7 --json/, reply: out(CHECKS_GREEN) },
    { when: /^gh pr merge 7 /, reply: {} },
    { when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out(RUN_SUCCESS) },
    { when: /^git (fetch origin|pull --ff-only|worktree prune)$/, reply: {} },
    // Trees: by default the merge commit's tree differs from the head's (main moved), so the check on main runs.
    { when: new RegExp(`^git rev-parse ${MERGE_SHA}\\^\\{tree\\}$`), reply: out(`${MERGE_TREE}\n`) },
    { when: /^git rev-parse [0-9a-f]{40}\^\{tree\}$/, reply: out(`${HEAD_TREE}\n`) },
    { when: /^git merge-base --is-ancestor origin\/main /, reply: { code: 0 } },
    { when: /^git worktree remove /, reply: {} },
    { when: /^git branch -D /, reply: {} },
    { when: /^git checkout -- /, reply: {} },
    // sync, in the task worktree
    { when: (c, cwd) => cwd === WT && c === 'git rev-parse --abbrev-ref HEAD', reply: out(`${BRANCH}\n`) },
    { when: (c, cwd) => cwd === WT && c === 'git rev-parse HEAD', reply: out(`${SYNC_SHA}\n`) },
    { when: (c, cwd) => cwd === WT && /^git merge --ff-only /.test(c), reply: {} },
    { when: (c, cwd) => cwd === WT && /^git merge --no-edit /.test(c), reply: {} },
    { when: (c, cwd) => cwd === WT && /^git push origin /.test(c), reply: {} },
    // the revert path
    { when: /^git worktree add .*revert\/pr-7 origin\/main$/, reply: {} },
    { when: (c, cwd) => cwd === REVERT_WT && /^git revert -m 1 --no-commit /.test(c), reply: {} },
    { when: (c, cwd) => cwd === REVERT_WT && /^git commit /.test(c), reply: {} },
    { when: (c, cwd) => cwd === REVERT_WT && c === 'git rev-parse HEAD', reply: out(`${REVERT_HEAD}\n`) },
    { when: (c, cwd) => cwd === REVERT_WT && c === 'git push origin revert/pr-7', reply: {} },
    { when: /^gh pr create /, reply: out('https://github.com/example/repo/pull/8\n') },
    { when: /^gh pr checks 8 --json/, reply: out(CHECKS_GREEN) },
    { when: /^gh pr merge 8 /, reply: {} },
    { when: /^gh pr view 8 --json state,mergeCommit$/, reply: out(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: REVERT_MERGE } })) },
    { when: new RegExp(`^gh run list --branch main --workflow check --commit ${REVERT_MERGE} `), reply: out(RUN_SUCCESS) },
    { when: /^gh run view \d+ --log-failed$/, reply: out('FAIL claude/lib/x.test.ts\nAssertionError: expected 1 to be 2\n') },
  ];
}

const PROJECT = { syncPolicy: 'always', mainCi: 'check', install: 'npm ci', check: 'npm run check', checkMutates: [] as string[], worktrees: '/work/wt', maxBuilders: 2 };

type Go = { project?: Record<string, unknown>; worktree?: string | null; dryRun?: boolean; deferMain?: boolean; verifyMain?: string; mainWaitMs?: number };

const everyCall: string[] = [];

async function go(rules: Rule[] = [], o: Go = {}) {
  const f = fakeRunner([...rules, ...baseRules()]);
  const sleeps: number[] = [];
  const result = await mergePr(
    { pr: 7, repo: REPO, worktree: o.worktree === null ? undefined : (o.worktree ?? WT), dryRun: o.dryRun ?? false, deferMain: o.deferMain, verifyMain: o.verifyMain, mainWaitMs: o.mainWaitMs, tempDir: '/tmp', project: { ...PROJECT, ...o.project } },
    { run: f.run, sleep: async (ms: number) => void sleeps.push(ms) },
  );
  const cmds = f.calls.map((c) => c.cmd);
  everyCall.push(...cmds);
  expect(f.unexpected).toEqual([]);
  assertSafe(cmds);
  return { result, cmds, calls: f.calls, sleeps };
}

// The rules every recorded call must obey, whatever the scenario.
function hookifyPatterns(): RegExp[] {
  const dir = join(root, 'claude');
  const patterns: RegExp[] = [];
  for (const name of readdirSync(dir).filter((n) => /^hookify\..*\.local\.md$/.test(n))) {
    const text = readFileSync(join(dir, name), 'utf8');
    if (!/^event:\s*bash\s*$/m.test(text)) continue;
    const m = text.match(/^pattern:\s*(.+)$/m);
    if (m) patterns.push(new RegExp(m[1]));
  }
  return patterns;
}

const FORBIDDEN_FLAG = /(^|\s)(--force\S*|-f|--admin|--auto\S*)(\s|$)/;

function assertSafe(cmds: string[]) {
  const hooks = hookifyPatterns();
  expect(hooks.length).toBeGreaterThanOrEqual(2);
  for (const cmd of cmds) {
    expect(cmd, `forbidden flag in: ${cmd}`).not.toMatch(FORBIDDEN_FLAG);
    for (const h of hooks) expect(cmd, `hookify ${h} would block: ${cmd}`).not.toMatch(h);
    if (/^git push\b/.test(cmd)) {
      expect(cmd, `push target in: ${cmd}`).toMatch(/^git push origin (HEAD:)?(feat\/[\w./-]+|revert\/pr-\d+)$/);
      expect(cmd).not.toMatch(/\bmain\b/);
    }
    if (/^gh pr merge\b/.test(cmd)) expect(cmd, `no head pin in: ${cmd}`).toMatch(/ --match-head-commit [0-9a-f]{40}$/);
  }
}

const index = (cmds: string[], re: RegExp) => cmds.findIndex((c) => re.test(c));
const count = (cmds: string[], re: RegExp) => cmds.filter((c) => re.test(c)).length;
const MERGE_CMD = `gh pr merge 7 --merge --delete-branch --match-head-commit ${HEAD}`;

describe('mergePr: the plain merge', () => {
  it('merged and main green: exit 0, one merge call pinned to the green head, nothing pushed', async () => {
    const { result, cmds } = await go();
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mergeSha: MERGE_SHA, mainSha: MERGE_SHA, ciState: 'green', failing: [], conflictFiles: [] });
    expect(cmds).toContain(MERGE_CMD);
    expect(count(cmds, /^git push/)).toBe(0);
    expect(index(cmds, /^gh pr checks 7 /)).toBeLessThan(index(cmds, /^gh pr merge 7 /));
    expect(index(cmds, /^gh pr merge 7 /)).toBeLessThan(index(cmds, /^gh run list /));
    expect(typeof result.ciWaitMs).toBe('number');
    expect(typeof result.mergeMs).toBe('number');
    expect(typeof result.mainCheckMs).toBe('number');
  });

  it('removes the task worktree and local branch after the merge when --worktree is given, and only then', async () => {
    const withWt = await go();
    expect(withWt.cmds).toContain(`git worktree remove ${WT}`);
    expect(withWt.cmds).toContain(`git branch -D ${BRANCH}`);
    expect(index(withWt.cmds, /^gh pr merge 7 /)).toBeLessThan(index(withWt.cmds, /^git worktree remove /));
    const without = await go([], { worktree: null });
    expect(count(without.cmds, /^git worktree remove /)).toBe(0);
    expect(count(without.cmds, /^git branch -D /)).toBe(0);
  });

  it('CI red: exit 2, the failing check and log tail are reported, no merge call is made', async () => {
    const { result, cmds } = await go([{ when: /^gh pr checks 7 --json/, reply: { code: 1, stdout: CHECKS_RED } }]);
    expect(result).toMatchObject({ outcome: 'refused', exit: 2, ciState: 'red', failing: ['check'], mergeSha: null });
    expect(result.logTail).toContain('AssertionError');
    expect(count(cmds, /^gh pr merge/)).toBe(0);
  });

  it('CI pending until the timeout: exit 2 with ciState pending, no merge call', async () => {
    const { result, cmds, sleeps } = await go([{ when: /^gh pr checks 7 --json/, reply: { code: 8, stdout: CHECKS_PENDING } }]);
    expect(result).toMatchObject({ outcome: 'refused', exit: 2, ciState: 'pending' });
    expect(sleeps.length).toBeGreaterThan(10);
    expect(count(cmds, /^gh pr merge/)).toBe(0);
  });

  it('a pull request that is not open is refused before anything else happens', async () => {
    const { result, cmds } = await go([{ when: /^gh pr view 7 --json .*headRefOid/, reply: prView({ ...PR_CLEAN, state: 'MERGED' }) }]);
    expect(result).toMatchObject({ outcome: 'refused', exit: 2 });
    expect(result.message).toMatch(/MERGED/);
    expect(count(cmds, /^gh pr (checks|merge)/)).toBe(0);
  });

  it('a head branch that is the base branch is an error, never touched', async () => {
    const { result, cmds } = await go([{ when: /^gh pr view 7 --json .*headRefOid/, reply: prView({ ...PR_CLEAN, headRefName: 'main' }) }]);
    expect(result).toMatchObject({ outcome: 'error', exit: 4 });
    expect(count(cmds, /^gh pr merge|^git push/)).toBe(0);
  });
});

describe('mergePr: when main is merged into the branch', () => {
  const movedMain: Rule[] = [
    { when: /^git merge-base --is-ancestor origin\/main /, reply: { code: 1 } },
    // the second read of the pull request (after the push) shows the new head
    { when: /^gh pr view 7 --json .*headRefOid/, reply: [prView(PR_CLEAN), prView({ ...PR_CLEAN, headRefOid: SYNC_SHA })] },
  ];

  it('syncPolicy always with main moved: merges main into the branch, pushes the head branch, waits for CI on the new head, merges that head', async () => {
    const { result, calls, cmds } = await go(movedMain);
    expect(result).toMatchObject({ outcome: 'merged', exit: 0 });
    const merge = calls.find((c) => /^git merge --no-edit /.test(c.cmd))!;
    expect(merge.cwd).toBe(WT);
    expect(merge.cmd).toContain('Sync branch with upstream before merge');
    expect(merge.cmd).toContain('Co-Authored-By: Claude <noreply@anthropic.com>');
    expect(merge.cmd).toMatch(/ origin\/main$/);
    expect(calls.find((c) => c.cmd === `git push origin HEAD:${BRANCH}`)?.cwd).toBe(WT);
    expect(index(cmds, /^git merge-base/)).toBeLessThan(index(cmds, /^git merge --no-edit/));
    expect(index(cmds, /^git merge --no-edit/)).toBeLessThan(index(cmds, /^git push/));
    expect(index(cmds, /^git push/)).toBeLessThan(index(cmds, /^gh pr checks 7/));
    expect(cmds).toContain(`gh pr merge 7 --merge --delete-branch --match-head-commit ${SYNC_SHA}`);
  });

  it('syncPolicy always with main not moved: no sync', async () => {
    const { cmds } = await go();
    expect(count(cmds, /^git merge --no-edit|^git push/)).toBe(0);
  });

  it('without --worktree the sync runs in a temporary detached worktree that is removed afterwards', async () => {
    const tmp = '/tmp/merge-pr-7-sync';
    const rules: Rule[] = [
      ...movedMain,
      { when: /^git worktree add --detach /, reply: {} },
      { when: (c, cwd) => cwd === tmp && c === 'git rev-parse HEAD', reply: out(`${SYNC_SHA}\n`) },
      { when: (c, cwd) => cwd === tmp && /^git (merge|push) /.test(c), reply: {} },
    ];
    const { result, cmds, calls } = await go(rules, { worktree: null });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0 });
    expect(cmds).toContain(`git worktree add --detach ${tmp} origin/${BRANCH}`);
    expect(calls.find((c) => /^git push/.test(c.cmd))?.cwd).toBe(tmp);
    expect(cmds).toContain(`git worktree remove ${tmp}`);
  });

  it('a sync conflict: exit 2, the conflict files are listed, the merge is aborted, nothing is pushed', async () => {
    const rules: Rule[] = [
      ...movedMain,
      { when: (c, cwd) => cwd === WT && /^git merge --no-edit /.test(c), reply: { code: 1, stdout: 'CONFLICT (content): Merge conflict in a.js\n' } },
      { when: (c, cwd) => cwd === WT && c === 'git diff --name-only --diff-filter=U', reply: out('a.js\nsrc/b.js\n') },
      { when: (c, cwd) => cwd === WT && c === 'git merge --abort', reply: {} },
    ];
    const { result, cmds } = await go(rules);
    expect(result).toMatchObject({ outcome: 'refused', exit: 2, conflictFiles: ['a.js', 'src/b.js'] });
    expect(cmds).toContain('git merge --abort');
    expect(count(cmds, /^git push/)).toBe(0);
    expect(count(cmds, /^gh pr (checks|merge)/)).toBe(0);
  });

  it('a worktree on another branch than the pull request head is an error', async () => {
    const rules: Rule[] = [...movedMain, { when: (c, cwd) => cwd === WT && c === 'git rev-parse --abbrev-ref HEAD', reply: out('feat/other\n') }];
    const { result, cmds } = await go(rules);
    expect(result).toMatchObject({ outcome: 'error', exit: 4 });
    expect(count(cmds, /^git merge --no-edit|^git push|^gh pr merge/)).toBe(0);
  });
});

describe('mergePr: syncPolicy conflict', () => {
  const policy = { project: { syncPolicy: 'conflict' } };

  it('a clean PR that is behind main skips the sync (BEHIND is never relied on)', async () => {
    const { result, cmds } = await go([{ when: /^gh pr view 7 --json .*headRefOid/, reply: prView(PR_BEHIND) }], policy);
    expect(result).toMatchObject({ outcome: 'merged', exit: 0 });
    expect(count(cmds, /^git merge --no-edit|^git push|^git merge-base/)).toBe(0);
    expect(cmds).toContain(MERGE_CMD);
  });

  it.each([
    ['mergeable CONFLICTING', { ...PR_CONFLICTING, mergeStateStatus: 'BLOCKED' }],
    ['mergeStateStatus DIRTY', { ...PR_CONFLICTING, mergeable: 'MERGEABLE' }],
  ])('%s syncs', async (_name, pr) => {
    const { result, cmds } = await go(
      [{ when: /^gh pr view 7 --json .*headRefOid/, reply: [prView(pr), prView({ ...pr, headRefOid: SYNC_SHA, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })] }],
      policy,
    );
    expect(result).toMatchObject({ outcome: 'merged', exit: 0 });
    expect(count(cmds, /^git merge --no-edit/)).toBe(1);
    expect(cmds).toContain(`git push origin HEAD:${BRANCH}`);
  });

  it('mergeable UNKNOWN twice, then MERGEABLE on the third read: no sync, two 10 s waits', async () => {
    const { result, cmds, sleeps } = await go(
      [{ when: /^gh pr view 7 --json .*headRefOid/, reply: [prView(PR_UNKNOWN), prView(PR_UNKNOWN), prView(PR_CLEAN)] }],
      policy,
    );
    expect(result).toMatchObject({ outcome: 'merged', exit: 0 });
    expect(sleeps.slice(0, 2)).toEqual([10000, 10000]);
    expect(count(cmds, /^gh pr view 7 --json .*headRefOid/)).toBe(3);
    expect(count(cmds, /^git merge --no-edit|^git push/)).toBe(0);
  });

  it('mergeable still UNKNOWN after three re-reads syncs', async () => {
    const { cmds, sleeps } = await go(
      [{ when: /^gh pr view 7 --json .*headRefOid/, reply: [prView(PR_UNKNOWN), prView(PR_UNKNOWN), prView(PR_UNKNOWN), prView(PR_UNKNOWN), prView({ ...PR_CLEAN, headRefOid: SYNC_SHA })] }],
      policy,
    );
    expect(sleeps.slice(0, 3)).toEqual([10000, 10000, 10000]);
    expect(count(cmds, /^git merge --no-edit/)).toBe(1);
  });
});

describe('mergePr: the merge call', () => {
  it('gh pr merge refused: exit 2 with the message, one attempt, no other way tried', async () => {
    const msg = 'X Pull request is not mergeable: the base branch policy prohibits the merge.';
    const { result, cmds } = await go([{ when: /^gh pr merge 7 /, reply: { code: 1, stderr: `${msg}\n` } }, { when: /^gh pr view 7 --json state,mergeCommit$/, reply: out('{"state":"OPEN","mergeCommit":null}') }]);
    expect(result).toMatchObject({ outcome: 'refused', exit: 2 });
    expect(result.message).toContain(msg);
    expect(count(cmds, /^gh pr merge/)).toBe(1);
    expect(count(cmds, /^gh run list|^git revert|^gh pr create/)).toBe(0);
  });

  it('gh pr merge exits 1 only because the branch is checked out in a worktree, and the PR state is MERGED: exit 0', async () => {
    const { result, cmds } = await go([{ when: /^gh pr merge 7 /, reply: { code: 1, stderr: "failed to delete local branch feat/1.3-lane-check: used by worktree at '/work/wt/1.2'\n" } }]);
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mergeSha: MERGE_SHA });
    expect(count(cmds, /^gh pr merge/)).toBe(1);
    expect(cmds).toContain('gh pr view 7 --json state,mergeCommit');
  });
});

describe('mergePr: main red', () => {
  const mainRed: Rule = { when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out(RUN_FAILURE) };

  it('opens one revert PR, awaits its CI, merges it pinned to its head, main green again: exit 3', async () => {
    const { result, cmds, calls } = await go([mainRed]);
    expect(result).toMatchObject({ outcome: 'reverted', exit: 3, mergeSha: MERGE_SHA, mainSha: REVERT_MERGE, revertPrUrl: 'https://github.com/example/repo/pull/8' });
    const add = cmds.find((c) => /^git worktree add /.test(c))!;
    expect(add).toBe(`git worktree add ${REVERT_WT} -b revert/pr-7 origin/main`);
    expect(cmds).toContain(`git revert -m 1 --no-commit ${MERGE_SHA}`);
    expect(calls.find((c) => /^git commit /.test(c.cmd))?.cwd).toBe(REVERT_WT);
    expect(cmds).toContain('git push origin revert/pr-7');
    const create = cmds.find((c) => /^gh pr create /.test(c))!;
    expect(create).toContain('--base main --head revert/pr-7');
    expect(create).toContain('AssertionError');
    expect(index(cmds, /^gh pr create/)).toBeLessThan(index(cmds, /^gh pr checks 8/));
    expect(index(cmds, /^gh pr checks 8/)).toBeLessThan(index(cmds, /^gh pr merge 8/));
    expect(cmds).toContain(`gh pr merge 8 --merge --delete-branch --match-head-commit ${REVERT_HEAD}`);
    expect(index(cmds, /^gh pr merge 8/)).toBeLessThan(index(cmds, new RegExp(`--commit ${REVERT_MERGE}`)));
    expect(cmds).toContain(`git worktree remove ${REVERT_WT}`);
    expect(cmds).toContain('git branch -D revert/pr-7');
  });

  it('the revert PR red: exit 4, the revert PR is reported and not merged, no second revert', async () => {
    const { result, cmds } = await go([mainRed, { when: /^gh pr checks 8 --json/, reply: { code: 1, stdout: CHECKS_RED } }]);
    expect(result).toMatchObject({ outcome: 'error', exit: 4, revertPrUrl: 'https://github.com/example/repo/pull/8', mergeSha: MERGE_SHA });
    expect(count(cmds, /^gh pr merge 8/)).toBe(0);
    expect(count(cmds, /^git revert/)).toBe(1);
    expect(count(cmds, /^gh pr create/)).toBe(1);
  });

  it('main still red after the revert: exit 4, no second revert', async () => {
    const { result, cmds } = await go([mainRed, { when: new RegExp(`^gh run list --branch main --workflow check --commit ${REVERT_MERGE} `), reply: out(RUN_FAILURE) }]);
    expect(result).toMatchObject({ outcome: 'error', exit: 4, revertPrUrl: 'https://github.com/example/repo/pull/8' });
    expect(result.message).toMatch(/no second revert/i);
    expect(count(cmds, /^git revert/)).toBe(1);
    expect(count(cmds, /^gh pr create/)).toBe(1);
  });

  it('a revert that does not apply cleanly: exit 4, the revert is aborted, nothing is pushed', async () => {
    const { result, cmds } = await go([
      mainRed,
      { when: (c, cwd) => cwd === REVERT_WT && /^git revert -m 1 --no-commit /.test(c), reply: { code: 1, stderr: 'error: could not revert\n' } },
      { when: (c, cwd) => cwd === REVERT_WT && c === 'git revert --abort', reply: {} },
    ]);
    expect(result).toMatchObject({ outcome: 'error', exit: 4, mergeSha: MERGE_SHA });
    expect(cmds).toContain('git revert --abort');
    expect(count(cmds, /^git push|^gh pr create/)).toBe(0);
  });

  it('a main CI run that was cancelled is not evidence of a red main: exit 4, no revert', async () => {
    const { result, cmds } = await go([{ when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out(RUN_CANCELLED) }]);
    expect(result).toMatchObject({ outcome: 'error', exit: 4, mergeSha: MERGE_SHA });
    expect(count(cmds, /^git revert|^git worktree add|^gh pr create/)).toBe(0);
  });

  it('a main CI run that never finishes: exit 4, no revert', async () => {
    const { result, cmds } = await go([{ when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out(RUN_IN_PROGRESS) }]);
    expect(result).toMatchObject({ outcome: 'error', exit: 4, mergeSha: MERGE_SHA });
    expect(count(cmds, /^git revert|^gh pr create/)).toBe(0);
  });

  it('a main CI run that never appears: exit 4, no revert', async () => {
    const { result, cmds, sleeps } = await go([{ when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out('[]') }]);
    expect(result).toMatchObject({ outcome: 'error', exit: 4 });
    expect(sleeps.length).toBeGreaterThan(0);
    expect(count(cmds, /^git revert|^gh pr create/)).toBe(0);
  });
});

describe('mergePr: mainCi empty runs the local check', () => {
  const local = { project: { mainCi: '' } };
  const SLOT = `SLOT_MAX=2 ${REPO}/.claude/slot.sh sh -c 'npm ci && npm run check'`;
  const repoHead = (...shas: string[]): Rule => ({ when: (c, cwd) => cwd === REPO && c === 'git rev-parse HEAD', reply: shas.map((s) => out(`${s}\n`)) });

  it('pulls the default branch, runs install and check once through slot.sh, restores checkMutates files', async () => {
    const { result, cmds, calls } = await go([repoHead(MERGE_SHA), { when: /slot\.sh/, reply: out('ok\n') }], { project: { mainCi: '', checkMutates: ['ratchet.json'] } });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mergeSha: MERGE_SHA, mainSha: MERGE_SHA });
    expect(cmds).toContain(SLOT);
    expect(calls.find((c) => c.cmd === SLOT)?.cwd).toBe(REPO);
    expect(count(cmds, /slot\.sh/)).toBe(1);
    expect(count(cmds, /^gh run list/)).toBe(0);
    expect(index(cmds, /^git pull --ff-only$/)).toBeLessThan(index(cmds, /slot\.sh/));
    expect(index(cmds, /slot\.sh/)).toBeLessThan(index(cmds, /^git checkout -- ratchet\.json$/));
  }, 120_000);

  it('a red local check reverts once; the check is run again on the revert merge and passes: exit 3', async () => {
    const { result, cmds } = await go(
      [
        repoHead(MERGE_SHA, REVERT_MERGE),
        { when: /slot\.sh/, reply: [{ code: 1, stdout: 'FAIL ratchet\n' }, { code: 0 }] },
      ],
      local,
    );
    expect(result).toMatchObject({ outcome: 'reverted', exit: 3, mainSha: REVERT_MERGE });
    expect(count(cmds, /slot\.sh/)).toBe(2);
    expect(cmds.find((c) => /^gh pr create/.test(c))).toContain('FAIL ratchet');
  });

  it('a red local check that stays red after the revert: exit 4, no second revert', async () => {
    const { result, cmds } = await go([repoHead(MERGE_SHA, REVERT_MERGE), { when: /slot\.sh/, reply: { code: 1, stdout: 'FAIL again\n' } }], local);
    expect(result).toMatchObject({ outcome: 'error', exit: 4 });
    expect(count(cmds, /^git revert/)).toBe(1);
  });
});

describe('mergePr: --dry-run', () => {
  it('runs the read-only steps, makes no write call, and lists the calls it would make', async () => {
    const { result, cmds } = await go([], { dryRun: true });
    expect(result).toMatchObject({ outcome: 'dry-run', exit: 0 });
    expect(result.wouldRun).toContain(MERGE_CMD);
    // the runner saw read-only calls only; every write was kept back and listed
    expect(cmds.filter((c) => !/^(gh pr (view|checks)|gh run (list|view)|git (fetch origin|merge-base|rev-parse|diff --name-only))\b/.test(c))).toEqual([]);
    expect(result.wouldRun).toEqual([MERGE_CMD]);
  });

  it('plans the sync without running it when main moved', async () => {
    const { result } = await go([{ when: /^git merge-base --is-ancestor origin\/main /, reply: { code: 1 } }], { dryRun: true });
    expect(result.outcome).toBe('dry-run');
    expect(result.wouldRun.some((c: string) => /^git merge --no-edit/.test(c))).toBe(true);
    expect(result.wouldRun.some((c: string) => /^git push origin HEAD:/.test(c))).toBe(true);
  });
});

// Loop perf change 3, opt-in since 2.5 (task 3.2): no check on main when the merged tree is the tree CI checked, and only
// with project.reuseTreeCi and a main CI workflow file that shows no event-dependent behaviour. Otherwise the caller can
// defer the wait for main's run (--defer-main) and watch it outside its merge lock (--verify-main).
const PLAIN_WORKFLOW = `name: check
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run check
`;
const WORKFLOW_DIR = '.github/workflows/';
const treeOf = (text: string): Rule[] => [
  { when: (c) => c === `git ls-tree --name-only ${MERGE_SHA} ${WORKFLOW_DIR}`, reply: out(`${WORKFLOW_DIR}check.yml\n`) },
  { when: (c) => c === `git show ${MERGE_SHA}:${WORKFLOW_DIR}check.yml`, reply: out(text) },
];
const REUSE = { reuseTreeCi: true };
const sameTreeRule: Rule = { when: new RegExp(`^git rev-parse ${MERGE_SHA}\\^\\{tree\\}$`), reply: out(`${HEAD_TREE}\n`) };

describe('mergePr: the check on main is skipped when nothing new can be learned', () => {
  const sameTree = sameTreeRule;

  it('with reuseTreeCi and a plain workflow, a merged tree equal to the green head tree skips: mainCheck skipped:unchanged, no main run is read', async () => {
    const { result, cmds } = await go([sameTree, ...treeOf(PLAIN_WORKFLOW)], { project: REUSE });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mergeSha: MERGE_SHA, mainSha: MERGE_SHA, mainCheck: 'skipped:unchanged' });
    expect(result.treeReuse).toMatchObject({ allowed: true });
    expect(cmds).toContain(`git rev-parse ${MERGE_SHA}^{tree}`);
    expect(cmds).toContain(`git rev-parse ${HEAD}^{tree}`);
    expect(cmds).toContain(`git ls-tree --name-only ${MERGE_SHA} ${WORKFLOW_DIR}`);
    expect(cmds).toContain(`git show ${MERGE_SHA}:${WORKFLOW_DIR}check.yml`);
    expect(count(cmds, /^gh run (list|view)/)).toBe(0);
    expect(count(cmds, /^git revert|^gh pr create/)).toBe(0);
    expect(index(cmds, /^gh pr merge 7 /)).toBeLessThan(index(cmds, /\^\{tree\}$/));
  });

  it('is off by default: an equal tree still runs the check on main (invariant 4 without exception)', async () => {
    const { result, cmds } = await go([sameTree, ...treeOf(PLAIN_WORKFLOW)]);
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mainCheck: 'green' });
    expect(result.treeReuse.allowed).toBe(false);
    expect(result.treeReuse.reason).toMatch(/reuseTreeCi/);
    expect(count(cmds, /^gh run list/)).toBe(1);
    expect(count(cmds, /^git ls-tree|^git show/)).toBe(0);
  });

  it('reuseTreeCi false is the same as the default', async () => {
    const { result } = await go([sameTree, ...treeOf(PLAIN_WORKFLOW)], { project: { reuseTreeCi: false } });
    expect(result).toMatchObject({ mainCheck: 'green' });
    expect(result.treeReuse.allowed).toBe(false);
  });

  it('with mainCi empty there is no workflow file, so the local check runs even when the tree is equal', async () => {
    const { result, cmds } = await go([sameTree, { when: (c, cwd) => cwd === REPO && c === 'git rev-parse HEAD', reply: out(`${MERGE_SHA}\n`) }, { when: /slot\.sh/, reply: out('ok\n') }], { project: { ...REUSE, mainCi: '' } });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mainCheck: 'green' });
    expect(result.treeReuse.allowed).toBe(false);
    expect(result.treeReuse.reason).toMatch(/mainCi/);
    expect(result.message).toMatch(/mainCi/);
    expect(count(cmds, /slot\.sh/)).toBe(1);
  });

  it('a tree that cannot be read is not proof: the check on main runs', async () => {
    const { result, cmds } = await go([{ when: new RegExp(`^git rev-parse ${MERGE_SHA}\\^\\{tree\\}$`), reply: { code: 128, stderr: 'fatal: bad object' } }, ...treeOf(PLAIN_WORKFLOW)], { project: REUSE });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mainCheck: 'green' });
    expect(count(cmds, /^gh run list/)).toBe(1);
  });

  it('main moved (the trees differ): the check on main runs as before and mainCheck is green', async () => {
    const { result, cmds } = await go([...treeOf(PLAIN_WORKFLOW)], { project: REUSE });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mainSha: MERGE_SHA, mainCheck: 'green' });
    expect(result.treeReuse.allowed).toBe(false);
    expect(count(cmds, /^gh run list/)).toBe(1);
  });

  it('keeps every field the wave loop reads', async () => {
    const { result } = await go([sameTree]);
    for (const k of ['outcome', 'exit', 'mergeSha', 'mainSha', 'ciState', 'failing', 'conflictFiles', 'revertPrUrl', 'message', 'logTail', 'ciWaitMs', 'mergeMs', 'mainCheckMs', 'revertMs', 'elapsedMs', 'treeReuse']) {
      expect(result, k).toHaveProperty(k);
    }
  });
});

describe('mergePr: tree reuse needs the main CI workflow to show no event-dependent behaviour', () => {
  const sameTree = sameTreeRule;
  const variants: Array<[string, (w: string) => string]> = [
    ['github.event_name', (w) => w.replace('npm ci &&', 'echo ${{ github.event_name }} && npm ci &&')],
    ['github.event.', (w) => w.replace('npm ci &&', 'echo ${{ github.event.pull_request.title }} && npm ci &&')],
    ['github.ref', (w) => w.replace('npm ci &&', 'echo ${{ github.ref }} && npm ci &&')],
    ['secrets.', (w) => w.replace('npm ci &&', 'echo ${{ secrets.TOKEN }} && npm ci &&')],
    ['vars.', (w) => w.replace('npm ci &&', 'echo ${{ vars.MODE }} && npm ci &&')],
    ['schedule:', (w) => w.replace('  pull_request:\n', '  pull_request:\n  schedule:\n    - cron: "0 3 * * *"\n')],
    ['no pull_request', (w) => w.replace('  pull_request:\n', '')],
    ['no push', (w) => w.replace('  push:\n    branches: [main]\n', '')],
    ['paths on push', (w) => w.replace('    branches: [main]\n', '    branches: [main]\n    paths: ["src/**"]\n')],
    ['paths on pull_request', (w) => w.replace('  pull_request:\n', '  pull_request:\n    paths:\n      - "src/**"\n')],
    ['paths-ignore on push', (w) => w.replace('    branches: [main]\n', '    branches: [main]\n    paths-ignore: ["docs/**"]\n')],
    ['paths-ignore on pull_request', (w) => w.replace('  pull_request:\n', '  pull_request:\n    paths-ignore: ["docs/**"]\n')],
    ['branches-ignore on push', (w) => w.replace('    branches: [main]\n', '    branches-ignore: ["wip/**"]\n')],
    ['branches-ignore on pull_request', (w) => w.replace('  pull_request:\n', '  pull_request:\n    branches-ignore: ["wip/**"]\n')],
    ['tags on push', (w) => w.replace('    branches: [main]\n', '    branches: [main]\n    tags: ["v*"]\n')],
    ['tags on pull_request', (w) => w.replace('  pull_request:\n', '  pull_request:\n    tags: ["v*"]\n')],
    ['branches on pull_request', (w) => w.replace('  pull_request:\n', '  pull_request:\n    branches: [main]\n')],
    ['push branches that do not list the default branch', (w) => w.replace('[main]', '[release]')],
    ['a job-level if', (w) => w.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    if: always()\n')],
    ['a job-level if as the first key of the job', (w) => w.replace('  check:\n', '  check:\n    if: always()\n')],
    ['a job-level if as the first key of a second job', (w) => `${w}  deploy:\n    if: always()\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo done\n`],
  ];

  it.each(variants)('%s prevents the skip: the check on main runs and message names the reason', async (_name, edit) => {
    const text = edit(PLAIN_WORKFLOW);
    expect(text).not.toBe(PLAIN_WORKFLOW);
    const { result, cmds } = await go([sameTree, ...treeOf(text)], { project: REUSE });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mainCheck: 'green' });
    expect(result.treeReuse.allowed).toBe(false);
    expect(result.treeReuse.reason).toMatch(/\S/);
    expect(result.message).toContain(result.treeReuse.reason);
    expect(count(cmds, /^gh run list/)).toBe(1);
  });

  it('a plain workflow written in other legal forms still allows the skip', async () => {
    const forms = [
      'name: check\non: [push, pull_request]\njobs:\n  check:\n    runs-on: x\n    steps:\n      - run: npm test\n',
      'name: check\non:\n  - push\n  - pull_request\njobs:\n  check:\n    runs-on: x\n    steps:\n      - run: npm test\n',
      'name: check # the main check\non:\n  push:\n    branches:\n      - main\n  pull_request:\n  workflow_dispatch:\njobs:\n  check:\n    runs-on: x\n    steps:\n      - if: runner.os == \'Linux\'\n        run: npm test\n',
      'name: check\n"on":\n  push:\n  pull_request:\njobs:\n  check:\n    runs-on: x\n    steps:\n      - run: npm test\n',
    ];
    for (const text of forms) {
      const { result } = await go([sameTree, ...treeOf(text)], { project: REUSE });
      expect(result.treeReuse, text).toMatchObject({ allowed: true });
      expect(result.mainCheck, text).toBe('skipped:unchanged');
    }
  });

  it('a missing workflow file prevents the skip (no workflow directory, no matching file, or a file that cannot be read)', async () => {
    const lsTree = (c: string) => c === `git ls-tree --name-only ${MERGE_SHA} ${WORKFLOW_DIR}`;
    const cases: Rule[][] = [
      [{ when: lsTree, reply: { code: 128, stderr: 'fatal: not a tree object' } }],
      [{ when: lsTree, reply: out('') }],
      [{ when: lsTree, reply: out(`${WORKFLOW_DIR}release.yml\n`) }, { when: (c) => c === `git show ${MERGE_SHA}:${WORKFLOW_DIR}release.yml`, reply: out('name: release\non: push\n') }],
      [{ when: lsTree, reply: out(`${WORKFLOW_DIR}check.yml\n`) }, { when: (c) => c.startsWith('git show '), reply: { code: 128, stderr: 'fatal: path does not exist' } }],
    ];
    for (const rules of cases) {
      const { result, cmds } = await go([sameTree, ...rules], { project: REUSE });
      expect(result, JSON.stringify(rules.map((r) => r.reply))).toMatchObject({ outcome: 'merged', exit: 0, mainCheck: 'green' });
      expect(result.treeReuse.allowed).toBe(false);
      expect(result.message).toContain(result.treeReuse.reason);
      expect(count(cmds, /^gh run list/)).toBe(1);
    }
  });

  it('finds the workflow by .yaml, by its top-level name, and refuses two files with that name', async () => {
    const lsTree = (c: string) => c === `git ls-tree --name-only ${MERGE_SHA} ${WORKFLOW_DIR}`;
    const show = (name: string, text: string): Rule => ({ when: (c) => c === `git show ${MERGE_SHA}:${WORKFLOW_DIR}${name}`, reply: out(text) });
    const byYaml = await go([sameTree, { when: lsTree, reply: out(`${WORKFLOW_DIR}check.yaml\n`) }, show('check.yaml', PLAIN_WORKFLOW)], { project: REUSE });
    expect(byYaml.result.treeReuse.allowed).toBe(true);
    const named = PLAIN_WORKFLOW.replace('name: check', 'name: "Main CI"');
    const mainRun: Rule = { when: new RegExp(`^gh run list --branch main --workflow 'Main CI' --commit ${MERGE_SHA} `), reply: out(RUN_SUCCESS) };
    const byName = await go([sameTree, mainRun, { when: lsTree, reply: out(`${WORKFLOW_DIR}ci.yml\n${WORKFLOW_DIR}release.yml\n`) }, show('ci.yml', named), show('release.yml', 'name: release\non: push\n')], { project: { ...REUSE, mainCi: 'Main CI' } });
    expect(byName.result.treeReuse.allowed).toBe(true);
    const twice = await go([sameTree, mainRun, { when: lsTree, reply: out(`${WORKFLOW_DIR}a.yml\n${WORKFLOW_DIR}b.yml\n`) }, show('a.yml', named), show('b.yml', named)], { project: { ...REUSE, mainCi: 'Main CI' } });
    expect(twice.result.treeReuse.allowed).toBe(false);
    expect(twice.result.mainCheck).toBe('green');
    expect(twice.result.message).toContain(twice.result.treeReuse.reason);
  });

  it('scanWorkflow is the same text scan on its own', () => {
    expect(scanWorkflow(PLAIN_WORKFLOW, 'main')).toMatchObject({ allowed: true });
    expect(scanWorkflow(PLAIN_WORKFLOW, 'trunk')).toMatchObject({ allowed: false });
    expect(scanWorkflow('name: x\njobs: {}\n', 'main')).toMatchObject({ allowed: false });
  });
});

describe('mergePr: deferMain and verifyMain', () => {
  const mergedPr: Rule = { when: /^gh pr view 7 --json .*headRefOid/, reply: prView({ ...PR_CLEAN, state: 'MERGED' }) };

  it('deferMain with main moved: merges, reports mainCheck deferred, and does not wait for the main run', async () => {
    const { result, cmds } = await go([], { deferMain: true });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mergeSha: MERGE_SHA, mainSha: null, mainCheck: 'deferred' });
    expect(result.message).toContain(`--verify-main ${MERGE_SHA}`);
    expect(cmds).toContain(MERGE_CMD);
    expect(count(cmds, /^gh run (list|view)/)).toBe(0);
  });

  it('deferMain still skips when the tree is unchanged', async () => {
    const { result } = await go([{ when: new RegExp(`^git rev-parse ${MERGE_SHA}\\^\\{tree\\}$`), reply: out(`${HEAD_TREE}\n`) }, ...treeOf(PLAIN_WORKFLOW)], { deferMain: true, project: REUSE });
    expect(result.mainCheck).toBe('skipped:unchanged');
  });

  it('deferMain without mainCi verifies inline: a local check is never run outside the caller lock', async () => {
    const { result, cmds } = await go([{ when: (c, cwd) => cwd === REPO && c === 'git rev-parse HEAD', reply: out(`${MERGE_SHA}\n`) }, { when: /slot\.sh/, reply: out('ok\n') }], { deferMain: true, project: { mainCi: '' } });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mainCheck: 'green' });
    expect(count(cmds, /slot\.sh/)).toBe(1);
  });

  it('verifyMain on a merged PR with a green main run: exit 0, mainCheck green, nothing merged or pushed', async () => {
    const { result, cmds } = await go([mergedPr], { verifyMain: MERGE_SHA, worktree: null });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mergeSha: MERGE_SHA, mainSha: MERGE_SHA, mainCheck: 'green' });
    expect(count(cmds, /^gh pr (merge|checks)|^git push|^git merge /)).toBe(0);
    expect(count(cmds, new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `))).toBe(1);
  });

  it('verifyMain with a red main run reverts once: exit 3, mainCheck red', async () => {
    const { result, cmds } = await go([mergedPr, { when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out(RUN_FAILURE) }], { verifyMain: MERGE_SHA, worktree: null });
    expect(result).toMatchObject({ outcome: 'reverted', exit: 3, mergeSha: MERGE_SHA, mainSha: REVERT_MERGE, mainCheck: 'red', revertPrUrl: 'https://github.com/example/repo/pull/8' });
    expect(count(cmds, /^git revert/)).toBe(1);
    expect(count(cmds, /^gh pr merge 7 /)).toBe(0);
  });

  it('verifyMain stops at mainWaitMs with a run still going: outcome pending, exit 5, no revert', async () => {
    const { result, cmds, sleeps } = await go([mergedPr, { when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out(RUN_IN_PROGRESS) }], { verifyMain: MERGE_SHA, worktree: null, mainWaitMs: 60000 });
    expect(result).toMatchObject({ outcome: 'pending', exit: 5, mainCheck: 'pending' });
    expect(sleeps).toHaveLength(3);
    expect(count(cmds, /^git revert|^gh pr create/)).toBe(0);
  });

  it('verifyMain on a PR that is not merged is an error and touches nothing', async () => {
    const { result, cmds } = await go([], { verifyMain: MERGE_SHA, worktree: null });
    expect(result).toMatchObject({ outcome: 'error', exit: 4 });
    expect(result.message).toMatch(/not MERGED/);
    expect(count(cmds, /^gh run list|^gh pr merge|^git push/)).toBe(0);
  });
});

describe('machineLoad', () => {
  it('is high only above factor x cores (default 4)', () => {
    expect(machineLoad(31.9, 8)).toEqual({ load1: 31.9, cores: 8, threshold: 32, high: false });
    expect(machineLoad(32.01, 8)).toMatchObject({ threshold: 32, high: true });
    expect(machineLoad(10, 8, 1)).toMatchObject({ threshold: 8, high: true });
  });

  it('survives bad inputs without throwing', () => {
    expect(machineLoad(Number.NaN, 0)).toEqual({ load1: 0, cores: 1, threshold: 4, high: false });
    expect(machineLoad(5, 1, -2)).toMatchObject({ threshold: 4, high: true });
  });
});

describe('the safety checks themselves', () => {
  it('catch a forbidden flag, a push to the default branch, a force push and an unpinned merge', () => {
    for (const bad of [
      'git push origin main',
      'git push origin HEAD:main',
      'git push --force origin feat/x',
      'git push -f origin feat/x',
      'git push --force-with-lease origin feat/x',
      'git push feat/x',
      'gh pr merge 7 --merge --delete-branch',
      'gh pr merge 7 --merge --admin --match-head-commit ' + HEAD,
      'gh pr merge 7 --auto --match-head-commit ' + HEAD,
    ]) {
      expect(() => assertSafe([bad]), bad).toThrow();
    }
    expect(() => assertSafe([`git push origin HEAD:${BRANCH}`, 'git push origin revert/pr-7', MERGE_CMD])).not.toThrow();
  });

  it('ran on every call the scenarios above made', () => {
    expect(everyCall.length).toBeGreaterThan(100);
    expect(everyCall.some((c) => /^git push/.test(c))).toBe(true);
    expect(everyCall.some((c) => /^gh pr merge 8 /.test(c))).toBe(true);
  });
});

// The spawn test: scripts/merge-pr.js through a symlink in a temp repo, with fake gh and git first on PATH.
const SHIM = `#!${process.execPath}
const fs = require('fs');
const name = require('path').basename(process.argv[1]);
const cmd = [name, ...process.argv.slice(2)].join(' ');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cmd, cwd: process.cwd() }) + '\\n');
for (const r of JSON.parse(fs.readFileSync(process.env.FAKE_RULES, 'utf8'))) {
  if (new RegExp(r.match).test(cmd)) {
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    process.exit(r.code || 0);
  }
}
process.stderr.write('unexpected call: ' + cmd + '\\n');
process.exit(127);
`;

function spawnWorld(config: object, rules: Array<{ match: string; stdout?: string; code?: number }>) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-pr-spawn-'));
  const repo = join(dir, 'repo');
  const shims = join(dir, 'shims');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, '.git'));
  mkdirSync(shims);
  writeFileSync(join(repo, '.claude', 'loop.local.json'), JSON.stringify(config));
  symlinkSync(join(root, 'scripts', 'merge-pr.js'), join(repo, 'scripts', 'merge-pr.js'));
  for (const name of ['gh', 'git']) {
    writeFileSync(join(shims, name), SHIM);
    chmodSync(join(shims, name), 0o755);
  }
  const log = join(dir, 'calls.log');
  const rulesFile = join(dir, 'rules.json');
  writeFileSync(log, '');
  writeFileSync(rulesFile, JSON.stringify(rules));
  const run = (args: string[]) =>
    spawnSync(process.execPath, [join(repo, 'scripts', 'merge-pr.js'), ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shims}:${process.env.PATH}`, FAKE_LOG: log, FAKE_RULES: rulesFile },
    });
  const calls = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Call);
  return { repo, run, calls };
}

const SPAWN_RULES = (checks: string, checksCode = 0) => [
  { match: '^git rev-parse --git-common-dir$', stdout: '.git\n' },
  { match: '^gh pr view 7 --json state,mergeCommit$', stdout: MERGED_VIEW },
  { match: '^gh pr view 7 --json .*headRefOid', stdout: JSON.stringify(PR_CLEAN) },
  { match: '^gh pr checks 7 --json', stdout: checks, code: checksCode },
  { match: '^gh pr merge 7 ', stdout: '' },
  { match: `^gh run list --branch main --workflow check --commit ${MERGE_SHA} `, stdout: RUN_SUCCESS },
  { match: '^gh run view \\d+ --log-failed$', stdout: 'AssertionError: expected 1 to be 2\n' },
  { match: '^git pull --ff-only$', stdout: '' },
];

describe('scripts/merge-pr.js (spawned through a symlink with fake gh and git)', () => {
  it('merged and main green: exit 0 and one JSON line on stdout', () => {
    const w = spawnWorld({ syncPolicy: 'conflict', mainCi: 'check' }, SPAWN_RULES(CHECKS_GREEN));
    const r = w.run(['7', '--repo', w.repo]);
    expect(r.stderr).not.toMatch(/Cannot find module|ERR_/);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ outcome: 'merged', exit: 0, mergeSha: MERGE_SHA, mainSha: MERGE_SHA, ciState: 'green', failing: [], conflictFiles: [], revertPrUrl: null });
    expect(w.calls().map((c) => c.cmd)).toContain(`gh pr merge 7 --merge --delete-branch --match-head-commit ${HEAD}`);
    assertSafe(w.calls().map((c) => c.cmd));
  }, 120_000);

  it('CI red: exit 2, the JSON names the failing check, no merge call reaches gh', () => {
    const w = spawnWorld({ syncPolicy: 'conflict', mainCi: 'check' }, SPAWN_RULES(CHECKS_RED, 1));
    const r = w.run(['7', '--repo', w.repo]);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ outcome: 'refused', exit: 2, ciState: 'red', failing: ['check'] });
    expect(w.calls().filter((c) => /^gh pr merge/.test(c.cmd))).toHaveLength(0);
  }, 120_000);

  it('bad usage: exit 4 with a JSON error line and no gh or git call', () => {
    const w = spawnWorld({}, []);
    const r = w.run(['not-a-number', '--repo', w.repo]);
    expect(r.status).toBe(4);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ outcome: 'error', exit: 4 });
    expect(w.calls()).toHaveLength(0);
  }, 120_000);

  it('--dry-run reports the machine load; --verify-main needs a sha and no --defer-main', () => {
    const w = spawnWorld({ syncPolicy: 'conflict', mainCi: 'check', loadWarnFactor: 1000 }, SPAWN_RULES(CHECKS_GREEN));
    const dry = w.run(['7', '--repo', w.repo, '--dry-run']);
    const line = JSON.parse(dry.stdout.trim());
    expect(line.outcome).toBe('dry-run');
    expect(line.load).toMatchObject({ high: false });
    expect(line.load.threshold).toBe(1000 * line.load.cores);
    expect(typeof line.load.load1).toBe('number');
    for (const args of [['--verify-main', 'not-a-sha'], ['--verify-main', MERGE_SHA, '--defer-main']]) {
      const r = w.run(['7', '--repo', w.repo, ...args]);
      expect(r.status, args.join(' ')).toBe(4);
      expect(JSON.parse(r.stdout.trim()).message).toMatch(/^usage:/);
    }
  }, 120_000);

  it('a repo without .claude/loop.local.json: exit 4 with a JSON error line', () => {
    const w = spawnWorld({}, []);
    const r = w.run(['7', '--repo', join(w.repo, 'scripts')]);
    expect(r.status).toBe(4);
    expect(JSON.parse(r.stdout.trim()).message).toMatch(/loop\.local\.json/);
    expect(w.calls()).toHaveLength(0);
  }, 120_000);
});

describe('mergePr: project.mergeMethod', () => {
  it('squash: squash-merges the PR pinned to the green head', async () => {
    const { result, cmds } = await go([], { project: { mergeMethod: 'squash' } });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0 });
    expect(cmds).toContain(`gh pr merge 7 --squash --delete-branch --match-head-commit ${HEAD}`);
    expect(count(cmds, /^gh pr merge 7 --merge/)).toBe(0);
  });

  it('squash and main red: the revert has no -m 1 and the revert PR is squash-merged too', async () => {
    const mainRed: Rule = { when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out(RUN_FAILURE) };
    const { result, cmds } = await go([mainRed, { when: (c, cwd) => cwd === REVERT_WT && /^git revert --no-commit /.test(c), reply: {} }], { project: { mergeMethod: 'squash' } });
    expect(result).toMatchObject({ outcome: 'reverted', exit: 3 });
    expect(cmds).toContain(`git revert --no-commit ${MERGE_SHA}`);
    expect(cmds).toContain(`gh pr merge 8 --squash --delete-branch --match-head-commit ${REVERT_HEAD}`);
  });

  it('the default is a merge commit', async () => {
    const { cmds } = await go();
    expect(cmds).toContain(MERGE_CMD);
  });

  it('an unknown method is a config error before any command runs', async () => {
    const { result, cmds } = await go([], { project: { mergeMethod: 'rebase' } });
    expect(result).toMatchObject({ outcome: 'error', exit: 4 });
    expect(result.message).toMatch(/^cannot read config: project.mergeMethod/);
    expect(cmds).toEqual([]);
  });
});


// ---------------------------------------------------------------------------------------------------------------------
// Task 3.2: the merge lock. mergePr takes it before it reads the PR it acts on and releases it on every exit path.
// ---------------------------------------------------------------------------------------------------------------------

const GIT_DIR = '/work/repo/.git';
const LOCK = `${GIT_DIR}/agent-loop-merge.lock`;
const TAKEOVER = `${LOCK}.takeover`;
const NOW0 = 1_800_000_000_000;
const MIN = 60_000;

// An in-memory file system for makeLock: directories carry a modification time, files live under them.
function memFs(clock: { t: number }) {
  const dirs = new Map<string, number>([[GIT_DIR, clock.t]]);
  const files = new Map<string, string>();
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  const log: string[] = [];
  const fs = {
    async mkdir(path: string) {
      log.push(`mkdir ${path}`);
      if (dirs.has(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
      dirs.set(path, clock.t);
    },
    async writeFile(path: string, text: string) {
      log.push(`write ${path}`);
      files.set(path, text);
      if (dirs.has(parentOf(path))) dirs.set(parentOf(path), clock.t);
    },
    async rename(from: string, to: string) {
      log.push(`rename ${from} ${to}`);
      if (!files.has(from)) throw enoent(from);
      if (!dirs.has(parentOf(to))) throw enoent(parentOf(to));
      files.set(to, files.get(from) as string);
      files.delete(from);
      dirs.set(parentOf(to), clock.t);
    },
    async readFile(path: string) {
      if (!files.has(path)) throw enoent(path);
      return files.get(path) as string;
    },
    async rm(path: string) {
      log.push(`rm ${path}`);
      for (const d of [...dirs.keys()]) if (d === path || d.startsWith(`${path}/`)) dirs.delete(d);
      for (const f of [...files.keys()]) if (f === path || f.startsWith(`${path}/`)) files.delete(f);
    },
    async mtimeMs(path: string) {
      if (!dirs.has(path)) throw enoent(path);
      return dirs.get(path) as number;
    },
  };
  return { fs, dirs, files, log };
}

type Owner = { pid: number; host: string; pr: number; startedAt: string };
const owner = (o: Partial<Owner> = {}): Owner => ({ pid: 4242, host: 'build-1', pr: 5, startedAt: new Date(NOW0 - 60_000).toISOString(), ...o });
const everyoneAlive = () => true;

function lockWorld(o: { alive?: (pid: number) => boolean; held?: { owner?: Owner | string | null; ageMs: number } } = {}) {
  const clock = { t: NOW0 };
  const m = memFs(clock);
  if (o.held) {
    m.dirs.set(LOCK, clock.t - o.held.ageMs);
    if (o.held.owner !== null && o.held.owner !== undefined) m.files.set(`${LOCK}/owner.json`, typeof o.held.owner === 'string' ? o.held.owner : JSON.stringify(o.held.owner));
  }
  const lockFor = (pid: number, host = 'build-1', alive = o.alive ?? everyoneAlive) => makeLock({ fs: m.fs, lockPath: LOCK, pid, host, now: () => clock.t, alive });
  const sleep = (ms: number) => {
    clock.t += ms;
    return new Promise<void>((r) => setTimeout(r, 0));
  };
  return { clock, ...m, lockFor, sleep };
}

async function goLocked(w: ReturnType<typeof lockWorld>, lock: unknown, rules: Rule[] = [], o: Go & { log?: string[]; tag?: string } = {}) {
  const f = fakeRunner([...rules, ...baseRules()]);
  const sleeps: number[] = [];
  const result = await mergePr(
    { pr: 7, repo: REPO, worktree: o.worktree === null ? undefined : (o.worktree ?? WT), dryRun: o.dryRun ?? false, deferMain: o.deferMain, verifyMain: o.verifyMain, mainWaitMs: o.mainWaitMs, tempDir: '/tmp', project: { ...PROJECT, ...o.project } },
    {
      run: async (cmd: string, opts?: { cwd?: string }) => {
        o.log?.push(`${o.tag ?? ''}${cmd}`);
        return f.run(cmd, opts);
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
        await w.sleep(ms);
      },
      now: () => w.clock.t,
      lock,
    },
  );
  const cmds = f.calls.map((c) => c.cmd);
  everyCall.push(...cmds);
  expect(f.unexpected).toEqual([]);
  assertSafe(cmds);
  return { result, cmds, sleeps };
}

// A lock that only records its calls in a shared log and answers from a script (the last answer repeats).
function spyLock(log: string[], answers: Array<{ held: boolean; holder?: Owner | null; reason?: string; note?: string }> = [{ held: true }]) {
  let n = 0;
  return {
    acquire: async (o: unknown) => {
      log.push(`lock.acquire ${JSON.stringify(o)}`);
      const a = answers[Math.min(n++, answers.length - 1)];
      return { path: LOCK, holder: null, reason: '', note: null, ...a };
    },
    release: async () => void log.push('lock.release'),
  };
}

describe('mergePr: the merge lock', () => {
  it('two concurrent mergePr calls run one after the other', async () => {
    const w = lockWorld();
    const log: string[] = [];
    const a = goLocked(w, w.lockFor(101), [], { log, tag: 'A:' });
    const b = goLocked(w, w.lockFor(102), [], { log, tag: 'B:' });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.result).toMatchObject({ outcome: 'merged', exit: 0 });
    expect(rb.result).toMatchObject({ outcome: 'merged', exit: 0 });
    const last = (t: string) => log.map((c, i) => (c.startsWith(t) ? i : -1)).filter((i) => i >= 0).pop() as number;
    const first = (t: string) => log.findIndex((c) => c.startsWith(t));
    expect(last('A:')).toBeLessThan(first('B:'));
    expect(rb.sleeps.length).toBeGreaterThan(0);
    expect(rb.sleeps.every((ms) => ms === 5000)).toBe(true);
    expect(ra.sleeps).toEqual([]);
    expect(w.dirs.has(LOCK)).toBe(false);
    expect(w.dirs.has(TAKEOVER)).toBe(false);
  });

  it('the lock is a directory made with mkdir, holding owner.json { pid, host, pr, startedAt } renamed into place, during the merge', async () => {
    const w = lockWorld();
    let snap: { dir: boolean; owner: unknown } | null = null;
    const peek: Rule = {
      when: (c) => {
        if (/^gh pr merge 7 /.test(c)) snap = { dir: w.dirs.has(LOCK), owner: JSON.parse(w.files.get(`${LOCK}/owner.json`) ?? 'null') };
        return false;
      },
      reply: {},
    };
    const { result } = await goLocked(w, w.lockFor(101), [peek]);
    expect(result.outcome).toBe('merged');
    expect(snap).toEqual({ dir: true, owner: { pid: 101, host: 'build-1', pr: 7, startedAt: new Date(NOW0).toISOString() } });
    expect(w.log[0]).toBe(`mkdir ${LOCK}`);
    const renamed = w.log.find((l) => l.startsWith('rename '));
    expect(renamed).toMatch(new RegExp(` ${LOCK}/owner\\.json$`));
    expect(renamed).not.toMatch(new RegExp(`^rename ${LOCK}/owner\\.json `));
    expect(w.dirs.has(LOCK)).toBe(false);
  });

  it('takes the lock before it reads the PR, holds it through the merge and the check on main, and releases it last', async () => {
    const log: string[] = [];
    const w = lockWorld();
    const { result } = await goLocked(w, spyLock(log), [], { log });
    expect(result).toMatchObject({ outcome: 'merged', mainCheck: 'green' });
    expect(log[0]).toMatch(/^lock\.acquire/);
    expect(log.findIndex((c) => /^gh pr view 7 /.test(c))).toBeGreaterThan(0);
    expect(log.filter((c) => c === 'lock.release')).toHaveLength(1);
    expect(log[log.length - 1]).toBe('lock.release');
    expect(log.findIndex((c) => /^gh run list /.test(c))).toBeLessThan(log.indexOf('lock.release'));
  });

  it('reads the PR once the lock is held, after any wait: the sync decision and the pinned head come from after the wait', async () => {
    const log: string[] = [];
    const w = lockWorld();
    const lock = spyLock(log, [{ held: false, holder: owner(), reason: 'held by a live process' }, { held: false, holder: owner() }, { held: true }]);
    const moved: Rule[] = [
      { when: /^git merge-base --is-ancestor origin\/main /, reply: { code: 1 } },
      { when: /^gh pr view 7 --json .*headRefOid/, reply: [prView(PR_CLEAN), prView({ ...PR_CLEAN, headRefOid: SYNC_SHA })] },
    ];
    const { result, sleeps } = await goLocked(w, lock, moved, { log });
    expect(result.outcome).toBe('merged');
    expect(sleeps.slice(0, 2)).toEqual([5000, 5000]);
    const firstRead = log.findIndex((c) => /^gh pr view 7 /.test(c));
    const lastAcquire = log.map((c) => c.startsWith('lock.acquire')).lastIndexOf(true);
    expect(lastAcquire).toBeLessThan(firstRead);
    expect(log.filter((c) => c.startsWith('lock.acquire'))).toHaveLength(3);
    expect(result.lockWaitMs).toBe(10_000);
  });

  it('releases the lock on every exit path: merged, refused, a conflict, an error, a throw, a deferred main and a revert', async () => {
    const throwing: Rule = { when: (c) => {
      if (/^gh pr checks 7 /.test(c)) throw new Error('the runner fell over');
      return false;
    }, reply: {} };
    const red: Rule = { when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out(RUN_FAILURE) };
    const cases: Array<[string, Rule[], Go, string]> = [
      ['merged', [], {}, 'merged'],
      ['refused: CI red', [{ when: /^gh pr checks 7 --json/, reply: { code: 1, stdout: CHECKS_RED } }], {}, 'refused'],
      ['refused: not open', [{ when: /^gh pr view 7 --json .*headRefOid/, reply: prView({ ...PR_CLEAN, state: 'CLOSED' }) }], {}, 'refused'],
      ['error: pr cannot be read', [{ when: /^gh pr view 7 --json .*headRefOid/, reply: { code: 1, stderr: 'boom' } }], {}, 'error'],
      ['a throw inside the merge', [throwing], {}, 'error'],
      ['deferred main', [], { deferMain: true }, 'merged'],
      ['reverted', [red], {}, 'reverted'],
    ];
    for (const [name, rules, o, outcome] of cases) {
      const log: string[] = [];
      const w = lockWorld();
      const { result } = await goLocked(w, spyLock(log), rules, { ...o, log });
      expect(result.outcome, name).toBe(outcome);
      expect(log.filter((c) => c === 'lock.release'), name).toHaveLength(1);
      expect(log[log.length - 1], name).toBe('lock.release');
    }
  });

  it('a revert after a red main stays under the lock: it is released only after the revert PR merged and main was checked again', async () => {
    const log: string[] = [];
    const w = lockWorld();
    const red: Rule = { when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out(RUN_FAILURE) };
    const { result } = await goLocked(w, spyLock(log), [red], { log });
    expect(result).toMatchObject({ outcome: 'reverted', exit: 3 });
    const release = log.indexOf('lock.release');
    expect(log.findIndex((c) => /^gh pr merge 8 /.test(c))).toBeLessThan(release);
    expect(log.findIndex((c) => new RegExp(`--commit ${REVERT_MERGE} `).test(c))).toBeLessThan(release);
  });

  it('a held lock past the wait gives locked, exit 2, the holder and the lock path in message, and touches nothing else', async () => {
    const w = lockWorld({ held: { owner: owner({ pid: 4242, host: 'build-1', pr: 5 }), ageMs: 3 * MIN } });
    const { result, cmds, sleeps } = await goLocked(w, w.lockFor(101));
    expect(result).toMatchObject({ outcome: 'locked', exit: 2, mergeSha: null });
    expect(result.message).toContain('4242');
    expect(result.message).toContain('#5');
    expect(result.message).toContain(LOCK);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(5 * MIN);
    expect(sleeps.every((ms) => ms === 5000)).toBe(true);
    expect(cmds).toEqual([]);
    expect(w.dirs.has(LOCK)).toBe(true);
    expect(JSON.parse(w.files.get(`${LOCK}/owner.json`) as string).pid).toBe(4242);
  });

  it('waits mergeLockWaitMin (default 5); a larger value is lowered to 8; zero does not wait', async () => {
    const waitFor = async (project: Record<string, unknown>) => {
      const w = lockWorld({ held: { owner: owner(), ageMs: MIN } });
      const { result, sleeps } = await goLocked(w, w.lockFor(101), [], { project });
      expect(result.outcome).toBe('locked');
      return sleeps.reduce((a, b) => a + b, 0);
    };
    expect(await waitFor({})).toBe(5 * MIN);
    expect(await waitFor({ mergeLockWaitMin: 2 })).toBe(2 * MIN);
    expect(await waitFor({ mergeLockWaitMin: 60 })).toBe(8 * MIN);
    expect(await waitFor({ mergeLockWaitMin: 0 })).toBe(0);
    expect(await waitFor({ mergeLockWaitMin: 'soon' })).toBe(5 * MIN);
  });

  it('a lock whose holder lets go during the wait is taken and the merge goes through', async () => {
    const w = lockWorld({ held: { owner: owner(), ageMs: MIN } });
    const lock = w.lockFor(101);
    let slept = 0;
    const origSleep = w.sleep;
    w.sleep = (ms: number) => {
      if (++slept === 3) {
        w.dirs.delete(LOCK);
        w.files.delete(`${LOCK}/owner.json`);
      }
      return origSleep(ms);
    };
    const { result, sleeps } = await goLocked(w, lock);
    expect(result).toMatchObject({ outcome: 'merged', exit: 0 });
    expect(sleeps).toHaveLength(3);
  });

  it('a stale lock (this host, dead pid) is taken over at once, and message says so', async () => {
    const w = lockWorld({ alive: (pid) => pid !== 4242, held: { owner: owner({ pid: 4242, host: 'build-1' }), ageMs: 2 * 1000 } });
    const { result, sleeps } = await goLocked(w, w.lockFor(101, 'build-1', (pid) => pid !== 4242));
    expect(result).toMatchObject({ outcome: 'merged', exit: 0 });
    expect(sleeps).toEqual([]);
    expect(result.message).toMatch(/took over/i);
    expect(result.message).toContain('4242');
    expect(w.log).toContain(`mkdir ${TAKEOVER}`);
    expect(w.log).toContain(`rm ${TAKEOVER}`);
    expect(w.dirs.has(TAKEOVER)).toBe(false);
    expect(w.dirs.has(LOCK)).toBe(false);
  });

  it('a live pid on this host is never stale, however old the lock is', async () => {
    const w = lockWorld({ held: { owner: owner({ pid: 4242, host: 'build-1' }), ageMs: 5 * 60 * MIN } });
    const { result } = await goLocked(w, w.lockFor(101, 'build-1', () => true), [], { project: { mergeLockWaitMin: 0.1 } });
    expect(result.outcome).toBe('locked');
    expect(w.dirs.has(LOCK)).toBe(true);
  });

  it('an old lock is taken over: another host older than mergeLockStaleMin (default 30), or no owner.json, or an unparseable one', async () => {
    const cases: Array<[string, { owner?: Owner | string | null; ageMs: number }]> = [
      ['another host', { owner: owner({ host: 'build-2' }), ageMs: 31 * MIN }],
      ['no owner.json', { owner: null, ageMs: 31 * MIN }],
      ['unparseable owner.json', { owner: '{"pid": 4', ageMs: 31 * MIN }],
    ];
    for (const [name, held] of cases) {
      const w = lockWorld({ held });
      const { result } = await goLocked(w, w.lockFor(101), [], { project: { mergeLockWaitMin: 0 } });
      expect(result, name).toMatchObject({ outcome: 'merged', exit: 0 });
      expect(result.message, name).toMatch(/took over/i);
    }
  });

  it('a younger lock is held: another host under mergeLockStaleMin, no owner.json under 10 s or under the age limit; mergeLockStaleMin is read', async () => {
    const cases: Array<[string, { owner?: Owner | string | null; ageMs: number }, Record<string, unknown>, string]> = [
      ['another host, 29 min', { owner: owner({ host: 'build-2' }), ageMs: 29 * MIN }, {}, 'locked'],
      ['no owner.json, 5 s', { owner: null, ageMs: 5000 }, {}, 'locked'],
      ['no owner.json, 5 min', { owner: null, ageMs: 5 * MIN }, {}, 'locked'],
      ['unparseable, 5 min', { owner: 'x', ageMs: 5 * MIN }, {}, 'locked'],
      ['another host, 29 min, mergeLockStaleMin 20', { owner: owner({ host: 'build-2' }), ageMs: 29 * MIN }, { mergeLockStaleMin: 20 }, 'merged'],
      ['no owner.json, 5 min, mergeLockStaleMin 3', { owner: null, ageMs: 5 * MIN }, { mergeLockStaleMin: 3 }, 'merged'],
      ['no owner.json, 5 s, mergeLockStaleMin 0', { owner: null, ageMs: 5000 }, { mergeLockStaleMin: 0 }, 'locked'],
    ];
    for (const [name, held, project, outcome] of cases) {
      const w = lockWorld({ held });
      const { result } = await goLocked(w, w.lockFor(101), [], { project: { mergeLockWaitMin: 0, ...project } });
      expect(result.outcome, name).toBe(outcome);
    }
  });

  it('a takeover re-reads owner.json under the takeover directory and replaces the lock only when it still shows the owner judged stale', async () => {
    const w = lockWorld({ held: { owner: owner({ pid: 4242 }), ageMs: MIN } });
    const gone = (pid: number) => pid !== 4242;
    const live = owner({ pid: 777 });
    let reads = 0;
    const fs = {
      ...w.fs,
      readFile: async (path: string) => {
        // the first read judges the owner; by the second read (under the takeover directory) somebody else holds the lock
        if (path.endsWith('owner.json') && ++reads === 2) w.files.set(path, JSON.stringify(live));
        return w.fs.readFile(path);
      },
    };
    const lock = makeLock({ fs, lockPath: LOCK, pid: 101, host: 'build-1', now: () => w.clock.t, alive: (pid: number) => gone(pid) || pid === 777 });
    const r = await lock.acquire({ pr: 7, staleMin: 30 });
    expect(r.held).toBe(false);
    expect(JSON.parse(w.files.get(`${LOCK}/owner.json`) as string).pid).toBe(777);
    expect(w.dirs.has(TAKEOVER)).toBe(false);
  });

  it('a takeover directory left by a crashed taker is cleared once it is a minute old; a fresh one counts as a takeover in progress', async () => {
    const stale = lockWorld({ alive: (pid) => pid !== 4242, held: { owner: owner({ pid: 4242 }), ageMs: MIN } });
    stale.dirs.set(TAKEOVER, NOW0 - 2 * MIN);
    const lock = stale.lockFor(101, 'build-1', (pid) => pid !== 4242);
    expect((await lock.acquire({ pr: 7, staleMin: 30 })).held).toBe(true);
    const fresh = lockWorld({ alive: (pid) => pid !== 4242, held: { owner: owner({ pid: 4242 }), ageMs: MIN } });
    fresh.dirs.set(TAKEOVER, NOW0 - 2000);
    const other = fresh.lockFor(101, 'build-1', (pid) => pid !== 4242);
    expect((await other.acquire({ pr: 7, staleMin: 30 })).held).toBe(false);
    expect(fresh.dirs.has(TAKEOVER)).toBe(true);
  });

  it('release removes the lock only while owner.json still names this holder', async () => {
    const w = lockWorld();
    const lock = w.lockFor(101);
    expect((await lock.acquire({ pr: 7, staleMin: 30 })).held).toBe(true);
    w.files.set(`${LOCK}/owner.json`, JSON.stringify(owner({ pid: 999 })));
    await lock.release();
    expect(w.dirs.has(LOCK)).toBe(true);
    const mine = lockWorld();
    const l2 = mine.lockFor(101);
    await l2.acquire({ pr: 7, staleMin: 30 });
    await l2.release();
    await l2.release();
    expect(mine.dirs.has(LOCK)).toBe(false);
  });

  it('a lock that cannot be made at all is an error, not a wait, and nothing runs', async () => {
    const w = lockWorld();
    const broken = makeLock({ fs: { ...w.fs, mkdir: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } }, lockPath: LOCK, pid: 1, host: 'build-1', now: () => w.clock.t, alive: everyoneAlive });
    const { result, cmds, sleeps } = await goLocked(w, broken);
    expect(result).toMatchObject({ outcome: 'error', exit: 4 });
    expect(result.message).toMatch(/EACCES/);
    expect(cmds).toEqual([]);
    expect(sleeps).toEqual([]);
  });

  it('--dry-run and --verify-main on a green main make no lock call', async () => {
    const log: string[] = [];
    const w = lockWorld();
    const dry = await goLocked(w, spyLock(log), [], { dryRun: true, log });
    expect(dry.result.outcome).toBe('dry-run');
    const verify = await goLocked(w, spyLock(log), [{ when: /^gh pr view 7 --json .*headRefOid/, reply: prView({ ...PR_CLEAN, state: 'MERGED' }) }], { verifyMain: MERGE_SHA, log });
    expect(verify.result).toMatchObject({ outcome: 'merged', mainCheck: 'green' });
    expect(log.filter((c) => c.startsWith('lock.'))).toEqual([]);
  });

  it('--verify-main takes the lock only for the revert, and holds it through it', async () => {
    const log: string[] = [];
    const w = lockWorld();
    const rules: Rule[] = [
      { when: /^gh pr view 7 --json .*headRefOid/, reply: prView({ ...PR_CLEAN, state: 'MERGED' }) },
      { when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out(RUN_FAILURE) },
    ];
    const { result } = await goLocked(w, spyLock(log), rules, { verifyMain: MERGE_SHA, log });
    expect(result).toMatchObject({ outcome: 'reverted', exit: 3 });
    const acquire = log.findIndex((c) => c.startsWith('lock.acquire'));
    const release = log.indexOf('lock.release');
    expect(log.findIndex((c) => /^gh run list /.test(c))).toBeLessThan(acquire);
    expect(acquire).toBeLessThan(log.findIndex((c) => /^git worktree add .*revert/.test(c)));
    expect(log.findIndex((c) => /^gh pr merge 8 /.test(c))).toBeLessThan(release);
    expect(log.filter((c) => c.startsWith('lock.'))).toHaveLength(2);
  });

  it('--verify-main whose revert finds the lock held past the wait gives locked, and the revert does not start', async () => {
    const w = lockWorld({ held: { owner: owner(), ageMs: MIN } });
    const rules: Rule[] = [
      { when: /^gh pr view 7 --json .*headRefOid/, reply: prView({ ...PR_CLEAN, state: 'MERGED' }) },
      { when: new RegExp(`^gh run list --branch main --workflow check --commit ${MERGE_SHA} `), reply: out(RUN_FAILURE) },
    ];
    const { result, cmds } = await goLocked(w, w.lockFor(101), rules, { verifyMain: MERGE_SHA, project: { mergeLockWaitMin: 0 } });
    expect(result).toMatchObject({ outcome: 'locked', exit: 2, mainCheck: 'red' });
    expect(count(cmds, /^git worktree add|^gh pr create/)).toBe(0);
  });

  it('without a lock dep (a caller that wired none) the merge still runs', async () => {
    const { result } = await go();
    expect(result.outcome).toBe('merged');
  });
});

describe('scripts/merge-pr.js wires the lock to the file system', () => {
  const lockDirOf = (repo: string) => join(repo, '.git', 'agent-loop-merge.lock');

  it('a clean merge leaves no lock behind', () => {
    const w = spawnWorld({ syncPolicy: 'conflict', mainCi: 'check' }, SPAWN_RULES(CHECKS_GREEN));
    const r = w.run(['7', '--repo', w.repo]);
    expect(r.status).toBe(0);
    expect(existsSync(lockDirOf(w.repo))).toBe(false);
    expect(w.calls().map((c) => c.cmd)).toContain('git rev-parse --git-common-dir');
  }, 120_000);

  it('a lock held by a live process on this host: outcome locked, exit 2, no gh call, the lock untouched', () => {
    const w = spawnWorld({ syncPolicy: 'conflict', mainCi: 'check', mergeLockWaitMin: 0 }, SPAWN_RULES(CHECKS_GREEN));
    mkdirSync(lockDirOf(w.repo));
    writeFileSync(join(lockDirOf(w.repo), 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), pr: 3, startedAt: new Date().toISOString() }));
    const r = w.run(['7', '--repo', w.repo]);
    expect(r.status).toBe(2);
    const line = JSON.parse(r.stdout.trim());
    expect(line).toMatchObject({ outcome: 'locked', exit: 2 });
    expect(line.message).toContain(lockDirOf(w.repo));
    expect(w.calls().filter((c) => /^gh /.test(c.cmd))).toHaveLength(0);
    expect(existsSync(join(lockDirOf(w.repo), 'owner.json'))).toBe(true);
  }, 120_000);

  it('a lock left by a dead process on this host is taken over and removed after the merge', () => {
    const w = spawnWorld({ syncPolicy: 'conflict', mainCi: 'check', mergeLockWaitMin: 0 }, SPAWN_RULES(CHECKS_GREEN));
    const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    mkdirSync(lockDirOf(w.repo));
    writeFileSync(join(lockDirOf(w.repo), 'owner.json'), JSON.stringify({ pid: dead.pid as number, host: hostname(), pr: 3, startedAt: new Date().toISOString() }));
    const r = w.run(['7', '--repo', w.repo]);
    expect(r.status).toBe(0);
    const line = JSON.parse(r.stdout.trim());
    expect(line).toMatchObject({ outcome: 'merged', exit: 0 });
    expect(line.message).toMatch(/took over/i);
    expect(existsSync(lockDirOf(w.repo))).toBe(false);
    expect(existsSync(`${lockDirOf(w.repo)}.takeover`)).toBe(false);
  }, 120_000);

  it('--dry-run and --state take no lock and ask git for no directory', () => {
    const w = spawnWorld({ syncPolicy: 'conflict', mainCi: 'check', loadWarnFactor: 1000 }, SPAWN_RULES(CHECKS_GREEN));
    mkdirSync(lockDirOf(w.repo));
    writeFileSync(join(lockDirOf(w.repo), 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), pr: 3, startedAt: new Date().toISOString() }));
    const dry = w.run(['7', '--repo', w.repo, '--dry-run']);
    expect(JSON.parse(dry.stdout.trim()).outcome).toBe('dry-run');
    const state = w.run(['7', '--repo', w.repo, '--state']);
    expect(JSON.parse(state.stdout.trim()).outcome).toBe('state');
    expect(w.calls().filter((c) => /git-common-dir/.test(c.cmd))).toHaveLength(0);
    expect(existsSync(join(lockDirOf(w.repo), 'owner.json'))).toBe(true);
  }, 120_000);
});
