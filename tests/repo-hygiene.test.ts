import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// PR #41 committed a node_modules symlink from a worktree (the ignore rule "node_modules/" matches only directories);
// pulling it replaced the real node_modules with a link to itself. The repo tracks no symlink and no node_modules.
const root = join(import.meta.dirname, '..');
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-s'], { encoding: 'utf8' }).trim().split('\n');

describe('repo hygiene', () => {
  it('tracks no symlink', () => {
    expect(tracked.filter((l) => l.startsWith('120000 '))).toEqual([]);
  });

  it('tracks nothing under or named node_modules', () => {
    expect(tracked.filter((l) => /(^|\/)node_modules(\/|$)/.test(l.split('\t')[1] ?? ''))).toEqual([]);
  });

  it('ignores node_modules whether it is a directory or a symlink', () => {
    const out = execFileSync('git', ['-C', root, 'check-ignore', '--no-index', 'node_modules'], { encoding: 'utf8' });
    expect(out.trim()).toBe('node_modules');
  });
});
