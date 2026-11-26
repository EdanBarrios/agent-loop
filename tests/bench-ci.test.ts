import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { enqueueRun, installHook, listRuns, readRun } from '../bench/ci.js';

// Local CI for the benchmark: a post-receive hook in a bare remote records one run per pushed sha, a detached runner
// runs install and check in a clean clone at that sha, at most BENCH_CI_JOBS at once. Real git, no network, no agent.
const roots: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'Bench';
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'bench@example.invalid';
  return env as NodeJS.ProcessEnv;
}
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function waitFor<T>(fn: () => T | undefined | false, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(40);
  }
}

type Fixture = { dir: string; remote: string; work: string; state: string; gate: string };
function setup(ci: Record<string, unknown> | null | ((gate: string) => Record<string, unknown>)): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'bench-ci-'));
  roots.push(dir);
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const state = join(dir, 'state');
  const gate = join(dir, 'gate');
  git(dir, 'init', '--bare', '-b', 'main', remote);
  git(dir, 'init', '-b', 'main', work);
  git(work, 'remote', 'add', 'origin', remote);
  mkdirSync(state, { recursive: true });
  if (ci) writeFileSync(join(state, 'ci.json'), JSON.stringify(typeof ci === 'function' ? ci(gate) : ci));
  installHook(remote, state);
  return { dir, remote, work, state, gate };
}
function commit(f: Fixture, name: string, content = name) {
  writeFileSync(join(f.work, name), content + '\n');
  git(f.work, 'add', '.');
  git(f.work, 'commit', '-m', `add ${name}`);
  return git(f.work, 'rev-parse', 'HEAD');
}
function push(f: Fixture, ref: string, env: Record<string, string> = {}) {
  return execFileSync('git', ['push', 'origin', ref], { cwd: f.work, encoding: 'utf8', env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
}

const trivial = { install: 'echo installing', check: 'test -f ok.txt && echo check-ok', mainCi: 'ci' };
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.BENCH_CI_JOBS;
  delete process.env.BENCH_CI_JOBS;
});
afterEach(() => {
  if (saved === undefined) delete process.env.BENCH_CI_JOBS;
  else process.env.BENCH_CI_JOBS = saved;
});
afterAll(async () => {
  await sleep(300);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('enqueueRun and listRuns', () => {
  it('writes a queued record per run with a unique positive integer id, newest first', () => {
    const f = setup(trivial);
    const a = enqueueRun(f.state, { sha: 'a'.repeat(40), branch: 'main', event: 'push', start: false });
    const b = enqueueRun(f.state, { sha: 'b'.repeat(40), branch: 'task/x', event: 'pull_request', start: false });
    expect(Number.isInteger(a.id) && a.id > 0).toBe(true);
    expect(b.id).not.toBe(a.id);
    expect(a).toMatchObject({ sha: 'a'.repeat(40), event: 'push', status: 'queued', conclusion: null, branch: 'main', workflow: 'ci', name: 'ci' });
    expect(typeof a.startedAt).toBe('string');
    expect(listRuns(f.state).map((r: { id: number }) => r.id)).toEqual([b.id, a.id].sort((x, y) => y - x));
    expect(readRun(f.state, a.id)).toEqual(a);
    // one file per run, written under a temporary name and renamed: nothing else is left in the directory
    expect(readdirSync(join(f.state, 'runs')).sort()).toEqual([`${a.id}.json`, `${b.id}.json`].sort());
  });

  it('is an error when ci.json is missing, and lists nothing before any run', () => {
    const f = setup(null);
    expect(() => enqueueRun(f.state, { sha: 'a'.repeat(40), branch: 'main', event: 'push', start: false })).toThrow(/ci\.json/);
    expect(listRuns(f.state)).toEqual([]);
  });
});

describe('post-receive hook', () => {
  it('records a queued run per push that turns green, event push for the default branch', async () => {
    const f = setup((gate) => ({ ...trivial, check: `while [ ! -f ${gate} ]; do sleep 0.05; done; test -f ok.txt && echo check-ok` }));
    const sha = commit(f, 'ok.txt');
    push(f, 'main'); // returns although the check is still waiting: the hook only records and detaches
    const [run] = listRuns(f.state);
    expect(run).toMatchObject({ sha, event: 'push', branch: 'main', conclusion: null, workflow: 'ci', name: 'ci' });
    expect(['queued', 'in_progress']).toContain(run.status);
    writeFileSync(f.gate, 'go');
    const done = await waitFor(() => {
      const r = readRun(f.state, run.id);
      return r.status === 'completed' && r;
    });
    expect(done.conclusion).toBe('success');
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    expect(done.logTail).toContain('installing');
    expect(done.logTail).toContain('check-ok');
  }, 40000);

  it('records event pull_request for another branch, and the run turns red when the check fails', async () => {
    const f = setup(trivial);
    commit(f, 'ok.txt');
    push(f, 'main');
    git(f.work, 'checkout', '-b', 'task/1.1');
    const sha = commit(f, 'other.txt');
    git(f.work, 'rm', '-q', 'ok.txt');
    git(f.work, 'commit', '-q', '-m', 'remove ok.txt');
    const tip = git(f.work, 'rev-parse', 'HEAD');
    expect(tip).not.toBe(sha);
    push(f, 'task/1.1');
    await waitFor(() => listRuns(f.state).every((r: { status: string }) => r.status === 'completed') && listRuns(f.state).length === 2);
    const runs = listRuns(f.state);
    const pr = runs.find((r: { branch: string }) => r.branch === 'task/1.1');
    const main = runs.find((r: { branch: string }) => r.branch === 'main');
    expect(pr).toMatchObject({ sha: tip, event: 'pull_request', status: 'completed', conclusion: 'failure' });
    expect(main).toMatchObject({ event: 'push', conclusion: 'success' });
  }, 40000);

  it('keeps the tail of a failed run log for run view --log-failed', async () => {
    const f = setup({ install: 'true', check: 'for i in $(seq 1 500); do echo "line $i"; done; echo "boom: assertion failed" >&2; exit 3', mainCi: 'ci' });
    commit(f, 'a.txt');
    push(f, 'HEAD:refs/heads/task/x');
    const run = await waitFor(() => {
      const r = listRuns(f.state)[0];
      return r && r.status === 'completed' && r;
    });
    expect(run.conclusion).toBe('failure');
    expect(run.logTail).toContain('boom: assertion failed');
    expect(run.logTail).toContain('line 500');
    expect(run.logTail).not.toContain('line 1\n');
    expect(run.logTail.length).toBeLessThan(30000);
    expect(JSON.parse(readFileSync(join(f.state, 'runs', `${run.id}.json`), 'utf8')).logTail).toBe(run.logTail);
  }, 40000);

  it('runs in a clean clone at the pushed sha, not in the working clone', async () => {
    const f = setup({ install: 'true', check: 'git rev-parse HEAD && ls && test ! -f untracked.txt', mainCi: 'ci' });
    writeFileSync(join(f.work, 'untracked.txt'), 'x');
    const sha = commit(f, 'a.txt');
    git(f.work, 'rm', '-q', '--cached', 'untracked.txt');
    git(f.work, 'commit', '-q', '-m', 'untrack');
    const tip = git(f.work, 'rev-parse', 'HEAD');
    push(f, 'main');
    const run = await waitFor(() => {
      const r = listRuns(f.state)[0];
      return r && r.status === 'completed' && r;
    });
    expect(run.sha).toBe(tip);
    expect(run.sha).not.toBe(sha);
    expect(run.conclusion).toBe('success');
    expect(run.logTail).toContain(tip);
  }, 40000);

  it('lets the push succeed when ci.json is missing', () => {
    const f = setup(null);
    commit(f, 'a.txt');
    expect(() => push(f, 'main')).not.toThrow();
    expect(listRuns(f.state)).toEqual([]);
  });

  it('holds the BENCH_CI_JOBS cap across runners, and defaults to 2', async () => {
    for (const [jobs, expected] of [['1', 1], [undefined, 2]] as const) {
      // each check registers itself in an "active" directory, records how many are active, and waits for the gate
      const f = setup((gate) => ({
        install: 'true',
        check: [
          'mkdir -p "$BENCH_ACTIVE"',
          'touch "$BENCH_ACTIVE/$$"',
          'ls "$BENCH_ACTIVE" | wc -l >> "$BENCH_COUNTS"',
          `while [ ! -f ${gate} ]; do sleep 0.05; done`,
          'rm "$BENCH_ACTIVE/$$"',
        ].join('; '),
        mainCi: 'ci',
      }));
      const active = join(f.dir, 'active');
      const env: Record<string, string> = { BENCH_ACTIVE: active, BENCH_COUNTS: join(f.dir, 'counts') };
      if (jobs) env.BENCH_CI_JOBS = jobs;
      writeFileSync(join(f.dir, 'counts'), '');
      commit(f, 'a.txt');
      push(f, 'main', env);
      for (const b of ['b1', 'b2']) {
        git(f.work, 'checkout', '-q', '-b', b, 'main');
        commit(f, `${b}.txt`);
        push(f, b, env);
      }
      const running = () => (existsSync(active) ? readdirSync(active).length : 0);
      await waitFor(() => running() === expected);
      await sleep(700); // long enough for a runner above the cap to have started
      expect(running()).toBe(expected);
      const runs = listRuns(f.state);
      expect(runs).toHaveLength(3);
      expect(runs.filter((r: { status: string }) => r.status === 'in_progress')).toHaveLength(expected);
      expect(runs.filter((r: { status: string }) => r.status === 'queued')).toHaveLength(3 - expected);
      writeFileSync(f.gate, 'go');
      await waitFor(() => listRuns(f.state).every((r: { status: string }) => r.status === 'completed'), 40000);
      const counts = readFileSync(join(f.dir, 'counts'), 'utf8').trim().split('\n').map(Number);
      expect(counts).toHaveLength(3);
      expect(Math.max(...counts)).toBe(expected);
      expect(listRuns(f.state).every((r: { conclusion: string }) => r.conclusion === 'success')).toBe(true);
      expect(existsSync(join(f.state, 'ci-slots')) ? readdirSync(join(f.state, 'ci-slots')) : []).toEqual([]);
    }
  }, 120000);
});
