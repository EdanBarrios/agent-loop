import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// v2.5 task 3.5: wave-loop wiring. (a) dependencies outside the run are checked by one dep-state relay; (b) a merge waits
// for the earlier merge's deferred check on the default branch (project.settleMain); (c) the integration review gates at
// project.integrationGate; (d) the preflight reports isolation; (f) a `locked` merge result is a wait. The workflow runs
// with a stubbed agent() that answers by label, as in tests/wave-loop-v24.test.ts.
const ROOT = join(import.meta.dirname, '..');
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const source = readFileSync(join(ROOT, 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Opts = { label: string; model?: string; effort?: string; phase?: string };
type Answer = unknown | ((opts: Opts, prompt: string) => unknown | Promise<unknown>);
type Json = Record<string, any>;
type TaskArg = { id: string; title: string; branch: string; deps: string[]; text: string; owns: string; notes: string };
const task = (id: string, extra: Partial<TaskArg> = {}): TaskArg => ({ id, title: 'T', branch: `task/${id}-t`, deps: [], text: 'x', owns: 'y', notes: '', ...extra });

const BASE = 'ab'.repeat(20);
const ran = (line: unknown, exitCode = 0) => ({ status: 'ran', exitCode, stdout: `${JSON.stringify(line)}\n` });
const permission = { allowed: true, rule: 'Bash(node /tmp/sim/.claude/scripts/merge-pr.js *)', source: '/tmp/sim/.claude/settings.json', denied: null, ask: null, broad: [], autoModeRules: 0, checked: [] };
const preflightLine = (over: Json = {}) => ran({ outcome: 'error', exit: 4, mergeSha: null, message: 'could not read PR #0: no pull requests found', loopVersion: VERSION, baseSha: BASE, permission, ...over }, 4);

async function runWave(answers: Record<string, Answer>, extra: { project?: Json; tasks?: TaskArg[]; tail?: TaskArg | null; preflight?: unknown } = {}) {
  const calls: string[] = [];
  const prompts: Record<string, string[]> = {};
  const opts: Record<string, Opts> = {};
  const logs: string[] = [];
  const all: Record<string, Answer> = { 'preflight:merge': extra.preflight ?? preflightLine(), ...answers };
  const agent = async (prompt: string, o: Opts) => {
    calls.push(o.label);
    (prompts[o.label] ||= []).push(prompt);
    opts[o.label] = o;
    await new Promise((r) => setTimeout(r, 0));
    const a = all[o.label];
    const v = typeof a === 'function' ? await (a as (o: Opts, p: string) => unknown)(o, prompt) : a;
    if (v instanceof Error) throw v;
    return v === undefined ? null : v;
  };
  const args = {
    project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 'docs/spec.md', maxBuilders: 2, maxChains: 4, mainCi: 'check', syncPolicy: 'conflict', integrationGate: 'off', ...(extra.project || {}) },
    wave: '9',
    tasks: extra.tasks ?? [task('9.1')],
    tail: extra.tail ?? null,
  };
  const out = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)(
    agent,
    async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
    async () => [],
    () => {},
    (line: string) => logs.push(String(line)),
    args,
  );
  const escalations = (out.escalations as Array<{ task: string; what: string; question: string }>) ?? [];
  return { out, calls, prompts, opts, logs, escalations };
}

