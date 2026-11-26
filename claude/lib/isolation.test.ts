import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { checkIsolation, DENY_READS, readSettingsDocs, settingsPaths } from './isolation.js';

// Task 3.4: the loop can only check and warn about isolation (invariant 6). checkIsolation reads four settings files
// (managed, project local, project, user) and says whether the sandbox is on and which credential reads are denied.
const ROOT = join(import.meta.dirname, '..', '..');
const run = promisify(execFile);

const MANAGED = '/etc/claude-code/managed-settings.json';
const LOCAL = '/work/proj/.claude/settings.local.json';
const PROJECT = '/work/proj/.claude/settings.json';
const USER = '/home/u/.claude/settings.json';
const doc = (path: string, json: unknown) => ({ path, json });
const deny = (...rules: string[]) => ({ permissions: { deny: rules } });
const RULES = [
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.config/gh/**)',
  'Read(~/.netrc)',
  'Read(**/.env*)',
];

describe('checkIsolation', () => {
  it('lists the five credential read rules in a fixed order', () => {
    expect(DENY_READS).toEqual(RULES);
  });

  it('reports a sandbox that is on, the rules present and nothing to warn about', () => {
    const r = checkIsolation([doc(USER, { sandbox: { enabled: true }, ...deny(...RULES) })]);
    expect(r).toEqual({ sandbox: { enabled: true, source: USER }, denyReads: { present: RULES, missing: [] }, warnings: [] });
  });

  it('warns about a missing sandbox key and every missing deny rule, in the fixed wording and order', () => {
    const r = checkIsolation([doc(USER, {})]);
    expect(r.sandbox).toEqual({ enabled: false, source: null });
    expect(r.denyReads).toEqual({ present: [], missing: RULES });
    expect(r.warnings).toEqual(['sandbox is not enabled', ...RULES.map((x) => `deny rule missing: ${x}`)]);
  });

  it.each(RULES)('names %s as missing when only the other four are present', (rule) => {
    const others = RULES.filter((x) => x !== rule);
    const r = checkIsolation([doc(USER, { sandbox: { enabled: true }, ...deny(...others) })]);
    expect(r.denyReads).toEqual({ present: others, missing: [rule] });
    expect(r.warnings).toEqual([`deny rule missing: ${rule}`]);
  });

  it('counts a deny rule from any file and ignores the same text under allow or ask', () => {
    const r = checkIsolation([
      doc(MANAGED, deny(RULES[0])),
      doc(LOCAL, deny(RULES[1], RULES[2])),
      doc(PROJECT, { permissions: { allow: [RULES[3]], ask: [RULES[4]] } }),
      doc(USER, deny('Read(~/.ssh/**)')),
    ]);
    expect(r.denyReads.present).toEqual(RULES.slice(0, 3));
    expect(r.denyReads.missing).toEqual(RULES.slice(3));
  });

  it('treats sandbox.enabled false and a non-boolean as not enabled, and names the file that set false', () => {
    expect(checkIsolation([doc(USER, { sandbox: { enabled: false } })]).sandbox).toEqual({ enabled: false, source: USER });
    expect(checkIsolation([doc(USER, { sandbox: { enabled: 'yes' } })]).sandbox).toEqual({ enabled: false, source: null });
    expect(checkIsolation([doc(USER, { sandbox: true })]).sandbox).toEqual({ enabled: false, source: null });
  });

  it('takes the source in the order managed, project local, project, user', () => {
    const on = { sandbox: { enabled: true } };
    expect(checkIsolation([doc(MANAGED, on), doc(LOCAL, on), doc(PROJECT, on), doc(USER, on)]).sandbox.source).toBe(MANAGED);
    expect(checkIsolation([doc(MANAGED, {}), doc(LOCAL, on), doc(PROJECT, on), doc(USER, on)]).sandbox.source).toBe(LOCAL);
    expect(checkIsolation([doc(MANAGED, {}), doc(LOCAL, {}), doc(PROJECT, on), doc(USER, on)]).sandbox.source).toBe(PROJECT);
    expect(checkIsolation([doc(MANAGED, {}), doc(LOCAL, {}), doc(PROJECT, {}), doc(USER, on)]).sandbox.source).toBe(USER);
  });

  it('lets the first file that sets the key decide, so a managed false wins over a user true', () => {
    const r = checkIsolation([doc(MANAGED, { sandbox: { enabled: false } }), doc(USER, { sandbox: { enabled: true } })]);
    expect(r.sandbox).toEqual({ enabled: false, source: MANAGED });
    expect(r.warnings).toContain('sandbox is not enabled');
  });

  it('lists a malformed file as a warning and carries on with the others', () => {
    const r = checkIsolation([doc(PROJECT, '{ not json'), doc(USER, JSON.stringify({ sandbox: { enabled: true }, ...deny(...RULES) }))]);
    expect(r.warnings).toEqual([`settings file unparseable: ${PROJECT}`]);
    expect(r.sandbox).toEqual({ enabled: true, source: USER });
    expect(r.denyReads.missing).toEqual([]);
  });

  it('lists a file that parses to a non-object as unparseable, and a missing file as nothing', () => {
    const r = checkIsolation([doc(LOCAL, '[1]'), doc(PROJECT, null), doc(USER, JSON.stringify({ sandbox: { enabled: true }, ...deny(...RULES) }))]);
    expect(r.warnings).toEqual([`settings file unparseable: ${LOCAL}`]);
  });

  it('never quotes the file content in a warning', () => {
    const r = checkIsolation([doc(USER, '{"token": "not-a-real-secret",')]);
    expect(JSON.stringify(r)).not.toContain('not-a-real-secret');
  });
});

