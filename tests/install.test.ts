import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('install.sh', { timeout: 120_000 }, () => {
  it('links the scripts directory as .claude/scripts and excludes it from git', () => {
    dir = mkdtempSync(join(tmpdir(), 'loop-install-'));
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('bash', [join(ROOT, 'install.sh'), dir], { stdio: 'pipe' });

    const scripts = join(dir, '.claude', 'scripts');
    expect(lstatSync(scripts).isSymbolicLink()).toBe(true);
    expect(readlinkSync(scripts)).toBe(join(ROOT, 'scripts'));
    expect(lstatSync(join(scripts, 'merge-pr.js')).isFile()).toBe(true);
    expect(lstatSync(join(scripts, 'wait-ci.js')).isFile()).toBe(true);

    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(exclude).toContain('.claude/scripts');
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
    expect(status).toBe('');
  });

  it('is idempotent: a second run adds no duplicate exclude lines', () => {
    dir = mkdtempSync(join(tmpdir(), 'loop-install-'));
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('bash', [join(ROOT, 'install.sh'), dir], { stdio: 'pipe' });
    execFileSync('bash', [join(ROOT, 'install.sh'), dir], { stdio: 'pipe' });
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(exclude.filter((l) => l === '.claude/scripts')).toHaveLength(1);
  });

  const ruleOf = (repo: string) => {
    const text = readFileSync(join(repo, '.claude', 'hookify.gh-this-repo.local.md'), 'utf8');
    return { text, pattern: new RegExp(/^pattern:\s*(.+)$/m.exec(text)![1]) };
  };
  const withConfig = (config: object | null) => {
    dir = mkdtempSync(join(tmpdir(), 'loop-install-'));
    execFileSync('git', ['init', '-q', dir]);
    if (config) {
      mkdirSync(join(dir, '.claude'));
      writeFileSync(join(dir, '.claude', 'loop.local.json'), JSON.stringify(config));
    }
    return execFileSync('bash', [join(ROOT, 'install.sh'), dir], { stdio: 'pipe', encoding: 'utf8' });
  };

  it('links the credential rule like the other hookify rules', () => {
    withConfig({ github: 'owner/name' });
    const link = join(dir, '.claude', 'hookify.block-credential-reads.local.md');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(ROOT, 'claude', 'hookify.block-credential-reads.local.md'));
  });

  it('writes (not links) a gh rule for the project github field, excluded from git', () => {
    withConfig({ github: 'owner/name' });
    const file = join(dir, '.claude', 'hookify.gh-this-repo.local.md');
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    const { text, pattern } = ruleOf(dir);
    expect(text).toMatch(/^event:\s*bash\s*$/m);
    expect(text).toMatch(/^action:\s*block\s*$/m);
    expect(text.match(/^pattern:/gm)).toHaveLength(1);
    for (const cmd of [
      'gh pr view 1 -R other/repo',
      'gh pr view 1 -R=other/repo',
      'gh pr view 1 --repo other/repo',
      'gh pr view https://github.com/other/repo/pull/1',
      'gh api repos/other/repo/pulls',
      'gh repo clone other/repo',
    ]) expect(pattern.test(cmd), cmd).toBe(true);
    for (const cmd of [
      'gh pr view 1 -R owner/name',
      'gh api repos/owner/name/pulls',
      'gh pr view 1',
    ]) expect(pattern.test(cmd), cmd).toBe(false);
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(exclude).toContain('.claude/hookify.gh-this-repo.local.md');
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
    expect(status).toBe('');
  });

  it('blocks a name that only starts like the project repository, and a dot is not a wildcard', () => {
    withConfig({ github: 'my-org/my.repo' });
    const { pattern } = ruleOf(dir);
    expect(pattern.test('gh pr view 1 -R my-org/my.repo')).toBe(false);
    expect(pattern.test('gh pr view 1 -R my-org/my.repo-fork')).toBe(true);
    expect(pattern.test('gh pr view 1 -R my-org/myxrepo')).toBe(true);
    expect(pattern.test('gh api repos/my-org/my.repo/issues')).toBe(false);
    expect(pattern.test('gh api repos/my-org/myxrepo/issues')).toBe(true);
    expect(pattern.test('gh repo clone my-org/my.repo')).toBe(false);
  });

  it('writes nothing and says so when there is no github field, or it is not owner/name', () => {
    for (const config of [{}, { github: 'a b/c' }, { github: 'x/y/z' }, { github: 'a/b$(id)' }, { github: 'owner/repo' }, { github: 7 }]) {
      const out = withConfig(config);
      expect(existsSync(join(dir, '.claude', 'hookify.gh-this-repo.local.md')), JSON.stringify(config)).toBe(false);
      expect(out).toMatch(/no gh rule/i);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing when loop.local.json comes from the template, whose github is a placeholder', () => {
    const out = withConfig(null);
    expect(existsSync(join(dir, '.claude', 'hookify.gh-this-repo.local.md'))).toBe(false);
    expect(out).toMatch(/no gh rule/i);
  });

  it('rewrites the gh rule on a second run', () => {
    withConfig({ github: 'owner/name' });
    writeFileSync(join(dir, '.claude', 'loop.local.json'), JSON.stringify({ github: 'owner/other' }));
    execFileSync('bash', [join(ROOT, 'install.sh'), dir], { stdio: 'pipe' });
    expect(ruleOf(dir).pattern.test('gh pr view 1 -R owner/other')).toBe(false);
    expect(ruleOf(dir).pattern.test('gh pr view 1 -R owner/name')).toBe(true);
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(exclude.filter((l) => l === '.claude/hookify.gh-this-repo.local.md')).toHaveLength(1);
  });
});
