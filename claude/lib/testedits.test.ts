import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { DEFAULT_TEST_GLOBS, classifyHunks, isAssertionLine, isTestFile, testGlobsOf } from './testedits.js';

const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'scripts', 'test-edits.js');
const PR = 7;

const scratch = mkdtempSync(join(tmpdir(), 'testedits-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A fake `gh` on PATH: answers only `gh pr view 7 --json commits,body,baseRefName,headRefOid` from $GH_FIXTURE.
const shimDir = join(scratch, 'bin');
mkdirSync(shimDir);
writeFileSync(
  join(shimDir, 'gh'),
  [
    '#!/bin/sh',
    'if [ "$1 $2 $3 $4 $5" = "pr view 7 --json commits,body,baseRefName,headRefOid" ]; then cat "$GH_FIXTURE"; exit 0; fi',
    'echo "unexpected gh $*" >&2',
    'exit 1',
    '',
  ].join('\n'),
);
chmodSync(join(shimDir, 'gh'), 0o755);

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

let counter = 0;

class Repo {
  dir: string;
  constructor() {
    this.dir = join(scratch, `repo${++counter}`);
    mkdirSync(this.dir);
    git(this.dir, 'init', '-q', '-b', 'main');
  }
  write(path: string, text: string) {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), text);
  }
  commit(message: string, files: Record<string, string | null> = {}): string {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) git(this.dir, 'rm', '-q', '-f', path);
      else this.write(path, text);
    }
    git(this.dir, 'add', '-A');
    git(this.dir, 'commit', '-q', '-m', message);
    return git(this.dir, 'rev-parse', 'HEAD');
  }
  git(...args: string[]) {
    return git(this.dir, ...args);
  }
}

const A_TEST = [
  "import { add } from './impl';",
  "describe('add', () => {",
  "  it('adds', () => {",
  '    expect(add(1, 2)).toBe(3);',
  '    expect(add(2, 2)).toBe(4);',
  '  });',
  "  it('is commutative', () => {",
  '    expect(add(3, 1)).toBe(add(1, 3));',
  '  });',
  '});',
  '',
].join('\n');

// b.test.ts lives on the base branch; its blocks are far apart so a merge from the base branch never conflicts.
const gap = (n: number) => Array.from({ length: n }, (_, i) => `  // filler ${i}`);
const B_TEST = [
  "describe('b', () => {",
  "  it('one', () => {",
  '    expect(one()).toBe(1);',
  '    expect(two()).toBe(2);',
  '  });',
  ...gap(8),
  "  it('three', () => {",
  '    expect(three()).toBe(3);',
  '  });',
  ...gap(8),
  "  it('four', () => {",
  '    expect(four()).toBe(4);',
  '  });',
  '});',
  '',
].join('\n');

const IMPL = 'export const add = (a: number, b: number) => a + b;\n';

type Report = {
  testFirstCommit: string | null;
  files: Array<{ path: string; removed: string[]; changed: Array<{ before: string; after: string }> }>;
  assertionsRemoved: number;
  assertionsChanged: number;
  bodySection: boolean;
  note: string | null;
};

type Options = { body?: string; globs?: string[]; baseRef?: string };

// Builds a repo whose main has impl.ts and b.test.ts, branches `task`, runs `build` on it, then records origin/main
// and the gh fixture the way a real pull request would look, and runs the CLI.
function scenario(build: (r: Repo, base: string) => void, opts: Options = {}) {
  const r = new Repo();
  const base = r.commit('base', { 'src/impl.ts': IMPL, 'src/b.test.ts': B_TEST });
  r.git('checkout', '-q', '-b', 'task');
  build(r, base);
  const head = r.git('rev-parse', 'HEAD');
  r.git('update-ref', 'refs/remotes/origin/main', r.git('rev-parse', 'main'));
  if (opts.globs) r.write('.claude/loop.local.json', JSON.stringify({ testGlobs: opts.globs }));
  return { r, head, ...runCli(r, head, opts) };
}

