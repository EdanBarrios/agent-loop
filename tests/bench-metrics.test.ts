import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { buildRecord, compareRecords, parseHoldoutOutput, summarizeLoad, tInterval, tQuantile, welch, wilson } from '../bench/metrics.js';
// @ts-expect-error plain JavaScript module with JSDoc
import { collect, prepare, runSampler } from '../bench/scenario.js';

// Task 4.3 metrics (formerly 4.4): `bench.js collect`, `sample` and `compare`. No network, no agent: the run outputs are
// hand-written in the shape the workflow runtime returns, and the interval figures are computed by hand (see each case).
const root = join(import.meta.dirname, '..');
const BENCH = join(root, 'scripts', 'bench.js');
const dirs: string[] = [];
vi.setConfig({ testTimeout: 120000 });
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `bench-mx-${label}-`));
  dirs.push(d);
  return d;
};
const near = (a: number, b: number, digits = 3) => expect(a).toBeCloseTo(b, digits);

describe('intervals', () => {
  it('pins the two-sided 95% t quantiles: 4.303 at 2 degrees of freedom, 2.776 at 4, 2.042 at 30, 1.96 above', () => {
    expect(tQuantile(1)).toBe(12.706);
    expect(tQuantile(2)).toBe(4.303);
    expect(tQuantile(4)).toBe(2.776);
    expect(tQuantile(30)).toBe(2.042);
    expect(tQuantile(31)).toBe(1.96);
    expect(tQuantile(500)).toBe(1.96);
  });

  it('Wilson: 3 of 10 is 10.8% to 60.3%; 5 of 5 stops at 100%; 0 of 5 starts at 0%', () => {
    const a = wilson(3, 10);
    near(a.mean, 0.3);
    near(a.lo, 0.1078, 4);
    near(a.hi, 0.6032, 4);
    near(wilson(5, 5).lo, 0.5655, 4);
    expect(wilson(5, 5).hi).toBeCloseTo(1, 10);
    expect(wilson(0, 5).lo).toBeCloseTo(0, 10);
    near(wilson(0, 5).hi, 0.4345, 4);
    expect(wilson(0, 0)).toMatchObject({ mean: null, lo: null, hi: null });
  });

  it('t interval of 10, 12, 14: mean 12 plus or minus 4.303 * 2 / sqrt(3) = 4.9686; none for fewer than 2 values', () => {
    const t = tInterval([10, 12, 14]);
    near(t.mean, 12);
    near(t.lo, 7.0313, 3);
    near(t.hi, 16.9687, 3);
    expect(tInterval([5])).toMatchObject({ mean: 5, lo: null, hi: null, n: 1 });
    expect(tInterval([])).toMatchObject({ mean: null, lo: null, hi: null, n: 0 });
  });

  it('Welch of [10, 12, 14] and [16, 18, 20]: difference 6, standard error 1.633, df 4 (floored from 4.0), 2.776 -> 1.467 to 10.533', () => {
    const w = welch([10, 12, 14], [16, 18, 20]);
    expect(w.df).toBe(4);
    near(w.diff, 6);
    near(w.lo, 1.4668, 3);
    near(w.hi, 10.5332, 3);
  });

  it('Welch rounds the degrees of freedom down: 3.806 uses the 3 df quantile (3.182)', () => {
    const w = welch([1000, 1100, 1250], [1500, 1700, 1600]);
    expect(w.df).toBe(3);
    near(w.diff, 483.3333, 3);
    near(w.lo, 188.0562, 2);
    near(w.hi, 778.6104, 2);
  });

  it('Welch needs 2 values in each group, and handles groups with no spread', () => {
    expect(welch([1], [2, 3])).toMatchObject({ lo: null, hi: null });
    const same = welch([2, 2, 2], [2, 2, 2]);
    expect(same.diff).toBe(0);
    expect(same.lo).toBe(0);
    expect(same.hi).toBe(0);
  });
});

function rec(config: string, i: number, v: { makespan: number; tokens: number; merged: number; passed?: number }) {
  return {
    scenario: 's', config, makespanMs: v.makespan, agentMinutes: 30, tokens: { total: v.tokens, perRole: {} }, tasks: { merged: v.merged, total: 6 },
    fixRounds: 1, escalations: 0, reverts: 0, holdout: { passed: v.passed ?? 3, total: 3 }, load: null, run: i,
  };
}

