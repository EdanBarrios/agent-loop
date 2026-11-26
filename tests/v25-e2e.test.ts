import { execFile, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Task 3.T (v2.5): the wave 3 tail. Real scripts run over a temp repo with a fake `gh` on PATH, and the real wave-loop
// script runs with a stubbed agent():
//
//   1  two concurrent merge-pr.js processes are serialized by the merge lock (the fake gh logs every call)
//   2  project.reuseTreeCi off runs the check on the default branch; on (with a plain workflow) skips it
//   3  a relaunch whose outside dependency dep-state.js (the real script, over the temp repo) reports unmerged parks;
//      one it reports merged starts
//   4  a high integration finding fails the gate
//
// Nothing here uses the network or a real agent.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');
const SCRIPTS = join(ROOT, 'scripts');
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const waveSource = readFileSync(join(ROOT, 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Json = Record<string, any>;
type Opts = { label: string; model?: string; effort?: string };
type Answer = unknown | ((opts: Opts, prompt: string) => unknown | Promise<unknown>);

const scratch = mkdtempSync(join(tmpdir(), 'v25-e2e-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------------------------------
// A temp repo with a bare origin, and a fake `gh`
// ---------------------------------------------------------------------------------------------------------------------
const GIT_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// The fake gh answers the calls merge-pr.js and dep-state.js make, from files in $GH_DIR, and appends one line per call to
// $GH_DIR/calls.log: `<epoch ms> <$GH_TAG> <gh subcommand>`. `pr checks` and `pr merge` sleep, so two unserialized
// processes would interleave their calls. `pr merge` really merges the head branch into the origin's default branch (a
// --no-ff merge commit made in a scratch clone) and records the merge commit, so the trees are real.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const dir = process.env.GH_DIR;
const a = process.argv.slice(2);
const number = /^\\d+$/.test(a[2] || '') ? a[2] : '';
fs.appendFileSync(path.join(dir, 'calls.log'), Date.now() + ' ' + (process.env.GH_TAG || '-') + ' ' + a.slice(0, 2).join(' ') + '\\n');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const delay = Number(process.env.GH_DELAY_MS || 0);
const prFile = path.join(dir, 'pr-' + number + '.json');
const readPr = () => JSON.parse(fs.readFileSync(prFile, 'utf8'));
const cmd = a.slice(0, 2).join(' ');
if (cmd === 'pr view') {
  process.stdout.write(JSON.stringify(readPr()) + '\\n');
} else if (cmd === 'pr checks') {
  sleep(delay);
  process.stdout.write(JSON.stringify([{ name: 'check', state: 'SUCCESS', bucket: 'pass', link: '', workflow: 'check' }]) + '\\n');
} else if (cmd === 'pr merge') {
  sleep(delay);
  const pr = readPr();
  const scratch = path.join(dir, 'merge-' + number);
  const git = (...x) => cp.execFileSync('git', x, { cwd: scratch, env: process.env, stdio: 'pipe' }).toString().trim();
  cp.execFileSync('git', ['clone', '-q', process.env.GH_ORIGIN, scratch], { env: process.env, stdio: 'pipe' });
  git('merge', '--no-ff', '-m', 'Merge pull request #' + number, 'origin/' + pr.headRefName);
  const oid = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', 'HEAD:' + pr.baseRefName);
  pr.state = 'MERGED';
  pr.mergeCommit = { oid };
  fs.writeFileSync(prFile, JSON.stringify(pr));
} else if (cmd === 'run list') {
  process.stdout.write(JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'success' }]) + '\\n');
} else if (cmd === 'pr list') {
  process.stdout.write(fs.readFileSync(path.join(dir, 'merged-list.json'), 'utf8'));
} else {
  process.stderr.write('unexpected gh ' + a.join(' ') + '\\n');
  process.exit(1);
}
`;

const WORKFLOW = ['name: check', 'on:', '  push:', '    branches: [main]', '  pull_request:', 'jobs:', '  check:', '    runs-on: ubuntu-latest', '    steps:', '      - run: npm ci', ''].join('\n');

let fixtureCount = 0;
type Fixture = { repo: string; origin: string; ghDir: string; env: Record<string, string>; heads: Record<string, string>; calls: () => Array<{ at: number; tag: string; cmd: string }> };

/** A fresh bare origin, a clone of it (the project repo), the fake gh, and one open PR per `files` entry. */
function fixture(prs: Record<number, string>, project: Json): Fixture {
  const root = join(scratch, `fx${++fixtureCount}`);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const repo = join(root, 'repo');
  const ghDir = join(root, 'gh');
  const bin = join(root, 'bin');
  for (const d of [root, ghDir, bin]) mkdirSync(d, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(seed, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(seed, '.github', 'workflows', 'check.yml'), WORKFLOW);
  writeFileSync(join(seed, 'README.md'), '# fixture\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');
  const heads: Record<string, string> = {};
  for (const [number, file] of Object.entries(prs)) {
    const branch = `task/9.${number}-slug`;
    git(seed, 'checkout', '-q', '-b', branch, 'main');
    writeFileSync(join(seed, file), `${file}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', `feat: ${file}`);
    git(seed, 'push', '-q', 'origin', branch);
    heads[number] = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'checkout', '-q', 'main');
    writeFileSync(
      join(ghDir, `pr-${number}.json`),
      JSON.stringify({ title: `Task 9.${number}`, state: 'OPEN', headRefName: branch, baseRefName: 'main', headRefOid: heads[number], mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', mergeCommit: null }),
    );
  }
  git(root, 'clone', '-q', origin, repo);
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude', 'loop.local.json'), JSON.stringify({ name: 'Sim', mainCi: 'check', syncPolicy: 'conflict', ...project }));
  writeFileSync(join(ghDir, 'merged-list.json'), '[]');
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, GH_DIR: ghDir, GH_ORIGIN: origin, GH_DELAY_MS: '300' };
  const calls = () =>
    (existsSync(join(ghDir, 'calls.log')) ? readFileSync(join(ghDir, 'calls.log'), 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [at, tag, ...rest] = l.split(' ');
        return { at: Number(at), tag, cmd: rest.join(' ') };
      });
  return { repo, origin, ghDir, env, heads, calls };
}

