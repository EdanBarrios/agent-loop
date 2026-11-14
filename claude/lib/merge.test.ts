import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { machineLoad, mergePr } from './merge.js';

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

// Loop perf change 3: no check on main when the merged tree is the tree CI checked; otherwise the caller can defer the
// wait for main's run (--defer-main) and watch it outside its merge lock (--verify-main).
describe('mergePr: the check on main is skipped when nothing new can be learned', () => {
  const sameTree: Rule = { when: new RegExp(`^git rev-parse ${MERGE_SHA}\\^\\{tree\\}$`), reply: out(`${HEAD_TREE}\n`) };

  it('merged tree equals the green head tree: exit 0, mainCheck skipped:unchanged, no main run is read', async () => {
    const { result, cmds } = await go([sameTree]);
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mergeSha: MERGE_SHA, mainSha: MERGE_SHA, mainCheck: 'skipped:unchanged' });
    expect(cmds).toContain(`git rev-parse ${MERGE_SHA}^{tree}`);
    expect(cmds).toContain(`git rev-parse ${HEAD}^{tree}`);
    expect(count(cmds, /^gh run (list|view)/)).toBe(0);
    expect(count(cmds, /^git revert|^gh pr create/)).toBe(0);
    expect(index(cmds, /^gh pr merge 7 /)).toBeLessThan(index(cmds, /\^\{tree\}$/));
  });

  it('skips the local check too when mainCi is empty', async () => {
    const { result, cmds } = await go([sameTree], { project: { mainCi: '' } });
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mainCheck: 'skipped:unchanged' });
    expect(count(cmds, /slot\.sh/)).toBe(0);
  });

  it('a tree that cannot be read is not proof: the check on main runs', async () => {
    const { result, cmds } = await go([{ when: new RegExp(`^git rev-parse ${MERGE_SHA}\\^\\{tree\\}$`), reply: { code: 128, stderr: 'fatal: bad object' } }]);
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mainCheck: 'green' });
    expect(count(cmds, /^gh run list/)).toBe(1);
  });

  it('main moved: the check on main runs as before and mainCheck is green', async () => {
    const { result, cmds } = await go();
    expect(result).toMatchObject({ outcome: 'merged', exit: 0, mainSha: MERGE_SHA, mainCheck: 'green' });
    expect(count(cmds, /^gh run list/)).toBe(1);
  });

  it('keeps every field the wave loop reads', async () => {
    const { result } = await go([sameTree]);
    for (const k of ['outcome', 'exit', 'mergeSha', 'mainSha', 'ciState', 'failing', 'conflictFiles', 'revertPrUrl', 'message', 'logTail', 'ciWaitMs', 'mergeMs', 'mainCheckMs', 'revertMs', 'elapsedMs']) {
      expect(result, k).toHaveProperty(k);
    }
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
    const { result } = await go([{ when: new RegExp(`^git rev-parse ${MERGE_SHA}\\^\\{tree\\}$`), reply: out(`${HEAD_TREE}\n`) }], { deferMain: true });
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