describe('compare', () => {
  const A = [10, 12, 14].map((m, i) => rec('cfg-a', i, { makespan: m, tokens: [1000, 1100, 1250][i], merged: [5, 6, 6][i] }));
  const B = [16, 18, 20].map((m, i) => rec('cfg-b', i, { makespan: m, tokens: [1500, 1700, 1600][i], merged: [3, 4, 5][i], passed: [2, 3, 3][i] }));

  it('groups records by config and prints each metric as a mean with a 95% interval', () => {
    const r = compareRecords([...A, ...B]);
    expect(r.groups.map((g: any) => [g.config, g.n])).toEqual([['cfg-a', 3], ['cfg-b', 3]]);
    const a = r.groups[0].metrics;
    near(a.makespanMs.mean, 12);
    near(a.makespanMs.lo, 7.0313);
    near(a.makespanMs.hi, 16.9687);
    near(a.tokens.mean, 1116.6667);
    near(a.tokens.lo, 804.061, 2);
    near(a.tokens.hi, 1429.272, 2);
    // a rate pools the counts: 17 of 18 tasks merged, Wilson 74.2% to 99.0%
    expect(a.tasksMerged).toMatchObject({ k: 17, n: 18 });
    near(a.tasksMerged.mean, 17 / 18);
    near(a.tasksMerged.lo, 0.7424, 4);
    near(a.tasksMerged.hi, 0.9901, 4);
    const b = r.groups[1].metrics;
    near(b.tasksMerged.lo, 0.4375, 4);
    near(b.tasksMerged.hi, 0.8372, 4);
    expect(b.holdoutPass).toMatchObject({ k: 8, n: 9 });
  });

  it('prints the difference with a Welch interval, and both the overlap of the single intervals and whether the difference includes 0', () => {
    const r = compareRecords([...A, ...B]);
    expect(r.comparisons).toHaveLength(1);
    const c = r.comparisons[0];
    expect([c.a, c.b]).toEqual(['cfg-a', 'cfg-b']);
    const m = c.metrics.makespanMs;
    near(m.diff, 6);
    near(m.lo, 1.4668);
    near(m.hi, 10.5332);
    expect(m.df).toBe(4);
    // the two single-config intervals overlap (7.03-16.97 and 13.03-22.97) while the difference excludes 0
    expect(m.overlap).toBe(true);
    expect(m.includesZero).toBe(false);
    const t = c.metrics.tokens;
    near(t.diff, 483.3333);
    expect(t.df).toBe(3);
    expect(t.overlap).toBe(true);
    expect(t.includesZero).toBe(false);
    // the merge rate: 17/18 (74.2% to 99.0%) and 12/18 (43.8% to 83.7%) overlap
    expect(c.metrics.tasksMerged.overlap).toBe(true);
    // a metric with no spread has a zero-width difference that includes 0
    expect(c.metrics.escalations).toMatchObject({ diff: 0, includesZero: true, overlap: true });
    expect(JSON.stringify(r)).not.toContain('NaN');
  });

  it('gives a mean and no interval for a config with one record, and no comparison interval', () => {
    const r = compareRecords([A[0], ...B]);
    const a = r.groups[0].metrics.makespanMs;
    expect(a).toMatchObject({ mean: 10, lo: null, hi: null, n: 1 });
    const c = r.comparisons[0].metrics.makespanMs;
    expect(c.diff).toBeCloseTo(8, 10);
    expect(c.lo).toBeNull();
    expect(c.hi).toBeNull();
    expect(c.overlap).toBeNull();
    expect(c.includesZero).toBeNull();
  });

  it('compares every pair when there are three configs, and a single config alone has no comparison', () => {
    const C = A.map((x, i) => ({ ...x, config: 'cfg-c', makespanMs: 30 + i }));
    expect(compareRecords([...A, ...B, ...C]).comparisons.map((c: any) => `${c.a}/${c.b}`)).toEqual(['cfg-a/cfg-b', 'cfg-a/cfg-c', 'cfg-b/cfg-c']);
    expect(compareRecords(A).comparisons).toEqual([]);
  });

  it('is what `bench.js compare` prints, one JSON line', () => {
    const dir = tmp('cmp');
    const files = [...A, ...B].map((r, i) => {
      const f = join(dir, `r${i}.json`);
      writeFileSync(f, JSON.stringify(r));
      return f;
    });
    const r = spawnSync('node', [BENCH, 'compare', ...files], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).comparisons[0].metrics.makespanMs.includesZero).toBe(false);
  });
});

describe('holdout output and load samples', () => {
  it('reads the pass count from vitest JSON and from node TAP output', () => {
    expect(parseHoldoutOutput('noise\n{"numTotalTests":5,"numPassedTests":4,"numFailedTests":1}\n')).toEqual({ passed: 4, total: 5 });
    expect(parseHoldoutOutput('TAP version 13\n# tests 8\n# suites 0\n# pass 7\n# fail 1\n')).toEqual({ passed: 7, total: 8 });
    expect(parseHoldoutOutput('segmentation fault')).toBeNull();
  });

  it('summarizes load samples, and reports null for none', () => {
    expect(summarizeLoad([{ t: 1, load1: 1 }, { t: 2, load1: 3 }, { t: 3, load1: 2 }])).toEqual({ samples: 3, mean: 2, max: 3 });
    expect(summarizeLoad([])).toBeNull();
    expect(summarizeLoad(null)).toBeNull();
  });
});