function runCli(r: Repo, head: string, opts: Options = {}, extra: string[] = []) {
  let commits: Array<{ oid: string }> = [];
  try {
    commits = r
      .git('rev-list', '--reverse', `${opts.baseRef ?? 'refs/remotes/origin/main'}..${head}`)
      .split('\n')
      .filter(Boolean)
      .map((oid) => ({ oid }));
  } catch {
    // the head is not in this repo yet (the fetch test); gh still lists it
    commits = [{ oid: head }];
  }
  const fixture = join(scratch, `gh${++counter}.json`);
  writeFileSync(fixture, JSON.stringify({ commits, body: opts.body ?? '', baseRefName: 'main', headRefOid: head }));
  const res = spawnSync('node', [cli, String(PR), '--repo', r.dir, ...extra], {
    encoding: 'utf8',
    env: { ...GIT_ENV, PATH: `${shimDir}:${process.env.PATH}`, GH_FIXTURE: fixture },
  });
  let report: Report | null = null;
  try {
    report = JSON.parse(res.stdout.trim().split('\n').pop() ?? '') as Report;
  } catch {
    // leave null; the assertions below show stdout and stderr
  }
  return { report: report as Report, status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('test-edits CLI', () => {
  it('an unchanged test: zero counts, testFirstCommit is the commit that added the test', () => {
    let tfc = '';
    const { report, status, stderr } = scenario((r) => {
      tfc = r.commit('test first', { 'src/a.test.ts': A_TEST });
      r.commit('impl', { 'src/impl.ts': IMPL + '// more\n' });
    });
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(report).toEqual({
      testFirstCommit: tfc,
      files: [],
      assertionsRemoved: 0,
      assertionsChanged: 0,
      bodySection: false,
      note: null,
    });
  });

  it('a deleted expect( line: removed 1', () => {
    const { report } = scenario((r) => {
      r.commit('test first', { 'src/a.test.ts': A_TEST });
      r.commit('weaken', { 'src/a.test.ts': A_TEST.replace('    expect(add(2, 2)).toBe(4);\n', '') });
    });
    expect(report.assertionsRemoved).toBe(1);
    expect(report.assertionsChanged).toBe(0);
    expect(report.files).toEqual([{ path: 'src/a.test.ts', removed: ['expect(add(2, 2)).toBe(4);'], changed: [] }]);
  });

  it('toBe(3) changed to toBeGreaterThan(0): changed 1, removed 0', () => {
    const { report } = scenario((r) => {
      r.commit('test first', { 'src/a.test.ts': A_TEST });
      r.commit('weaken', { 'src/a.test.ts': A_TEST.replace('toBe(3)', 'toBeGreaterThan(0)') });
    });
    expect(report.assertionsRemoved).toBe(0);
    expect(report.assertionsChanged).toBe(1);
    expect(report.files).toEqual([
      {
        path: 'src/a.test.ts',
        removed: [],
        changed: [{ before: 'expect(add(1, 2)).toBe(3);', after: 'expect(add(1, 2)).toBeGreaterThan(0);' }],
      },
    ]);
  });

  it('an assertion replaced by a line that is not an assertion counts as removed', () => {
    const { report } = scenario((r) => {
      r.commit('test first', { 'src/a.test.ts': A_TEST });
      r.commit('hollow', { 'src/a.test.ts': A_TEST.replace('expect(add(1, 2)).toBe(3);', 'const three = add(1, 2);') });
    });
    expect(report.assertionsRemoved).toBe(1);
    expect(report.assertionsChanged).toBe(0);
    expect(report.files[0].removed).toEqual(['expect(add(1, 2)).toBe(3);']);
  });

  it('a test file changed only by a merge from main (adds, removes and edits an assertion): zero counts each', () => {
    let tfc = '';
    const { report, status } = scenario((r) => {
      // main moves on: edits one assertion, removes one, adds one, all in b.test.ts
      r.git('checkout', '-q', 'main');
      r.commit('main edits b', {
        'src/b.test.ts': B_TEST.replace('toBe(1)', 'toBe(10)').replace('    expect(two()).toBe(2);\n', '').replace('    expect(four()).toBe(4);', '    expect(four()).toBe(4);\n    expect(five()).toBe(5);'),
      });
      r.git('checkout', '-q', 'task');
      tfc = r.commit('test first', { 'src/a.test.ts': A_TEST });
      r.git('merge', '-q', '--no-ff', '-m', 'Merge main into task', 'main');
    });
    expect(status).toBe(0);
    expect(report.testFirstCommit).toBe(tfc);
    expect(report.assertionsRemoved).toBe(0);
    expect(report.assertionsChanged).toBe(0);
    expect(report.files).toEqual([]);
  });

  it('the branch own edit of a file that a merge from main also changed is still counted, the merge part is not', () => {
    const { report } = scenario((r) => {
      r.git('checkout', '-q', 'main');
      r.commit('main edits b', { 'src/b.test.ts': B_TEST.replace('toBe(1)', 'toBe(10)').replace('    expect(two()).toBe(2);\n', '') });
      r.git('checkout', '-q', 'task');
      r.commit('test first', { 'src/a.test.ts': A_TEST });
      r.git('merge', '-q', '--no-ff', '-m', 'Merge main into task', 'main');
      r.commit('branch weakens b', { 'src/b.test.ts': B_TEST.replace('toBe(1)', 'toBe(10)').replace('    expect(two()).toBe(2);\n', '').replace('    expect(three()).toBe(3);\n', '') });
    });
    expect(report.assertionsRemoved).toBe(1);
    expect(report.assertionsChanged).toBe(0);
    expect(report.files).toEqual([{ path: 'src/b.test.ts', removed: ['expect(three()).toBe(3);'], changed: [] }]);
  });

  it('a merge commit is skipped when looking for the first test commit', () => {
    let tfc = '';
    const { report } = scenario((r) => {
      r.commit('impl first', { 'src/impl.ts': IMPL + '// x\n' });
      r.git('checkout', '-q', 'main');
      r.commit('main edits b', { 'src/b.test.ts': B_TEST.replace('toBe(1)', 'toBe(10)') });
      r.git('checkout', '-q', 'task');
      r.git('merge', '-q', '--no-ff', '-m', 'Merge main into task', 'main');
      tfc = r.commit('test first', { 'src/a.test.ts': A_TEST });
    });
    expect(report.testFirstCommit).toBe(tfc);
    expect(report.assertionsRemoved + report.assertionsChanged).toBe(0);
  });

  it('a renamed test file: counts unchanged', () => {
    const { report } = scenario((r) => {
      r.commit('test first', { 'src/a.test.ts': A_TEST });
      r.commit('rename', { 'src/a.test.ts': null, 'src/adder.test.ts': A_TEST });
    });
    expect(report.assertionsRemoved).toBe(0);
    expect(report.assertionsChanged).toBe(0);
    expect(report.files).toEqual([]);
  });

  it('a renamed test file with one assertion deleted: counted once, under the new path', () => {
    const { report } = scenario((r) => {
      r.commit('test first', { 'src/a.test.ts': A_TEST });
      r.commit('rename and weaken', {
        'src/a.test.ts': null,
        'src/adder.test.ts': A_TEST.replace('    expect(add(2, 2)).toBe(4);\n', ''),
      });
    });
    expect(report.assertionsRemoved).toBe(1);
    expect(report.files).toEqual([{ path: 'src/adder.test.ts', removed: ['expect(add(2, 2)).toBe(4);'], changed: [] }]);
  });

  it('a deleted test file: every assertion line in it is removed', () => {
    const { report } = scenario((r) => {
      r.commit('test first', { 'src/a.test.ts': A_TEST });
      r.commit('delete', { 'src/a.test.ts': null });
    });
    expect(report.assertionsRemoved).toBe(3);
    expect(report.assertionsChanged).toBe(0);
    expect(report.files).toHaveLength(1);
    expect(report.files[0].path).toBe('src/a.test.ts');
    expect(report.files[0].removed).toEqual(['expect(add(1, 2)).toBe(3);', 'expect(add(2, 2)).toBe(4);', 'expect(add(3, 1)).toBe(add(1, 3));']);
  });

  it('a test file that existed before the branch and is deleted is counted too', () => {
    const { report } = scenario((r) => {
      r.commit('test first', { 'src/a.test.ts': A_TEST });
      r.commit('delete b', { 'src/b.test.ts': null });
    });
    expect(report.assertionsRemoved).toBe(4);
    expect(report.files.map((f) => f.path)).toEqual(['src/b.test.ts']);
  });

  it('a new test file added after the test-first commit is not counted: it did not exist then', () => {
    const { report } = scenario((r) => {
      r.commit('test first', { 'src/a.test.ts': A_TEST });
      r.commit('more tests', { 'src/new.test.ts': "it('n', () => {\n  expect(1).toBe(1);\n});\n" });
      r.commit('and they change', { 'src/new.test.ts': "it('n', () => {\n  expect(1).toBeTruthy();\n});\n" });
    });
    expect(report.assertionsRemoved).toBe(0);
    expect(report.assertionsChanged).toBe(0);
    expect(report.files).toEqual([]);
  });

  it('bodySection is true when a body line starts with "Test edits:"', () => {
    const build = (r: Repo) => {
      r.commit('test first', { 'src/a.test.ts': A_TEST });
    };
    const withSection = scenario(build, { body: 'Summary\n\nTest edits: loosened toBe(3), see commit 2\n\nDecisions:' });
    expect(withSection.report.bodySection).toBe(true);
    const indented = scenario(build, { body: 'see below\n  Test edits: none' });
    expect(indented.report.bodySection).toBe(false);
    const without = scenario(build, { body: 'Summary only, mentions Test edits: mid-line' });
    expect(without.report.bodySection).toBe(false);
  });

  it('a branch with no test commit: testFirstCommit null, zero counts and a note', () => {
    const { report, status } = scenario((r) => {
      r.commit('impl only', { 'src/impl.ts': IMPL + '// y\n' });
    });
    expect(status).toBe(0);
    expect(report.testFirstCommit).toBeNull();
    expect(report.files).toEqual([]);
    expect(report.assertionsRemoved).toBe(0);
    expect(report.assertionsChanged).toBe(0);
    expect(typeof report.note).toBe('string');
    expect(report.note).toMatch(/test/i);
  });

  it('a commit that only deletes a test file is not the test-first commit', () => {
    const { report } = scenario((r) => {
      r.commit('delete b', { 'src/b.test.ts': null });
    });
    expect(report.testFirstCommit).toBeNull();
  });

  it('testGlobs from <repo>/.claude/loop.local.json decide which files are tests', () => {
    const { report } = scenario(
      (r) => {
        r.commit('test first', { 'spec/a.check.ts': A_TEST });
        r.commit('weaken', { 'spec/a.check.ts': A_TEST.replace('    expect(add(2, 2)).toBe(4);\n', '') });
      },
      { globs: ['spec/**'] },
    );
    expect(report.testFirstCommit).not.toBeNull();
    expect(report.assertionsRemoved).toBe(1);
  });

  it('--base overrides the base branch name from gh', () => {
    const r = new Repo();
    const base = r.commit('base', { 'src/impl.ts': IMPL });
    r.git('checkout', '-q', '-b', 'task');
    const tfc = r.commit('test first', { 'src/a.test.ts': A_TEST });
    r.git('update-ref', 'refs/remotes/origin/develop', base);
    const head = r.git('rev-parse', 'HEAD');
    const out = runCli(r, head, { baseRef: 'refs/remotes/origin/develop' }, ['--base', 'develop']);
    expect(out.status).toBe(0);
    expect(out.report.testFirstCommit).toBe(tfc);
    // without --base, gh says main, and origin/main does not exist here: an error, not an empty report
    const wrong = runCli(r, head, { baseRef: 'refs/remotes/origin/develop' });
    expect(wrong.status).toBe(1);
  });

  it('a head commit missing from the repo is fetched once with git fetch origin pull/<pr>/head', () => {
    const origin = new Repo();
    const base = origin.commit('base', { 'src/impl.ts': IMPL });
    origin.git('checkout', '-q', '-b', 'task');
    const tfc = origin.commit('test first', { 'src/a.test.ts': A_TEST });
    const head = origin.commit('weaken', { 'src/a.test.ts': A_TEST.replace('    expect(add(2, 2)).toBe(4);\n', '') });
    origin.git('update-ref', `refs/pull/${PR}/head`, head);
    origin.git('checkout', '-q', 'main');
    origin.git('branch', '-D', 'task');
    expect(base).not.toBe(head);

    const work = new Repo();
    work.git('remote', 'add', 'origin', origin.dir);
    work.git('fetch', '-q', 'origin', 'main:refs/remotes/origin/main');
    expect(() => work.git('cat-file', '-e', `${head}^{commit}`)).toThrow();

    const out = runCli(work, head);
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    expect(out.report.testFirstCommit).toBe(tfc);
    expect(out.report.assertionsRemoved).toBe(1);
    expect(work.git('cat-file', '-t', head)).toBe('commit');
  });

  it('bad usage exits 4 and prints a usage line', () => {
    const res = spawnSync('node', [cli, 'x'], { encoding: 'utf8' });
    expect(res.status).toBe(4);
    expect(res.stdout).toMatch(/usage/i);
  });

  it('a gh failure exits 1 with an error note, not a clean zero report', () => {
    const r = new Repo();
    r.commit('base', { 'src/impl.ts': IMPL });
    const res = spawnSync('node', [cli, '8', '--repo', r.dir], {
      encoding: 'utf8',
      env: { ...GIT_ENV, PATH: `${shimDir}:${process.env.PATH}`, GH_FIXTURE: '/nonexistent' },
    });
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout.trim()).note).toMatch(/gh/);
    expect(existsSync(join(r.dir, '.git'))).toBe(true);
  });
});

