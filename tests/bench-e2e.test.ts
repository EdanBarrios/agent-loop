import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { listRuns } from '../bench/ci.js';
// @ts-expect-error plain JavaScript module with JSDoc
import { runGh } from '../bench/fake-gh.js';
// @ts-expect-error plain JavaScript module with JSDoc
import { prepare } from '../bench/scenario.js';

// Task 4.T: the benchmark end to end, with no real agent. The synthetic-6 scenario is prepared twice (two loop
// configurations), a stubbed wave of six tasks is driven through the fake gh and the local CI (a branch, a push that the
// post-receive hook turns into a run, a PR, the checks, a merge), the runs are collected by `bench.js collect` and compared
// by `bench.js compare`. The agents are stand-ins: their labels, times and token counts are written by this file.
const root = join(import.meta.dirname, '..');
const BENCH = join(root, 'scripts', 'bench.js');
const dirs: string[] = [];
vi.setConfig({ testTimeout: 180000, hookTimeout: 300000 });
afterAll(async () => {
  // the post-receive hook starts each CI runner detached, in its own process group: stop any still running (a failed
  // expect between a push and its watch leaves one) before their directories go
  for (const d of dirs) spawnSync('pkill', ['-f', d]);
  await new Promise((r) => setTimeout(r, 500));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
// `gh pr checks --watch` runs in process and blocks the event loop while it polls, so vitest's timeouts cannot end it:
// each watch gets its own deadline, and a run that does not complete fails the test naming the command
const WATCH_LIMIT_MS = 120000;

function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') || k.startsWith('BENCH_')) delete env[k];
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'Bench';
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'bench@example.invalid';
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}
function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function tmp(label: string) {
  const d = mkdtempSync(join(tmpdir(), `bench-e2e-${label}-`));
  dirs.push(d);
  return d;
}
function cli(args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync('node', [BENCH, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop() as string) : null };
}

// ---- the stub agents' work: the six tasks of the synthetic-6 spec, each owning two files ----

type Files = Record<string, string>;
type Task = { id: string; files: Files; broken?: Files };
const js = (s: string) => s.trim() + '\n';
const testOf = (mod: string, body: string) => js(`import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n${mod}\n\n${body}`);

const TASKS: Task[] = [
  {
    id: '1.1',
    files: {
      'src/slug.js': js(`export function slugify(text) {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}`),
      'tests/slug.test.js': testOf("import { slugify } from '../src/slug.js';", "test('slugify', () => {\n  assert.equal(slugify('  Hello,   World!! '), 'hello-world');\n});"),
    },
  },
  {
    id: '1.2',
    files: {
      'src/title-slug.js': js(`import { slugify } from './slug.js';\n\nexport function titleSlug(title, maxLength) {\n  return slugify(title).slice(0, maxLength).replace(/-+$/, '');\n}`),
      'tests/title-slug.test.js': testOf("import { titleSlug } from '../src/title-slug.js';", "test('titleSlug', () => {\n  assert.equal(titleSlug('abcd efgh', 5), 'abcd');\n});"),
    },
  },
  {
    id: '1.3',
    files: {
      'src/stats.js': js(`export function mean(values) {\n  if (values.length === 0) throw new RangeError('empty');\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n\nexport function median(values) {\n  if (values.length === 0) throw new RangeError('empty');\n  const s = [...values].sort((a, b) => a - b);\n  const m = s.length >> 1;\n  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;\n}`),
      'tests/stats.test.js': testOf("import { mean, median } from '../src/stats.js';", "test('stats', () => {\n  assert.equal(mean([1, 2, 3, 4]), 2.5);\n  assert.equal(median([3, 1, 2]), 2);\n  assert.throws(() => mean([]), RangeError);\n});"),
    },
  },
  {
    id: '1.4',
    files: {
      'src/summary.js': js(`import { mean, median } from './stats.js';\n\nexport function summarize(values) {\n  return { n: values.length, mean: mean(values), median: median(values), min: Math.min(...values), max: Math.max(...values) };\n}`),
      'tests/summary.test.js': testOf("import { summarize } from '../src/summary.js';", "test('summarize', () => {\n  assert.deepEqual(summarize([4, 1, 3, 2]), { n: 4, mean: 2.5, median: 2.5, min: 1, max: 4 });\n});"),
    },
  },
  {
    id: '1.5',
    files: {
      'src/wrap.js': js(`export function wrap(text, width) {\n  const lines = [];\n  let line = '';\n  for (const word of text.split(' ').filter(Boolean)) {\n    if (line && line.length + 1 + word.length > width) {\n      lines.push(line);\n      line = word;\n    } else line = line ? line + ' ' + word : word;\n  }\n  if (line) lines.push(line);\n  return lines;\n}`),
      'tests/wrap.test.js': testOf("import { wrap } from '../src/wrap.js';", "test('wrap', () => {\n  assert.deepEqual(wrap('the quick brown fox', 9), ['the quick', 'brown fox']);\n});"),
    },
    // the first attempt of this task in the second configuration: its own test is red
    broken: {
      'src/wrap.js': js(`export function wrap(text, width) {\n  return [text];\n}`),
    },
  },
  {
    id: '1.6',
    files: {
      'src/csv.js': js(`export function parseCsvLine(line) {\n  const fields = [];\n  let cur = '';\n  let quoted = false;\n  for (let i = 0; i < line.length; i++) {\n    const c = line[i];\n    if (quoted) {\n      if (c === '"' && line[i + 1] === '"') {\n        cur += '"';\n        i++;\n      } else if (c === '"') quoted = false;\n      else cur += c;\n    } else if (c === '"') quoted = true;\n    else if (c === ',') {\n      fields.push(cur);\n      cur = '';\n    } else cur += c;\n  }\n  fields.push(cur);\n  return fields;\n}`),
      'tests/csv.test.js': testOf("import { parseCsvLine } from '../src/csv.js';", "test('parseCsvLine', () => {\n  assert.deepEqual(parseCsvLine('a,\"b,c\",d'), ['a', 'b,c', 'd']);\n});"),
    },
  },
];
const DEPENDS: Record<string, string> = { '1.2': '1.1', '1.4': '1.3' };

type Progress = { label: string; startedAt: number; durationMs: number; tokens: number };
type Driven = { outputFile: string; expectedTokens: number; expectedByRole: Record<string, number>; fixRounds: number; order: string[] };

/**
 * Plays one wave with stub agents. Per task: a worker (branch, files, commit, push, `gh pr create`), a critic (`gh pr diff`)
 * and a merger (`gh pr checks --watch`, then `gh pr merge`). A task with `redFirst` pushes its broken version first: its
 * check turns red, a second worker round pushes the fix, and the merger waits for the new run.
 */
function driveWave(dir: string, order: string[], opts: { redFirst?: string; tokens: { worker: number; critic: number; merger: number } }): Driven {
  const clone = join(dir, 'clone');
  const state = join(dir, 'state');
  const env = cleanEnv({ BENCH_STATE: state, BENCH_CI_JOBS: '2', BENCH_POLL_MS: '100' });
  const gh = (args: string[]) => {
    const deadline = Date.now() + WATCH_LIMIT_MS;
    let timedOut = false;
    const sleep = (ms: number) => {
      if (Date.now() > deadline) {
        timedOut = true;
        throw new Error('watch deadline');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    };
    const r = runGh(args, { cwd: clone, stdin: () => '', env: { BENCH_STATE: state, BENCH_POLL_MS: '100' }, startRuns: false, sleep });
    // runGh turns a thrown error into exit 1, which a watch expecting a red check would accept: fail here instead
    if (timedOut) throw new Error(`gh ${args.join(' ')}: CI run not completed within ${WATCH_LIMIT_MS / 1000} s`);
    return { code: r.code as number, out: r.stdout as string, err: r.stderr as string };
  };
  const progress: Progress[] = [];
  const byRole: Record<string, number> = {};
  const stamp = <T,>(label: string, role: keyof typeof opts.tokens, fn: () => T): T => {
    const startedAt = Date.now();
    const v = fn();
    const tokens = opts.tokens[role];
    progress.push({ label, startedAt, durationMs: Math.max(1, Date.now() - startedAt), tokens });
    byRole[role] = (byRole[role] ?? 0) + tokens;
    return v;
  };
  const push = (branch: string, files: Files, message: string) => {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(clone, p)), { recursive: true });
      writeFileSync(join(clone, p), c);
    }
    git(clone, env, 'add', '-A');
    git(clone, env, 'commit', '-q', '-m', message);
    git(clone, env, 'push', '-q', 'origin', branch);
    return git(clone, env, 'rev-parse', 'HEAD');
  };

  const tasks: Record<string, unknown> = {};
  const states: Record<string, string> = {};
  let fixRounds = 0;
  for (const id of order) {
    const task = TASKS.find((t) => t.id === id) as Task;
    const branch = `task/${id}`;
    const red = opts.redFirst === id;
    let tip = '';
    let pr = 0;
    stamp(`worker:${id}`, 'worker', () => {
      git(clone, env, 'fetch', '-q', 'origin');
      git(clone, env, 'checkout', '-q', '-B', branch, 'origin/main');
      tip = push(branch, red ? { ...task.files, ...task.broken } : task.files, `${id}: ${branch}`);
      const created = gh(['pr', 'create', '--base', 'main', '--head', branch, '--title', `${id}: stub task`, '--body', `Stub PR for ${id}.`]);
      expect(created.code, created.err).toBe(0);
      pr = Number(/\/pull\/(\d+)/.exec(created.out)?.[1]);
    });
    stamp(`critic:${id}`, 'critic', () => {
      const diff = gh(['pr', 'diff', String(pr)]);
      expect(diff.code, diff.err).toBe(0);
      expect(diff.out).toContain(`src/`);
    });
    const rounds = [{ round: 1, verdict: red ? 'FIX' : 'MERGE' }];
    if (red) {
      // the first run is red: the merger would not merge, so the worker is sent back once
      const first = gh(['pr', 'checks', String(pr), '--watch']);
      expect(first.code, first.out).toBe(1);
      stamp(`worker:${id} fix 1`, 'worker', () => {
        tip = push(branch, task.files, `${id}: fix the red check`);
      });
      stamp(`critic:${id} round 2`, 'critic', () => {
        expect(gh(['pr', 'diff', String(pr)]).code).toBe(0);
      });
      rounds.push({ round: 2, verdict: 'MERGE' });
      fixRounds++;
    }
    stamp(`merger:${id}`, 'merger', () => {
      const checks = gh(['pr', 'checks', String(pr), '--watch']);
      expect(checks.code, checks.out).toBe(0);
      const merged = gh(['pr', 'merge', String(pr), '--merge', '--delete-branch', '--match-head-commit', tip]);
      expect(merged.code, merged.err).toBe(0);
    });
    tasks[id] = { rounds, merge: { outcome: 'merged' } };
    states[id] = 'merged';
  }
  const outputFile = join(dir, 'run-output.json');
  writeFileSync(outputFile, JSON.stringify({ result: { state: states, tasks, escalations: [] }, workflowProgress: progress }));
  const expectedTokens = Object.values(byRole).reduce((a, b) => a + b, 0);
  return { outputFile, expectedTokens, expectedByRole: byRole, fixRounds, order };
}