describe('buildRecord', () => {
  const T = 1_700_000_000_000;
  const agent = (label: string, start: number, dur: number, tokens: number) => ({ type: 'workflow_agent', label, state: 'done', tokens, durationMs: dur, startedAt: T + start });
  const output = {
    result: JSON.stringify({
      state: { '1.1': 'merged', '1.2': 'merged', '1.3': 'reverted', '1.4': 'parked' },
      tasks: {
        '1.1': { rounds: [{ round: 1, verdict: 'MERGE' }], merge: { outcome: 'merged' } },
        '1.2': { rounds: [{ round: 1, verdict: 'FIX' }, { round: 2, verdict: 'MERGE' }], merge: { outcome: 'merged' } },
        '1.3': { rounds: [{ round: 1, verdict: 'MERGE' }], merge: { outcome: 'reverted' } },
        '1.4': { rounds: [{ round: 1, verdict: 'FIX' }, { round: 2, verdict: 'FIX' }, { round: 3, verdict: 'FIX' }] },
      },
      escalations: [{ task: '1.4', what: 'x', question: 'y' }],
    }),
    workflowProgress: [
      agent('worker:1.1', 0, 600000, 1000),
      agent('worker:1.2', 0, 720000, 2000),
      agent('critic:1.1 r1', 600000, 180000, 500),
      agent('merger:1.1', 840000, 120000, 50),
      agent('critic:1.2 r1', 720000, 240000, 700),
      agent('worker:1.2 fix1', 960000, 300000, 800),
      agent('merger:1.2', 1300000, 100000, 60),
      agent('main:1.2', 1400000, 50000, 40),
    ],
  };
  const meta = { scenario: 's', configKey: 'k'.repeat(64), ciJobs: 2, loop: { commit: 'abc', version: '2.4.0' }, holdoutTotal: 3 };

  it('computes makespan from the first agent start to the end of the last merge relay, and the rest', () => {
    const r = buildRecord({ meta, outputs: [output], load: null, holdout: { passed: 2, total: 3 } });
    expect(r.config).toBe(meta.configKey);
    expect(r.scenario).toBe('s');
    expect(r.loop).toEqual({ commit: 'abc', version: '2.4.0' });
    // merger:1.2 ends at T + 1,400,000; main:1.2 is not a merge relay
    expect(r.makespanMs).toBe(1_400_000);
    near(r.agentMinutes, (600000 + 720000 + 180000 + 120000 + 240000 + 300000 + 100000 + 50000) / 60000);
    expect(r.tokens.perRole).toEqual({ worker: 3800, critic: 1200, merger: 110, main: 40 });
    expect(r.tokens.total).toBe(5150);
    expect(r.tasks).toEqual({ merged: 2, total: 4 });
    expect(r.fixRounds).toBe(1 + 2);
    expect(r.escalations).toBe(1);
    expect(r.reverts).toBe(1);
    expect(r.holdout).toEqual({ passed: 2, total: 3 });
    expect(r.load).toBeNull();
  });

  it('has a null makespan when no merge relay ran, and combines relaunch outputs with the later state winning', () => {
    const none = buildRecord({ meta, outputs: [{ ...output, workflowProgress: [agent('worker:1.1', 0, 1000, 1)] }], load: null, holdout: null });
    expect(none.makespanMs).toBeNull();
    expect(none.holdout).toBeNull();
    const relaunch = { result: { state: { '1.4': 'merged' }, tasks: { '1.4': { rounds: [{ round: 1, verdict: 'MERGE' }], merge: { outcome: 'merged' } } }, escalations: [] }, workflowProgress: [agent('merger:1.4', 2000000, 60000, 5)] };
    const both = buildRecord({ meta, outputs: [output, relaunch], load: { samples: 2, mean: 1.5, max: 2 }, holdout: null });
    expect(both.tasks).toEqual({ merged: 3, total: 4 });
    expect(both.makespanMs).toBe(2_060_000);
    expect(both.escalations).toBe(1);
    expect(both.load).toEqual({ samples: 2, mean: 1.5, max: 2 });
  });
});

