import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Task 3.T: the v2.1 release record. The release doc is a human-facing record of the build; this test keeps it
// honest where a machine can: the tag and the held items are written down, the timings section equals what
// `loop-scorecard.py --timings` prints for the build's result JSONs (or says n/a when there are none), and every
// file the doc names exists. It does not run `npm run check` (that would recurse); the doc records the command
// and CI runs it on main.
const root = join(import.meta.dirname, '..');
const docPath = join(root, 'docs', 'agent-loop-v2', 'RELEASE-v2.1.md');
const doc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';

// The text under a "## <heading>" line, up to the next "## " line.
function section(heading: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).trim().toLowerCase().startsWith(heading.toLowerCase()));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

describe('RELEASE-v2.1.md', () => {
  it('exists and records the check command', () => {
    expect(doc.length).toBeGreaterThan(0);
    expect(doc).toContain('npm run check');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.check).toBeTruthy();
  });

  it('records the tag to cut as human step H1 and that the loop does not cut it', () => {
    const s = section('Tag to cut');
    expect(s).toMatch(/`v2\.1`/);
    expect(s).toContain('H1');
    expect(s).toMatch(/agent-loop-stable/);
    expect(s).toMatch(/not (made|cut|moved) by the loop/i);
  });

  it('records the --timings table of this build, or n/a when no result JSON is available', () => {
    const s = section('Timings');
    expect(s).toContain('--timings');
    const dir = join(root, 'docs', 'agent-loop-v2');
    const results = readdirSync(dir).filter((f) => /result.*\.json$/.test(f)).sort();
    if (results.length === 0) {
      expect(s).toMatch(/\bn\/a\b/);
      expect(s).not.toContain('| Task |');
    } else {
      const table = execFileSync('python3', ['-I', join(root, 'scripts', 'loop-scorecard.py'), '--timings', ...results.map((f) => join(dir, f))], { encoding: 'utf8' });
      const body = table.split('\n').filter((l) => l.startsWith('|') || l.startsWith('- '));
      for (const line of body) expect(s).toContain(line);
    }
  });

  it('states whether README v2 wave 5 (5.1) still needs the new config rows', () => {
    const s = section('README');
    expect(s).toContain('5.1');
    expect(s).toMatch(/still needs/i);
    for (const key of ['merger', 'fastLane', 'quickCheck', 'loopScripts']) expect(s).toContain(`\`${key}\``);
  });

  it('states that install.sh must link the scripts directory or projects must set loopScripts', () => {
    const s = section('Install');
    expect(s).toContain('install.sh');
    expect(s).toContain('.claude/scripts');
    expect(s).toContain('`loopScripts`');
    expect(s).toMatch(/merge-pr\.js/);
    expect(s).toMatch(/wait-ci\.js/);
  });

  it('lists the items held for Edan', () => {
    const s = section('Held');
    expect(s).toContain('H2');
    expect(s).toMatch(/fast lane/i);
    expect(s).toContain('denyPaths');
    expect(s).toContain('H3');
    expect(s).toMatch(/runner/i);
    expect(s).toMatch(/Bash allow rule/i);
    expect(s).toContain('merge-pr.js');
    expect(s).toMatch(/stable (link|tag)/i);
  });

  it('names only files that exist', () => {
    const named = [...doc.matchAll(/`((?:scripts|claude|tests|docs|templates)\/[A-Za-z0-9_./-]+\.[a-z]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const p of new Set(named)) expect(existsSync(join(root, p)), p).toBe(true);
  });

  it('contains no secrets, street addresses or personal data markers', () => {
    expect(doc).not.toMatch(/\/Users\/[a-z]/);
    expect(doc).not.toMatch(/@[a-z0-9-]+\.(com|org|net)\b/i);
  });
});