const opened = (id: string, pr: number) => ({
  status: 'opened',
  branch: `task/${id}-t`,
  worktree: `/tmp/sim-wt/${id}`,
  filesChanged: ['a'],
  checkCommand: 'c',
  checkExitCode: 0,
  decisions: [],
  questions: [],
  prNumber: pr,
  prUrl: `https://example.test/pull/${pr}`,
});
const criticMerge = { verdict: 'MERGE', prHeadSha: 'abc1234', checklist: [], fixItems: [], findings: [], notes: '' };
const ciOf = (state: string, over: Json = {}) => ran({ state, failing: [], logTail: '', polls: 2, elapsedMs: 60000, ...over });
const green = ciOf('green');
const mergeRan = (over: Json = {}) => {
  const line = { outcome: 'merged', exit: 0, mergeSha: 'm1', mainSha: 'm1', ciState: 'green', failing: [], conflictFiles: [], revertPrUrl: null, message: 'merged', logTail: '', ciWaitMs: 1, mergeMs: 1, mainCheckMs: 1, ...over };
  return ran(line, line.exit);
};
const chainFor = (id: string, pr: number, sha = 'm1'): Record<string, Answer> => ({
  [`worker:${id}`]: opened(id, pr),
  [`ci:${id} r1`]: green,
  [`critic:${id} r1`]: criticMerge,
  [`merger:${id}`]: mergeRan({ mergeSha: sha, mainSha: sha }),
});
const happy = chainFor('9.1', 7);
const deferredLine = { mainCheck: 'deferred', mainSha: null, mainCheckMs: 5 };
const deferred = () => {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
};

// ---- (a) dependencies outside the run ----
const depEntry = (over: Json = {}) => ({ merged: true, pr: 21, mergeSha: 'c0ffee1234', onDefault: true, reason: null, ...over });
const depLine = (tasks: Record<string, Json>) => ran({ tasks });
const relaunch = [task('9.2', { deps: ['9.1'] }), task('9.3', { deps: ['9.2'] })];

describe('3.5 (a) dependencies outside the run are checked by one dep-state relay', () => {
  it('starts a task whose missing dependency dep-state reports merged and on the default branch, and logs which PR and merge commit proved it', async () => {
    const { out, calls, prompts, logs } = await runWave({ 'deps:outside': depLine({ '9.1': depEntry() }), ...chainFor('9.2', 8, 'm2'), ...chainFor('9.3', 9, 'm3') }, { tasks: relaunch });
    expect(out.gate).toBe('PASS');
    expect(out.state).toEqual({ '9.2': 'merged', '9.3': 'merged' });
    expect(calls.filter((c) => c === 'deps:outside')).toHaveLength(1);
    expect(calls.indexOf('deps:outside')).toBeLessThan(calls.indexOf('worker:9.2'));
    const command = prompts['deps:outside'][0];
    expect(command).toContain('node /tmp/sim/.claude/scripts/dep-state.js --repo /tmp/sim --task 9.1 --prefix task/');
    const line = logs.find((l) => l.includes('treated as merged in an earlier run'));
    expect(line).toBeTruthy();
    expect(line).toContain('9.2');
    expect(line).toContain('PR #21');
    expect(line).toContain('c0ffee1234');
  });

  it('passes every outside dependency once, and the prefix the task branches spell', async () => {
    const tasks = [task('9.2', { deps: ['9.0', '9.1'], branch: 'feat/9.2-t' }), task('9.3', { deps: ['9.1'], branch: 'feat/9.3-t' })];
    const { prompts } = await runWave({ 'deps:outside': depLine({ '9.0': depEntry(), '9.1': depEntry() }), ...chainFor('9.2', 8, 'm2'), ...chainFor('9.3', 9, 'm3') }, { tasks });
    expect(prompts['deps:outside'][0]).toContain('--task 9.0 9.1 --prefix feat/');
  });

  it('runs no relay when every dependency is in the run', async () => {
    const { calls } = await runWave({ ...chainFor('9.1', 7), ...chainFor('9.2', 8, 'm2') }, { tasks: [task('9.1'), task('9.2', { deps: ['9.1'] })] });
    expect(calls).not.toContain('deps:outside');
  });

  it('parks a task whose dependency is not merged, and its dependent, with the reason; no worker starts', async () => {
    const { out, calls, escalations } = await runWave({ 'deps:outside': depLine({ '9.1': depEntry({ merged: false, pr: null, mergeSha: null, onDefault: false, reason: 'no merged PR' }) }) }, { tasks: relaunch });
    expect(out.gate).toBe('FAIL');
    expect(out.state).toEqual({ '9.2': 'parked', '9.3': 'parked' });
    expect(calls.filter((c) => c.startsWith('worker:'))).toEqual([]);
    expect(escalations.find((e) => e.task === '9.2')!.what).toBe('dependency 9.1 not merged on the default branch: no merged PR');
    expect(escalations.find((e) => e.task === '9.3')).toBeTruthy();
    expect(out.tasks['9.2']).toMatchObject({ task: '9.2', merged: false, rounds: [] });
  });

  it('a merged PR whose merge commit is not on the default branch parks the task', async () => {
    const { out, escalations } = await runWave({ 'deps:outside': depLine({ '9.1': depEntry({ onDefault: false, reason: 'not on default branch' }) }) }, { tasks: relaunch });
    expect(out.state['9.2']).toBe('parked');
    expect(escalations[0].what).toBe('dependency 9.1 not merged on the default branch: not on default branch');
  });

  it('a task with no dependency outside the run still starts when another task is parked', async () => {
    const tasks = [task('9.2', { deps: ['9.1'] }), task('9.4')];
    const { out } = await runWave({ 'deps:outside': depLine({ '9.1': depEntry({ merged: false, onDefault: false, reason: 'reverted' }) }), ...chainFor('9.4', 10, 'm4') }, { tasks });
    expect(out.state).toEqual({ '9.2': 'parked', '9.4': 'merged' });
  });

  it('a relay that fails, is blocked, prints no JSON or returns nothing parks every such task (fail closed)', async () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['blocked', { status: 'blocked', note: 'denied by rule' }, /blocked/],
      ['no JSON', { status: 'ran', exitCode: 1, stdout: 'boom\n' }, /no JSON/],
      ['nothing', undefined, /nothing/],
      ['no entry for the id', depLine({}), /9\.1/],
    ];
    for (const [name, answer, why] of cases) {
      const { out, calls, escalations } = await runWave({ 'deps:outside': answer }, { tasks: relaunch });
      expect(out.state, name).toEqual({ '9.2': 'parked', '9.3': 'parked' });
      expect(calls.filter((c) => c.startsWith('worker:')), name).toEqual([]);
      const e = escalations.find((x) => x.task === '9.2')!;
      expect(e.what, name).toContain('dependency 9.1 not merged on the default branch');
      expect(e.what, name).toMatch(why);
    }
  });

  it('is called with probe false: a relay that answers nothing does not pause the wave', async () => {
    const { out, calls } = await runWave({}, { tasks: relaunch });
    expect(calls.some((c) => c.startsWith('probe:'))).toBe(false);
    expect(out.gate).toBe('FAIL');
    expect('paused' in out).toBe(false);
  });
});