describe('settingsPaths', () => {
  it('orders managed, project local, project, user', () => {
    const paths: string[] = settingsPaths('/home/u', '/work/proj');
    expect(paths.slice(-3)).toEqual(['/work/proj/.claude/settings.local.json', '/work/proj/.claude/settings.json', '/home/u/.claude/settings.json']);
    expect(paths.slice(0, -3).every((p) => p.endsWith('managed-settings.json'))).toBe(true);
    expect(paths.length).toBeGreaterThan(3);
  });
});

describe('readSettingsDocs', () => {
  it('reads each path through the injected reader and gives null for one that cannot be read', () => {
    const docs = readSettingsDocs(['/a', '/b'], (p: string) => {
      if (p === '/a') return '{}';
      throw new Error('ENOENT');
    });
    expect(docs).toEqual([
      { path: '/a', json: '{}' },
      { path: '/b', json: null },
    ]);
  });
});

describe('scripts/isolation.js', { timeout: 60_000 }, () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('prints one JSON line with sandbox, denyReads and warnings, and writes no file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'loop-isolation-'));
    const home = join(dir, 'home');
    const repo = join(dir, 'repo');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [RULES[0]] } }));
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{ broken');
    const { stdout } = await run('node', [join(ROOT, 'scripts', 'isolation.js'), '--repo', repo], { env: { ...process.env, HOME: home } });
    expect(stdout.trim().split('\n')).toHaveLength(1);
    const out = JSON.parse(stdout);
    expect(Object.keys(out)).toEqual(['sandbox', 'denyReads', 'warnings']);
    expect(out.denyReads.present).toEqual([RULES[0]]);
    expect(out.warnings).toContain(`settings file unparseable: ${join(repo, '.claude', 'settings.local.json')}`);
    expect(out.warnings).toContain(`deny rule missing: ${RULES[1]}`);
  });

  it('exits non-zero with a usage line without --repo', async () => {
    await expect(run('node', [join(ROOT, 'scripts', 'isolation.js')])).rejects.toMatchObject({ code: 4 });
  });
});
