import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { fastLaneEligible, filesOutsideOwns, matchesPath } from './lane.js';

// Task 1.3 acceptance: fastLaneEligible({ task, changedFiles, addedText, decisions, project, ci,
// testCount, laneUsedInWave }) returns { eligible, reason }. Every case below starts from an
// eligible input and changes one thing.
function input(over: Record<string, unknown> = {}) {
  return {
    task: { id: '1.3', lane: 'fast', owns: ['claude/lib/lane.js', 'claude/lib/lane.test.ts'] },
    changedFiles: ['claude/lib/lane.js', 'claude/lib/lane.test.ts'],
    addedText: '+export function fastLaneEligible() {}\n+// plain code\n',
    decisions: ['D1 | use segment-aware prefixes | the spec says prefixes | yes'],
    project: {
      forbiddenStrings: ['ACME-SECRET'],
      fastLane: {
        enabled: true,
        denyPaths: ['claude/workflows/', 'claude/hookify.*'],
        maxPerWave: 3,
        testCountCommand: 'npm run count-tests',
      },
    },
    ci: { state: 'green', failing: [], logTail: '' },
    testCount: { before: 120, after: 126 },
    laneUsedInWave: 0,
    ...over,
  };
}

function withFastLane(over: Record<string, unknown>) {
  const base = input();
  return { project: { ...base.project, fastLane: { ...base.project.fastLane, ...over } } };
}

describe('fastLaneEligible', () => {
  it('is eligible when every condition holds', () => {
    const r = fastLaneEligible(input());
    expect(r.eligible).toBe(true);
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('is eligible with equal test counts, no decisions, and a cap not yet reached', () => {
    const r = fastLaneEligible(input({ testCount: { before: 10, after: 10 }, decisions: [], laneUsedInWave: 2 }));
    expect(r.eligible, r.reason).toBe(true);
  });

  it('is not eligible when a changed file is outside Owns', () => {
    const r = fastLaneEligible(input({ changedFiles: ['claude/lib/lane.js', 'claude/lib/other.js'] }));
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain('claude/lib/other.js');
    expect(r.reason).toMatch(/owns/i);
  });

  it('is not eligible when a changed file is under denyPaths, even inside Owns', () => {
    const r = fastLaneEligible(
      input({
        task: { id: '2.1', lane: 'fast', owns: ['claude/workflows/wave-loop.js'] },
        changedFiles: ['claude/workflows/wave-loop.js'],
      }),
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain('claude/workflows/wave-loop.js');
    expect(r.reason).toMatch(/deny/i);
  });

  it('is not eligible when a hookify rule is changed (glob deny path)', () => {
    const r = fastLaneEligible(
      input({
        task: { id: '2.1', lane: 'fast', owns: ['claude/'] },
        changedFiles: ['claude/hookify.block-secrets.local.md'],
      }),
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/deny/i);
  });

  it('is not eligible when the added text contains a forbidden string', () => {
    const r = fastLaneEligible(input({ addedText: '+const k = "ACME-SECRET";\n' }));
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain('ACME-SECRET');
    expect(r.reason).toMatch(/forbidden/i);
  });

  it('is not eligible when the test count is lower', () => {
    const r = fastLaneEligible(input({ testCount: { before: 120, after: 119 } }));
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/test count/i);
  });

  it('is not eligible when fastLane.enabled is false', () => {
    const r = fastLaneEligible(input(withFastLane({ enabled: false })));
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/enabled/i);
  });

  it('is not eligible when the project has no fastLane config at all', () => {
    const r = fastLaneEligible(input({ project: {} }));
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/enabled/i);
  });

  it('is not eligible when the per-wave cap is reached', () => {
    const r = fastLaneEligible(input({ laneUsedInWave: 3 }));
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/per wave|cap/i);
  });

  it('uses maxPerWave 3 by default and honours a smaller one', () => {
    expect(fastLaneEligible(input(withFastLane({ maxPerWave: undefined, enabled: true })), ).eligible).toBe(true);
    const capped = fastLaneEligible({ ...input(withFastLane({ maxPerWave: undefined })), laneUsedInWave: 3 });
    expect(capped.eligible).toBe(false);
    const small = fastLaneEligible({ ...input(withFastLane({ maxPerWave: 1 })), laneUsedInWave: 1 });
    expect(small.eligible).toBe(false);
  });

  it('is not eligible when the task is not marked Lane: fast', () => {
    const r = fastLaneEligible(input({ task: { id: '1.3', lane: 'normal', owns: ['claude/lib/lane.js'] } }));
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/lane/i);
  });

  it('treats a task with no lane as normal', () => {
    const r = fastLaneEligible(input({ task: { id: '1.3', owns: ['claude/lib/lane.js'] } }));
    expect(r.eligible).toBe(false);
  });

  it('is not eligible with no test-count command, even if a count is given', () => {
    const r = fastLaneEligible(input(withFastLane({ testCountCommand: undefined })));
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/testCountCommand|test-count command/i);
  });

  it('is not eligible when the test count is missing or not numbers', () => {
    for (const testCount of [undefined, null, { before: 1 }, { before: 'a', after: 'b' }, { before: 1, after: Number.NaN }]) {
      const r = fastLaneEligible(input({ testCount }));
      expect(r.eligible, JSON.stringify(testCount)).toBe(false);
    }
  });

  it('is not eligible when a Decisions line is reversible: no', () => {
    const r = fastLaneEligible(input({ decisions: ['D1 | drop a column | simpler | no'] }));
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain('D1');
    expect(r.reason).toMatch(/envelope/i);
  });

  it('is not eligible when a Decisions line names a human-only category', () => {
    const r = fastLaneEligible(input({ decisions: ['D2 | rotate the secret | the old one leaked | yes'] }));
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain('D2');
    expect(r.reason).toMatch(/envelope|human-only/i);
  });

  it('is not eligible when a Decisions line cannot be read, and ignores blank or heading lines', () => {
    const bad = fastLaneEligible(input({ decisions: ['I chose something'] }));
    expect(bad.eligible).toBe(false);
    const ok = fastLaneEligible(input({ decisions: ['Decisions:', '', '- D1 | a | b | yes'] }));
    expect(ok.eligible, ok.reason).toBe(true);
  });

  it('is not eligible when CI is not green, or when nothing changed', () => {
    for (const state of ['red', 'pending', 'missing']) {
      const r = fastLaneEligible(input({ ci: { state, failing: [], logTail: '' } }));
      expect(r.eligible, state).toBe(false);
      expect(r.reason).toMatch(/ci/i);
    }
    expect(fastLaneEligible(input({ changedFiles: [] })).eligible).toBe(false);
    expect(fastLaneEligible(input({ ci: undefined })).eligible).toBe(false);
  });

  it('does not mutate its input', () => {
    const i = input();
    const copy = JSON.parse(JSON.stringify(i));
    fastLaneEligible(i);
    expect(i).toEqual(copy);
  });
});

