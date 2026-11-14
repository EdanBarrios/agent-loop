import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
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
});
