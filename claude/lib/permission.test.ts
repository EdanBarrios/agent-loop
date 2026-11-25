import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { checkPermission } from './permission.js';

// Warden wave 4 (2026-11-17) was refused at its first merge: the permission system declined the merge script and nothing
// said so before the wave spent its tokens. checkPermission reads the settings files and predicts the refusal.
const ROOT = join(import.meta.dirname, '..', '..');
const run = promisify(execFile);

const SCRIPT = '/work/proj/.claude/scripts/merge-pr.js';
const COMMAND = `node ${SCRIPT} 7 --repo /work/proj --worktree /work/proj-worktrees/1.1`;
const USER = '/home/u/.claude/settings.json';
const PROJECT = '/work/proj/.claude/settings.json';
const LOCAL = '/work/proj/.claude/settings.local.json';

const doc = (path: string, json: unknown) => ({ path, json });
const allow = (...rules: string[]) => ({ permissions: { allow: rules } });

describe('checkPermission', () => {
  it('allows a command named by an exact rule', () => {
    const r = checkPermission(COMMAND, [doc(USER, allow(`Bash(${COMMAND})`))]);
    expect(r.allowed).toBe(true);
    expect(r.rule).toBe(`Bash(${COMMAND})`);
    expect(r.source).toBe(USER);
    expect(r.denied).toBeNull();
    expect(r.broad).toEqual([]);
  });

  it('allows a command under a :* prefix rule, and the bare prefix', () => {
    const rule = `Bash(node ${SCRIPT}:*)`;
    const r = checkPermission(COMMAND, [doc(PROJECT, allow(rule))]);
    expect(r).toMatchObject({ allowed: true, rule, source: PROJECT });
    expect(checkPermission(`node ${SCRIPT}`, [doc(PROJECT, allow(rule))]).allowed).toBe(true);
  });

  it('allows a command under a " *" prefix rule, and the bare prefix', () => {
    const rule = `Bash(node ${SCRIPT} *)`;
    const r = checkPermission(COMMAND, [doc(LOCAL, allow(rule))]);
    expect(r).toMatchObject({ allowed: true, rule, source: LOCAL });
    expect(checkPermission(`node ${SCRIPT}`, [doc(LOCAL, allow(rule))]).allowed).toBe(true);
  });

  it('does not let a prefix match run on into another word', () => {
    const r = checkPermission(`node ${SCRIPT}x 7`, [doc(USER, allow(`Bash(node ${SCRIPT} *)`))]);
    expect(r.allowed).toBe(false);
  });

  it('matches a * in the middle of a rule', () => {
    const r = checkPermission(COMMAND, [doc(USER, allow(`Bash(node ${SCRIPT} * --repo /work/proj *)`))]);
    expect(r.allowed).toBe(true);
  });

  it('does not allow a prefix rule for another path', () => {
    const r = checkPermission(COMMAND, [doc(USER, allow('Bash(node /elsewhere/.claude/scripts/merge-pr.js *)', 'Bash(node /work/other/.claude/scripts/merge-pr.js:*)'))]);
    expect(r).toMatchObject({ allowed: false, rule: null, source: null, denied: null });
  });

  it('lets a deny rule override an allow, in any file', () => {
    const r = checkPermission(COMMAND, [
      doc(USER, allow(`Bash(node ${SCRIPT} *)`)),
      doc(PROJECT, { permissions: { deny: [`Bash(node ${SCRIPT}:*)`] } }),
    ]);
    expect(r.allowed).toBe(false);
    expect(r.denied).toBe(`Bash(node ${SCRIPT}:*)`);
    expect(r.rule).toBeNull();
  });

  it('lets an ask rule override an allow: a relay cannot answer a prompt', () => {
    const r = checkPermission(COMMAND, [doc(USER, { permissions: { allow: [`Bash(node ${SCRIPT} *)`], ask: [`Bash(node ${SCRIPT} *)`] } })]);
    expect(r.allowed).toBe(false);
    expect(r.ask).toBe(`Bash(node ${SCRIPT} *)`);
    expect(r.denied).toBeNull();
  });

  it('reads the deny and ask rules of managed settings, and nothing else from them', () => {
    const managed = '/etc/claude-code/managed-settings.json';
    const denyAll = checkPermission(COMMAND, [doc(USER, allow(`Bash(node ${SCRIPT} *)`)), doc(managed, { permissions: { deny: ['Bash(node *)'] } })]);
    expect(denyAll).toMatchObject({ allowed: false, denied: 'Bash(node *)' });
    const allowOnly = checkPermission(COMMAND, [doc(managed, allow(`Bash(node ${SCRIPT} *)`))]);
    expect(allowOnly.allowed).toBe(false);
  });

  it('counts autoMode.allow prose entries and never treats them as an allow', () => {
    const r = checkPermission(COMMAND, [doc(USER, { autoMode: { allow: ['Merging pull requests with the loop script is fine', 'Reading files is fine'] } })]);
    expect(r.allowed).toBe(false);
    expect(r.autoModeRules).toBe(2);
    expect(r.rule).toBeNull();
  });

  it('returns broad allow rules as broad and never allows on them', () => {
    const broad = ['Bash', 'Bash(*)', 'Bash(node *)', 'Bash(node*)', 'Bash(node /work/proj/.claude/scripts/*)'];
    const r = checkPermission(COMMAND, [doc(USER, allow(...broad, 'Bash(npm run check)', 'Read(*)'))]);
    expect(r.allowed).toBe(false);
    expect(r.rule).toBeNull();
    expect(r.broad).toEqual(broad);
  });

  it('takes the narrow rule when a broad one matches too', () => {
    const r = checkPermission(COMMAND, [doc(USER, allow('Bash(node *)', `Bash(node ${SCRIPT} *)`))]);
    expect(r).toMatchObject({ allowed: true, rule: `Bash(node ${SCRIPT} *)` });
    expect(r.broad).toEqual(['Bash(node *)']);
  });

  it('lists a missing file and a malformed file in checked with a fixed error, and skips them', () => {
    const secret = 'sk-live-0123456789abcdef-SECRET';
    const r = checkPermission(COMMAND, [
      doc(USER, null),
      doc(PROJECT, `{"permissions": {"allow": ["Bash(node ${SCRIPT} *)"]} ${secret}`),
      doc(LOCAL, allow(`Bash(node ${SCRIPT} *)`)),
    ]);
    expect(r.checked).toEqual([
      { path: USER, error: 'missing' },
      { path: PROJECT, error: 'unparseable' },
      { path: LOCAL, error: null },
    ]);
    expect(r).toMatchObject({ allowed: true, source: LOCAL });
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('skips a malformed file: its rules do not count', () => {
    const r = checkPermission(COMMAND, [doc(USER, `{"permissions": {"allow": ["Bash(node ${SCRIPT} *)"]`)]);
    expect(r.allowed).toBe(false);
    expect(r.checked).toEqual([{ path: USER, error: 'unparseable' }]);
  });

  it('accepts already parsed settings, and ignores entries that are not rules', () => {
    const r = checkPermission(COMMAND, [doc(USER, { permissions: { allow: [3, null, `Bash(node ${SCRIPT} *)`], deny: 'nope' }, autoMode: 'x' })]);
    expect(r).toMatchObject({ allowed: true, autoModeRules: 0 });
    expect(checkPermission(COMMAND, [doc(USER, [1, 2])]).checked).toEqual([{ path: USER, error: 'unparseable' }]);
  });

  it('gives the empty shape with no settings at all', () => {
    expect(checkPermission(COMMAND, [])).toEqual({ allowed: false, rule: null, source: null, denied: null, ask: null, broad: [], autoModeRules: 0, checked: [] });
  });
});

// Each test spawns node and git; a machine under load needs far more than vitest's 5 s.
describe('merge-pr.js --dry-run permission', { timeout: 240000 }, () => {
  const SCRIPTS = join(ROOT, 'scripts');

  async function dryRun(settings: { user?: unknown; project?: unknown; local?: unknown; userRaw?: string }, args: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'loop-perm-'));
    try {
      mkdirSync(join(dir, 'repo', '.claude'), { recursive: true });
      mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'repo', '.claude', 'loop.local.json'), '{"name":"X"}');
      writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/sh\necho "no pull requests found" >&2\nexit 1\n');
      chmodSync(join(dir, 'bin', 'gh'), 0o755);
      if (settings.user !== undefined) writeFileSync(join(dir, 'home', '.claude', 'settings.json'), JSON.stringify(settings.user));
      if (settings.userRaw !== undefined) writeFileSync(join(dir, 'home', '.claude', 'settings.json'), settings.userRaw);
      if (settings.project !== undefined) writeFileSync(join(dir, 'repo', '.claude', 'settings.json'), JSON.stringify(settings.project));
      if (settings.local !== undefined) writeFileSync(join(dir, 'repo', '.claude', 'settings.local.json'), JSON.stringify(settings.local));
      const res = await run('node', [join(SCRIPTS, 'merge-pr.js'), '0', '--repo', join(dir, 'repo'), '--dry-run', ...args], {
        env: { ...process.env, HOME: join(dir, 'home'), PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
      }).catch((e: { stdout: string }) => e);
      const stdout = String(res.stdout);
      return { line: JSON.parse(stdout.trim().split('\n').pop() as string), stdout, dir };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('prints permission.allowed true with the matching rule when a rule names the script', async () => {
    const rule = `Bash(node ${join(SCRIPTS, 'merge-pr.js')} *)`;
    const { line, dir } = await dryRun({ user: allow(rule) });
    expect(line.permission.allowed).toBe(true);
    expect(line.permission.rule).toBe(rule);
    expect(line.permission.source).toBe(join(dir, 'home', '.claude', 'settings.json'));
    expect(line.permission.checked).toEqual([
      { path: join(dir, 'home', '.claude', 'settings.json'), error: null },
      { path: join(dir, 'repo', '.claude', 'settings.json'), error: 'missing' },
      { path: join(dir, 'repo', '.claude', 'settings.local.json'), error: 'missing' },
    ]);
  });

  it('prints permission.allowed false without a rule', async () => {
    const { line } = await dryRun({ user: allow('Bash(npm run check)') });
    expect(line.permission).toMatchObject({ allowed: false, rule: null, source: null, denied: null });
  });

  it('is allowed only when every command form the workflow runs is allowed', async () => {
    const merge = `Bash(node ${join(SCRIPTS, 'merge-pr.js')} * --repo * --worktree *)`;
    const partial = await dryRun({ user: allow(merge) });
    expect(partial.line.permission.allowed).toBe(false); // --verify-main and --state are refused
    // The project's settings.local.json counts too.
    const all = await dryRun({ local: allow(merge, `Bash(node ${join(SCRIPTS, 'merge-pr.js')} * --repo * --verify-main *)`, `Bash(node ${join(SCRIPTS, 'merge-pr.js')}:*)`) });
    expect(all.line.permission).toMatchObject({ allowed: true, source: join(all.dir, 'repo', '.claude', 'settings.local.json') });
  });

  it('prints nothing of a malformed settings file', async () => {
    const secret = 'sk-live-0123456789abcdef-SECRET';
    const { line, stdout } = await dryRun({ userRaw: `{"permissions": ${secret}` });
    expect(line.permission.allowed).toBe(false);
    expect(line.permission.checked[0]).toMatchObject({ error: 'unparseable' });
    expect(stdout).not.toContain(secret);
  });
});
