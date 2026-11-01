import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { firstPassRate, shouldContinue } from './chain.js';

// Runs the chain-loop workflow script (the bundled file, as the runtime would) with a stubbed workflow().
// The stub answers by wave id, so a test scripts each wave's result and asserts which waves ran, in what
// order, with which arguments, and why the chain stopped.
const source = readFileSync(join(import.meta.dirname, '..', 'workflows', 'chain-loop.js'), 'utf8').replace(
  /^export const meta/m,
  'const meta',
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Any = Record<string, any>;

const project = { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 's.md' };

function task(id: string, verdicts: Array<string | null>): Any {
  return {
    task: id,
    title: id,
    merged: true,
    rounds: verdicts.map((verdict, i) => ({ round: i + 1, verdict, ci: 'green', fixItems: [], notes: '', checklist: [] })),
  };
}

// A wave result shaped like wave-loop's return value. `firstRound` lists each task's first-round verdict.
function waveResult(wave: string, over: Any = {}): Any {
  const firstRound: Array<string | null> = over.firstRound ?? ['MERGE', 'MERGE'];
  const tasks: Any = {};
  firstRound.forEach((v, i) => {
    tasks[`${wave}.${i + 1}`] = task(`${wave}.${i + 1}`, v === 'MERGE' ? ['MERGE'] : [v, 'MERGE']);
  });
  return { project: 'Sim', wave, gate: over.gate ?? 'PASS', models: {}, state: {}, tasks, escalations: over.escalations ?? [] };
}

const waveArg = (wave: string) => ({
  wave,
  tasks: [{ id: `${wave}.1`, title: 'T', branch: `feat/${wave}.1`, deps: [], text: 'x', owns: 'y', notes: '' }],
  tail: null,
});

async function runChain(opts: { project?: Any; waves: string[]; answers: Record<string, Any | Error> }) {
  const calls: Array<{ name: string; args: Any }> = [];
  const workflow = async (name: string, args: Any) => {
    calls.push({ name, args });
    const a = opts.answers[args.wave];
    if (a instanceof Error) throw a;
    return a ?? null;
  };
  const logs: string[] = [];
  const args = { project: opts.project ?? project, waves: opts.waves.map(waveArg) };
  const out = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', 'args', source)(
    async () => {
      throw new Error('chain-loop must not call agent()');
    },
    (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
    async () => [],
    () => {},
    (s: string) => logs.push(s),
    workflow,
    args,
  );
  return { out, calls, logs };
}

describe('chain-loop: running waves in order', () => {
  it('runs two waves chained, in order, one wave-loop call each', async () => {
    const { out, calls } = await runChain({
      waves: ['1', '2'],
      answers: { '1': waveResult('1'), '2': waveResult('2') },
    });
    expect(calls.map((c) => c.name)).toEqual(['wave-loop', 'wave-loop']);
    expect(calls.map((c) => c.args.wave)).toEqual(['1', '2']);
    expect(calls[0].args).toEqual({ project, wave: '1', tasks: waveArg('1').tasks, tail: null });
    expect(out.waves.map((w: Any) => w.wave)).toEqual(['1', '2']);
    expect(out.remaining).toEqual([]);
    expect(out.stoppedBecause).toBe('complete');
  });

  it('a FAIL gate stops after the first wave with gate_fail', async () => {
    const { out, calls } = await runChain({
      waves: ['1', '2', '3'],
      answers: { '1': waveResult('1', { gate: 'FAIL', escalations: [{ task: '1.1', what: 'worker blocked (ambiguity)' }] }), '2': waveResult('2') },
    });
    expect(calls.map((c) => c.args.wave)).toEqual(['1']);
    expect(out.stoppedBecause).toBe('gate_fail');
    expect(out.remaining).toEqual(['2', '3']);
    expect(out.waves).toHaveLength(1);
  });

  it('chain.after = 2 stops after wave 1 with learning_gate', async () => {
    const { out, calls } = await runChain({
      project: { ...project, chain: { after: '2' } },
      waves: ['1', '2'],
      answers: { '1': waveResult('1'), '2': waveResult('2') },
    });
    expect(calls.map((c) => c.args.wave)).toEqual(['1']);
    expect(out.stoppedBecause).toBe('learning_gate');
    expect(out.remaining).toEqual(['2']);
  });

  it('a first-pass rate of 0.5 stops with first_pass_low', async () => {
    const { out, calls } = await runChain({
      waves: ['1', '2'],
      answers: { '1': waveResult('1', { firstRound: ['MERGE', 'FIX'] }), '2': waveResult('2') },
    });
    expect(calls.map((c) => c.args.wave)).toEqual(['1']);
    expect(out.stoppedBecause).toBe('first_pass_low');
    expect(out.remaining).toEqual(['2']);
  });

  it('chain: false stops after wave 1 with chain_off', async () => {
    const { out, calls } = await runChain({
      project: { ...project, chain: false },
      waves: ['1', '2', '3'],
      answers: { '1': waveResult('1'), '2': waveResult('2') },
    });
    expect(calls.map((c) => c.args.wave)).toEqual(['1']);
    expect(out.stoppedBecause).toBe('chain_off');
    expect(out.remaining).toEqual(['2', '3']);
  });

  it('an open escalation stops the chain; one that names a reality gap stops with reality_gap', async () => {
    const open = await runChain({
      waves: ['1', '2'],
      answers: { '1': waveResult('1', { escalations: [{ task: '1.1', what: 'critic STOP' }] }), '2': waveResult('2') },
    });
    expect(open.out.stoppedBecause).toBe('escalation');
    const gap = await runChain({
      waves: ['1', '2'],
      answers: { '1': waveResult('1', { escalations: [{ task: '1.T', what: 'reality_gap: block gap R1' }] }), '2': waveResult('2') },
    });
    expect(gap.out.stoppedBecause).toBe('reality_gap');
    expect(gap.calls).toHaveLength(1);
  });

  it('a child that throws stops the chain, is reported and is never retried', async () => {
    const { out, calls } = await runChain({
      waves: ['1', '2', '3'],
      answers: { '1': waveResult('1'), '2': new Error('runtime exploded'), '3': waveResult('3') },
    });
    expect(calls.map((c) => c.args.wave)).toEqual(['1', '2']);
    expect(out.stoppedBecause).toBe('child_error');
    expect(out.error).toEqual({ wave: '2', message: 'runtime exploded' });
    expect(out.waves.map((w: Any) => w.wave)).toEqual(['1']);
    expect(out.remaining).toEqual(['3']);
  });

  it('a child that returns nothing is reported as an error too', async () => {
    const { out, calls } = await runChain({ waves: ['1', '2'], answers: {} });
    expect(calls).toHaveLength(1);
    expect(out.stoppedBecause).toBe('child_error');
    expect(out.error.wave).toBe('1');
    expect(out.remaining).toEqual(['2']);
  });

  it('refuses to start without waves', async () => {
    await expect(runChain({ waves: [], answers: {} })).rejects.toThrow(/args\.waves/);
  });
});

describe('chain: shouldContinue', () => {
  const pass = { wave: '1', gate: 'PASS', escalations: [] };

  it('goes when everything holds, with the defaults (after 1, minFirstPassRate 0.7)', () => {
    expect(shouldContinue(pass, {}, '2', 1)).toEqual({ go: true, reason: null });
    expect(shouldContinue(pass, { chain: { after: '1', minFirstPassRate: 0.7 } }, '2', 0.7).go).toBe(true);
  });

  it('names each stop reason', () => {
    expect(shouldContinue(pass, { chain: false }, '2', 1)).toEqual({ go: false, reason: 'chain_off' });
    expect(shouldContinue({ ...pass, gate: 'FAIL' }, {}, '2', 1).reason).toBe('gate_fail');
    expect(shouldContinue({ ...pass, escalations: [{ what: 'x' }] }, {}, '2', 1).reason).toBe('escalation');
    expect(shouldContinue({ ...pass, escalations: [{ what: 'reality_gap R1' }] }, {}, '2', 1).reason).toBe('reality_gap');
    expect(shouldContinue({ ...pass, wave: '0' }, {}, '1', 1).reason).toBe('learning_gate');
    expect(shouldContinue(pass, { chain: { after: '2' } }, '2', 1).reason).toBe('learning_gate');
    expect(shouldContinue(pass, {}, '2', 0.69).reason).toBe('first_pass_low');
    expect(shouldContinue(pass, { chain: { minFirstPassRate: 0.9 } }, '2', 0.8).reason).toBe('first_pass_low');
  });

  it('compares wave ids naturally: wave 10 is past after = 2, wave 0a is before 1', () => {
    expect(shouldContinue({ ...pass, wave: '10' }, { chain: { after: '2' } }, '11', 1).go).toBe(true);
    expect(shouldContinue({ ...pass, wave: '0a' }, {}, '1', 1).reason).toBe('learning_gate');
  });

  it('a chain object with missing fields falls back to the defaults', () => {
    expect(shouldContinue(pass, { chain: {} }, '2', 0.7).go).toBe(true);
    expect(shouldContinue(pass, { chain: { minFirstPassRate: 'x' } }, '2', 0.5).reason).toBe('first_pass_low');
  });
});

describe('chain: firstPassRate', () => {
  const t = (verdicts: Array<string | null>) => ({ rounds: verdicts.map((verdict) => ({ verdict })) });

  it('is tasks whose first round was MERGE over tasks in the result', () => {
    expect(firstPassRate({ tasks: { a: t(['MERGE']), b: t(['FIX', 'MERGE']), c: t(['MERGE']), d: t([null]) } })).toBe(0.5);
    expect(firstPassRate({ tasks: [t(['MERGE']), t(['FIX'])] })).toBe(0.5);
  });

  it('counts a wave with no tasks as 1, and a task with no rounds as not first-pass', () => {
    expect(firstPassRate({ tasks: {} })).toBe(1);
    expect(firstPassRate({})).toBe(1);
    expect(firstPassRate({ tasks: { a: t([]) } })).toBe(0);
  });
});