describe('path matcher (shared with the critic owned-paths check)', () => {
  it('matches a file, a directory prefix, and is segment-aware', () => {
    expect(matchesPath('scripts/a.js', 'scripts/a.js')).toBe(true);
    expect(matchesPath('scripts/a.js', 'scripts/')).toBe(true);
    expect(matchesPath('scripts/a.js', 'scripts')).toBe(true);
    expect(matchesPath('scripts/sub/a.js', 'scripts/')).toBe(true);
    expect(matchesPath('scripts-extra/a.js', 'scripts')).toBe(false);
    expect(matchesPath('scripts/a.js.bak', 'scripts/a.js')).toBe(false);
    expect(matchesPath('./scripts/a.js', 'scripts/a.js')).toBe(true);
  });

  it('matches a glob inside one segment', () => {
    expect(matchesPath('tests/fixtures/timings-a.json', 'tests/fixtures/timings-*.json')).toBe(true);
    expect(matchesPath('tests/fixtures/sub/timings-a.json', 'tests/fixtures/timings-*.json')).toBe(false);
    expect(matchesPath('claude/hookify.block-force-push.local.md', 'claude/hookify.*')).toBe(true);
  });

  it('never matches an escaping path or an empty pattern', () => {
    expect(matchesPath('../x/a.js', 'x/')).toBe(false);
    expect(matchesPath('a/../b.js', 'b.js')).toBe(false);
    expect(matchesPath('/etc/passwd', 'etc')).toBe(false);
    expect(matchesPath('a.js', '')).toBe(false);
  });

  it('filesOutsideOwns lists the files no Owns entry covers', () => {
    expect(filesOutsideOwns(['a/x.js', 'b/y.js', 'c.js'], ['a/', 'c.js'])).toEqual(['b/y.js']);
    expect(filesOutsideOwns(['a/x.js'], [])).toEqual(['a/x.js']);
  });

  it('reads Owns written as a string of backticked paths', () => {
    expect(filesOutsideOwns(['a/x.js', 'b/y.js'], 'Owns `a/x.js`, `c/`.')).toEqual(['b/y.js']);
  });
});
