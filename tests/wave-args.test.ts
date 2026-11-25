import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, slug, waveArgs } from '../scripts/wave-args.js';

// The session built Warden's wave 1 args by hand and got a dependency wrong; this script builds them from the spec.
const root = join(import.meta.dirname, '..');
const script = join(root, 'scripts', 'wave-args.js');

const SECTIONS = [
  '## End goal\n\nShip it.',
  '## Invariants\n\n1. Never commit to the default branch.',
  '## Budget\n\nNo paid calls.',
  '## Decision envelope\n\nReversible and free.',
  '## Fixed decisions\n\n- Node.',
  '## Human checklist\n\n| id | before | what | why |\n|---|---|---|---|\n| H1 | 0 | Repo | needed |',
].join('\n\n');

const SPEC = `# Spec

${SECTIONS}

## Wave 1: first

- **1.1 Pure module.** Owns \`lib/a.js\`, \`lib/a.test.ts\`. Adds a function. Test: a table of cases. Lane: fast.
- **1.2 Second module.** Depends on 1.1. Owns \`lib/b.js\` and \`lib/b.test.ts\`. Test: cases
  that continue on a second line. Lane: normal.

### Tail

- **1.T Tail.** Depends on 1.1 and 1.2. Owns \`tests/tail.test.ts\`. Test: everything together.

## Wave 2: second

- **2.1 Uses wave 1.** Depends on 1.2. Owns \`lib/c.js\`, \`lib/c.test.ts\`. Test: c works.
- **2.2 Another.** Depends on 2.1. Owns \`lib/d.js\`, \`lib/d.test.ts\`. Test: d works.
- **2.3 Third.** Owns \`lib/e.js\`, \`lib/e.test.ts\`. Test: e works.
`;

const project = { name: 'Sim', spec: 'docs/spec.md' };

describe('wave-args', { timeout: 120_000 }, () => {
  it('builds tasks with verbatim text, owned paths, same-wave deps, lane and branch, and the .T tail', () => {
    const r = waveArgs({ project, specText: SPEC, wave: '1', notes: 'n' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { args } = r;
    expect(args.project).toBe(project);
    expect(args.wave).toBe('1');
    expect(args.tasks.map((t: { id: string }) => t.id)).toEqual(['1.1', '1.2']);
    const [a, b] = args.tasks;
    expect(a).toEqual({
      id: '1.1',
      title: 'Pure module',
      branch: 'task/1.1-pure-module',
      deps: [],
      text: '**1.1 Pure module.** Owns `lib/a.js`, `lib/a.test.ts`. Adds a function. Test: a table of cases. Lane: fast.',
      owns: '`lib/a.js`, `lib/a.test.ts`',
      notes: 'n',
      lane: 'fast',
    });
    expect(b.deps).toEqual(['1.1']);
    expect(b.text).toContain('\n  that continue on a second line.');
    expect(b.text).toBe(b.text.trimEnd());
    expect(b.owns).toBe('`lib/b.js`, `lib/b.test.ts`');
    expect(args.tail.id).toBe('1.T');
    expect(args.tail.deps).toEqual(['1.1', '1.2']);
  });

  it('drops dependencies on earlier waves, keeps spec order, and gives a null tail when the wave has none', () => {
    const r = waveArgs({ project, specText: SPEC, wave: '2' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.tasks.map((t: { id: string; deps: string[] }) => [t.id, t.deps])).toEqual([['2.1', []], ['2.2', ['2.1']], ['2.3', []]]);
    expect(r.args.tail).toBeNull();
    expect(r.args.tasks[2].lane).toBe('normal');
  });

  it('takes --tail as the tail, and refuses a tail id that is not in the wave', () => {
    const r = waveArgs({ project, specText: SPEC, wave: '2', tail: '2.3' });
    expect(r.ok && r.args.tail.id).toBe('2.3');
    expect(r.ok && r.args.tasks.map((t: { id: string }) => t.id)).toEqual(['2.1', '2.2']);
    const bad = waveArgs({ project, specText: SPEC, wave: '2', tail: '1.T' });
    expect(bad.ok).toBe(false);
  });

  it('refuses a spec that fails spec-lint, and a wave with no tasks', () => {
    const broken = waveArgs({ project, specText: SPEC.replace('## Budget\n\nNo paid calls.', ''), wave: '1' });
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.errors.join(' ')).toContain('Budget');
    const none = waveArgs({ project, specText: SPEC, wave: '7' });
    expect(!none.ok && none.errors.join(' ')).toContain('wave 7');
  });

  it('slugs titles for branches', () => {
    expect(slug('Time windows, review count and head dates')).toBe('time-windows-review-count-and-head-dates');
    expect(slug('A'.repeat(50)).length).toBeLessThanOrEqual(40);
  });

  it('CLI: reads loop.local.json and project.spec from --repo; exit codes 0, 1 and 2', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wave-args-'));
    mkdirSync(join(repo, '.claude'));
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, '.claude', 'loop.local.json'), JSON.stringify(project));
    writeFileSync(join(repo, 'docs', 'spec.md'), SPEC);
    let out = '';
    let err = '';
    const io = { out: (s: string) => (out += s), err: (s: string) => (err += s) };
    expect(main(['node', script, '--repo', repo, '--wave', '1', '--notes', 'hello'], io)).toBe(0);
    const args = JSON.parse(out);
    expect(args.project).toEqual(project);
    expect(args.tasks[0].notes).toBe('hello');
    expect(main(['node', script, '--repo', repo, '--wave', '9'], io)).toBe(1);
    expect(err).toContain('wave 9');
    expect(main(['node', script, '--repo', repo], io)).toBe(2);
    expect(main(['node', script, '--repo', join(repo, 'missing'), '--wave', '1'], io)).toBe(2);

    const real = spawnSync('node', [script, '--repo', repo, '--wave', '2'], { encoding: 'utf8' });
    expect(real.status, real.stderr).toBe(0);
    expect(JSON.parse(real.stdout).tasks).toHaveLength(3);
  });
});

