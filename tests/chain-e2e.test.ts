import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Task 4.T: chain-loop and wave-loop together. The real chain-loop script runs with a stubbed workflow() that
// delegates each wave to the real wave-loop script under stubbed agents, so gates, the reality check and the chain
// decision are all the shipped code. Both scripts are bundled and self-contained and run as the runtime would.
const workflowSource = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', 'claude', 'workflows', name), 'utf8').replace(/^export const meta/m, 'const meta');
const chainSource = workflowSource('chain-loop.js');
const waveSource = workflowSource('wave-loop.js');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Any = Record<string, any>;

const project = {
  name: 'Sim',
  repo: '/tmp/sim',
  github: 'o/r',
  worktrees: '/tmp/sim-wt',
  spec: 's.md',
  maxBuilders: 2,
  maxChains: 2,
  mainCi: 'check',
  syncPolicy: 'conflict',
  merger: 'agent', // task 2.1: the v2 merger agent; the wave also starts a CI relay beside the critic, answered green below
  realityCheck: { command: 'node scripts/reality.js', readOnly: true, timeoutSec: 30 },
};

const gateItem = (over: Any = {}) => ({
  id: 'G1',
  what: 'Raise the vendor quota',
  why: 'wave 3 calls the vendor',
  owner: 'human',
  before: '3',
  leadTime: 'days',
  status: 'open',
  evidence: '',
  ...over,
});

const GAP = { id: 'R1', severity: 'block', what: 'person_org has 0 rows' };

const waveArg = (wave: string) => ({
  wave,
  tasks: [{ id: `${wave}.1`, title: 'T', branch: `feat/${wave}.1`, deps: [], text: 'x', owns: 'y', notes: '' }],
  tail: null,
});

// Every task opens a PR, passes the critic first time and merges; the wave id is read from the label.
function agentAnswer(label: string, gaps: Any[]): Any | null {
  const id = /^\w+:(\d+\.\d+)/.exec(label)?.[1] ?? '';
  const base = { branch: `feat/${id}`, worktree: `/tmp/sim-wt/${id}`, filesChanged: ['a'], checkCommand: 'c', decisions: [], questions: [] };
  if (label.startsWith('worker:')) return { ...base, status: 'opened', checkExitCode: 0, prNumber: 7, prUrl: 'u' };
  if (label.startsWith('critic:')) return { verdict: 'MERGE', prHeadSha: 'abc', checklist: [], fixItems: [], notes: '' };
  if (label.startsWith('merger:')) return { outcome: 'merged', details: 'ok', mergeSha: 'm', mainSha: 'm', checkOnMainExitCode: 0 };
  if (label === 'reality:check') return { stdout: JSON.stringify({ gaps }), code: 0 };
  return null;
}

