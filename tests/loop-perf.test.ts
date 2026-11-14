import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The loop perf fixes of 3 Nov 2026 (docs/pilot/2026-11-03-loop-performance.md), as wave-loop sees them:
//  1. a load warning at wave start (from the preflight dry run);
//  3. the check on main: skipped when the merged tree is the tree CI checked, else watched outside the merge lock;
//  6. no second critic round after a MERGE when the only later changes are CI-only.
// The workflow runs with a stubbed agent() that answers by label, as in tests/wave-loop-relay.test.ts.
const source = readFileSync(join(import.meta.dirname, '..', 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Opts = { label: string };
type Answer = unknown | ((opts: Opts, prompt: string) => unknown | Promise<unknown>);
type Json = Record<string, any>;
type TaskArg = { id: string; title: string; branch: string; deps: string[]; text: string; owns: string; notes: string };
const task = (id: string, extra: Partial<TaskArg> = {}): TaskArg => ({ id, title: 'T', branch: `feat/${id}`, deps: [], text: 'x', owns: 'y', notes: '', ...extra });

const ran = (line: unknown, exitCode = 0) => ({ status: 'ran', exitCode, stdout: `${JSON.stringify(line)}\n` });
const preflight = (load?: Json) => ran({ outcome: 'error', exit: 4, mergeSha: null, message: 'could not read PR #0: no pull requests found', loopVersion: '2.2.0', ...(load ? { load } : {}) }, 4);

async function runWave(answers: Record<string, Answer>, extra: { project?: Json; tasks?: TaskArg[] } = {}) {
  const calls: string[] = [];
  const prompts: Record<string, string[]> = {};
  const logs: string[] = [];
  const all: Record<string, Answer> = { 'preflight:merge': preflight(), ...answers };
  const agent = async (prompt: string, opts: Opts) => {
    calls.push(opts.label);
    (prompts[opts.label] ||= []).push(prompt);
    await new Promise((r) => setTimeout(r, 0));
    const a = all[opts.label];
    const v = typeof a === 'function' ? await (a as (o: Opts, p: string) => unknown)(opts, prompt) : a;
    return v === undefined ? null : v;
  };
  const args = {
    project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 'docs/spec.md', maxBuilders: 2, maxChains: 4, mainCi: 'check', syncPolicy: 'conflict', ...(extra.project || {}) },
    wave: '9',
    tasks: extra.tasks ?? [task('9.1')],
    tail: null,
  };
  const out = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)(
    agent,
    async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
    async () => [],
    () => {},
    (s: string) => logs.push(s),
    args,
  );
  return { out, calls, prompts, logs, escalations: (out.escalations as Array<{ task: string; what: string; question: string }>) ?? [] };
}

const opened = (id: string, pr: number) => ({ status: 'opened', branch: `feat/${id}`, worktree: `/tmp/sim-wt/${id}`, filesChanged: ['a'], checkCommand: 'c', checkExitCode: 0, decisions: [], questions: [], prNumber: pr, prUrl: `https://example.test/pull/${pr}` });
const ciOf = (state: string, over: Json = {}) => ran({ state, failing: [], logTail: '', polls: 1, elapsedMs: 1000, ...over });
const green = ciOf('green');
const REVIEWED = 'ab'.repeat(20);
const criticMerge = { verdict: 'MERGE', prHeadSha: REVIEWED, checklist: [], fixItems: [], notes: 'all good' };
const criticFix = { ...criticMerge, verdict: 'FIX', fixItems: [{ n: 1, what: 'rename', provedBy: 'test', cause: 'defect' }] };
const mergeLine = (over: Json = {}) => ({ outcome: 'merged', exit: 0, mergeSha: 'm1', mainSha: 'm1', ciState: 'green', failing: [], conflictFiles: [], revertPrUrl: null, message: 'merged', logTail: '', ciWaitMs: 100, mergeMs: 200, mainCheckMs: 300, revertMs: 0, elapsedMs: 600, mainCheck: 'green', ...over });
const mergeRan = (over: Json = {}) => {
  const line = mergeLine(over);
  return ran(line, line.exit);
};
const deferredLine = { mainCheck: 'deferred', mainSha: null, mainCheckMs: 5 };
const deferred = () => {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
};

