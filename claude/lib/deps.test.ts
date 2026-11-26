import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { depState, taskPullRequest } from './deps.js';

// Each CLI run starts node, git and the fake gh; on a loaded machine one run takes several seconds.
vi.setConfig({ testTimeout: 300_000 });

const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'scripts', 'dep-state.js');

const scratch = mkdtempSync(join(tmpdir(), 'deps-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A fake `gh` on PATH. It answers only `gh pr list --state merged --limit 1000 --json number,headRefName,mergeCommit`
// (from $GH_LIST), exits 1 when $GH_FAIL is set, and logs every call to $GH_DIR/calls.log.
const gh = join(scratch, 'bin');
mkdirSync(gh);
writeFileSync(
  join(gh, 'gh'),
  [
    '#!/bin/sh',
    'echo "$*" >> "$GH_DIR/calls.log"',
    'if [ -n "$GH_FAIL" ]; then echo "gh: HTTP 502" >&2; exit 1; fi',
    'if [ "$*" = "pr list --state merged --limit 1000 --json number,headRefName,mergeCommit" ]; then cat "$GH_LIST"; exit 0; fi',
    'echo "unexpected gh $*" >&2',
    'exit 1',
    '',
  ].join('\n'),
);
chmodSync(join(gh, 'gh'), 0o755);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

type Row = { number: number; headRefName: string; mergeCommit: { oid: string } | null };
type Entry = {
  merged: boolean;
  pr: number | null;
  mergeSha: string | null;
  onDefault: boolean;
  reason: string | null;
  note?: string;
};
type Report = { tasks: Record<string, Entry> };

// The temp repo: a bare origin and a clone of it. A task PR is a branch merged into main with a merge commit and
// pushed, like GitHub's merge button. Every merged PR is recorded for the fake `gh pr list`.
const origin = join(scratch, 'origin.git');
const repo = join(scratch, 'repo');
const other = join(scratch, 'other');
const broken = join(scratch, 'broken');
const ghDir = join(scratch, 'ghdata');
const rows: Row[] = [];
let n = 0;

function commitFile(cwd: string, name: string): string {
  n += 1;
  writeFileSync(join(cwd, name), `${n}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', `add ${name}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

// Merge a branch with the given name into main of `cwd`, push it, and record the PR. mergeCommit false records null.
function mergePr(cwd: string, number: number, branch: string, mergeCommit: boolean | string = true): string {
  git(cwd, 'checkout', '-q', '-b', branch, 'main');
  commitFile(cwd, `f${number}.txt`);
  git(cwd, 'checkout', '-q', 'main');
  git(cwd, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${number} from owner/${branch}`, branch);
  git(cwd, 'push', '-q', 'origin', 'main');
  const sha = git(cwd, 'rev-parse', 'HEAD');
  const oid = typeof mergeCommit === 'string' ? mergeCommit : sha;
  rows.push({ number, headRefName: branch, mergeCommit: mergeCommit === false ? null : { oid } });
  return sha;
}

const sha: Record<string, string> = {};

beforeAll(() => {
  mkdirSync(ghDir);
  git(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
  git(scratch, 'clone', '-q', origin, repo);
  git(repo, 'checkout', '-q', '-b', 'main');
  commitFile(repo, 'README.md');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'remote', 'set-head', 'origin', '-a');

  // 1.1 merged and on the default branch; 1.10 must not be taken for it.
  sha.a = mergePr(repo, 1, 'task/1.1-merged');
  // 1.3: the merge commit gh names is on no branch of origin.
  git(repo, 'checkout', '-q', '-b', 'dangling', 'main');
  sha.dangling = commitFile(repo, 'dangling.txt');
  git(repo, 'checkout', '-q', 'main');
  rows.push({ number: 3, headRefName: 'task/1.3-dangling', mergeCommit: { oid: sha.dangling } });
  // 1.4: a reopen, two merged PRs (the older one is listed first on purpose: the latest is the higher number).
  sha.old = mergePr(repo, 5, 'task/1.4-first');
  sha.latest = mergePr(repo, 9, 'task/1.4-second');
  // 1.5: reverted through revert/<id>; 1.6: reverted through revert/pr-<n>.
  mergePr(repo, 6, 'task/1.5-x');
  mergePr(repo, 7, 'revert/1.5');
  mergePr(repo, 8, 'task/1.6-x');
  mergePr(repo, 10, 'revert/pr-8');
  // 1.7: reverted, then reopened: the reopen is the latest and is not reverted.
  mergePr(repo, 11, 'task/1.7-a');
  mergePr(repo, 12, 'revert/1.7');
  sha.reopen = mergePr(repo, 13, 'task/1.7-b');
  // 1.8: a merged PR without a merge commit.
  mergePr(repo, 14, 'task/1.8-x', false);
  // 1.9: a revert branch that merged before the task PR (a lower number) does not revert it; revert/pr-<other> neither.
  mergePr(repo, 15, 'revert/1.9');
  mergePr(repo, 16, 'revert/pr-99');
  sha.nine = mergePr(repo, 17, 'task/1.9-x');
  // 1.10 and a PR under another prefix.
  sha.ten = mergePr(repo, 18, 'task/1.10-x');
  sha.work = mergePr(repo, 19, 'work/2.1-w');
  // A task with a PR whose branch only starts like the id: not a match.
  mergePr(repo, 21, 'task/1.11x-y');
  git(repo, 'checkout', '-q', 'main');

  // A PR merged on origin after the clone: only a fetch shows its merge commit on origin/main.
  git(scratch, 'clone', '-q', origin, other);
  git(other, 'checkout', '-q', 'main');
  sha.fresh = mergePr(other, 20, 'task/2.2-fresh');

  // A clone whose origin cannot be reached, with the same history as the first clone.
  git(scratch, 'clone', '-q', repo, broken);
  git(broken, 'remote', 'set-url', 'origin', join(scratch, 'does-not-exist.git'));
  git(broken, 'update-ref', 'refs/remotes/origin/main', 'refs/heads/main');
  git(broken, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

  writeFileSync(join(ghDir, 'list.json'), JSON.stringify(rows));
}, 300_000);

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${gh}:${process.env.PATH}`, GH_DIR: ghDir, GH_LIST: join(ghDir, 'list.json'), ...env },
  });
  const line = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  let report: Report | null = null;
  try {
    report = JSON.parse(line);
  } catch {
    // leave null: the test reports stdout and stderr below
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, report: report as Report };
}

function state(repoPath: string, tasks: string[], extra: string[] = [], env: Record<string, string> = {}) {
  const r = run(['--repo', repoPath, '--task', ...tasks, ...extra], env);
  if (!r.report) throw new Error(`no JSON line: stdout=${r.stdout} stderr=${r.stderr}`);
  return r;
}

describe('dependency state over a temp repo with a fake gh', () => {
  it('a merged task whose merge commit is on the default branch: merged and onDefault', () => {
    const { code, report } = state(repo, ['1.1']);
    expect(code).toBe(0);
    expect(report.tasks['1.1']).toEqual({ merged: true, pr: 1, mergeSha: sha.a, onDefault: true, reason: null });
  });

  it('prints only the tasks asked for, one entry each, and calls gh once with the spec arguments', () => {
    rmSync(join(ghDir, 'calls.log'), { force: true });
    const { report } = state(repo, ['1.1', '1.2', '1.1']);
    expect(Object.keys(report.tasks).sort()).toEqual(['1.1', '1.2']);
    const calls = spawnSync('cat', [join(ghDir, 'calls.log')], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(calls).toEqual(['pr list --state merged --limit 1000 --json number,headRefName,mergeCommit']);
  });

  it('a task with no PR: merged false, reason no merged PR', () => {
    const { report } = state(repo, ['1.2']);
    expect(report.tasks['1.2']).toEqual({ merged: false, pr: null, mergeSha: null, onDefault: false, reason: 'no merged PR' });
  });

  it('a PR merged whose merge commit is not on the default branch: onDefault false', () => {
    const { report } = state(repo, ['1.3']);
    expect(report.tasks['1.3']).toEqual({
      merged: true,
      pr: 3,
      mergeSha: sha.dangling,
      onDefault: false,
      reason: 'not on default branch',
    });
  });

  it('a reopen with two PRs uses the latest (the higher number), whatever the listing order', () => {
    const { report } = state(repo, ['1.4']);
    expect(report.tasks['1.4']).toEqual({ merged: true, pr: 9, mergeSha: sha.latest, onDefault: true, reason: null });
  });

  it('a task reverted through a revert/<id> PR is not merged, reason reverted', () => {
    const { report } = state(repo, ['1.5']);
    expect(report.tasks['1.5']).toMatchObject({ merged: false, pr: 6, onDefault: false, reason: 'reverted' });
  });

  it('a task reverted through a revert/pr-<n> PR is not merged, reason reverted', () => {
    const { report } = state(repo, ['1.6']);
    expect(report.tasks['1.6']).toMatchObject({ merged: false, pr: 8, onDefault: false, reason: 'reverted' });
  });

  it('a task reverted and then reopened is merged through the reopen', () => {
    const { report } = state(repo, ['1.7']);
    expect(report.tasks['1.7']).toEqual({ merged: true, pr: 13, mergeSha: sha.reopen, onDefault: true, reason: null });
  });

  it('a revert branch that merged before the task PR, or one that names another PR, does not revert it', () => {
    const { report } = state(repo, ['1.9']);
    expect(report.tasks['1.9']).toEqual({ merged: true, pr: 17, mergeSha: sha.nine, onDefault: true, reason: null });
  });

  it('a null merge commit gives onDefault false, reason no merge commit', () => {
    const { report } = state(repo, ['1.8']);
    expect(report.tasks['1.8']).toEqual({ merged: true, pr: 14, mergeSha: null, onDefault: false, reason: 'no merge commit' });
  });

  it('matches the id up to the dash after it: 1.1 is not 1.10, 1.11 is not 1.11x', () => {
    const { report } = state(repo, ['1.1', '1.10', '1.11']);
    expect(report.tasks['1.1']).toMatchObject({ pr: 1 });
    expect(report.tasks['1.10']).toMatchObject({ pr: 18, mergeSha: sha.ten, onDefault: true });
    expect(report.tasks['1.11']).toMatchObject({ merged: false, reason: 'no merged PR' });
  });

  it('--prefix names the branch prefix; the default is task/', () => {
    const { report } = state(repo, ['2.1'], ['--prefix', 'work/']);
    expect(report.tasks['2.1']).toEqual({ merged: true, pr: 19, mergeSha: sha.work, onDefault: true, reason: null });
    expect(state(repo, ['2.1']).report.tasks['2.1']).toMatchObject({ merged: false, reason: 'no merged PR' });
  });

  it('fetches before it checks: a merge on origin that the clone has not fetched is on the default branch', () => {
    const { report } = state(repo, ['2.2']);
    expect(report.tasks['2.2']).toEqual({ merged: true, pr: 20, mergeSha: sha.fresh, onDefault: true, reason: null });
  });

  it('a failing fetch gives onDefault false, reason fetch failed', () => {
    const { code, report } = state(broken, ['1.1', '1.2']);
    expect(report.tasks['1.1']).toEqual({ merged: true, pr: 1, mergeSha: sha.a, onDefault: false, reason: 'fetch failed' });
    expect(report.tasks['1.2']).toMatchObject({ merged: false, reason: 'no merged PR' });
    expect(code).toBe(0);
  });

  it('exactly 1000 rows with no match: not in the newest 1000 merged PRs, with a note', () => {
    const filler = Array.from({ length: 1000 }, (_, i) => ({ number: 1000 + i, headRefName: `task/9.${i}-x`, mergeCommit: null }));
    writeFileSync(join(ghDir, 'cap.json'), JSON.stringify(filler));
    const { report } = state(repo, ['5.5'], [], { GH_LIST: join(ghDir, 'cap.json') });
    expect(report.tasks['5.5']).toMatchObject({ merged: false, pr: null, onDefault: false, reason: 'not in the newest 1000 merged PRs' });
    expect(typeof report.tasks['5.5'].note).toBe('string');
    expect(report.tasks['5.5'].note).toMatch(/1000/);
  });

  it('999 rows with no match is just no merged PR, and a match among 1000 rows is found', () => {
    const filler = Array.from({ length: 999 }, (_, i) => ({ number: 1000 + i, headRefName: `task/9.${i}-x`, mergeCommit: null }));
    writeFileSync(join(ghDir, 'cap999.json'), JSON.stringify(filler));
    expect(state(repo, ['5.5'], [], { GH_LIST: join(ghDir, 'cap999.json') }).report.tasks['5.5']).toMatchObject({
      reason: 'no merged PR',
    });
    writeFileSync(join(ghDir, 'cap-hit.json'), JSON.stringify([...filler, rows[0]]));
    expect(state(repo, ['1.1'], [], { GH_LIST: join(ghDir, 'cap-hit.json') }).report.tasks['1.1']).toMatchObject({
      merged: true,
      onDefault: true,
    });
  });

  it('gh failing (exit 1): every task is not merged, reason gh failed, nothing printed as merged', () => {
    const { code, stdout, report } = state(repo, ['1.1', '1.4'], [], { GH_FAIL: '1' });
    expect(code).toBe(1);
    expect(stdout).not.toMatch(/"merged":true/);
    for (const id of ['1.1', '1.4']) {
      expect(report.tasks[id]).toEqual({ merged: false, pr: null, mergeSha: null, onDefault: false, reason: 'gh failed' });
    }
  });

  it('gh printing something that is not a JSON list counts as gh failed', () => {
    writeFileSync(join(ghDir, 'junk.json'), 'not json');
    const { report } = state(repo, ['1.1'], [], { GH_LIST: join(ghDir, 'junk.json') });
    expect(report.tasks['1.1']).toMatchObject({ merged: false, reason: 'gh failed' });
  });

  it('bad usage exits 4 with a usage note and calls nothing', () => {
    for (const args of [[], ['--repo', repo], ['--task', '1.1'], ['--repo', repo, '--task'], ['--repo', repo, '--task', '1.1', '--prefix', ''], ['--repo', repo, '--task', '1.1', '--bogus']]) {
      const r = run(args);
      expect(r.code).toBe(4);
      expect(r.stdout).toMatch(/usage/);
    }
  });
});

describe('depState with injected I/O', () => {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });

  it('asks git for the default branch and tests ancestry against that name', async () => {
    const calls: string[] = [];
    const sha = 'a'.repeat(40);
    const list = JSON.stringify([{ number: 4, headRefName: 'task/1.1-x', mergeCommit: { oid: sha } }]);
    const run = async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(' ')}`);
      return file === 'gh' ? ok(list) : ok('origin/trunk\n');
    };
    const out = await depState({ tasks: ['1.1'], prefix: 'task/' }, { run });
    expect(out.tasks['1.1']).toEqual({ merged: true, pr: 4, mergeSha: sha, onDefault: true, reason: null });
    expect(calls).toContain('git fetch origin');
    expect(calls).toContain('git symbolic-ref --short refs/remotes/origin/HEAD');
    expect(calls).toContain(`git merge-base --is-ancestor ${sha} origin/trunk`);
  });

  it('an ancestry check that exits 1 is not on the default branch; a merge commit that is not a full sha is no merge commit', async () => {
    const good = 'b'.repeat(40);
    const list = JSON.stringify([
      { number: 1, headRefName: 'task/1.1-x', mergeCommit: { oid: good } },
      { number: 2, headRefName: 'task/1.2-x', mergeCommit: { oid: '--upload-pack=x' } },
    ]);
    const run = async (file: string, args: string[]) => {
      if (file === 'gh') return ok(list);
      if (args[0] === 'merge-base') return { code: 1, stdout: '', stderr: '' };
      return ok(args[0] === 'symbolic-ref' ? 'origin/main\n' : '');
    };
    const out = await depState({ tasks: ['1.1', '1.2'], prefix: 'task/' }, { run });
    expect(out.tasks['1.1']).toMatchObject({ merged: true, onDefault: false, reason: 'not on default branch' });
    expect(out.tasks['1.2']).toMatchObject({ merged: true, mergeSha: null, onDefault: false, reason: 'no merge commit' });
  });

  it('taskPullRequest picks the highest-numbered merged PR of the id', () => {
    const rowsIn = [
      { number: 2, headRefName: 'task/3.1-a', mergeCommit: null },
      { number: 7, headRefName: 'task/3.1-b', mergeCommit: null },
      { number: 9, headRefName: 'task/3.10-c', mergeCommit: null },
    ];
    expect(taskPullRequest(rowsIn, '3.1', 'task/').number).toBe(7);
    expect(taskPullRequest(rowsIn, '3.2', 'task/')).toBeNull();
  });
});