// One launch of chain-loop. `gaps` is what the reality command prints; `gates` is the parsed gate file the session
// passes in (scripts have no filesystem). Records the agents each wave started, in order.
async function launch(opts: { project?: Any; waves: string[]; gates: Any[]; gaps?: Any[] }) {
  const gaps = opts.gaps ?? [];
  const workflowCalls: Array<{ name: string; args: Any }> = [];
  const agentsByWave: Record<string, string[]> = {};
  const workflow = async (name: string, args: Any) => {
    workflowCalls.push({ name, args });
    const started: string[] = (agentsByWave[args.wave] = []);
    const agent = async (_prompt: string, o: { label: string }) => {
      if (o.label.startsWith('ci:')) return { status: 'ran', exitCode: 0, stdout: `${JSON.stringify({ state: 'green', failing: [], logTail: '', polls: 1, elapsedMs: 1000 })}\n` };
      started.push(o.label);
      return agentAnswer(o.label, gaps);
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
    return new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', waveSource)(agent, parallel, pipeline, () => {}, () => {}, args);
  };
  const out = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', 'args', chainSource)(
    async () => {
      throw new Error('chain-loop must not call agent()');
    },
    (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
    async () => [],
    () => {},
    () => {},
    workflow,
    { project: opts.project ?? project, waves: opts.waves.map(waveArg), gates: opts.gates },
  );
  return { out, workflowCalls, agentsByWave };
}

const wavesRun = (r: { workflowCalls: Array<{ args: Any }> }) => r.workflowCalls.map((c) => c.args.wave);
const taskAgents = (wave: string) => [`worker:${wave}.1`, `critic:${wave}.1 r1`, `merger:${wave}.1`];
const ranGreen = (wave: string) => [...taskAgents(wave), 'reality:check'];

describe('chain-loop over wave-loop: three waves, a gate before wave 3 and a reality gap in wave 2', () => {
  const open = [gateItem()];

  it('wave 1 stops for the human read: no chain, waves 2 and 3 remain', async () => {
    const r = await launch({ project: { ...project, chain: false }, waves: ['1', '2', '3'], gates: open });
    expect(wavesRun(r)).toEqual(['1']);
    expect(r.agentsByWave['1']).toEqual(ranGreen('1'));
    expect(r.out.waves[0]).toMatchObject({ wave: '1', gate: 'PASS', escalations: [] });
    expect(r.out.stoppedBecause).toBe('chain_off');
    expect(r.out.remaining).toEqual(['2', '3']);
  });

  it('with chain.after = 1, wave 2 runs and its block gap stops the chain with reality_gap', async () => {
    const r = await launch({ project: { ...project, chain: { after: '1' } }, waves: ['2', '3'], gates: open, gaps: [GAP] });
    expect(wavesRun(r)).toEqual(['2']);
    expect(r.agentsByWave['2']).toEqual(ranGreen('2'));
    expect(r.agentsByWave['3']).toBeUndefined();
    const wave2 = r.out.waves[0];
    expect(wave2.gate).toBe('FAIL');
    expect(wave2.state).toEqual({ '2.1': 'merged' });
    expect(wave2.escalations).toHaveLength(1);
    expect(wave2.escalations[0].what).toMatch(/reality_gap: R1/);
    expect(wave2.reality).toEqual({ ok: true, gaps: [GAP] });
    expect(r.out.stoppedBecause).toBe('reality_gap');
    expect(r.out.remaining).toEqual(['3']);
  });

  it('a warn gap in wave 2 does not stop the chain, and the open gate then holds wave 3 without starting an agent', async () => {
    const warn = { id: 'W1', severity: 'warn', what: 'stale cursor' };
    const r = await launch({ project: { ...project, chain: { after: '1' } }, waves: ['2', '3'], gates: open, gaps: [warn] });
    expect(wavesRun(r)).toEqual(['2', '3']);
    expect(r.out.waves[0]).toMatchObject({ wave: '2', gate: 'PASS', reality: { ok: true, gaps: [warn] } });
    expect(r.out.waves[1]).toMatchObject({ wave: '3', gate: 'BLOCKED', blockedBy: ['G1'] });
    expect(r.agentsByWave['3']).toEqual([]);
  });

  it('with the gap resolved, wave 3 stays blocked while G1 is open and runs once G1 is done', async () => {
    const chain = { ...project, chain: { after: '1' } };

    const blocked = await launch({ project: chain, waves: ['3'], gates: open });
    expect(wavesRun(blocked)).toEqual(['3']);
    expect(blocked.out.waves[0]).toMatchObject({ wave: '3', gate: 'BLOCKED', blockedBy: ['G1'], tasks: {}, escalations: [] });
    expect(blocked.agentsByWave['3']).toEqual([]);

    const done = [gateItem({ status: 'done', evidence: 'quota raised' })];
    const ran = await launch({ project: chain, waves: ['3'], gates: done });
    expect(ran.agentsByWave['3']).toEqual(ranGreen('3'));
    expect(ran.out.waves[0]).toMatchObject({ wave: '3', gate: 'PASS', state: { '3.1': 'merged' }, escalations: [] });
    expect(ran.out.waves[0].blockedBy).toBeUndefined();
    expect(ran.out.stoppedBecause).toBe('complete');
    expect(ran.out.remaining).toEqual([]);
  });

  it('forwards the same gate array to every wave it runs', async () => {
    const done = [gateItem({ status: 'done' })];
    const r = await launch({ project: { ...project, chain: { after: '1' } }, waves: ['2', '3'], gates: done });
    expect(wavesRun(r)).toEqual(['2', '3']);
    for (const c of r.workflowCalls) expect(c.args.gates).toBe(done);
    expect(r.out.waves.map((w: Any) => w.gate)).toEqual(['PASS', 'PASS']);
    expect(r.out.stoppedBecause).toBe('complete');
  });
});