// ---- (b) settle main ----
describe('3.5 (b) a merge waits for the earlier merge’s deferred check on the default branch', () => {
  const two = (over: Record<string, Answer> = {}): Record<string, Answer> => ({
    ...chainFor('9.1', 7),
    ...chainFor('9.2', 8, 'm2'),
    'merger:9.1': mergeRan({ ...deferredLine }),
    'merger:9.2': mergeRan({ mergeSha: 'm2', mainSha: 'm2', mainCheck: 'skipped:unchanged' }),
    ...over,
  });

  it('the second merge starts only after the first deferred check returned (the call order shows it)', async () => {
    const order: string[] = [];
    const { out } = await runWave(
      two({
        'merger:9.1': () => {
          order.push('merger:9.1');
          return mergeRan({ ...deferredLine });
        },
        'main:9.1': async () => {
          await new Promise((r) => setTimeout(r, 40));
          order.push('main:9.1 done');
          return mergeRan({ mainCheck: 'green' });
        },
        'merger:9.2': () => {
          order.push('merger:9.2');
          return mergeRan({ mergeSha: 'm2', mainSha: 'm2', mainCheck: 'skipped:unchanged' });
        },
      }),
      { tasks: [task('9.1'), task('9.2')] },
    );
    expect(order).toEqual(['merger:9.1', 'main:9.1 done', 'merger:9.2']);
    expect(out.gate).toBe('PASS');
  });

  it('with settleMain false the second merge does not wait (2.4 behaviour)', async () => {
    const hold = deferred();
    const order: string[] = [];
    const { out } = await runWave(
      two({
        'main:9.1': async () => {
          await hold.p;
          order.push('main:9.1 done');
          return mergeRan({ mainCheck: 'green' });
        },
        'merger:9.2': () => {
          order.push('merger:9.2');
          hold.release();
          return mergeRan({ mergeSha: 'm2', mainSha: 'm2', mainCheck: 'skipped:unchanged' });
        },
      }),
      { tasks: [task('9.1'), task('9.2')], project: { settleMain: false } },
    );
    expect(order).toEqual(['merger:9.2', 'main:9.1 done']);
    expect(out.gate).toBe('PASS');
  });

  it('workers and critics keep running while a merge waits', async () => {
    const releaseMain = deferred();
    const seen: string[] = [];
    const { out } = await runWave(
      two({
        'main:9.1': async () => {
          await releaseMain.p;
          return mergeRan({ mainCheck: 'green' });
        },
        'critic:9.2 r1': () => {
          seen.push('critic:9.2');
          releaseMain.release();
          return criticMerge;
        },
      }),
      { tasks: [task('9.1'), task('9.2')] },
    );
    // The critic of 9.2 ran while 9.1's main check was still pending: it is what released it.
    expect(seen).toEqual(['critic:9.2']);
    expect(out.gate).toBe('PASS');
  });

  it('a red check is reverted before the next merge starts', async () => {
    const { out, calls } = await runWave(
      two({
        'main:9.1': mergeRan({ outcome: 'reverted', exit: 3, mainCheck: 'red', revertPrUrl: 'https://example.test/pull/99', logTail: 'FAIL x' }),
        'worker:9.1 reopen': { ...opened('9.1', 7), status: 'blocked', questions: ['q'] },
      }),
      { tasks: [task('9.1'), task('9.2')] },
    );
    expect(calls.indexOf('main:9.1')).toBeGreaterThan(calls.indexOf('merger:9.1'));
    expect(calls.indexOf('main:9.1')).toBeLessThan(calls.indexOf('merger:9.2'));
    expect(out.tasks['9.1'].reopened).toBe(true);
    expect(out.tasks['9.2'].merged).toBe(true);
  });

  it('a deferred check that is still pending after its watch calls parks each waiting task with "main not verified after <task>" and starts no merge', async () => {
    const pending = mergeRan({ outcome: 'pending', exit: 2, mainCheck: 'pending' });
    const { out, calls, escalations } = await runWave(
      two({ 'main:9.1': pending, 'main:9.1 c2': pending, 'main:9.1 c3': pending }),
      { tasks: [task('9.1'), task('9.2')] },
    );
    expect(calls).not.toContain('merger:9.2');
    expect(out.state['9.2']).toBe('parked');
    expect(escalations.some((e) => e.task === '9.2' && e.what === 'main not verified after 9.1')).toBe(true);
    expect(escalations.some((e) => e.task === '9.1')).toBe(true);
  });

  it('a blocked relay, or one that prints no JSON, is also no verdict', async () => {
    for (const answer of [{ status: 'blocked', note: 'denied' }, { status: 'ran', exitCode: 1, stdout: 'oops\n' }, undefined]) {
      const { out, calls, escalations } = await runWave(two({ 'main:9.1': answer }), { tasks: [task('9.1'), task('9.2')] });
      expect(calls).not.toContain('merger:9.2');
      expect(out.state['9.2']).toBe('parked');
      expect(escalations.some((e) => e.task === '9.2' && e.what === 'main not verified after 9.1')).toBe(true);
    }
  });

  it('with settleMain false an unverified check does not stop the next merge', async () => {
    const { out, calls } = await runWave(two({ 'main:9.1': { status: 'blocked', note: 'denied' } }), { tasks: [task('9.1'), task('9.2')], project: { settleMain: false } });
    expect(calls).toContain('merger:9.2');
    expect(out.tasks['9.2'].merged).toBe(true);
  });
});