describe('perf 1: machine load warning at wave start', () => {
  it('logs a warning when the preflight reports a load above the threshold, and still runs the wave', async () => {
    const { out, logs } = await runWave({
      'preflight:merge': preflight({ load1: 200.5, cores: 8, threshold: 32, high: true }),
      'worker:9.1': opened('9.1', 7),
      'ci:9.1 r1': green,
      'critic:9.1 r1': criticMerge,
      'merger:9.1': mergeRan(),
    });
    const warn = logs.find((l) => l.startsWith('WARNING'));
    expect(warn).toContain('200.5');
    expect(warn).toContain('above 32 (8 cores)');
    expect(out.gate).toBe('PASS');
  });

  it('logs nothing when the load is fine or not reported', async () => {
    for (const load of [{ load1: 3, cores: 8, threshold: 32, high: false }, undefined]) {
      const { logs } = await runWave({ 'preflight:merge': preflight(load), 'worker:9.1': opened('9.1', 7), 'ci:9.1 r1': green, 'critic:9.1 r1': criticMerge, 'merger:9.1': mergeRan() });
      expect(logs.some((l) => l.startsWith('WARNING'))).toBe(false);
    }
  });
});

describe('perf 3: the check on main', () => {
  const base = { 'worker:9.1': opened('9.1', 7), 'ci:9.1 r1': green, 'critic:9.1 r1': criticMerge };

  it('with mainCi the merge relay defers the main check; without it the merge relay verifies inline', async () => {
    const withCi = await runWave({ ...base, 'merger:9.1': mergeRan() });
    expect(withCi.prompts['merger:9.1'][0]).toContain('/tmp/sim/.claude/scripts/merge-pr.js 7 --repo /tmp/sim --worktree /tmp/sim-wt/9.1 --defer-main');
    const local = await runWave({ ...base, 'merger:9.1': mergeRan() }, { project: { mainCi: '' } });
    expect(local.prompts['merger:9.1'][0]).not.toContain('--defer-main');
  });

  it('skipped:unchanged merges with no main watch and logs the skip', async () => {
    const { out, calls, logs } = await runWave({ ...base, 'merger:9.1': mergeRan({ mainCheck: 'skipped:unchanged', mainCheckMs: 0 }) });
    expect(calls.some((c) => c.startsWith('main:'))).toBe(false);
    expect(out.gate).toBe('PASS');
    expect(out.tasks['9.1'].merge).toMatchObject({ outcome: 'merged', checkOnMainExitCode: 0 });
    expect(out.tasks['9.1'].merge.script.mainCheck).toBe('skipped:unchanged');
    expect(logs).toContain('9.1: check on main skipped: the merged tree is the tree CI checked');
  });

  it('deferred: a --verify-main relay watches main after the merge relay, and its green result merges the task', async () => {
    const { out, calls, prompts } = await runWave({ ...base, 'merger:9.1': mergeRan(deferredLine), 'main:9.1': mergeRan({ mainCheck: 'green', mainCheckMs: 400000, ciWaitMs: 0, mergeMs: 0 }) });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'merger:9.1', 'main:9.1']);
    expect(prompts['main:9.1'][0]).toContain('/tmp/sim/.claude/scripts/merge-pr.js 7 --repo /tmp/sim --verify-main m1 --timeout-min 9');
    expect(out.gate).toBe('PASS');
    expect(out.tasks['9.1'].merge).toMatchObject({ outcome: 'merged', mergeSha: 'm1', checkOnMainExitCode: 0 });
    expect(out.timings['9.1'].mainCheckMs).toBe(5 + 400000);
  });

  it('the merge lock is released before main is watched: the next PR merges while the first main run is still going', async () => {
    const hold = deferred();
    const order: string[] = [];
    const { out, calls } = await runWave(
      {
        'worker:9.1': opened('9.1', 7),
        'worker:9.2': opened('9.2', 8),
        'ci:9.1 r1': green,
        'ci:9.2 r1': green,
        'critic:9.1 r1': criticMerge,
        'critic:9.2 r1': criticMerge,
        'merger:9.1': mergeRan(deferredLine),
        'merger:9.2': () => {
          order.push('merger:9.2');
          hold.release();
          return mergeRan({ mergeSha: 'm2', mainSha: 'm2', mainCheck: 'skipped:unchanged' });
        },
        'main:9.1': async () => {
          await hold.p;
          order.push('main:9.1 done');
          return mergeRan({ mainCheck: 'green' });
        },
      },
      { tasks: [task('9.1'), task('9.2')] },
    );
    // If the watch held the merge lock, merger:9.2 could never run and main:9.1 would never finish.
    expect(order).toEqual(['merger:9.2', 'main:9.1 done']);
    expect(calls).toContain('main:9.1');
    expect(out.gate).toBe('PASS');
  });

  it('a dependent task starts only after its dependency’s main check came back', async () => {
    const { calls } = await runWave(
      {
        'worker:9.1': opened('9.1', 7),
        'worker:9.2': opened('9.2', 8),
        'ci:9.1 r1': green,
        'ci:9.2 r1': green,
        'critic:9.1 r1': criticMerge,
        'critic:9.2 r1': criticMerge,
        'merger:9.1': mergeRan(deferredLine),
        'main:9.1': mergeRan({ mainCheck: 'green' }),
        'merger:9.2': mergeRan({ mainCheck: 'skipped:unchanged' }),
      },
      { tasks: [task('9.1'), task('9.2', { deps: ['9.1'] })] },
    );
    expect(calls.indexOf('main:9.1')).toBeLessThan(calls.indexOf('worker:9.2'));
  });

  it('a red main found by the watch is reverted by the script and the task reopens, as before', async () => {
    const { out } = await runWave({
      ...base,
      'merger:9.1': mergeRan(deferredLine),
      'main:9.1': mergeRan({ outcome: 'reverted', exit: 3, mainCheck: 'red', mainSha: 'r1', revertPrUrl: 'https://example.test/pull/9', logTail: 'boom' }),
      'worker:9.1 reopen': opened('9.1', 10),
      'ci:9.1 reopen': green,
      'critic:9.1 reopen': criticMerge,
      'merger:9.1 reopen': mergeRan({ mergeSha: 'm3', mainSha: 'm3', mainCheck: 'skipped:unchanged' }),
    });
    expect(out.tasks['9.1'].reopened).toBe(true);
    expect(out.tasks['9.1'].merged).toBe(true);
  });

  it('a watch that reports pending is called again (c2, c3); still pending after three calls escalates', async () => {
    const pending = mergeRan({ outcome: 'pending', exit: 5, mainCheck: 'pending', mainSha: null, mainCheckMs: 540000 });
    const twice = await runWave({ ...base, 'merger:9.1': mergeRan(deferredLine), 'main:9.1': pending, 'main:9.1 c2': pending, 'main:9.1 c3': mergeRan({ mainCheck: 'green', mainCheckMs: 60000 }) });
    expect(twice.calls.filter((c) => c.startsWith('main:'))).toEqual(['main:9.1', 'main:9.1 c2', 'main:9.1 c3']);
    expect(twice.out.gate).toBe('PASS');
    expect(twice.out.timings['9.1'].mainCheckMs).toBe(5 + 540000 * 2 + 60000);

    const stuck = await runWave({ ...base, 'merger:9.1': mergeRan(deferredLine), 'main:9.1': pending, 'main:9.1 c2': pending, 'main:9.1 c3': pending });
    expect(stuck.out.gate).toBe('FAIL');
    expect(stuck.escalations[0].what).toMatch(/still running after 3 watch calls/);
    expect(stuck.escalations[0].question).toContain('merged at m1');
  });

  it('a blocked or empty watch relay escalates and names the merged sha', async () => {
    const blocked = await runWave({ ...base, 'merger:9.1': mergeRan(deferredLine), 'main:9.1': { status: 'blocked', note: 'denied' } });
    expect(blocked.escalations[0].what).toMatch(/main check relay blocked/);
    expect(blocked.escalations[0].question).toContain('merged at m1');
    const none = await runWave({ ...base, 'merger:9.1': mergeRan(deferredLine) });
    expect(none.escalations[0].what).toMatch(/main check relay returned nothing/);
  });
});