type Played = { dir: string; configKey: string; driven: Driven; record: any };
/** prepare, doctor, drive, collect: one replay of the synthetic scenario under one configuration. */
function replay(label: string, overrides: object, order: string[], opts: Parameters<typeof driveWave>[2]): Played {
  const dir = join(tmp(label), 'run');
  const prepared = prepare('synthetic-6', { loop: root, out: dir, ciJobs: 2, config: overrides });
  // bound each runner command (ci.js defaults to 30 minutes) so a stuck check ends as a red run, not a wait
  const ciJson = join(dir, 'state', 'ci.json');
  writeFileSync(ciJson, JSON.stringify({ ...JSON.parse(readFileSync(ciJson, 'utf8')), timeoutMs: 60000 }));
  const env = cleanEnv({ PATH: `${dir}/bin:${process.env.PATH}`, BENCH_STATE: join(dir, 'state'), BENCH_CI_JOBS: '2' });
  const doctor = cli(['doctor', dir], env);
  expect(doctor.code, doctor.out + doctor.err).toBe(0);
  expect(doctor.json.ok).toBe(true);
  const driven = driveWave(dir, order, opts);
  const collected = cli(['collect', dir, driven.outputFile], cleanEnv());
  expect(collected.code, collected.out + collected.err).toBe(0);
  return { dir, configKey: prepared.configKey, driven, record: collected.json };
}