// ---- (c) integration gate ----
describe('3.5 (c) the integration review gates at project.integrationGate', () => {
  const finding = (severity: string, what: string, where: string) => ({ severity, area: 'security', what, where });
  const integ = (findings: Json[]) => ({ summary: 's', findings });
  const high = finding('high', 'TLS is off', 'src/db.ts:12');
  const medium = finding('medium', 'query per row', 'src/list.ts:3');
  const low = finding('low', 'unused', 'src/x.ts:1');

  it('the default is "high": one high finding fails the gate with one escalation naming what and where', async () => {
    const { out, escalations } = await runWave({ ...happy, 'integration:wave': integ([high, medium, low]) }, { project: { integrationGate: undefined } });
    expect(out.gate).toBe('FAIL');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].what).toBe('integration: TLS is off (src/db.ts:12)');
    expect(escalations[0].question).toMatch(/follow-up task/);
    expect(escalations[0].question).toMatch(/integrationGate/);
    expect(escalations[0].question).toMatch(/relaunch/);
  });

  it('"off" passes the same wave, and the review stays advisory', async () => {
    const { out, escalations } = await runWave({ ...happy, 'integration:wave': integ([high]) }, { project: { integrationGate: 'off' } });
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect(out.integration.findings).toHaveLength(1);
  });

  it('"high" lets medium and low findings pass; "medium" fails on a medium one, one escalation per finding', async () => {
    const hi = await runWave({ ...happy, 'integration:wave': integ([medium, low]) }, { project: { integrationGate: 'high' } });
    expect(hi.out.gate).toBe('PASS');
    const med = await runWave({ ...happy, 'integration:wave': integ([high, medium, low]) }, { project: { integrationGate: 'medium' } });
    expect(med.out.gate).toBe('FAIL');
    expect(med.escalations.map((e) => e.what)).toEqual(['integration: TLS is off (src/db.ts:12)', 'integration: query per row (src/list.ts:3)']);
  });

  it('a review that did not run logs "WARNING: integration review did not run:" and does not gate', async () => {
    const { out, logs, escalations } = await runWave({ ...happy }, { project: { integrationGate: 'high' } });
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect(logs.some((l) => l.startsWith('WARNING: integration review did not run:'))).toBe(true);
    const off = await runWave({ ...happy }, { project: { integrationGate: 'off' } });
    expect(off.logs.some((l) => l.startsWith('WARNING: integration review did not run:'))).toBe(false);
  });

  it('integrationReview false with a level other than "off" logs a warning; with "off" it does not', async () => {
    const warn = await runWave({ ...happy }, { project: { integrationReview: false, integrationGate: 'high' } });
    expect(warn.out.gate).toBe('PASS');
    expect(warn.out.integration).toBeNull();
    expect(warn.logs.some((l) => l.startsWith('WARNING:') && l.includes('integrationReview'))).toBe(true);
    const quiet = await runWave({ ...happy }, { project: { integrationReview: false, integrationGate: 'off' } });
    expect(quiet.logs.some((l) => l.includes('integrationReview'))).toBe(false);
  });

  it('a value that is not high, medium or off is refused before anything runs', async () => {
    await expect(runWave({ ...happy }, { project: { integrationGate: 'low' } })).rejects.toThrow(/integrationGate/);
  });
});