describe('perf 6: no second critic round after a MERGE when only CI-only changes followed', () => {
  // Round 1: the critic says MERGE but CI is red (a formatter complaint), so a fix round runs; round 2 asks ci-only.js.
  const redThenFix = {
    'worker:9.1': opened('9.1', 7),
    'ci:9.1 r1': ciOf('red', { failing: ['prettier'], logTail: 'Code style issues found' }),
    'critic:9.1 r1': criticMerge,
    'worker:9.1 fix1': opened('9.1', 7),
    'ci:9.1 r2': green,
    'merger:9.1': mergeRan(),
  };

  it('skips the critic in round 2, logs it, records it, and merges on the round-1 MERGE', async () => {
    const { out, calls, prompts, logs } = await runWave({ ...redThenFix, 'delta:9.1 r2': ran({ ciOnly: true, since: REVIEWED, head: 'cd'.repeat(20), reason: '1 formatting-only commit (12 files)', commits: 1, files: [] }) });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'worker:9.1 fix1', 'ci:9.1 r2', 'delta:9.1 r2', 'merger:9.1']);
    expect(prompts['delta:9.1 r2'][0]).toContain(`/tmp/sim/.claude/scripts/ci-only.js 7 --repo /tmp/sim --since ${REVIEWED}`);
    expect(logs).toContain('9.1 critic round 2: skipped (CI-only change)');
    expect(out.tasks['9.1'].rounds[1]).toMatchObject({ round: 2, verdict: 'MERGE', ci: 'green', criticSkipped: 'ci-only' });
    expect(out.gate).toBe('PASS');
  });

  it('runs the critic when ci-only.js says the change is real, or cannot say', async () => {
    for (const delta of [ran({ ciOnly: false, reason: 'changes a.ts beyond formatting' }), { status: 'blocked', note: 'denied' }, undefined]) {
      const { calls, out } = await runWave({ ...redThenFix, 'delta:9.1 r2': delta, 'critic:9.1 r2': criticMerge });
      expect(calls).toContain('critic:9.1 r2');
      expect(out.tasks['9.1'].rounds[1].criticSkipped).toBeUndefined();
    }
  });

  it('never skips after a FIX verdict, and never asks without a real reviewed sha', async () => {
    const afterFix = await runWave({ 'worker:9.1': opened('9.1', 7), 'ci:9.1 r1': green, 'critic:9.1 r1': criticFix, 'worker:9.1 fix1': opened('9.1', 7), 'ci:9.1 r2': green, 'critic:9.1 r2': criticMerge, 'merger:9.1': mergeRan() });
    expect(afterFix.calls.some((c) => c.startsWith('delta:'))).toBe(false);
    expect(afterFix.calls).toContain('critic:9.1 r2');

    const noSha = await runWave({ ...redThenFix, 'critic:9.1 r1': { ...criticMerge, prHeadSha: 'abc' }, 'critic:9.1 r2': criticMerge });
    expect(noSha.calls.some((c) => c.startsWith('delta:'))).toBe(false);
    expect(noSha.calls).toContain('critic:9.1 r2');
  });

  it('a third round compares against the head the critic actually reviewed', async () => {
    const { prompts, calls } = await runWave({
      ...redThenFix,
      'ci:9.1 r2': ciOf('red', { failing: ['lint'] }),
      'delta:9.1 r2': ran({ ciOnly: true, reason: 'formatting' }),
      'worker:9.1 fix2': opened('9.1', 7),
      'ci:9.1 r3': green,
      'delta:9.1 r3': ran({ ciOnly: true, reason: 'formatting' }),
    });
    expect(calls.filter((c) => c.startsWith('critic:'))).toEqual(['critic:9.1 r1']);
    expect(prompts['delta:9.1 r3'][0]).toContain(`--since ${REVIEWED}`);
  });
});
