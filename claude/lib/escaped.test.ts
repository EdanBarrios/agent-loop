import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { isFixTitle, parseBlameOrigins, parseDiffRanges, taskIdOf } from './escaped.js';

// Each CLI run starts node, git and the fake gh; on a loaded machine one run takes several seconds.
vi.setConfig({ testTimeout: 120_000 });

const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'scripts', 'escaped.js');

const scratch = mkdtempSync(join(tmpdir(), 'escaped-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A fake `gh` on PATH. It answers only `gh pr list --state merged --limit 1000 --json number,headRefName,mergedAt`
// (from $GH_LIST) and `gh pr view <n> --json commits` (from $GH_DIR/view-<n>.json), and logs every call to
// $GH_DIR/calls.log.
const gh = join(scratch, 'bin');
mkdirSync(gh);
writeFileSync(
  join(gh, 'gh'),
  [
    '#!/bin/sh',
    'echo "$*" >> "$GH_DIR/calls.log"',
    'if [ "$*" = "pr list --state merged --limit 1000 --json number,headRefName,mergedAt" ]; then cat "$GH_LIST"; exit 0; fi',
    'if [ "$1 $2 $4 $5" = "pr view --json commits" ] && [ -f "$GH_DIR/view-$3.json" ]; then cat "$GH_DIR/view-$3.json"; exit 0; fi',
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

type Fix = { sha: string; title: string; kind: string; files: string[]; lines: number };
type Task = { pr: number; prs: number[]; escaped: number; fixes: Fix[] };
type Report = { tasks: Record<string, Task>; scanned: number; note: string | null };

// The temp repo: main only, no remote. Task PRs are merged with --no-ff and GitHub's merge-commit message; one task
// is squash-merged. Every merged PR is recorded for the fake `gh pr list`.
const repo = join(scratch, 'repo');
const ghDir = join(scratch, 'ghdata');
const merged: Array<{ number: number; headRefName: string; mergedAt: string }> = [];
const sha: Record<string, string> = {};
let tick = 0;

function put(path: string, lines: string[] | null) {
  if (lines === null) {
    git(repo, 'rm', '-q', '-f', path);
    return;
  }
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), lines.join('\n') + '\n');
}

function commit(message: string, files: Record<string, string[] | null>): string {
  for (const [path, lines] of Object.entries(files)) put(path, lines);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function stamp(): string {
  tick += 1;
  return `2026-02-${String(tick).padStart(2, '0')}T12:00:00Z`;
}

// A pull request: a branch off main with the given commits, merged by a merge commit like GitHub's.
function pr(
  number: number,
  branch: string,
  title: string,
  commits: Array<{ message: string; files: Record<string, string[] | null> }>,
  mergedAt = stamp(),
) {
  git(repo, 'checkout', '-q', '-b', branch, 'main');
  const oids = commits.map((c) => commit(c.message, c.files));
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${number} from owner/${branch}`, '-m', title, branch);
  merged.push({ number, headRefName: branch, mergedAt });
  mkdirSync(ghDir, { recursive: true });
  writeFileSync(join(ghDir, `view-${number}.json`), JSON.stringify({ commits: oids.map((oid) => ({ oid })) }));
}

function direct(message: string, files: Record<string, string[] | null>): string {
  return commit(message, files);
}

beforeAll(() => {
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commit('init', { 'README.md': ['# fixture'] });

  // Task PRs. The first one was merged before 2026, for --since.
  pr(1, 'task/1.1-fixme', 'feat: fix.txt', [{ message: 'feat: fix.txt', files: { 'fix.txt': ['f1', 'f2', 'f3'] } }], '2025-12-31T10:00:00Z');
  pr(2, 'task/1.2-adds', 'feat: add.txt', [
    { message: 'feat: add.txt part one', files: { 'add.txt': ['a1'] } },
    { message: 'feat: add.txt part two', files: { 'add.txt': ['a1', 'a2'] } },
  ]);
  pr(3, 'task/1.3-later', 'feat: later.txt', [{ message: 'feat: later.txt', files: { 'later.txt': ['l1', 'l2', 'l3'] } }]);
  pr(4, 'task/1.5-feat', 'feat: feat.txt', [{ message: 'feat: feat.txt', files: { 'feat.txt': ['e1', 'e2'] } }]);
  pr(5, 'task/1.6-rev', 'feat: rev.txt', [{ message: 'feat: rev.txt', files: { 'rev.txt': ['r1', 'r2'] } }]);
  pr(6, 'task/1.7-direct', 'feat: direct.txt', [{ message: 'feat: direct.txt', files: { 'direct.txt': ['d1', 'd2'] } }]);
  pr(7, 'task/1.8-xx', 'feat: x.txt', [{ message: 'feat: x.txt', files: { 'x.txt': ['x1', 'x2'] } }]);
  pr(8, 'task/1.9-yy', 'feat: y.txt', [{ message: 'feat: y.txt', files: { 'y.txt': ['y1', 'y2'] } }]);
  pr(9, 'task/1.10-ren', 'feat: old-name.txt', [
    { message: 'feat: old-name.txt', files: { 'old-name.txt': ['n1', 'n2', 'n3', 'n4', 'n5'] } },
  ]);

  // Task 1.11 is squash-merged: the PR's own commit is never on main, only the squash commit with "(#13)".
  git(repo, 'checkout', '-q', '-b', 'task/1.11-squash', 'main');
  const squashOid = commit('feat: sq.txt', { 'sq.txt': ['w1', 'w2'] });
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--squash', 'task/1.11-squash');
  git(repo, 'commit', '-q', '-m', 'feat: sq.txt (#13)');
  merged.push({ number: 13, headRefName: 'task/1.11-squash', mergedAt: stamp() });
  writeFileSync(join(ghDir, 'view-13.json'), JSON.stringify({ commits: [{ oid: squashOid }] }));

  // 1. A non-task PR whose title is a fix changes a task line: escaped 1 for 1.1.
  pr(20, 'fix/f2', 'fix: correct f2', [{ message: 'correct f2', files: { 'fix.txt': ['f1', 'f2-fixed', 'f3'] } }]);
  // 2. A later commit that only adds lines: nothing to blame.
  direct('fix: append a3', { 'add.txt': ['a1', 'a2', 'a3'] });
  // 3. A later task PR changes a line of 1.3 (its commit even says fix): not counted, not listed.
  pr(10, 'task/1.4-patch', 'fix: patch l2', [
    { message: 'fix: l2', files: { 'later.txt': ['l1', 'l2-new', 'l3'], 'four.txt': ['q1', 'q2'] } },
  ]);
  // 4. A later feat: commit changes a line of 1.5: listed as other, escaped 0.
  sha.feat = direct('feat: rewrite e1', { 'feat.txt': ['e1-new', 'e2'] });
  // 5. The loop's own revert from a revert/ branch: not listed.
  pr(11, 'revert/1.6-undo', 'Revert 1.6', [{ message: 'Revert 1.6', files: { 'rev.txt': ['r2'] } }]);
  // A reopen: task 1.6 again with a second PR, then a fix to its new line.
  pr(12, 'task/1.6-again', 'feat: rev2.txt', [{ message: 'feat: rev2.txt', files: { 'rev2.txt': ['s1', 's2'] } }]);
  sha.rev = direct('fix: s2', { 'rev2.txt': ['s1', 's2b'] });
  // 6. A fix pushed straight to main.
  sha.direct = direct('fix: d1', { 'direct.txt': ['d1-fixed', 'd2'] });
  // 7. One fix touching two tasks' lines.
  sha.both = direct('fix(scope): x and y', { 'x.txt': ['x1-fixed', 'x2'], 'y.txt': ['y1-fixed', 'y2'] });
  // 8. A rename before the fix, then the fix under the new name.
  git(repo, 'mv', 'old-name.txt', 'new-name.txt');
  git(repo, 'commit', '-q', '-m', 'chore: rename old-name');
  sha.rename = direct('Fix n3 in the renamed file', { 'new-name.txt': ['n1', 'n2', 'n3-fixed', 'n4', 'n5'] });
  // The squash-merged task gets a fix as well.
  sha.squash = direct('fix: w1', { 'sq.txt': ['w1-fixed', 'w2'] });
  // A task PR under another prefix.
  pr(14, 'work/2.1-w', 'feat: w.txt', [{ message: 'feat: w.txt', files: { 'w.txt': ['z1', 'z2'] } }]);
  sha.work = direct('fix: z1', { 'w.txt': ['z1-fixed', 'z2'] });
  sha.fix20 = git(repo, 'log', '--first-parent', '--format=%H', '--grep=Merge pull request #20 ', '-n1').trim();

  writeFileSync(join(ghDir, 'list.json'), JSON.stringify(merged));
}, 120_000);

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

function trace(extra: string[] = [], env: Record<string, string> = {}) {
  const r = run(['--repo', repo, ...extra], env);
  if (!r.report) throw new Error(`no JSON line: stdout=${r.stdout} stderr=${r.stderr}`);
  return r;
}

// The run with no options is the same for most cases: do it once.
let plain: ReturnType<typeof trace> | null = null;
function traced() {
  plain ??= trace();
  return plain;
}

describe('escaped-defect tracer over a temp repo with a fake gh', () => {
  it('a task PR whose line a later fix changes: escaped 1, with the fix listed', () => {
    const { code, report } = traced();
    expect(code).toBe(0);
    const t = report.tasks['1.1'];
    expect(t.pr).toBe(1);
    expect(t.escaped).toBe(1);
    expect(t.fixes).toHaveLength(1);
    expect(t.fixes[0]).toEqual({ sha: sha.fix20, title: 'fix: correct f2', kind: 'fix', files: ['fix.txt'], lines: 1 });
  });

  it('a later commit that only adds lines does not count and is not listed', () => {
    const t = traced().report.tasks['1.2'];
    expect(t.escaped).toBe(0);
    expect(t.fixes).toEqual([]);
  });

  it('a later task PR that changes the line is not counted and not listed', () => {
    const { tasks } = traced().report;
    expect(tasks['1.3'].escaped).toBe(0);
    expect(tasks['1.3'].fixes).toEqual([]);
    expect(tasks['1.4'].escaped).toBe(0);
  });

  it('a later feat: commit that changes the line is listed as other and does not count', () => {
    const t = traced().report.tasks['1.5'];
    expect(t.escaped).toBe(0);
    expect(t.fixes).toEqual([{ sha: sha.feat, title: 'feat: rewrite e1', kind: 'other', files: ['feat.txt'], lines: 1 }]);
  });

  it('a loop revert from a revert/ branch is not listed; a reopened task shows the latest PR and every number', () => {
    const t = traced().report.tasks['1.6'];
    expect(t.pr).toBe(12);
    expect(t.prs).toEqual([5, 12]);
    expect(t.fixes.map((f) => f.title)).toEqual(['fix: s2']);
    expect(t.escaped).toBe(1);
    expect(t.fixes[0].sha).toBe(sha.rev);
  });

  it('a fix: commit pushed straight to the default branch counts', () => {
    const t = traced().report.tasks['1.7'];
    expect(t.escaped).toBe(1);
    expect(t.fixes).toEqual([{ sha: sha.direct, title: 'fix: d1', kind: 'fix', files: ['direct.txt'], lines: 1 }]);
  });

  it('a fix touching two tasks lines counts once for each', () => {
    const { tasks } = traced().report;
    expect(tasks['1.8'].escaped).toBe(1);
    expect(tasks['1.9'].escaped).toBe(1);
    expect(tasks['1.8'].fixes).toEqual([{ sha: sha.both, title: 'fix(scope): x and y', kind: 'fix', files: ['x.txt'], lines: 1 }]);
    expect(tasks['1.9'].fixes).toEqual([{ sha: sha.both, title: 'fix(scope): x and y', kind: 'fix', files: ['y.txt'], lines: 1 }]);
  });

  it('a file renamed before the fix: blame follows the rename, escaped 1', () => {
    const t = traced().report.tasks['1.10'];
    expect(t.escaped).toBe(1);
    expect(t.fixes).toEqual([{ sha: sha.rename, title: 'Fix n3 in the renamed file', kind: 'fix', files: ['new-name.txt'], lines: 1 }]);
  });

  it('a squash-merged task PR is found by its (#n) subject and its commit counts as the origin', () => {
    const t = traced().report.tasks['1.11'];
    expect(t.pr).toBe(13);
    expect(t.escaped).toBe(1);
    expect(t.fixes[0].sha).toBe(sha.squash);
  });

  it('lists every task PR of the prefix and no others, and counts the later commits it scanned', () => {
    const { report } = traced();
    expect(Object.keys(report.tasks).sort()).toEqual(
      ['1.1', '1.10', '1.11', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9'].sort(),
    );
    // fix PR 20, "fix: append a3", "feat: rewrite e1", "fix: s2", "fix: d1", the x/y fix, the rename, the n3 fix,
    // "fix: w1", the work/ merge and "fix: z1"
    expect(report.scanned).toBe(11);
    expect(report.note).toBeNull();
  });

  it('asks gh for the merged PR list once and for commits only of task PRs', () => {
    writeFileSync(join(ghDir, 'calls.log'), '');
    trace();
    const calls = readFileSync(join(ghDir, 'calls.log'), 'utf8').trim().split('\n');
    expect(calls[0]).toBe('pr list --state merged --limit 1000 --json number,headRefName,mergedAt');
    const views = calls.filter((c) => c.startsWith('pr view')).sort();
    expect(views.every((c) => /^pr view \d+ --json commits$/.test(c))).toBe(true);
    expect(views).toHaveLength(12);
    expect(calls.filter((c) => c.startsWith('pr list'))).toHaveLength(1);
  });

  it('--since keeps PRs merged on or after the date', () => {
    const { report } = trace(['--since', '2026-01-01']);
    expect(report.tasks['1.1']).toBeUndefined();
    expect(report.tasks['1.2']).toBeDefined();
    const none = trace(['--since', '2031-01-01']).report;
    expect(none.tasks).toEqual({});
    const day = trace(['--since', '2025-12-31']).report;
    expect(day.tasks['1.1'].escaped).toBe(1);
  });

  it('--prefix picks other branches; the task id is parsed after the prefix', () => {
    const { report } = trace(['--prefix', 'work/']);
    expect(Object.keys(report.tasks)).toEqual(['2.1']);
    expect(report.tasks['2.1'].escaped).toBe(1);
    expect(report.tasks['2.1'].fixes[0].sha).toBe(sha.work);
  });

  it('says so in note when gh returns 1000 merged PRs', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      number: 1000 + i,
      headRefName: `docs/p${i}`,
      mergedAt: '2026-03-01T00:00:00Z',
    }));
    writeFileSync(join(ghDir, 'big.json'), JSON.stringify(many));
    const { report } = trace([], { GH_LIST: join(ghDir, 'big.json') });
    expect(report.tasks).toEqual({});
    expect(report.note).toMatch(/1000/);
  });

  it('exit 4 on bad usage, exit 1 with an error note when gh fails', () => {
    expect(run([]).code).toBe(4);
    expect(run(['--repo', repo, '--since', 'yesterday']).code).toBe(4);
    expect(run(['--repo', repo, '--bogus']).code).toBe(4);
    const failed = run(['--repo', repo], { GH_LIST: join(ghDir, 'missing.json') });
    expect(failed.code).toBe(1);
    expect(failed.report.note).toMatch(/^error: /);
    expect(failed.report.tasks).toEqual({});
  });
});

describe('pure helpers', () => {
  it('taskIdOf reads digits, dots and T after the prefix', () => {
    expect(taskIdOf('task/2.3-escaped-defect-tracer', 'task/')).toBe('2.3');
    expect(taskIdOf('task/1.T-wave-1-tail', 'task/')).toBe('1.T');
    expect(taskIdOf('task/12-x', 'task/')).toBe('12');
    expect(taskIdOf('revert/2.3-x', 'task/')).toBeNull();
    expect(taskIdOf('task/notanid', 'task/')).toBeNull();
    expect(taskIdOf('task/2.3', 'task/')).toBeNull();
  });

  it('isFixTitle matches fix, fix(scope), Fix ... and not words that merely start with fix', () => {
    for (const t of ['fix: a', 'fix(scope): a', 'Fix a thing', 'fix!: a', 'Fixes the thing', 'fix']) expect(isFixTitle(t)).toBe(true);
    for (const t of ['feat: fix a', 'fixture: a', 'prefix: fix', '', 'Revert "fix: a"']) expect(isFixTitle(t)).toBe(false);
  });

  it('parseDiffRanges lists the old line ranges of changed and deleted lines and skips pure additions', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 1..2 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -2 +2 @@',
      '-x',
      '+y',
      '@@ -10,3 +10,0 @@',
      '-p',
      '-q',
      '-r',
      '@@ -20,0 +21,2 @@',
      '+n',
      '+m',
      'diff --git a/old b/new',
      'similarity index 90%',
      'rename from old',
      'rename to new',
      '--- a/old\t',
      '+++ b/new\t',
      '@@ -1,2 +1,2 @@',
      '-a',
      '-b',
      '+c',
      '+d',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,4 +0,0 @@',
      'diff --git a/fresh.txt b/fresh.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/fresh.txt',
      '@@ -0,0 +1,3 @@',
    ].join('\n');
    expect(parseDiffRanges(diff)).toEqual([
      { path: 'a.txt', start: 2, count: 1 },
      { path: 'a.txt', start: 10, count: 3 },
      { path: 'old', start: 1, count: 2 },
      { path: 'gone.txt', start: 1, count: 4 },
    ]);
  });

  it('parseBlameOrigins counts the lines of each origin commit in porcelain output', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const out = [
      `${a} 1 1 2`,
      'author Test',
      'summary one',
      'filename f.txt',
      '\tline one',
      `${a} 2 2`,
      '\tline two',
      `${b} 7 3 1`,
      'author Other',
      'filename f.txt',
      '\t' + a + ' 9 9 looks like a header but is content',
    ].join('\n');
    expect([...parseBlameOrigins(out).entries()]).toEqual([
      [a, 2],
      [b, 1],
    ]);
  });
});
