import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Loop 2.3.0: the critic's findings[] with severity (a high finding is a FIX item), and the integration review of the
// whole wave's diff after the tail. The workflow script runs with a stubbed agent() that answers by label, in script
// mode (relays for preflight, CI and merge), as in tests/wave-loop-relay.test.ts.
const root = join(import.meta.dirname, '..');
const source = readFileSync(join(root, 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const VERSION: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Opts = { label: string; model?: string; effort?: string; phase?: string; schema?: any };
type Json = Record<string, any>;

const BASE = 'b'.repeat(40);
const ran = (line: unknown, exitCode = 0) => ({ status: 'ran', exitCode, stdout: `${JSON.stringify(line)}\n` });
const preflight = (over: Json = {}) => ran({ outcome: 'error', exit: 4, mergeSha: null, message: 'could not read PR #0: no pull requests found', loopVersion: VERSION, baseSha: BASE, ...over }, 4);
const green = ran({ state: 'green', failing: [], logTail: '', polls: 1, elapsedMs: 1000 });
const merged = (sha: string) =>
  ran({ outcome: 'merged', exit: 0, mergeSha: sha, mainSha: sha, ciState: 'green', failing: [], conflictFiles: [], revertPrUrl: null, message: 'merged', logTail: '', ciWaitMs: 1, mergeMs: 1, mainCheckMs: 1, revertMs: 0, elapsedMs: 3 });
const opened = (id: string, pr: number) => ({ status: 'opened', branch: `feat/${id}`, worktree: `/tmp/sim-wt/${id}`, filesChanged: ['a'], checkCommand: 'c', checkExitCode: 0, decisions: [], questions: [], prNumber: pr, prUrl: `u${pr}` });
const finding = (severity: string, what: string, where: string) => ({ severity, what, where });
const critic = (verdict: string, findings: Json[], over: Json = {}) => ({ verdict, prHeadSha: 'abc', checklist: [], fixItems: [], findings, notes: 'summary', ...over });

async function runWave(answers: Record<string, unknown>, project: Json = {}, tasks = [{ id: '9.1', title: 'T', branch: 'feat/9.1', deps: [], text: 'x', owns: 'y', notes: '' }]) {
  const calls: string[] = [];
  const prompts: Record<string, string> = {};
  const opts: Record<string, Opts> = {};
  const logs: string[] = [];
  const agent = async (prompt: string, o: Opts) => {
    calls.push(o.label);
    prompts[o.label] = prompt;
    opts[o.label] = o;
    await new Promise((r) => setTimeout(r, 0));
    if (o.label.startsWith('ci:') && !(o.label in answers)) return green;
    const a = answers[o.label];
    if (a instanceof Error) throw a;
    return a === undefined ? null : a;
  };
  const args = {
    project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 'docs/spec.md', maxBuilders: 2, maxChains: 4, syncPolicy: 'conflict', ...project },
    wave: '9',
    tasks,
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
  return { out, calls, prompts, opts, logs };
}

const happy = { 'preflight:merge': preflight(), 'worker:9.1': opened('9.1', 7), 'critic:9.1 r1': critic('MERGE', []), 'merger:9.1': merged('m1') };

describe('critic findings', () => {
  it('the critic schema requires findings, each with a severity of high, medium or low, what and where', async () => {
    const { opts } = await runWave(happy);
    const s = opts['critic:9.1 r1'].schema;
    expect(s.required).toEqual(['verdict', 'checklist', 'fixItems', 'findings', 'notes']);
    expect(s.properties.findings.items.properties.severity.enum).toEqual(['high', 'medium', 'low']);
    expect(s.properties.findings.items.required).toEqual(['severity', 'what', 'where']);
    expect(s.properties.notes).toBeDefined();
  });

  it('the critic prompt asks for every problem in findings, a high one as a FIX item, and nothing only in notes', async () => {
    const { prompts } = await runWave(happy);
    const p = prompts['critic:9.1 r1'];
    expect(p).toMatch(/record every problem you see in findings, whatever the verdict/);
    expect(p).toMatch(/every high finding is also a FIX item/);
    expect(p).toMatch(/Medium and low findings go in findings only and do not change the verdict/);
    expect(p).toMatch(/never put a problem only in notes/);
  });

  it('a MERGE with medium and low findings merges first pass and the result carries the findings', async () => {
    const f = [finding('medium', 'helper duplicated', 'src/a.ts:4'), finding('low', 'typo', 'src/a.ts:1')];
    const { out, calls } = await runWave({ ...happy, 'critic:9.1 r1': critic('MERGE', f) });
    expect(calls).not.toContain('worker:9.1 fix1');
    expect(out.gate).toBe('PASS');
    expect(out.tasks['9.1'].rounds[0]).toMatchObject({ round: 1, verdict: 'MERGE', findings: f });
    expect(out.findings).toEqual(f.map((x) => ({ task: '9.1', round: 1, ...x })));
  });

  it('a MERGE with a high finding is turned into FIX: the worker gets the finding as an item, and the next MERGE merges', async () => {
    const high = finding('high', 'database connection without TLS', 'src/db.ts:12');
    const { out, calls, prompts, logs } = await runWave({
      ...happy,
      'critic:9.1 r1': critic('MERGE', [high]),
      'worker:9.1 fix1': opened('9.1', 7),
      'critic:9.1 r2': critic('MERGE', []),
    });
    expect(calls).toContain('worker:9.1 fix1');
    expect(prompts['worker:9.1 fix1']).toContain('database connection without TLS (src/db.ts:12)');
    expect(out.tasks['9.1'].rounds[0]).toMatchObject({ verdict: 'FIX', findings: [high] });
    expect(out.tasks['9.1'].rounds[0].fixItems).toEqual([{ n: 1, what: 'database connection without TLS (src/db.ts:12)', provedBy: "the critic's high finding no longer applies", cause: 'defect' }]);
    expect(out.tasks['9.1'].rounds[1]).toMatchObject({ verdict: 'MERGE', findings: [] });
    expect(out.tasks['9.1'].merged).toBe(true);
    expect(logs.some((l) => /critic said MERGE with 1 high finding; turned into FIX/.test(l))).toBe(true);
  });

  it('a FIX verdict with a high finding keeps the critic\'s own fix items', async () => {
    const items = [{ n: 1, what: 'add TLS', provedBy: 'the db test', cause: 'defect' }];
    const { out } = await runWave({
      ...happy,
      'critic:9.1 r1': critic('FIX', [finding('high', 'no TLS', 'src/db.ts:12')], { fixItems: items }),
      'worker:9.1 fix1': opened('9.1', 7),
      'critic:9.1 r2': critic('MERGE', []),
    });
    expect(out.tasks['9.1'].rounds[0].fixItems).toEqual(items);
  });

  it('a critic result with no findings field (an older agent) still works, and malformed findings are dropped', async () => {
    const { out } = await runWave({ ...happy, 'critic:9.1 r1': { verdict: 'MERGE', prHeadSha: 'abc', checklist: [], fixItems: [], notes: '' } });
    expect(out.gate).toBe('PASS');
    expect(out.tasks['9.1'].rounds[0].findings).toEqual([]);
    expect(out.findings).toEqual([]);
    const bad = await runWave({ ...happy, 'critic:9.1 r1': critic('MERGE', [{ severity: 'critical', what: 'x', where: 'y' }, { severity: 'low', what: '' }, null]) });
    expect(bad.out.tasks['9.1'].rounds[0].findings).toEqual([]);
  });
});

describe('integration review', () => {
  const integ = { summary: 'Fine overall.', findings: [{ severity: 'high', area: 'security', what: 'service role for reads', where: 'src/b.ts:5' }, { severity: 'low', area: 'nonsense', what: 'unused', where: 'src/c.ts:1' }] };

  it('records the wave base from the preflight dry run and runs one read-only agent on the critic model after the tail', async () => {
    const { out, calls, prompts, opts } = await runWave({ ...happy, 'integration:wave': integ });
    expect(calls[calls.length - 1]).toBe('integration:wave');
    expect(calls.filter((c) => c === 'integration:wave')).toHaveLength(1);
    const p = prompts['integration:wave'];
    expect(p).toContain(`git diff ${BASE}..origin/main`);
    for (const area of ['duplication', 'layering', 'security', 'performance at real data sizes', 'dead code']) expect(p).toContain(area);
    expect(p).toMatch(/Do not edit, create or delete any file/);
    expect(p).toContain('file:line');
    expect(opts['integration:wave']).toMatchObject({ model: out.models.critic.model, effort: out.models.critic.effort, phase: 'Integration' });
    expect(opts['integration:wave'].schema.properties.findings.items.required).toEqual(['severity', 'area', 'what', 'where']);
    expect(out.integration).toEqual({
      ran: true,
      baseSha: BASE,
      summary: 'Fine overall.',
      findings: [
        { severity: 'high', area: 'security', what: 'service role for reads', where: 'src/b.ts:5' },
        { severity: 'low', area: 'other', what: 'unused', where: 'src/c.ts:1' },
      ],
    });
    expect(out.models.integration).toEqual({ model: out.models.critic.model, effort: out.models.critic.effort });
  });

  it('never blocks the gate: a high integration finding leaves the gate PASS and raises no escalation', async () => {
    const { out } = await runWave({ ...happy, 'integration:wave': integ });
    expect(out.gate).toBe('PASS');
    expect(out.escalations).toEqual([]);
  });

  it('an integration agent that returns nothing or throws is recorded and the gate still passes', async () => {
    const none = await runWave({ ...happy });
    expect(none.out.gate).toBe('PASS');
    expect(none.out.integration).toMatchObject({ ran: false, error: 'the integration agent returned nothing' });
    const threw = await runWave({ ...happy, 'integration:wave': new Error('boom') });
    expect(threw.out.gate).toBe('PASS');
    expect(threw.out.integration).toMatchObject({ ran: false, error: 'boom' });
  });

  it('project.integrationReview: false turns it off: no agent, integration null', async () => {
    const { out, calls } = await runWave({ ...happy, 'integration:wave': integ }, { integrationReview: false });
    expect(calls).not.toContain('integration:wave');
    expect(out.integration).toBeNull();
    expect(out.models.integration).toBeUndefined();
  });

  it('is skipped without a wave base (a dry run that reports none) or when no task merged', async () => {
    const noBase = await runWave({ ...happy, 'preflight:merge': preflight({ baseSha: undefined }), 'integration:wave': integ });
    expect(noBase.calls).not.toContain('integration:wave');
    expect(noBase.out.integration).toMatchObject({ ran: false, skipped: expect.stringContaining('no wave base sha') });
    const parked = await runWave({ ...happy, 'critic:9.1 r1': critic('STOP', [], { stopSection: 'X' }), 'integration:wave': integ });
    expect(parked.calls).not.toContain('integration:wave');
    expect(parked.out.integration).toMatchObject({ ran: false, skipped: 'no task merged' });
  });

  it('meta lists the Integration phase after Tail', () => {
    const titles = [...source.matchAll(/\{ title: '(\w+)'/g)].map((m) => m[1]);
    expect(titles.slice(-2)).toEqual(['Tail', 'Integration']);
  });
});
