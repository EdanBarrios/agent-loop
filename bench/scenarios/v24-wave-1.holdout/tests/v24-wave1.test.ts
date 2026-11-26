import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { classifyFailure } from '../claude/lib/pause.js';

// Wave 1 tail of v2.4: the five pure modules (permission check, test-edit report, usage-limit classification, wave
// token estimate, test-impact map) run together on fixtures, the way the loop's own scripts will call them.
const root = join(import.meta.dirname, '..');
const scripts = join(root, 'scripts');

const scratch = mkdtempSync(join(tmpdir(), 'v24-wave1-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let counter = 0;
const fresh = (label: string) => {
  const dir = join(scratch, `${label}${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir: string, path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function lastJsonLine(stdout: string) {
  return JSON.parse(stdout.trim().split('\n').pop() ?? '');
}

describe('v2.4 wave 1 modules together', { timeout: 240_000 }, () => {
  it('merge dry run: a settings file without the rule is not allowed, one with the rule is', () => {
    const dryRun = (settings: unknown) => {
      const dir = fresh('perm');
      mkdirSync(join(dir, 'repo', '.claude'), { recursive: true });
      mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
      mkdirSync(join(dir, 'bin'));
      write(dir, 'repo/.claude/loop.local.json', '{"name":"X"}');
      write(dir, 'bin/gh', '#!/bin/sh\necho "no pull requests found" >&2\nexit 1\n');
      chmodSync(join(dir, 'bin', 'gh'), 0o755);
      write(dir, 'home/.claude/settings.json', JSON.stringify(settings));
      const res = spawnSync('node', [join(scripts, 'merge-pr.js'), '0', '--repo', join(dir, 'repo'), '--dry-run'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: join(dir, 'home'), PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
      });
      return lastJsonLine(res.stdout).permission;
    };
    const without = dryRun({ permissions: { allow: ['Bash(npm run check)'] } });
    expect(without).toMatchObject({ allowed: false, rule: null, source: null });
    const rule = `Bash(node ${join(scripts, 'merge-pr.js')}:*)`;
    const withRule = dryRun({ permissions: { allow: [rule] } });
    expect(withRule).toMatchObject({ allowed: true, rule });
  });

  it('test edits: a PR branch that weakens an assertion reports assertionsChanged 1 and no Test edits section', () => {
    const dir = fresh('edits');
    const shim = join(dir, 'bin');
    mkdirSync(shim);
    write(dir, 'bin/gh', [
      '#!/bin/sh',
      'if [ "$1 $2 $3 $4 $5" = "pr view 7 --json commits,body,baseRefName,headRefOid" ]; then cat "$GH_FIXTURE"; exit 0; fi',
      'echo "unexpected gh $*" >&2',
      'exit 1',
      '',
    ].join('\n'));
    chmodSync(join(shim, 'gh'), 0o755);

    const repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    const commit = (message: string, files: Record<string, string>) => {
      for (const [path, text] of Object.entries(files)) write(repo, path, text);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', message);
    };
    const TEST = "it('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n";
    commit('base', { 'src/impl.ts': 'export const add = (a: number, b: number) => a + b;\n' });
    git(repo, 'checkout', '-q', '-b', 'task');
    commit('test first', { 'src/impl.test.ts': TEST });
    commit('weaken', { 'src/impl.test.ts': TEST.replace('toBe(3)', 'toBeGreaterThan(0)') });
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'main'));
    const commits = git(repo, 'rev-list', '--reverse', `refs/remotes/origin/main..${head}`).split('\n').map((oid) => ({ oid }));
    const fixture = join(dir, 'gh.json');
    writeFileSync(fixture, JSON.stringify({ commits, body: 'Files changed: src/impl.test.ts', baseRefName: 'main', headRefOid: head }));

    const res = spawnSync('node', [join(scripts, 'test-edits.js'), '7', '--repo', repo], {
      encoding: 'utf8',
      env: { ...GIT_ENV, PATH: `${shim}:${process.env.PATH}`, GH_FIXTURE: fixture },
    });
    expect(res.status, res.stderr).toBe(0);
    const report = lastJsonLine(res.stdout);
    expect(report.assertionsChanged).toBe(1);
    expect(report.assertionsRemoved).toBe(0);
    expect(report.bodySection).toBe(false);
    expect(report.files).toEqual([
      { path: 'src/impl.test.ts', removed: [], changed: [{ before: 'expect(add(1, 2)).toBe(3);', after: 'expect(add(1, 2)).toBeGreaterThan(0);' }] },
    ]);
  });

  it('usage limit: the Warden wave 4 message is a far-out usage limit, with a clock and without one', () => {
    const message =
      "failed: usage limit; resets Nov 19 at 12pm (America/Los_Angeles), too far out to wait for: You've hit your weekly limit · resets Nov 19 at 12pm (America/Los_Angeles)";
    expect(classifyFailure(message, Date.UTC(2026, 10, 16, 20))).toEqual({ kind: 'usage_limit', resetsAt: 1795118400000, farOut: true });
    expect(classifyFailure(message, null)).toEqual({ kind: 'usage_limit', resetsAt: null, farOut: true });
  });

  it('wave-args: prints an estimate from fixture scorecards', () => {
    const repo = fresh('args');
    write(repo, '.claude/loop.local.json', JSON.stringify({ name: 'Sim', spec: 'docs/spec.md' }));
    write(repo, 'docs/spec.md', [
      '# Spec',
      '',
      '## End goal\n\nShip it.',
      '',
      '## Invariants\n\n1. Never commit to the default branch.',
      '',
      '## Budget\n\nNo paid calls.',
      '',
      '## Decision envelope\n\nReversible and free.',
      '',
      '## Fixed decisions\n\n- Node.',
      '',
      '## Human checklist\n\n| id | before | what | why |\n|---|---|---|---|\n| H1 | 0 | Repo | needed |',
      '',
      '## Wave 1: first',
      '',
      '- **1.1 First.** Owns `lib/a.js`. Test: a.',
      '- **1.2 Second.** Owns `lib/b.js`. Test: b.',
      '',
      '### Tail',
      '',
      '- **1.T Tail.** Depends on 1.1 and 1.2. Owns `tests/tail.test.ts`. Test: both.',
      '',
    ].join('\n'));
    const cards = join(repo, 'docs', 'scorecards');
    mkdirSync(cards);
    const fixtures = join(root, 'tests', 'fixtures');
    copyFileSync(join(fixtures, 'wave-scorecard-a.md'), join(cards, '2026-11-10-wave-1-loop.md'));
    copyFileSync(join(fixtures, 'wave-scorecard-b.md'), join(cards, '2026-11-11-wave-2-loop.md'));
    copyFileSync(join(fixtures, 'wave-scorecard-c.md'), join(cards, '2026-11-12-wave-3-loop.md'));

    const res = spawnSync('node', [join(scripts, 'wave-args.js'), '--repo', repo, '--wave', '1', '--scorecards', 'docs/scorecards'], { encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain('wave-args: estimated 4.5M tokens for 3 tasks (median of ');
    const args = JSON.parse(res.stdout);
    expect(args.budget).toMatchObject({ tasks: 3, tokensPerTask: 1_500_000, estimate: 4_500_000 });
    expect(args.budget.basis).toHaveLength(3);
  });

  it('impact: lists the test that imports a changed module, directly and through one module', () => {
    const repo = fresh('impact');
    git(repo, 'init', '-q', '-b', 'main');
    write(repo, 'src/core.ts', 'export const core = 1;\n');
    write(repo, 'src/mid.ts', "export { core } from './core';\n");
    write(repo, 'src/other.ts', 'export const other = 2;\n');
    write(repo, 'tests/core.test.ts', "import { core } from '../src/core';\nexpect(core).toBe(1);\n");
    write(repo, 'tests/mid.test.ts', "import { core } from '../src/mid';\nexpect(core).toBe(1);\n");
    write(repo, 'tests/other.test.ts', "import { other } from '../src/other';\nexpect(other).toBe(2);\n");
    git(repo, 'add', '-A');

    const res = spawnSync('node', [join(scripts, 'impact.js'), '--repo', repo, '--owns', 'src/core.ts'], { encoding: 'utf8', env: GIT_ENV });
    expect(res.status, res.stderr).toBe(0);
    const { tests } = JSON.parse(res.stdout) as { tests: Array<{ path: string; via: string | null; owner: string | null }> };
    expect(Object.fromEntries(tests.map((t) => [t.path, t.via]))).toEqual({
      'tests/core.test.ts': null,
      'tests/mid.test.ts': 'src/mid.ts',
    });
    expect(tests.map((t) => t.path)).not.toContain('tests/other.test.ts');
  });
});