// Task 1.4: a token estimate for the wave, from the Total tokens of the newest scorecards.
const fixture = (name: string) => join(root, 'tests', 'fixtures', `wave-scorecard-${name}.md`);
/** A scorecard directory: each entry copies a fixture to a scorecard file name. */
function scorecardDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wave-args-cards-'));
  for (const [name, fix] of Object.entries(files)) copyFileSync(fixture(fix), join(dir, name));
  return dir;
}
const cards = (files: Record<string, string>) =>
  Object.entries(files).map(([name, fix]) => ({ name, text: readFileSync(fixture(fix), 'utf8') }));

describe('wave-args budget', { timeout: 120_000 }, () => {
  // Wave 1 of SPEC has 2 tasks and a tail: 3 tasks.
  it('is the median of three scorecards: tokens per task, times the wave task count, to the nearest thousand', () => {
    const r = waveArgs({
      project,
      specText: SPEC,
      wave: '1',
      scorecards: cards({ '2026-11-10-wave-1-loop.md': 'a', '2026-11-11-wave-2-loop.md': 'b', '2026-11-12-wave-3-loop.md': 'c' }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.budget).toEqual({
      tasks: 3,
      tokensPerTask: 1_500_000,
      estimate: 4_500_000,
      basis: [
        { file: '2026-11-12-wave-3-loop.md', tokens: 5_000_000, tasks: 2, tokensPerTask: 2_500_000 },
        { file: '2026-11-11-wave-2-loop.md', tokens: 7_500_000, tasks: 5, tokensPerTask: 1_500_000 },
        { file: '2026-11-10-wave-1-loop.md', tokens: 4_000_000, tasks: 4, tokensPerTask: 1_000_000 },
      ],
    });
  });

  it('counts only the Tasks section rows, skips zero and missing totals before it picks the newest three, and sorts by date then wave id as text', () => {
    const r = waveArgs({
      project,
      specText: SPEC,
      wave: '1',
      scorecards: cards({
        '2026-11-01-wave-9-loop.md': 'old',
        '2026-11-10-wave-1-loop.md': 'a',
        '2026-11-10-wave-1b-loop.md': 'b',
        '2026-11-11-wave-2-loop.md': 'c',
        '2026-11-12-wave-3-loop.md': 'zero',
        '2026-11-13-wave-4-loop.md': 'missing',
      }),
    });
    expect(r.ok && r.args.budget.basis.map((b: { file: string }) => b.file)).toEqual([
      '2026-11-11-wave-2-loop.md',
      '2026-11-10-wave-1b-loop.md',
      '2026-11-10-wave-1-loop.md',
    ]);
    expect(r.ok && r.args.budget.tokensPerTask).toBe(1_500_000);
    // A scorecard whose name is not a *-loop.md file is not a scorecard.
    const other = waveArgs({ project, specText: SPEC, wave: '1', scorecards: cards({ 'notes.md': 'a', '2026-11-10-wave-1-loop.md': 'b' }) });
    expect(other.ok && other.args.budget.basis).toHaveLength(1);
  });

  it('is the mean of two usable scorecards, and the value of one', () => {
    const two = waveArgs({ project, specText: SPEC, wave: '1', scorecards: cards({ '2026-11-10-wave-1-loop.md': 'a', '2026-11-11-wave-2-loop.md': 'c', '2026-11-12-wave-3-loop.md': 'zero' }) });
    expect(two.ok && two.args.budget.tokensPerTask).toBe(1_750_000);
    expect(two.ok && two.args.budget.estimate).toBe(5_250_000);
    const one = waveArgs({ project, specText: SPEC, wave: '1', scorecards: cards({ '2026-11-10-wave-1-loop.md': 'a' }) });
    expect(one.ok && one.args.budget).toMatchObject({ tasks: 3, tokensPerTask: 1_000_000, estimate: 3_000_000 });
  });

  it('is null with no scorecards, with none usable, and without the flag', () => {
    const none = waveArgs({ project, specText: SPEC, wave: '1' });
    expect(none.ok && none.args.budget).toBeNull();
    const unusable = waveArgs({ project, specText: SPEC, wave: '1', scorecards: cards({ '2026-11-10-wave-1-loop.md': 'zero', '2026-11-11-wave-2-loop.md': 'missing' }) });
    expect(unusable.ok && unusable.args.budget).toBeNull();
    expect(waveArgs({ project, specText: SPEC, wave: '1', scorecards: [] }).ok).toBe(true);
  });

  it('counts a wave without a tail by its tasks alone', () => {
    const r = waveArgs({ project, specText: SPEC, wave: '2', scorecards: cards({ '2026-11-10-wave-1-loop.md': 'a' }) });
    expect(r.ok && r.args.budget.tasks).toBe(3);
    expect(r.ok && r.args.budget.estimate).toBe(3_000_000);
  });

  it('CLI: --scorecards prints the estimate on stderr and puts budget in the args; without it nothing is printed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wave-args-'));
    mkdirSync(join(repo, '.claude'));
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, '.claude', 'loop.local.json'), JSON.stringify(project));
    writeFileSync(join(repo, 'docs', 'spec.md'), SPEC);
    const dir = scorecardDir({ '2026-11-10-wave-1-loop.md': 'a', '2026-11-11-wave-2-loop.md': 'b', '2026-11-12-wave-3-loop.md': 'c' });
    let out = '';
    let err = '';
    const io = { out: (s: string) => (out += s), err: (s: string) => (err += s) };
    expect(main(['node', script, '--repo', repo, '--wave', '1', '--scorecards', dir], io)).toBe(0);
    expect(JSON.parse(out).budget.estimate).toBe(4_500_000);
    expect(err).toBe(
      'wave-args: estimated 4.5M tokens for 3 tasks (median of 2026-11-12-wave-3-loop.md, 2026-11-11-wave-2-loop.md, 2026-11-10-wave-1-loop.md)\n',
    );

    out = '';
    err = '';
    expect(main(['node', script, '--repo', repo, '--wave', '1'], io)).toBe(0);
    expect(JSON.parse(out).budget).toBeNull();
    expect(err).toBe('');

    out = '';
    const empty = mkdtempSync(join(tmpdir(), 'wave-args-empty-'));
    expect(main(['node', script, '--repo', repo, '--wave', '1', '--scorecards', empty], io)).toBe(0);
    expect(JSON.parse(out).budget).toBeNull();
    expect(err).toBe('');

    // A directory that cannot be read is exit 2, like any other unreadable input.
    expect(main(['node', script, '--repo', repo, '--wave', '1', '--scorecards', join(repo, 'missing')], io)).toBe(2);
    expect(err).toContain('wave-args:');

    const real = spawnSync('node', [script, '--repo', repo, '--wave', '2', '--scorecards', dir], { encoding: 'utf8' });
    expect(real.status, real.stderr).toBe(0);
    expect(real.stderr).toContain('estimated 4.5M tokens for 3 tasks');
  });
});
