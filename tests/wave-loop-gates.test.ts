import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Task 4.1: gates and reality in wave-loop. Same harness style as tests/wave-loop.test.ts: the workflow script runs
// with a stubbed agent() that answers by label, so a test scripts one task and asserts which agents ran.
const source = readFileSync(join(import.meta.dirname, '..', 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(
  /^export const meta/m,
  'const meta',
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Task 2.1: wave-loop starts a CI relay beside the critic. These tests are about gates, reality, decisions and models, so
// the stub answers every ci: relay green without recording it, and the project uses the v2 merger agent (merger: 'agent').
// The relay and script paths are covered in tests/wave-loop-relay.test.ts.
const greenCi = { status: 'ran', exitCode: 0, stdout: `${JSON.stringify({ state: 'green', failing: [], logTail: '', polls: 1, elapsedMs: 1000 })}\n` };

type Result = Record<string, unknown>;
type Answer = Result | null | ((opts: Opts) => Result | null);
type Opts = { label: string; model?: string; effort?: string };

const gateItem = (over: Record<string, unknown> = {}) => ({
  id: 'H1',
  what: 'Raise the Vertex quota',
  why: 'blocks wave 2',
  owner: 'human',
  before: '2',
  leadTime: 'days',
  status: 'open',
  evidence: '',
  ...over,
});

async function runWave(answers: Record<string, Answer>, extra: { project?: Result; gates?: unknown; wave?: string; omitGates?: boolean } = {}) {
  const calls: string[] = [];
  const optsSeen: Opts[] = [];
  const prompts: Record<string, string> = {};
  const agent = async (prompt: string, opts: Opts) => {
    if (opts.label.startsWith('ci:')) return greenCi;
    // Task 2.1 (v2.4): an agent that returns nothing is followed by a `probe:<label>` relay; like ci:, it is answered
    // by the case and not recorded, so the cases keep their call lists.
    if (opts.label.startsWith('probe:')) return answers[opts.label] ?? null;
    calls.push(opts.label);
    optsSeen.push(opts);
    prompts[opts.label] = prompt;
    const a = answers[opts.label] ?? null;
    return typeof a === 'function' ? a(opts) : a;
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
  const wave = extra.wave ?? '2';
  const args: Result = {
    project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 's.md', maxBuilders: 2, maxChains: 2, mainCi: 'check', syncPolicy: 'conflict', merger: 'agent', ...(extra.project || {}) },
    wave,
    tasks: [{ id: `${wave}.1`, title: 'T', branch: `feat/${wave}.1`, deps: [], text: 'x', owns: 'y', notes: '' }],
    tail: null,
  };
  if (extra.gates !== undefined) args.gates = extra.gates;
  const out = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)(
    agent,
    parallel,
    pipeline,
    () => {},
    () => {},
    args,
  );
  return { out, calls, optsSeen, prompts, escalations: ((out.escalations ?? []) as Array<{ what: string }>).map((e) => e.what) };
}

const base = { branch: 'feat/2.1', worktree: '/tmp/sim-wt/2.1', filesChanged: ['a'], checkCommand: 'c', decisions: [], questions: [] };
const opened = { ...base, status: 'opened', checkExitCode: 0, prNumber: 7, prUrl: 'u' };
const merge = { verdict: 'MERGE', prHeadSha: 'abc', checklist: [], fixItems: [], notes: '' };
const fix = { ...merge, verdict: 'FIX', fixItems: [{ n: 1, what: 'x', provedBy: 'y', cause: 'defect' }] };
const merged = { outcome: 'merged', details: 'ok', mergeSha: 'm', mainSha: 'm', checkOnMainExitCode: 0 };
const green = { 'worker:2.1': opened, 'critic:2.1 r1': merge, 'merger:2.1': merged };
const greenCalls = ['worker:2.1', 'critic:2.1 r1', 'merger:2.1'];

// A relay that ran `true` and exited 0: the passing answer to the probe (decision D1: the probe covers every agent but the critic).
const probeOk = { status: 'ran', exitCode: 0, stdout: '' };

const REALITY = { command: 'node scripts/reality.js', readOnly: true, timeoutSec: 30 };
const gapsOut = (gaps: unknown[]) => ({ stdout: JSON.stringify({ gaps }), code: 0 });

describe('wave-loop gates', () => {
  it('an open gate item before the wave blocks it and starts no agent', async () => {
    const { out, calls } = await runWave(green, { gates: [gateItem()] });
    expect(calls).toEqual([]);
    expect(out.gate).toBe('BLOCKED');
    expect(out.blockedBy).toEqual(['H1']);
    expect(out.wave).toBe('2');
  });

  it('lists every blocking id, days lead time first, and ignores done, waived and later items', async () => {
    const gates = [
      gateItem({ id: 'H2', leadTime: 'minutes' }),
      gateItem({ id: 'H3', leadTime: 'days', before: '1' }),
      gateItem({ id: 'H4', status: 'done' }),
      gateItem({ id: 'H5', status: 'waived' }),
      gateItem({ id: 'H6', before: '3' }),
    ];
    const { out, calls } = await runWave(green, { gates });
    expect(calls).toEqual([]);
    expect(out.blockedBy).toEqual(['H3', 'H2']);
  });

  it('runs the wave when every item before it is done or waived', async () => {
    const { out, calls } = await runWave(green, { gates: [gateItem({ status: 'done' }), gateItem({ id: 'H2', status: 'waived' }), gateItem({ id: 'H3', before: '3' })] });
    expect(calls).toEqual(greenCalls);
    expect(out.gate).toBe('PASS');
    expect(out.blockedBy).toBeUndefined();
  });

  it('rejects an invalid gate list before starting any agent', async () => {
    await expect(runWave(green, { gates: [gateItem({ status: 'maybe' })] })).rejects.toThrow(/H1.*status/);
  });

  it('fails closed when project.gates is set but no parsed gates were passed', async () => {
    await expect(runWave(green, { project: { gates: 'docs/gates.json' } })).rejects.toThrow(/args\.gates/);
  });
});

describe('wave-loop reality check', () => {
  it('a block gap fails an otherwise green wave and escalates reality_gap', async () => {
    const { out, calls, escalations, optsSeen, prompts } = await runWave(
      { ...green, 'reality:check': gapsOut([{ id: 'G1', severity: 'block', what: 'person_org has 0 rows' }]) },
      { project: { realityCheck: REALITY } },
    );
    expect(calls).toEqual([...greenCalls, 'reality:check']);
    expect(out.gate).toBe('FAIL');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatch(/reality_gap/);
    expect(out.reality).toEqual({ ok: true, gaps: [{ id: 'G1', severity: 'block', what: 'person_org has 0 rows' }] });
    // The check runs through a small agent on haiku/low, with the exact command and the timeout.
    const reality = optsSeen.find((o) => o.label === 'reality:check')!;
    expect(reality.model).toBe('claude-haiku-5-5');
    expect(reality.effort).toBe('low');
    expect(prompts['reality:check']).toContain('node scripts/reality.js');
    expect(prompts['reality:check']).toContain('/tmp/sim');
  });

  it('warn gaps are returned and do not fail the wave', async () => {
    const gaps = [{ id: 'W1', severity: 'warn', what: 'stale cursor' }];
    const { out, escalations } = await runWave({ ...green, 'reality:check': gapsOut(gaps) }, { project: { realityCheck: REALITY } });
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect(out.reality).toEqual({ ok: true, gaps });
  });

  it('a check that does not run cleanly counts as a block', async () => {
    for (const answer of [{ stdout: 'not json', code: 0 }, { stdout: '{"gaps":[]}', code: 3 }, null]) {
      const { out, escalations } = await runWave({ ...green, 'reality:check': answer }, { project: { realityCheck: REALITY } });
      expect(out.gate).toBe('FAIL');
      expect(escalations.some((e) => /reality_gap/.test(e))).toBe(true);
      expect((out.reality as { ok: boolean }).ok).toBe(false);
    }
  });

  it('runs after the machine gate even when a task parked, and still reports its gaps', async () => {
    const { out, calls } = await runWave(
      { 'worker:2.1': null, 'probe:worker:2.1': probeOk, 'reality:check': gapsOut([{ id: 'W1', severity: 'warn', what: 'w' }]) },
      { project: { realityCheck: REALITY } },
    );
    expect(calls).toEqual(['worker:2.1', 'reality:check']);
    expect(out.gate).toBe('FAIL');
    expect((out.reality as { gaps: unknown[] }).gaps).toHaveLength(1);
  });

  it('refuses a check that is not declared read-only before starting any agent', async () => {
    await expect(runWave(green, { project: { realityCheck: { command: 'x', readOnly: false } } })).rejects.toThrow(/readOnly/);
    await expect(runWave(green, { project: { realityCheck: { readOnly: true } } })).rejects.toThrow(/command/);
  });

  it('is not run for a blocked wave', async () => {
    const { calls } = await runWave(green, { project: { realityCheck: REALITY }, gates: [gateItem()] });
    expect(calls).toEqual([]);
  });
});

describe('wave-loop without gates or reality', () => {
  it('gives the v1 result plus empty reality and decisions', async () => {
    const { out, calls } = await runWave(green);
    expect(calls).toEqual(greenCalls);
    expect(Object.keys(out).sort()).toEqual(['decisions', 'escalations', 'findings', 'gate', 'integration', 'loopVersion', 'models', 'project', 'reality', 'state', 'tasks', 'timings', 'wave']);
    expect(out.gate).toBe('PASS');
    expect(out.reality).toBeNull();
    expect(out.decisions).toEqual([]);
    expect(out.state).toEqual({ '2.1': 'merged' });
  });

  it('accepts an empty gate list', async () => {
    const { out } = await runWave(green, { gates: [] });
    expect(out.gate).toBe('PASS');
  });
});

describe('wave-loop decisions', () => {
  it('collects workers decisions written as id | choice | reason | reversible, and leaves other text in the task record', async () => {
    const worker = { ...opened, decisions: ['D1 | keep aliases | runtime unverified | yes', 'took the conventional default'] };
    const { out } = await runWave({ ...green, 'worker:2.1': worker });
    expect(out.decisions).toEqual([{ id: 'D1', task: '2.1', choice: 'keep aliases', reason: 'runtime unverified', reversible: true, outcome: 'accepted' }]);
    expect((out.tasks as Record<string, { pr: { decisions: string[] } }>)['2.1'].pr.decisions).toHaveLength(2);
  });
});

describe('wave-loop models', () => {
  it('pins the default roles by full model id', async () => {
    const { optsSeen, out } = await runWave(green);
    const by = (prefix: string) => optsSeen.find((o) => o.label.startsWith(prefix))!;
    expect([by('worker').model, by('worker').effort]).toEqual(['claude-sonnet-5-5', 'high']);
    expect([by('critic').model, by('critic').effort]).toEqual(['claude-fable-5-1', 'high']);
    expect([by('merger').model, by('merger').effort]).toEqual(['claude-sonnet-5-5', 'low']);
    const models = out.models as Record<string, { model: string }>;
    expect([models.worker.model, models.critic.model, models.merger.model]).toEqual(['claude-sonnet-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
  });

  it('still lets project.models override a role', async () => {
    const { optsSeen } = await runWave(green, { project: { models: { critic: { model: 'opus', effort: 'high' } } } });
    expect(optsSeen.find((o) => o.label.startsWith('critic'))!.model).toBe('opus');
  });

  it('retries a critic that hits a usage limit once with opus/high and records the swap', async () => {
    const limited = (opts: Opts) => {
      if (opts.model === 'claude-fable-5-1') throw new Error('Claude usage limit reached for claude-fable-5-1');
      return merge;
    };
    const { out, calls, optsSeen, escalations } = await runWave({ ...green, 'critic:2.1 r1': limited });
    expect(calls).toEqual(['worker:2.1', 'critic:2.1 r1', 'critic:2.1 r1', 'merger:2.1']);
    const critics = optsSeen.filter((o) => o.label.startsWith('critic'));
    expect(critics.map((o) => [o.model, o.effort])).toEqual([
      ['claude-fable-5-1', 'high'],
      ['opus', 'high'],
    ]);
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect((out.models as Record<string, unknown>).critic).toMatchObject({ model: 'opus', effort: 'high', swappedFrom: { model: 'claude-fable-5-1', effort: 'high' } });
  });

  it('swaps once: later critic calls go straight to opus', async () => {
    let fableCalls = 0;
    const critic = (opts: Opts) => {
      if (opts.model === 'claude-fable-5-1') {
        fableCalls++;
        throw new Error('usage limit reached');
      }
      return opts.label.endsWith('r1') ? fix : merge;
    };
    const { out, optsSeen } = await runWave({
      'worker:2.1': opened,
      'critic:2.1 r1': critic,
      'worker:2.1 fix1': { ...base, status: 'opened', checkExitCode: 0 },
      'critic:2.1 r2': critic,
      'merger:2.1': merged,
    });
    expect(fableCalls).toBe(1);
    expect(optsSeen.filter((o) => o.label.startsWith('critic')).map((o) => o.model)).toEqual(['claude-fable-5-1', 'opus', 'opus']);
    expect(out.gate).toBe('PASS');
  });

  it('treats a null critic result as the usage-limit case: swaps once to opus/high and retries', async () => {
    const nullOnFable = (opts: Opts) => (opts.model === 'claude-fable-5-1' ? null : merge);
    const { out, calls, optsSeen, escalations } = await runWave({ ...green, 'critic:2.1 r1': nullOnFable });
    expect(calls).toEqual(['worker:2.1', 'critic:2.1 r1', 'critic:2.1 r1', 'merger:2.1']);
    expect(optsSeen.filter((o) => o.label.startsWith('critic')).map((o) => [o.model, o.effort])).toEqual([
      ['claude-fable-5-1', 'high'],
      ['opus', 'high'],
    ]);
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    const critic = (out.models as Record<string, Record<string, unknown>>).critic;
    expect(critic).toMatchObject({ model: 'opus', effort: 'high', swappedFrom: { model: 'claude-fable-5-1', effort: 'high' } });
    expect(String(critic.reason)).toMatch(/nothing/);
    expect(critic.reason).not.toBe('usage_limit');
  });

  it('pauses the wave once when the critic returns null on both models, with exactly two critic calls', async () => {
    const { out, calls, escalations } = await runWave({ 'worker:2.1': opened, 'critic:2.1 r1': null });
    expect(calls.filter((c) => c.startsWith('critic'))).toHaveLength(2);
    expect(out.gate).toBe('PAUSED');
    expect(escalations).toEqual(['wave paused: usage limit, resets unknown']);
    expect(out.paused).toMatchObject({ resetText: null });
  });

  it('does not retry a critic error that is not a usage limit, and a second limit escalates', async () => {
    let n = 0;
    const boom = () => {
      n++;
      throw new Error('socket hang up');
    };
    const first = await runWave({ 'worker:2.1': opened, 'critic:2.1 r1': boom });
    expect(n).toBe(1);
    expect(first.out.gate).toBe('FAIL');
    expect(first.escalations).toEqual(['task chain threw']);

    const always = () => {
      throw new Error('usage limit reached');
    };
    const second = await runWave({ 'worker:2.1': opened, 'critic:2.1 r1': always });
    expect(second.calls.filter((c) => c.startsWith('critic'))).toHaveLength(2);
    expect(second.out.gate).toBe('FAIL');
    expect(second.escalations).toEqual(['critic agent returned nothing']);
  });
});

describe('wave-loop script rules', () => {
  it('has no import, no dynamic import, no require and never calls workflow()', () => {
    const code = source
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bworkflow\s*\(/);
  });

  it('carries the gates and reality libs as bundled regions', () => {
    expect(source).toMatch(/^\/\/ @bundle-start gates$/m);
    expect(source).toMatch(/^\/\/ @bundle-end gates$/m);
    expect(source).toMatch(/^\/\/ @bundle-start reality$/m);
    expect(source).toMatch(/^\/\/ @bundle-end reality$/m);
  });
});