describe('isAssertionLine', () => {
  const yes = [
    'expect(add(1, 2)).toBe(3);',
    '    expect(x).toEqual({ a: 1 });',
    'assert(ok);',
    'assert.strictEqual(a, b);',
    'await expect(p).rejects.toThrow();',
    'result.should.equal(3);',
    'expect(list).toHaveLength(2)',
    't.deepEqual(a, b);',
  ];
  const no = [
    'new Date(x).toISOString()',
    'name.toLowerCase()',
    '// expect(a).toBe(1)',
    "it('x', () => {",
    '  * expect(a).toBe(1) in a doc comment',
    'const total = items.length;',
  ];

  it('recognises assertion lines', () => {
    for (const line of yes) expect(isAssertionLine(line), line).toBe(true);
  });

  it('rejects other lines, comments and look-alikes', () => {
    for (const line of no) expect(isAssertionLine(line), line).toBe(false);
  });

  it('is a 12-plus sample set with at least 4 non-assertions', () => {
    expect(yes.length + no.length).toBeGreaterThanOrEqual(12);
    expect(no.length).toBeGreaterThanOrEqual(4);
  });

  it('a block-comment opener is not an assertion', () => {
    expect(isAssertionLine('/* expect(a).toBe(1) */')).toBe(false);
  });
});