describe('collect and sample on a prepared run', () => {
  const dir = tmp('collect');
  const source = join(dir, 'source');
  const scenarios = join(dir, 'scenarios');
  const run = join(dir, 'run');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'B', GIT_AUTHOR_EMAIL: 'b@example.invalid', GIT_COMMITTER_NAME: 'B', GIT_COMMITTER_EMAIL: 'b@example.invalid' };
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim();
  const T = 1_700_000_000_000;
  const outputFile = join(dir, 'output.json');

  it('prepares, then collects the record with the holdout run on the final default branch', async () => {
    mkdirSync(source, { recursive: true });
    g(dir, 'init', '-q', '-b', 'main', source);
    writeFileSync(join(source, 'a.txt'), 'a\n');
    g(source, 'add', '.');
    g(source, 'commit', '-q', '-m', 'base');
    mkdirSync(join(scenarios, 'c.holdout', 'tests'), { recursive: true });
    writeFileSync(
      join(scenarios, 'c.holdout', 'tests', 'hold.test.js'),
      "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { existsSync } from 'node:fs';\ntest('has a', () => assert.ok(existsSync('a.txt')));\ntest('has b', () => assert.ok(existsSync('b.txt')));\ntest('one', () => assert.equal(1, 1));\n",
    );
    writeFileSync(
      join(scenarios, 'c.json'),
      JSON.stringify({
        name: 'c', source: 'loop', baseSha: g(source, 'rev-parse', 'HEAD'), spec: 'a.txt', wave: '1', holdout: ['tests/hold.test.js'], holdoutTotal: 3,
        holdoutCommand: 'node --test --test-reporter=tap tests/hold.test.js',
        project: { mainCi: 'check', maxBuilders: 1, maxChains: 1, models: {}, syncPolicy: 'conflict', install: 'true', check: 'true' },
      }),
    );
    prepare(join(scenarios, 'c.json'), { loop: root, out: run, source, ciJobs: 2 });
    writeFileSync(
      outputFile,
      JSON.stringify({
        result: { state: { '1.1': 'merged' }, tasks: { '1.1': { rounds: [{ round: 1, verdict: 'MERGE' }], merge: { outcome: 'merged' } } }, escalations: [] },
        workflowProgress: [
          { label: 'worker:1.1', tokens: 100, durationMs: 60000, startedAt: T },
          { label: 'merger:1.1', tokens: 10, durationMs: 30000, startedAt: T + 90000 },
        ],
      }),
    );
    // the work happened on the remote's main: b.txt landed there (no hook: the push must not start a CI runner)
    rmSync(join(run, 'remote.git', 'hooks', 'post-receive'));
    const work = join(dir, 'work');
    g(dir, 'clone', '-q', join(run, 'remote.git'), work);
    writeFileSync(join(work, 'b.txt'), 'b\n');
    g(work, 'add', '.');
    g(work, 'commit', '-q', '-m', 'task');
    execFileSync('git', ['push', '-q', join(run, 'remote.git'), 'HEAD:refs/heads/main'], { cwd: work, env: { ...env, PATH: process.env.PATH } });
    const r = await collect(run, [outputFile]);
    expect(r.holdout).toEqual({ passed: 3, total: 3 });
    expect(r.makespanMs).toBe(120000);
    expect(r.tasks).toEqual({ merged: 1, total: 1 });
    expect(r.load).toBeNull();
    expect(r.config).toMatch(/^[0-9a-f]{64}$/);
  });

  it('counts a failing holdout case: without b.txt on the default branch 2 of 3 pass', async () => {
    const r2 = join(dir, 'run2');
    prepare(join(scenarios, 'c.json'), { loop: root, out: r2, source, ciJobs: 2 });
    const r = await collect(r2, [outputFile]);
    expect(r.holdout).toEqual({ passed: 2, total: 3 });
  });

  it('the CLI prints one record, with load from $BENCH_STATE/load.jsonl once a sampler has written it', () => {
    const state = join(run, 'state');
    writeFileSync(join(state, 'load.jsonl'), '{"t":1,"load1":1}\n{"t":2,"load1":3}\n\nnot json\n');
    const r = spawnSync('node', [BENCH, 'collect', run, outputFile], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const rec = JSON.parse(r.stdout);
    expect(rec.load).toEqual({ samples: 2, mean: 2, max: 3 });
    expect(rec.holdout).toEqual({ passed: 3, total: 3 });
  });

  it('sample appends { t, load1 } lines until its pid file is removed', async () => {
    const state = join(dir, 'sample-state');
    mkdirSync(state, { recursive: true });
    const loads = [0.5, 1.5, 2.5, 9];
    let slept = 0;
    const n = await runSampler(state, {
      everyS: 30,
      loadavg: () => [loads.shift() as number, 0, 0],
      now: () => T + slept * 30000,
      sleep: async (ms: number) => {
        slept++;
        expect(ms).toBeLessThanOrEqual(30000);
        if (slept === 3) rmSync(join(state, 'sample.pid'));
      },
    });
    expect(n).toBe(3);
    const lines = readFileSync(join(state, 'load.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ t: T, load1: 0.5 }, { t: T + 30000, load1: 1.5 }, { t: T + 60000, load1: 2.5 }]);
    expect(existsSync(join(state, 'sample.pid'))).toBe(false);
  });
});