/** Run merge-pr.js for one PR; `tag` marks the fake gh's log lines. Resolves with the exit code and the JSON line printed. */
function mergeProcess(fx: Fixture, pr: number, extra: string[] = []): Promise<{ code: number; line: Json }> {
  return new Promise((done, fail) => {
    const child = spawn('node', [join(SCRIPTS, 'merge-pr.js'), String(pr), '--repo', fx.repo, ...extra], { env: { ...fx.env, GH_TAG: String(pr) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', fail);
    child.on('close', (code) => {
      try {
        done({ code: code ?? -1, line: JSON.parse(stdout.trim().split('\n').pop()!) });
      } catch {
        fail(new Error(`merge-pr.js ${pr} printed no JSON (exit ${code}): ${stdout} ${stderr}`));
      }
    });
  });
}

const lockDir = (fx: Fixture) => join(fx.repo, '.git', 'agent-loop-merge.lock');
const treeOf = (cwd: string, rev: string) => git(cwd, 'rev-parse', `${rev}^{tree}`);

// ---------------------------------------------------------------------------------------------------------------------
// 1. the merge lock
// ---------------------------------------------------------------------------------------------------------------------
describe('two concurrent merge-pr.js processes', () => {
  it('are serialized by the merge lock: one runs its whole merge before the other reads its PR', async () => {
    const fx = fixture({ 1: 'one.txt', 2: 'two.txt' }, {});
    const [a, b] = await Promise.all([mergeProcess(fx, 1), mergeProcess(fx, 2)]);
    for (const r of [a, b]) {
      expect(r.code).toBe(0);
      expect(r.line).toMatchObject({ outcome: 'merged', exit: 0, mainCheck: 'green' });
    }
    // The fake gh's log: every call of the first process comes before every call of the second, whichever won the race.
    const calls = fx.calls();
    const order = calls.map((c) => c.tag).filter((tag, i, all) => i === 0 || tag !== all[i - 1]);
    expect(order, JSON.stringify(calls)).toHaveLength(2);
    expect(order.slice().sort()).toEqual(['1', '2']);
    const [first, second] = order;
    const ofFirst = calls.filter((c) => c.tag === first);
    const ofSecond = calls.filter((c) => c.tag === second);
    expect(Math.max(...ofFirst.map((c) => c.at))).toBeLessThanOrEqual(Math.min(...ofSecond.map((c) => c.at)));
    // The first held the lock through its check on the default branch, the second read its PR only after that.
    expect(ofFirst.map((c) => c.cmd)).toEqual(['pr view', 'pr checks', 'pr merge', 'pr view', 'run list']);
    expect(ofSecond.map((c) => c.cmd)).toEqual(['pr view', 'pr checks', 'pr merge', 'pr view', 'run list']);
    // Only the process that waited reports a lock wait.
    const waited = (first === '1' ? b : a).line;
    const winner = (first === '1' ? a : b).line;
    expect(waited.lockWaitMs).toBeGreaterThanOrEqual(4000);
    expect(winner.lockWaitMs).toBeLessThan(4000);
    // Both merges landed on the origin's default branch, and the lock is gone.
    git(fx.repo, 'fetch', '-q', 'origin');
    expect(git(fx.repo, 'ls-tree', '--name-only', 'origin/main').split('\n')).toEqual(expect.arrayContaining(['one.txt', 'two.txt']));
    expect(git(fx.repo, 'log', '--merges', '--format=%s', 'origin/main').split('\n').sort()).toEqual(['Merge pull request #1', 'Merge pull request #2']);
    expect(existsSync(lockDir(fx))).toBe(false);
  });

  it('a lock held by a live process makes the other end "locked" (exit 2) when its wait is spent, and releases nothing of the holder', async () => {
    const fx = fixture({ 1: 'one.txt' }, { mergeLockWaitMin: 0 });
    mkdirSync(lockDir(fx));
    writeFileSync(join(lockDir(fx), 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), pr: 99, startedAt: new Date().toISOString() }));
    const r = await mergeProcess(fx, 1);
    expect(r.code).toBe(2);
    expect(r.line).toMatchObject({ outcome: 'locked', exit: 2, mergeSha: null });
    expect(r.line.message).toContain('PR #99');
    expect(fx.calls()).toEqual([]);
    expect(existsSync(join(lockDir(fx), 'owner.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. tree reuse is opt-in
// ---------------------------------------------------------------------------------------------------------------------
describe('project.reuseTreeCi', () => {
  it('off (the default) runs the check on the default branch though the merged tree is the tree CI checked', async () => {
    const fx = fixture({ 1: 'one.txt' }, {});
    const r = await mergeProcess(fx, 1);
    expect(r.code).toBe(0);
    expect(r.line).toMatchObject({ outcome: 'merged', mainCheck: 'green' });
    expect(r.line.treeReuse.allowed).toBe(false);
    expect(r.line.treeReuse.reason).toContain('reuseTreeCi');
    expect(fx.calls().map((c) => c.cmd)).toContain('run list');
    // The trees really are equal, so only the option stopped the skip.
    expect(treeOf(fx.repo, r.line.mergeSha)).toBe(treeOf(fx.repo, fx.heads[1]));
  });

  it('on, with a plain workflow file, skips the check on the default branch', async () => {
    const fx = fixture({ 1: 'one.txt' }, { reuseTreeCi: true });
    const r = await mergeProcess(fx, 1);
    expect(r.code).toBe(0);
    expect(r.line).toMatchObject({ outcome: 'merged', mainCheck: 'skipped:unchanged' });
    expect(r.line.treeReuse.allowed).toBe(true);
    expect(fx.calls().map((c) => c.cmd)).not.toContain('run list');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The stubbed wave (the real wave-loop script, a stubbed agent)
// ---------------------------------------------------------------------------------------------------------------------
const ran = (line: unknown, exitCode = 0) => ({ status: 'ran', exitCode, stdout: `${JSON.stringify(line)}\n` });
const permission = { allowed: true, rule: 'Bash(node /x/.claude/scripts/merge-pr.js *)', source: '/x/.claude/settings.json', denied: null, ask: null, broad: [], autoModeRules: 0, checked: [] };
const preflightLine = ran({ outcome: 'error', exit: 4, mergeSha: null, message: 'could not read PR #0: no pull requests found', loopVersion: VERSION, baseSha: 'ab'.repeat(20), permission }, 4);
const task = (id: string, deps: string[] = []) => ({ id, title: `Task ${id}`, branch: `task/${id}-slug`, deps, text: 'x', owns: 'y', notes: '' });
const opened = (id: string, pr: number) => ({ status: 'opened', branch: `task/${id}-slug`, worktree: `/tmp/sim-wt/${id}`, filesChanged: ['a'], checkCommand: 'c', checkExitCode: 0, decisions: [], questions: [], prNumber: pr, prUrl: `https://example.test/pull/${pr}` });
const criticMerge = { verdict: 'MERGE', prHeadSha: 'abc1234', checklist: [], fixItems: [], findings: [], notes: '' };
const mergeRan = (sha: string) => ran({ outcome: 'merged', exit: 0, mergeSha: sha, mainSha: sha, ciState: 'green', failing: [], conflictFiles: [], revertPrUrl: null, message: 'merged', logTail: '', ciWaitMs: 1, mergeMs: 1, mainCheckMs: 1 });
const chainFor = (id: string, pr: number, sha: string): Record<string, Answer> => ({
  [`worker:${id}`]: opened(id, pr),
  [`ci:${id} r1`]: ran({ state: 'green', failing: [], logTail: '', polls: 1, elapsedMs: 1000 }),
  [`critic:${id} r1`]: criticMerge,
  [`merger:${id}`]: mergeRan(sha),
});

async function runWave(repo: string, tasks: ReturnType<typeof task>[], answers: Record<string, Answer>, project: Json = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const all: Record<string, Answer> = { 'preflight:merge': preflightLine, ...answers };
  const agent = async (prompt: string, o: Opts) => {
    calls.push(o.label);
    await new Promise((r) => setTimeout(r, 0));
    const a = all[o.label];
    const v = typeof a === 'function' ? await (a as (o: Opts, p: string) => unknown)(o, prompt) : a;
    return v === undefined ? null : v;
  };
  const args = { project: { name: 'Sim', repo, github: 'o/r', worktrees: `${repo}-wt`, spec: 'docs/spec.md', maxBuilders: 2, maxChains: 4, mainCi: 'check', syncPolicy: 'conflict', ...project }, wave: '9', tasks, tail: null };
  const out = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', waveSource)(
    agent,
    async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
    async () => [],
    () => {},
    (line: string) => logs.push(String(line)),
    args,
  );
  return { out, calls, logs, escalations: (out.escalations ?? []) as Array<{ task: string; what: string; question: string }> };
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. a relaunch with an outside dependency, checked by the real dep-state.js over the temp repo
// ---------------------------------------------------------------------------------------------------------------------
describe('a relaunch whose dependency is outside the run', () => {
  const relaunch = [task('9.2', ['9.1']), task('9.3', ['9.2'])];

  // The dep-state relay: the command line the workflow gave it, run for real with the loop's own scripts directory.
  const depRelay = (fx: Fixture): Answer => async (_o, prompt) => {
    const command = prompt.split('\n').find((l) => l.startsWith('node ') && l.includes('dep-state.js'));
    if (!command) throw new Error(`no dep-state.js command in the relay prompt: ${prompt}`);
    const real = command.replace(/^node \S+dep-state\.js/, `node ${join(SCRIPTS, 'dep-state.js')}`);
    const r = spawnSync('sh', ['-c', real], { cwd: fx.repo, encoding: 'utf8', env: fx.env });
    return { status: 'ran', exitCode: r.status ?? -1, stdout: r.stdout };
  };

  it('parks a task whose dependency has no merged PR, and its dependent; no worker starts', async () => {
    const fx = fixture({}, {});
    const { out, calls, escalations } = await runWave(fx.repo, relaunch, { 'deps:outside': depRelay(fx) });
    expect(calls).toContain('deps:outside');
    expect(out.gate).toBe('FAIL');
    expect(out.state).toEqual({ '9.2': 'parked', '9.3': 'parked' });
    expect(calls.filter((c) => c.startsWith('worker:'))).toEqual([]);
    expect(escalations.find((e) => e.task === '9.2')!.what).toBe('dependency 9.1 not merged on the default branch: no merged PR');
    expect(escalations.find((e) => e.task === '9.3')).toBeTruthy();
  });

  it('parks it too when the dependency PR merged but its merge commit is not on the default branch', async () => {
    const fx = fixture({}, {});
    // A commit that exists only on a side branch of the origin.
    const side = join(scratch, `side${fixtureCount}`);
    git(scratch, 'clone', '-q', fx.origin, side);
    git(side, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(side, 'x.txt'), 'x\n');
    git(side, 'add', '-A');
    git(side, 'commit', '-q', '-m', 'side');
    git(side, 'push', '-q', 'origin', 'side');
    writeFileSync(join(fx.ghDir, 'merged-list.json'), JSON.stringify([{ number: 21, headRefName: 'task/9.1-slug', mergeCommit: { oid: git(side, 'rev-parse', 'HEAD') } }]));
    const { out, escalations } = await runWave(fx.repo, relaunch, { 'deps:outside': depRelay(fx) });
    expect(out.state).toEqual({ '9.2': 'parked', '9.3': 'parked' });
    expect(escalations.find((e) => e.task === '9.2')!.what).toBe('dependency 9.1 not merged on the default branch: not on default branch');
  });

  it('starts both tasks when the dependency is merged and on the default branch, and the log names the PR and merge commit', async () => {
    const fx = fixture({}, {});
    const onMain = git(fx.repo, 'rev-parse', 'HEAD');
    writeFileSync(join(fx.ghDir, 'merged-list.json'), JSON.stringify([{ number: 21, headRefName: 'task/9.1-slug', mergeCommit: { oid: onMain } }]));
    const { out, calls, logs } = await runWave(fx.repo, relaunch, { 'deps:outside': depRelay(fx), ...chainFor('9.2', 8, 'm2'), ...chainFor('9.3', 9, 'm3') });
    expect(out.state).toEqual({ '9.2': 'merged', '9.3': 'merged' });
    expect(calls).toContain('worker:9.2');
    const line = logs.find((l) => l.includes('treated as merged in an earlier run'));
    expect(line).toContain('PR #21');
    expect(line).toContain(onMain);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. the integration gate
// ---------------------------------------------------------------------------------------------------------------------
describe('the integration review', () => {
  const high = { severity: 'high', area: 'security', what: 'TLS is off', where: 'src/db.ts:12' };
  const review = { summary: 's', findings: [high] };

  it('a high finding fails the gate by default, with one escalation naming what and where, though every task merged', async () => {
    const { out, escalations } = await runWave('/tmp/sim', [task('9.1')], { ...chainFor('9.1', 7, 'm1'), 'integration:wave': review });
    expect(out.state).toEqual({ '9.1': 'merged' });
    expect(out.gate).toBe('FAIL');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].what).toBe('integration: TLS is off (src/db.ts:12)');
    expect(escalations[0].question).toContain('follow-up task');
    expect(escalations[0].question).toContain('integrationGate');
  });

  it('integrationGate "off" passes the same wave and keeps the finding advisory', async () => {
    const { out, escalations } = await runWave('/tmp/sim', [task('9.1')], { ...chainFor('9.1', 7, 'm1'), 'integration:wave': review }, { integrationGate: 'off' });
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect(out.integration.findings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The version
// ---------------------------------------------------------------------------------------------------------------------
describe('LOOP_VERSION', () => {
  it('is 2.5.0 in package.json, wave-loop, chain-loop and the wave result', async () => {
    expect(VERSION).toBe('2.5.0');
    expect(waveSource).toContain("const LOOP_VERSION = '2.5.0'");
    expect(readFileSync(join(ROOT, 'claude', 'workflows', 'chain-loop.js'), 'utf8')).toContain("const LOOP_VERSION = '2.5.0'");
    const { out } = await runWave('/tmp/sim', [task('9.1')], chainFor('9.1', 7, 'm1'), { integrationGate: 'off' });
    expect(out.loopVersion).toBe('2.5.0');
  });
});