// ---- (d) isolation ----
describe('3.5 (d) the preflight reports isolation', () => {
  const report = { sandbox: { enabled: false, source: null }, denyReads: { present: ['Read(~/.ssh/**)'], missing: ['Read(~/.aws/**)'] }, warnings: ['sandbox is not enabled', 'deny rule missing: Read(~/.aws/**)'] };

  it('runs isolation.js once, in its own relay after the merge dry run, with probe false', async () => {
    const { out, calls, prompts } = await runWave({ ...happy, 'preflight:isolation': ran(report) });
    expect(calls.slice(0, 2)).toEqual(['preflight:merge', 'preflight:isolation']);
    expect(calls.filter((c) => c === 'preflight:isolation')).toHaveLength(1);
    expect(prompts['preflight:isolation'][0]).toContain('node /tmp/sim/.claude/scripts/isolation.js --repo /tmp/sim');
    expect(out.isolation).toEqual(report);
  });

  it('logs each warning as a line starting "WARNING: isolation:" and the gate is unchanged', async () => {
    const { out, logs, escalations } = await runWave({ ...happy, 'preflight:isolation': ran(report) });
    const lines = logs.filter((l) => l.startsWith('WARNING: isolation:'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('sandbox is not enabled');
    expect(lines[1]).toContain('deny rule missing: Read(~/.aws/**)');
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
  });

  it('result.isolation is null when the relay returned nothing, and a stub that answers nothing does not pause the wave', async () => {
    const { out, calls } = await runWave({ ...happy });
    expect(out.isolation).toBeNull();
    expect('isolation' in out).toBe(true);
    expect(calls.some((c) => c.startsWith('probe:'))).toBe(false);
    expect(out.gate).toBe('PASS');
    expect('paused' in out).toBe(false);
  });

  it('is null when the relay is blocked or prints no JSON, and never fails the wave', async () => {
    for (const answer of [{ status: 'blocked', note: 'denied' }, { status: 'ran', exitCode: 1, stdout: 'x\n' }]) {
      const { out } = await runWave({ ...happy, 'preflight:isolation': answer });
      expect(out.isolation).toBeNull();
      expect(out.gate).toBe('PASS');
    }
  });

  it('the key is present when the preflight failed too', async () => {
    const { out } = await runWave({ ...happy }, { preflight: preflightLine({ loopVersion: '0.0.1' }) });
    expect(out.gate).toBe('FAIL');
    expect('isolation' in out).toBe(true);
    expect(out.isolation).toBeNull();
  });
});

// ---- (f) a locked merge is a wait ----
describe('3.5 (f) a merge result with outcome "locked" is a wait, not a refusal', () => {
  const locked = (message = 'merge lock held by pid 4242 on host h1 (PR #3), since 2026-11-26T10:00:00Z') => ran({ outcome: 'locked', exit: 2, mergeSha: null, message, conflictFiles: [] }, 2);

  it('a locked result then a merged one merges, with no FIX round', async () => {
    const { out, calls } = await runWave({ ...happy, 'merger:9.1': locked(), 'merger:9.1 locked2': mergeRan() });
    expect(out.gate).toBe('PASS');
    expect(out.tasks['9.1'].merged).toBe(true);
    expect(calls.filter((c) => c.startsWith('merger:9.1'))).toEqual(['merger:9.1', 'merger:9.1 locked2']);
    expect(calls).not.toContain('worker:9.1 fix1');
  });

  it('three locked results park the task naming the holder, and start no FIX round', async () => {
    const { out, calls, escalations } = await runWave({ ...happy, 'merger:9.1': locked(), 'merger:9.1 locked2': locked(), 'merger:9.1 locked3': locked('merge lock held by pid 77') });
    expect(out.state['9.1']).toBe('parked');
    expect(calls.filter((c) => c.startsWith('merger:9.1'))).toEqual(['merger:9.1', 'merger:9.1 locked2', 'merger:9.1 locked3']);
    expect(calls).not.toContain('worker:9.1 fix1');
    expect(escalations).toHaveLength(1);
    expect(`${escalations[0].what} ${escalations[0].question}`).toContain('merge lock held by pid 77');
    expect(escalations[0].what).toMatch(/locked/);
  });
});

// ---- (e) version ----
describe('3.5 (e) the loop version is 2.5.0 everywhere it is stamped', () => {
  it('package.json, wave-loop and chain-loop agree on 2.5.0', () => {
    expect(VERSION).toBe('2.5.0');
    expect(source).toContain("const LOOP_VERSION = '2.5.0'");
    const chain = readFileSync(join(ROOT, 'claude', 'workflows', 'chain-loop.js'), 'utf8');
    expect(chain).toContain("const LOOP_VERSION = '2.5.0'");
  });

  it('docs/OPERATING.md documents the new settings, scripts and human steps', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'OPERATING.md'), 'utf8');
    for (const word of ['mergeLockStaleMin', 'mergeLockWaitMin', 'reuseTreeCi', 'settleMain', 'integrationGate', 'isolation.js', 'dep-state.js', 'H4', 'H5']) {
      expect(doc, word).toContain(word);
    }
  });
});
