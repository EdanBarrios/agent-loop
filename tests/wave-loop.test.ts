import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Runs the wave-loop workflow script with stubbed agents. Each stub answers by agent label, so a test
// scripts one task's worker, critic and merger and asserts which agents ran and how the task ended.
// Task 2.1: these tests use the merger agent (project.merger = 'agent'); the CI relay stays on and answers green by default.
// The script-mode paths (relays, preflight, fast lane) are in tests/wave-loop-relay.test.ts.
const source = readFileSync(join(import.meta.dirname, '..', 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(
  /^export const meta/m,
  'const meta',
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Result = Record<string, unknown>;

async function runWave(answers: Record<string, Result>) {
  const calls: string[] = [];
  const agent = async (_prompt: string, opts: { label: string }) => {
    calls.push(opts.label);
    // Agents take time: yield a macrotask so the CI relay and the critic settle in start order.
    await new Promise((r) => setTimeout(r, 0));
    if (opts.label.startsWith('ci:') && !(opts.label in answers)) return greenCi;
    return answers[opts.label] ?? null;
  };
  const parallel = (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f()));
  const pipeline = async (items: unknown[], ...stages: Array<(v: unknown) => Promise<unknown>>) =>
    Promise.all(
      items.map(async (x) => {
        let v = x;
        for (const s of stages) v = await s(v);
        return v;
      }),
    );
  const args = {
    project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 's.md', maxBuilders: 2, maxChains: 2, mainCi: 'check', syncPolicy: 'conflict', merger: 'agent' },
    wave: '9',
    tasks: [{ id: '9.1', title: 'T', branch: 'feat/9.1', deps: [], text: 'x', owns: 'y', notes: '' }],
    tail: null,
  };
  const out = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)(
    agent,
    parallel,
    pipeline,
    () => {},
    () => {},
    args,
  );
  return { out, calls, escalations: (out.escalations as Array<{ what: string }>).map((e) => e.what) };
}

const base = { branch: 'feat/9.1', worktree: '/tmp/sim-wt/9.1', filesChanged: ['a'], checkCommand: 'c', decisions: [], questions: [] };
const opened = { ...base, status: 'opened', checkExitCode: 0, prNumber: 7, prUrl: 'u' };
const unfinished = { ...base, status: 'blocked', checkExitCode: -1, questions: ['check still running'] };
const greenCi = { status: 'ran', exitCode: 0, stdout: `${JSON.stringify({ state: 'green', failing: [], logTail: '', polls: 1, elapsedMs: 1000 })}\n` };
const merge = { verdict: 'MERGE', prHeadSha: 'abc', checklist: [], fixItems: [], notes: '' };
const fix = { ...merge, verdict: 'FIX', fixItems: [{ n: 1, what: 'x', provedBy: 'y', cause: 'defect' }] };
const merged = { outcome: 'merged', details: 'ok', mergeSha: 'm', mainSha: 'm', checkOnMainExitCode: 0 };

describe('wave-loop: a worker that returns before its check finishes', () => {
  it('is sent back to finish, then reviewed and merged', async () => {
    const { out, calls, escalations } = await runWave({
      'worker:9.1': unfinished,
      'worker:9.1 finish1': opened,
      'critic:9.1 r1': merge,
      'merger:9.1': merged,
    });
    expect(calls).toEqual(['worker:9.1', 'worker:9.1 finish1', 'ci:9.1 r1', 'critic:9.1 r1', 'merger:9.1']);
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
  });

  it('escalates as an unfinished check after the finish rounds run out', async () => {
    const { out, calls, escalations } = await runWave({
      'worker:9.1': unfinished,
      'worker:9.1 finish1': unfinished,
      'worker:9.1 finish2': unfinished,
    });
    expect(calls).toEqual(['worker:9.1', 'worker:9.1 finish1', 'worker:9.1 finish2']);
    expect(out.gate).toBe('FAIL');
    expect(escalations).toEqual(['npm run check unfinished after 2 finish rounds']);
  });

  it('still escalates a genuine ambiguity at once', async () => {
    const { calls, escalations } = await runWave({
      'worker:9.1': { ...base, status: 'blocked', checkExitCode: 0, questions: ['two readings'] },
    });
    expect(calls).toEqual(['worker:9.1']);
    expect(escalations).toEqual(['worker blocked (ambiguity)']);
  });

  it('finishes an unfinished fix round before the next review', async () => {
    const { out, calls } = await runWave({
      'worker:9.1': opened,
      'critic:9.1 r1': fix,
      'worker:9.1 fix1': { ...base, status: 'opened', checkExitCode: -1 },
      'worker:9.1 finish1': { ...base, status: 'opened', checkExitCode: 0 },
      'critic:9.1 r2': merge,
      'merger:9.1': merged,
    });
    expect(calls).toEqual(['worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'worker:9.1 fix1', 'worker:9.1 finish1', 'ci:9.1 r2', 'critic:9.1 r2', 'merger:9.1']);
    expect(out.gate).toBe('PASS');
  });
});
