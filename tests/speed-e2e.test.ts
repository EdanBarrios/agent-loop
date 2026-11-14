import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Task 2.T: the speed work end to end. The real wave-loop.js runs against stubbed agents (no network, no real agent):
//   - the CI relay, the merge relay and the facts relay answer with the stdout and exit code the scripts would print;
//   - the CI relay and the critic of one task are ordered by a promise the test controls (CI still pending when the
//     critic reports);
//   - the agent records for the timings table are synthesized from the stub call log with a fake clock, and the table
//     is printed by the real scripts/loop-scorecard.py --timings.
const root = join(import.meta.dirname, '..');
const source = readFileSync(join(root, 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const scorecard = join(root, 'scripts', 'loop-scorecard.py');
const run = promisify(execFile);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Opts = { label: string; model?: string; effort?: string; phase?: string };
type Answer = unknown | ((opts: Opts, prompt: string) => unknown | Promise<unknown>);
type Json = Record<string, any>;
type TaskArg = { id: string; title: string; branch: string; deps: string[]; text: string; owns: string; notes: string; lane?: string };

const task = (id: string, extra: Partial<TaskArg> = {}): TaskArg => ({ id, title: 'T', branch: `feat/${id}`, deps: [], text: 'x', owns: 'y', notes: '', ...extra });

// Fake clock: every agent call starts 30 s after the previous one started; how long it takes comes from its label.
const MIN = 60_000;
const START = 1_700_000_000_000;
const durationOf = (label: string) => {
  if (label.startsWith('worker:')) return /fix|reopen/.test(label) ? 2 * MIN : 10 * MIN;
  if (label.startsWith('critic:')) return 3 * MIN;
  if (label.startsWith('merger:')) return MIN / 2;
  if (label.startsWith('ci:')) return 4 * MIN;
  return MIN / 2;
};

const PROJECT = {
  name: 'Sim',
  repo: '/tmp/sim',
  github: 'o/r',
  worktrees: '/tmp/sim-wt',
  spec: 'docs/spec.md',
  maxBuilders: 2,
  maxChains: 4,
  mainCi: 'check',
  syncPolicy: 'conflict',
  syncConflicts: 'ratchet.json, by taking the higher value',
  fastLane: { enabled: true, maxPerWave: 3, testCountCommand: 'npm run -s test-count' },
};

async function runWave(answers: Record<string, Answer>, tasks: TaskArg[], projectExtra: Json = {}) {
  const calls: string[] = [];
  const prompts: Record<string, string[]> = {};
  const records: Json[] = [];
  let clock = START;
  const all: Record<string, Answer> = { 'preflight:merge': preflightOk, ...answers };
  const agent = async (prompt: string, opts: Opts) => {
    calls.push(opts.label);
    (prompts[opts.label] ||= []).push(prompt);
    const startedAt = clock;
    clock += 30_000;
    const durationMs = durationOf(opts.label);
    records.push({
      type: 'workflow_agent',
      index: records.length + 1,
      label: opts.label,
      agentId: `agent${records.length + 1}`,
      state: 'done',
      tokens: 1000,
      toolCalls: 3,
      durationMs,
      model: opts.model ?? 'claude-sonnet-5-5',
      queuedAt: startedAt - 1000,
      startedAt,
      lastProgressAt: startedAt + durationMs - 500,
    });
    // Agents take time: yield a macrotask so promise chains settle in label order, not in microtask-depth order.
    await new Promise((r) => setTimeout(r, 0));
    const a = all[opts.label];
    const v = typeof a === 'function' ? await (a as (o: Opts, p: string) => unknown)(opts, prompt) : a;
    return v === undefined ? null : v;
  };
  const args = { project: { ...PROJECT, ...projectExtra }, wave: '9', tasks, tail: null };
  const out = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)(
    agent,
    async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
    async () => [],
    () => {},
    () => {},
    args,
  );
  const escalations = (out.escalations as Array<{ task: string; what: string; question: string }>) ?? [];
  const labels = (prefix: string) => calls.filter((c) => c.startsWith(prefix));
  return { out, calls, prompts, records, escalations, labels };
}

const deferred = () => {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
};
const seq = (...items: unknown[]) => {
  let i = 0;
  return () => items[Math.min(i++, items.length - 1)];
};

const opened = (id: string, pr: number, localCheckMs = 120_000) => ({
  status: 'opened',
  branch: `feat/${id}`,
  worktree: `/tmp/sim-wt/${id}`,
  filesChanged: ['a'],
  checkCommand: 'c',
  checkExitCode: 0,
  decisions: [],
  questions: [],
  prNumber: pr,
  prUrl: `https://example.test/pull/${pr}`,
  localCheckMs,
});

const criticMerge = { verdict: 'MERGE', prHeadSha: 'abc', checklist: [], fixItems: [], notes: '' };

// What a relay returns: the command's stdout (one JSON line, as the scripts print) and its exit code.
const ran = (line: unknown, exitCode = 0) => ({ status: 'ran', exitCode, stdout: `${JSON.stringify(line)}\n` });
const ciOf = (state: string, over: Json = {}) => ran({ state, failing: [], logTail: '', polls: 2, elapsedMs: 4 * MIN, ...over });
const mergeRan = (over: Json = {}) => {
  const line = {
    outcome: 'merged',
    exit: 0,
    mergeSha: 'm1',
    mainSha: 'm1',
    ciState: 'green',
    failing: [],
    conflictFiles: [],
    revertPrUrl: null,
    message: 'merged',
    logTail: '',
    ciWaitMs: 0,
    mergeMs: MIN / 2,
    mainCheckMs: 3.5 * MIN,
    revertMs: 0,
    elapsedMs: 4 * MIN,
    ...over,
  };
  return ran(line, line.exit);
};
const blocked = (note = 'Permission to run this command was denied.') => ({ status: 'blocked', note });
const preflightOk = ran({ outcome: 'error', exit: 4, mergeSha: null, message: 'could not read PR #0: no pull requests found', loopVersion: '2.2.0' }, 4);
const green = ciOf('green');

// The read-only facts the fast-lane relay gathers: the changed files stay inside Owns and the test count rises.
const facts = {
  status: 'ran',
  changedFiles: ['docs/notes/a.md'],
  addedText: 'a synthetic added line',
  decisions: ['D1 | keep the wording | the conventional default | yes'],
  testCountBeforeOut: '40\n',
  testCountAfterOut: '41\n',
};

describe('2.T four-task fake wave: pending CI, red CI, fast lane and an ordinary task', () => {
  const wave = async () => {
    const events: string[] = [];
    const ci1 = deferred();
    const answers: Record<string, Answer> = {
      // 9.1: the critic reports MERGE while its CI is still pending; the CI relay answers only after the critic did.
      'worker:9.1': opened('9.1', 7),
      'ci:9.1 r1': async () => {
        await ci1.p;
        events.push('ci:9.1 resolved');
        return green;
      },
      'critic:9.1 r1': async () => {
        events.push('critic:9.1 reported');
        setTimeout(ci1.release, 5);
        return criticMerge;
      },
      'merger:9.1': () => {
        events.push('merger:9.1 started');
        return mergeRan();
      },
      // 9.2: CI is red; the critic says MERGE. One FIX round names the failing check, then green.
      'worker:9.2': opened('9.2', 8),
      'ci:9.2 r1': ciOf('red', { failing: ['lint'], logTail: 'src/a.js: no-unused-vars' }),
      'critic:9.2 r1': criticMerge,
      'worker:9.2 fix1': opened('9.2', 8, 60_000),
      'ci:9.2 r2': green,
      'critic:9.2 r2': criticMerge,
      'merger:9.2': mergeRan(),
      // 9.3: a fast-lane task, eligible: no critic.
      'worker:9.3': opened('9.3', 9),
      'ci:9.3 r1': green,
      'facts:9.3 r1': facts,
      'merger:9.3': mergeRan(),
      // 9.4: an ordinary task.
      'worker:9.4': opened('9.4', 10),
      'ci:9.4 r1': green,
      'critic:9.4 r1': criticMerge,
      'merger:9.4': mergeRan(),
    };
    const tasks = [task('9.1'), task('9.2'), task('9.3', { lane: 'fast', owns: 'docs/notes/' }), task('9.4')];
    const res = await runWave(answers, tasks);
    return { ...res, events };
  };

  it('has exactly one FIX round (the red CI), no merger agent, and the gate PASSes', async () => {
    const { out, calls, prompts, escalations, labels } = await wave();
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect(Object.values(out.state)).toEqual(['merged', 'merged', 'merged', 'merged']);

    // One FIX round in total, and it is the red CI of 9.2.
    expect(labels('worker:').filter((l) => /fix/.test(l))).toEqual(['worker:9.2 fix1']);
    expect(prompts['worker:9.2 fix1'][0]).toContain('CI failed on the PR head: lint');
    const verdicts = Object.values(out.tasks as Json).flatMap((t: Json) => t.rounds.map((r: Json) => [t.task, r.verdict, r.ci]));
    expect(verdicts.filter(([, v]) => v === 'FIX')).toEqual([]);
    expect(out.tasks['9.2'].rounds.map((r: Json) => [r.verdict, r.ci])).toEqual([
      ['MERGE', 'red'],
      ['MERGE', 'green'],
    ]);

    // No merger agent: every merger: call is a relay that runs merge-pr.js, none is the v2 merger prompt.
    const mergers = labels('merger:');
    expect(mergers.sort()).toEqual(['merger:9.1', 'merger:9.2', 'merger:9.3', 'merger:9.4']);
    for (const l of mergers) {
      expect(prompts[l][0], l).toContain('/tmp/sim/.claude/scripts/merge-pr.js');
      expect(prompts[l][0], l).not.toContain('You are the merger');
    }
    expect(calls.filter((c) => c === 'preflight:merge')).toHaveLength(1);
    expect(calls.indexOf('preflight:merge')).toBe(0);
  });

  it('the pending CI of 9.1 never causes a FIX: the merge starts after the CI relay resolved, after the critic reported', async () => {
    const { events, out } = await wave();
    expect(events).toEqual(['critic:9.1 reported', 'ci:9.1 resolved', 'merger:9.1 started']);
    expect(out.tasks['9.1'].rounds).toHaveLength(1);
    expect(out.tasks['9.1'].rounds[0]).toMatchObject({ verdict: 'MERGE', ci: 'green' });
  });

  it('the fast-lane task makes no critic call; the other three do (4 calls with the FIX round)', async () => {
    const { labels, out } = await wave();
    expect(labels('critic:').sort()).toEqual(['critic:9.1 r1', 'critic:9.2 r1', 'critic:9.2 r2', 'critic:9.4 r1']);
    expect(labels('facts:')).toEqual(['facts:9.3 r1']);
    expect(out.tasks['9.3'].rounds).toHaveLength(1);
    expect(out.tasks['9.3'].rounds[0]).toMatchObject({ verdict: 'MERGE', ci: 'green', lane: 'fast' });
  });

  it('every task records the merge script line in the v1 shape and the wave ends with main green', async () => {
    const { out } = await wave();
    for (const id of ['9.1', '9.2', '9.3', '9.4']) {
      expect(out.tasks[id].merged, id).toBe(true);
      expect(out.tasks[id].merge, id).toMatchObject({ outcome: 'merged', checkOnMainExitCode: 0 });
      expect(out.tasks[id].merge.script, id).toMatchObject({ exit: 0 });
    }
    expect(out.timings['9.2']).toEqual({ ciWaitMs: 8 * MIN, mergeMs: MIN / 2, mainCheckMs: 3.5 * MIN, localCheckMs: 180_000 });
  });

  it('prints the timings table of 1.4 for the run, from agent records synthesized from the call log', async () => {
    const { out, records } = await wave();
    const dir = mkdtempSync(join(tmpdir(), 'speed-e2e-'));
    try {
      const file = join(dir, 'result.json');
      writeFileSync(file, JSON.stringify({ result: JSON.stringify(out), workflowProgress: records }));
      const { stdout } = await run('python3', ['-I', scorecard, '--timings', file]);
      const lines = stdout.split('\n');
      expect(lines).toContain('| Task | Build | Local check | Slot wait | Review | CI wait | Merge | Main check | Fix rounds |');
      // Build and review are the agent records; fix rounds are the one fix worker; the fast-lane task has review 0.0.
      expect(lines).toContain('| 9.1 | 10.0 | 2.0 | n/a | 3.0 | 4.0 | 0.5 | 3.5 | 0.0 |');
      expect(lines).toContain('| 9.2 | 10.0 | 3.0 | n/a | 6.0 | 8.0 | 0.5 | 3.5 | 2.0 |');
      expect(lines).toContain('| 9.3 | 10.0 | 2.0 | n/a | 0.0 | 4.0 | 0.5 | 3.5 | 0.0 |');
      expect(lines).toContain('| 9.4 | 10.0 | 2.0 | n/a | 3.0 | 4.0 | 0.5 | 3.5 | 0.0 |');
      expect(lines).toContain('| wave | 40.0 | 9.0 | n/a | 12.0 | 20.0 | 2.0 | 14.0 | 2.0 |');
      expect(stdout).toMatch(/- Wall time: \d+\.\d min/);
      expect(stdout).toMatch(/- Idle time \(no agent running\): \d+\.\d min/);
      expect(stdout).toMatch(/- CI wait share of wall time: \d+\.\d%/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('2.T a second run in which the preflight relay answers blocked', () => {
  it('fails the wave before any worker runs, with one escalation naming the command', async () => {
    const { out, calls, escalations } = await runWave({ 'preflight:merge': blocked('denied by settings'), 'worker:9.1': opened('9.1', 7) }, [task('9.1'), task('9.2')]);
    expect(calls).toEqual(['preflight:merge']);
    expect(out.gate).toBe('FAIL');
    expect(out.tasks).toEqual({});
    expect(out.timings).toEqual({});
    expect(escalations).toHaveLength(1);
    expect(escalations[0].task).toBe('preflight');
    expect(`${escalations[0].what} ${escalations[0].question}`).toContain('merge-pr.js 0 --repo /tmp/sim --dry-run');
  });
});

describe('2.T the merge script reports a problem after the review', () => {
  const happy = { 'worker:9.1': opened('9.1', 7), 'ci:9.1 r1': green, 'critic:9.1 r1': criticMerge };

  it('a sync conflict starts exactly one worker fix round, then merges', async () => {
    const conflict = mergeRan({ outcome: 'refused', exit: 2, mergeSha: null, mainSha: null, conflictFiles: ['ratchet.json', 'src/x.ts'], message: 'sync conflict' });
    const { out, calls, prompts, escalations } = await runWave(
      { ...happy, 'merger:9.1': seq(conflict, mergeRan()), 'worker:9.1 fix1': opened('9.1', 7), 'ci:9.1 r2': green, 'critic:9.1 r2': criticMerge },
      [task('9.1')],
    );
    expect(calls.filter((c) => c.startsWith('worker:'))).toEqual(['worker:9.1', 'worker:9.1 fix1']);
    expect(calls.filter((c) => c.startsWith('merger:'))).toEqual(['merger:9.1', 'merger:9.1']);
    expect(prompts['worker:9.1 fix1'][0]).toContain('ratchet.json');
    expect(prompts['worker:9.1 fix1'][0]).toContain('src/x.ts');
    expect(prompts['worker:9.1 fix1'][0]).toContain('Resolve conflicts only in ratchet.json, by taking the higher value');
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
  });

  it('a red main after a merge reopens the task once, then merges', async () => {
    const reverted = mergeRan({ outcome: 'reverted', exit: 3, mainSha: 'm0', revertPrUrl: 'https://example.test/pull/99', message: 'main was red; reverted', logTail: 'FAIL tests/a.test.ts' });
    const { out, calls, prompts, escalations } = await runWave(
      {
        ...happy,
        'merger:9.1': reverted,
        'worker:9.1 reopen': { ...opened('9.1', 11), branch: 'feat/9.1-2' },
        'ci:9.1 reopen': green,
        'critic:9.1 reopen': criticMerge,
        'merger:9.1 reopen': mergeRan({ mergeSha: 'm2', mainSha: 'm2' }),
      },
      [task('9.1')],
    );
    expect(calls.filter((c) => c.includes('reopen')).filter((c) => c.startsWith('worker:'))).toEqual(['worker:9.1 reopen']);
    expect(prompts['worker:9.1 reopen'][0]).toContain('FAIL tests/a.test.ts');
    expect(out.tasks['9.1'].reopened).toBe(true);
    expect(out.tasks['9.1'].merged).toBe(true);
    expect(out.tasks['9.1'].merge).toMatchObject({ outcome: 'merged', mergeSha: 'm2', checkOnMainExitCode: 0 });
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
  });

  it('a second red main after the reopen is not reopened again: it escalates', async () => {
    const reverted = mergeRan({ outcome: 'reverted', exit: 3, revertPrUrl: 'u', message: 'reverted' });
    const { out, calls, escalations } = await runWave(
      { ...happy, 'merger:9.1': reverted, 'worker:9.1 reopen': opened('9.1', 11), 'ci:9.1 reopen': green, 'critic:9.1 reopen': criticMerge, 'merger:9.1 reopen': reverted },
      [task('9.1')],
    );
    expect(calls.filter((c) => c === 'worker:9.1 reopen')).toHaveLength(1);
    expect(out.gate).toBe('FAIL');
    expect(escalations).toHaveLength(1);
  });
});