const ORDER_A = ['1.1', '1.3', '1.5', '1.6', '1.2', '1.4'];
const ORDER_B = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6'];

describe('the synthetic scenario replayed under two configurations', () => {
  let a: Played;
  let b: Played;
  beforeAll(() => {
    a = replay('a', {}, ORDER_A, { tokens: { worker: 40000, critic: 15000, merger: 5000 } });
    b = replay('b', { maxBuilders: 1, models: { worker: { effort: 'low' } } }, ORDER_B, { redFirst: '1.5', tokens: { worker: 30000, critic: 15000, merger: 5000 } });
  });

  it('merges every task through the fake gh, in dependency order, with a real merge commit each', () => {
    for (const p of [a, b]) {
      const remote = join(p.dir, 'remote.git');
      const env = cleanEnv();
      const merges = git(remote, env, 'log', '--first-parent', '--reverse', '--format=%s', 'refs/heads/main').split('\n').filter((s) => s.startsWith('Merge pull request'));
      expect(merges).toHaveLength(6);
      const order = merges.map((s) => /bench\/task\/(\d\.\d)/.exec(s)?.[1]);
      expect(order).toEqual(p.driven.order);
      expect(order.indexOf('1.1')).toBeLessThan(order.indexOf('1.2'));
      expect(order.indexOf('1.3')).toBeLessThan(order.indexOf('1.4'));
      for (const id of Object.keys(DEPENDS)) expect(order.indexOf(id), id).toBeGreaterThan(order.indexOf(DEPENDS[id]));
      expect(git(remote, env, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
    }
  });

  it('ran the local CI on every pushed branch: one green run per task, and a red one before the fix in the second configuration', () => {
    const runsA = listRuns(join(a.dir, 'state')).filter((r: any) => r.event === 'pull_request');
    expect(runsA).toHaveLength(6);
    expect(runsA.every((r: any) => r.status === 'completed' && r.conclusion === 'success')).toBe(true);
    const runsB = listRuns(join(b.dir, 'state')).filter((r: any) => r.event === 'pull_request');
    expect(runsB).toHaveLength(7);
    const red = runsB.filter((r: any) => r.conclusion === 'failure');
    expect(red).toHaveLength(1);
    expect(red[0].branch).toBe('task/1.5');
    expect(red[0].logTail).toContain('wrap');
    // each merge recorded its push run for the new default-branch sha
    expect(listRuns(join(a.dir, 'state')).filter((r: any) => r.event === 'push')).toHaveLength(6);
  });

  it('collects a record per run: all tasks merged, the holdout tests passing on the final default branch, no agent minutes invented', () => {
    for (const p of [a, b]) {
      expect(p.record.scenario).toBe('synthetic-6');
      expect(p.record.config).toBe(p.configKey);
      expect(p.record.tasks).toEqual({ merged: 6, total: 6 });
      expect(p.record.holdout).toEqual({ passed: 8, total: 8 });
      expect(p.record.holdoutError).toBeUndefined();
      expect(p.record.escalations).toBe(0);
      expect(p.record.reverts).toBe(0);
      expect(p.record.load).toBeNull();
      expect(p.record.tokens.total).toBe(p.driven.expectedTokens);
      expect(p.record.tokens.perRole).toEqual(p.driven.expectedByRole);
      expect(p.record.makespanMs).toBeGreaterThan(0);
      expect(p.record.agentMinutes).toBeGreaterThan(0);
      expect(p.record.outputs).toBe(1);
    }
    expect(a.record.fixRounds).toBe(0);
    expect(b.record.fixRounds).toBe(1);
    expect(a.record.agents).toBe(18);
    expect(b.record.agents).toBe(20);
  });

  it('keys the two configurations apart, and keeps the holdout out of the clones the agents work in', () => {
    expect(a.record.config).not.toBe(b.record.config);
    for (const p of [a, b]) {
      expect(existsSync(join(p.dir, 'clone', 'tests', 'holdout.test.js'))).toBe(false);
      expect(existsSync(join(p.dir, 'holdout', 'tests', 'holdout.test.js'))).toBe(true);
    }
  });

  it('compares the two records: two groups, the difference of the means, and no interval from a single run', () => {
    const fileA = join(a.dir, 'record.json');
    const fileB = join(b.dir, 'record.json');
    writeFileSync(fileA, JSON.stringify(a.record));
    writeFileSync(fileB, JSON.stringify(b.record));
    const r = cli(['compare', fileA, fileB], cleanEnv());
    expect(r.code, r.out + r.err).toBe(0);
    const { groups, comparisons } = r.json;
    expect(groups.map((g: any) => [g.config, g.n])).toEqual([[a.configKey, 1], [b.configKey, 1]]);
    expect(groups[0].metrics.tokens.mean).toBe(a.driven.expectedTokens);
    expect(groups[0].metrics.tokens.lo).toBeNull();
    expect(groups[0].metrics.tasksMerged).toMatchObject({ k: 6, n: 6 });
    expect(groups[1].metrics.holdoutPass).toMatchObject({ k: 8, n: 8 });
    expect(comparisons).toHaveLength(1);
    expect([comparisons[0].a, comparisons[0].b]).toEqual([a.configKey, b.configKey]);
    const tokens = comparisons[0].metrics.tokens;
    expect(tokens.diff).toBe(b.driven.expectedTokens - a.driven.expectedTokens);
    expect(tokens.lo).toBeNull();
    expect(tokens.includesZero).toBeNull();
    expect(comparisons[0].metrics.fixRounds.diff).toBe(1);
    expect(comparisons[0].metrics.escalations.diff).toBe(0);
  });

  it('compares two records per configuration with Welch intervals when the runs repeat', () => {
    // a second run of each configuration: the same collected records with other times and tokens, as a repeated replay gives
    const again = (rec: any, dTokens: number, dMs: number) => ({ ...rec, tokens: { ...rec.tokens, total: rec.tokens.total + dTokens }, makespanMs: rec.makespanMs + dMs });
    const file = join(tmp('cmp'), 'records.json');
    writeFileSync(file, JSON.stringify([a.record, again(a.record, 2000, 500), b.record, again(b.record, 2000, 500)]));
    const r = cli(['compare', file], cleanEnv());
    expect(r.code, r.out + r.err).toBe(0);
    const { groups, comparisons } = r.json;
    expect(groups.map((g: any) => g.n)).toEqual([2, 2]);
    expect(groups[0].metrics.tokens.n).toBe(2);
    expect(groups[0].metrics.tokens.lo).toBeLessThan(groups[0].metrics.tokens.mean);
    expect(groups[0].metrics.tokens.hi).toBeGreaterThan(groups[0].metrics.tokens.mean);
    const t = comparisons[0].metrics.tokens;
    expect(t.diff).toBe(b.driven.expectedTokens - a.driven.expectedTokens);
    expect(t.df).toBe(2);
    expect(typeof t.includesZero).toBe('boolean');
    expect(typeof t.overlap).toBe('boolean');
  });
});

describe('docs/BENCHMARK.md', () => {
  const file = join(root, 'docs', 'BENCHMARK.md');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';

  it('exists', () => {
    expect(existsSync(file)).toBe(true);
  });

  it('says how to run a comparison with the commands bench.js has, in the order a run uses them', () => {
    const used = [...text.matchAll(/scripts\/bench\.js (\w+)/g)].map((m) => m[1]);
    for (const c of used) expect(['prepare', 'doctor', 'sample', 'collect', 'compare'], c).toContain(c);
    for (const c of ['prepare', 'doctor', 'sample', 'collect', 'compare']) expect(used, c).toContain(c);
    expect(used.indexOf('prepare')).toBeLessThan(used.indexOf('doctor'));
    expect(used.indexOf('doctor')).toBeLessThan(used.indexOf('collect'));
    expect(used.indexOf('collect')).toBeLessThan(used.lastIndexOf('compare'));
    expect(text).toContain('H7');
    expect(text).toContain('H6');
    expect(text).toContain('wave-loop');
  });

  it('states the cost: about 1.7M tokens per replay of wave 1, a pilot of 1 run per configuration before 3, and /usage before and after', () => {
    expect(text).toMatch(/1\.7M tokens/);
    expect(text).toMatch(/wave 1 scorecard/);
    expect(text).toMatch(/pilot/i);
    expect(text).toMatch(/1 run per configuration/);
    expect(text).toMatch(/\b3\b/);
    expect(text).toContain('/usage');
    expect(text).toMatch(/before and after/);
    expect(text).toMatch(/one observation of one wave/);
    expect(text).toMatch(/estimate/);
    expect(text).toMatch(/measured drop/);
  });

  it('states the contamination limit: relative comparisons only, no absolute correctness score, and what could hide the answers', () => {
    expect(text).toMatch(/2\.4\.0 or later/);
    expect(text).toContain('reference solutions');
    expect(text).toContain('.claude');
    expect(text).toContain('v24-wave-1');
    expect(text).toMatch(/relative comparisons/);
    expect(text).toMatch(/not an absolute correctness score/);
    expect(text).toContain('H4');
    expect(text).toMatch(/source checkout/);
    expect(text).toMatch(/loop files/);
  });
});