describe('isTestFile and testGlobsOf', () => {
  it('uses the default globs', () => {
    expect(DEFAULT_TEST_GLOBS).toEqual(['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**']);
    for (const p of ['a.test.ts', 'src/a.test.ts', 'src/deep/x.spec.js', 'test/helper.js', 'tests/fixtures/a.json']) {
      expect(isTestFile(p, DEFAULT_TEST_GLOBS), p).toBe(true);
    }
    for (const p of ['src/a.ts', 'src/testing.ts', 'docs/tests.md', 'src/test/a.ts']) {
      expect(isTestFile(p, DEFAULT_TEST_GLOBS), p).toBe(false);
    }
  });

  it('globs default when omitted', () => {
    expect(isTestFile('x.test.ts')).toBe(true);
    expect(isTestFile('x.ts')).toBe(false);
  });

  it('testGlobsOf returns the field or the default', () => {
    expect(testGlobsOf({ testGlobs: ['spec/**'] })).toEqual(['spec/**']);
    expect(testGlobsOf({})).toEqual(DEFAULT_TEST_GLOBS);
    expect(testGlobsOf(null)).toEqual(DEFAULT_TEST_GLOBS);
    expect(testGlobsOf({ testGlobs: 'spec/**' })).toEqual(DEFAULT_TEST_GLOBS);
    expect(testGlobsOf({ testGlobs: [] })).toEqual(DEFAULT_TEST_GLOBS);
  });
});

describe('classifyHunks', () => {
  it('pairs the i-th removed assertion line with the i-th added line; the pair is changed only if the added line is an assertion', () => {
    const r = classifyHunks([
      {
        removed: ['expect(a).toBe(1);', 'expect(b).toBe(2);', 'expect(c).toBe(3);'],
        added: ['expect(a).toBeTruthy();', 'const b = 2;'],
      },
    ]);
    expect(r.changed).toEqual([{ before: 'expect(a).toBe(1);', after: 'expect(a).toBeTruthy();' }]);
    expect(r.removed).toEqual(['expect(b).toBe(2);', 'expect(c).toBe(3);']);
  });

  it('removed lines that are not assertions are ignored; a reindented assertion is not an edit', () => {
    const r = classifyHunks([{ removed: ['const x = 1;', '    expect(a).toBe(1);'], added: ['  expect(a).toBe(1);'] }]);
    expect(r.changed).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it('a hunk of only added lines counts nothing', () => {
    const r = classifyHunks([{ removed: [], added: ['expect(a).toBe(1);'] }]);
    expect(r).toEqual({ removed: [], changed: [] });
  });
});
