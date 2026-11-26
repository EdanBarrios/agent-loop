import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// v2.4 task 2.1: wave-loop control flow. Preflight reads the permission prediction of the merge dry run, a far-out usage
// limit pauses the wave instead of parking every task, and CI waits come in project.ciChunkMin chunks. The workflow script
// runs with a stubbed agent() that answers by label, as in tests/wave-loop-relay.test.ts.
const ROOT = join(import.meta.dirname, '..');
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const source = readFileSync(join(ROOT, 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Opts = { label: string; model?: string; effort?: string; phase?: string };
type Answer = unknown | ((opts: Opts, prompt: string) => unknown | Promise<unknown>);
type Json = Record<string, any>;
type TaskArg = { id: string; title: string; branch: string; deps: string[]; text: string; owns: string; notes: string };
const task = (id: string, extra: Partial<TaskArg> = {}): TaskArg => ({ id, title: 'T', branch: `task/${id}`, deps: [], text: 'x', owns: 'y', notes: '', ...extra });

async function runWave(answers: Record<string, Answer>, extra: { project?: Json; tasks?: TaskArg[]; tail?: TaskArg | null; preflight?: unknown } = {}) {
  const calls: string[] = [];
  const prompts: Record<string, string[]> = {};
  const logs: string[] = [];
  const all: Record<string, Answer> = { 'preflight:merge': extra.preflight ?? preflightLine(), ...answers };
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
  return { out, calls, prompts, logs, escalations };
}

const ran = (line: unknown, exitCode = 0) => ({ status: 'ran', exitCode, stdout: `${JSON.stringify(line)}\n` });
const permission = (over: Json = {}) => ({ allowed: true, rule: 'Bash(node /tmp/sim/.claude/scripts/merge-pr.js *)', source: '/tmp/sim/.claude/settings.json', denied: null, ask: null, broad: [], autoModeRules: 0, checked: [], ...over });
const preflightLine = (over: Json = {}, withPermission: Json | null = permission()) =>
  ran({ outcome: 'error', exit: 4, mergeSha: null, message: 'could not read PR #0: no pull requests found', loopVersion: VERSION, ...(withPermission ? { permission: withPermission } : {}), ...over }, 4);
const noRule = permission({ allowed: false, rule: null, source: null, broad: ['Bash(node *)'] });

const opened = (id: string, pr: number) => ({
  status: 'opened',
  branch: `task/${id}`,
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
const mergeRan = (over: Json = {}) => ran({ outcome: 'merged', exit: 0, mergeSha: 'm1', mainSha: 'm1', ciState: 'green', failing: [], conflictFiles: [], revertPrUrl: null, message: 'merged', logTail: '', ciWaitMs: 1, mergeMs: 1, mainCheckMs: 1, ...over });
const chainFor = (id: string, pr: number): Record<string, Answer> => ({ [`worker:${id}`]: opened(id, pr), [`ci:${id} r1`]: green, [`critic:${id} r1`]: criticMerge, [`merger:${id}`]: mergeRan() });
const happy = chainFor('9.1', 7);

const WARDEN_LIMIT = "failed: usage limit; resets Nov 19 at 12pm (America/Los_Angeles), too far out to wait for: You've hit your weekly limit · resets Nov 19 at 12pm (America/Los_Angeles)";
const RESET_TEXT = 'Nov 19 at 12pm (America/Los_Angeles)';
const deferred = () => {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
};

describe('2.1 (a) preflight reads the permission prediction of the merge dry run', () => {
  it('fails with one escalation that names the rule to add and lists the broad rules, and starts no worker', async () => {
    const { out, calls, escalations } = await runWave(happy, { preflight: preflightLine({}, noRule) });
    expect(calls).toEqual(['preflight:merge']);
    expect(out.gate).toBe('FAIL');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].task).toBe('preflight');
    const text = `${escalations[0].what} ${escalations[0].question}`;
    expect(text).toContain('Bash(node /tmp/sim/.claude/scripts/merge-pr.js *)');
    expect(text).toContain('Bash(node *)');
    expect('paused' in out).toBe(false);
  });

  it('names the rule with the scripts directory of project.loopScripts', async () => {
    const { escalations } = await runWave(happy, { preflight: preflightLine({}, noRule), project: { loopScripts: '/opt/loop/scripts' } });
    expect(`${escalations[0].what} ${escalations[0].question}`).toContain('Bash(node /opt/loop/scripts/merge-pr.js *)');
  });

  it('a dry run that allows the merge continues with no warning', async () => {
    const { out, logs, escalations } = await runWave(happy);
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect(logs.some((l) => /permission/i.test(l))).toBe(false);
  });

  it('mergePermission "prompt" logs a warning and continues', async () => {
    const { out, calls, logs, escalations } = await runWave(happy, { preflight: preflightLine({}, noRule), project: { mergePermission: 'prompt' } });
    expect(calls).toContain('worker:9.1');
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect(logs.some((l) => /mergePermission/.test(l) && /merge-pr\.js/.test(l))).toBe(true);
  });

  it('mergePermission "prompt" also continues on an ask rule', async () => {
    const ask = permission({ allowed: false, ask: 'Bash(node /tmp/sim/.claude/scripts/merge-pr.js *)' });
    const { out } = await runWave(happy, { preflight: preflightLine({}, ask), project: { mergePermission: 'prompt' } });
    expect(out.gate).toBe('PASS');
  });

  it('a deny rule fails preflight with mergePermission "prompt" too, and by default', async () => {
    const denied = permission({ allowed: false, rule: null, denied: 'Bash(node /tmp/sim/.claude/scripts/merge-pr.js:*)' });
    for (const project of [{ mergePermission: 'prompt' }, {}]) {
      const { out, calls, escalations } = await runWave(happy, { preflight: preflightLine({}, denied), project });
      expect(calls).toEqual(['preflight:merge']);
      expect(out.gate).toBe('FAIL');
      expect(escalations).toHaveLength(1);
      expect(`${escalations[0].what} ${escalations[0].question}`).toContain('Bash(node /tmp/sim/.claude/scripts/merge-pr.js:*)');
    }
  });

  it('a dry run without a permission field (an older merge-pr.js) logs a note and continues', async () => {
    const { out, logs } = await runWave(happy, { preflight: preflightLine({}, null) });
    expect(out.gate).toBe('PASS');
    const note = logs.find((l) => /permission/i.test(l));
    expect(note).toBeTruthy();
    expect(note!.startsWith('WARNING')).toBe(false);
  });
});

describe('2.1 (b) a far-out usage limit pauses the wave', () => {
  it('pauses a wave of 5 tasks and a tail: one merged, one running that finishes, one failed on the limit, two not started', async () => {
    const mergedOne = deferred();
    const finishTwo = deferred();
    const tasks = [task('9.1'), task('9.2'), task('9.3'), task('9.4', { deps: ['9.2'] }), task('9.5', { deps: ['9.2'] })];
    const { out, calls, escalations } = await runWave(
      {
        ...chainFor('9.1', 1),
        'merger:9.1': () => {
          mergedOne.release();
          return mergeRan();
        },
        ...chainFor('9.2', 2),
        'worker:9.2': async () => {
          await finishTwo.p;
          return opened('9.2', 2);
        },
        'merger:9.2': mergeRan({ mergeSha: 'm2' }),
        'worker:9.3': async () => {
          await mergedOne.p;
          setTimeout(finishTwo.release, 30);
          throw new Error(WARDEN_LIMIT);
        },
      },
      { tasks, tail: task('9.T', { deps: ['9.1', '9.2', '9.3', '9.4', '9.5'] }), project: { maxChains: 3, realityCheck: { command: 'true', readOnly: true } } },
    );
    expect(out.gate).toBe('PAUSED');
    expect(out.state).toEqual({ '9.1': 'merged', '9.2': 'merged', '9.3': 'paused', '9.4': 'paused', '9.5': 'paused', '9.T': 'paused' });
    expect(out.tasks['9.1'].merged).toBe(true);
    expect(out.tasks['9.2'].merged).toBe(true);
    for (const id of ['9.3', '9.4', '9.5', '9.T']) expect(out.tasks[id], id).toMatchObject({ task: id, rounds: [], merged: false });
    expect(out.paused).toEqual({ resetsAt: null, resetText: RESET_TEXT, tasks: ['9.3', '9.4', '9.5', '9.T'] });
    expect(escalations).toHaveLength(1);
    expect(escalations[0].what).toBe(`wave paused: usage limit, resets ${RESET_TEXT}`);
    // No new chain starts, and the machine gate, the reality gate and the integration review do not run.
    expect(calls.filter((c) => /^worker:9\.[45T]/.test(c))).toEqual([]);
    expect(calls).not.toContain('integration:wave');
    expect(calls).not.toContain('reality:check');
    expect(out.reality).toBeNull();
  });

  it('a wave that did not pause has no paused key', async () => {
    const { out } = await runWave(happy);
    expect(out.gate).toBe('PASS');
    expect('paused' in out).toBe(false);
  });

  it('a task whose dependency is paused is paused, not parked, and the tail raises no "tail not run"', async () => {
    const { out, escalations } = await runWave(
      { 'worker:9.1': () => { throw new Error(WARDEN_LIMIT); } },
      { tasks: [task('9.1'), task('9.2', { deps: ['9.1'] })], tail: task('9.T') },
    );
    expect(out.gate).toBe('PAUSED');
    expect(out.state).toEqual({ '9.1': 'paused', '9.2': 'paused', '9.T': 'paused' });
    expect(escalations.map((e) => e.what)).toEqual([`wave paused: usage limit, resets ${RESET_TEXT}`]);
    expect(out.paused.tasks).toEqual(['9.1', '9.2', '9.T']);
  });

  it('a parked task stays parked and keeps its own escalation beside the pause one', async () => {
    const stop = { ...criticMerge, verdict: 'STOP', stopSection: 'Fixed decisions', notes: 'contradiction' };
    const { out, escalations } = await runWave(
      {
        ...chainFor('9.1', 1),
        'critic:9.1 r1': stop,
        'worker:9.2': () => {
          throw new Error(WARDEN_LIMIT);
        },
      },
      { tasks: [task('9.1'), task('9.2')], project: { maxChains: 2 } },
    );
    expect(out.gate).toBe('PAUSED');
    expect(out.state['9.1']).toBe('parked');
    expect(out.state['9.2']).toBe('paused');
    expect(out.paused.tasks).toEqual(['9.2']);
    expect(escalations.map((e) => e.what)).toEqual(['critic STOP', `wave paused: usage limit, resets ${RESET_TEXT}`]);
  });

  it('a short usage limit does not pause: the task parks as before', async () => {
    const { out, escalations } = await runWave({ 'worker:9.1': () => { throw new Error('usage limit reached; resets in 10 minutes'); } });
    expect(out.gate).toBe('FAIL');
    expect(out.state['9.1']).toBe('parked');
    expect('paused' in out).toBe(false);
    expect(escalations.map((e) => e.what)).toEqual(['task chain threw']);
  });

  it('a limit message with no reset text pauses with resets unknown', async () => {
    const { out, escalations } = await runWave({ 'worker:9.1': () => { throw new Error('usage limit; too far out to wait for'); } });
    expect(out.gate).toBe('PAUSED');
    expect(out.paused).toEqual({ resetsAt: null, resetText: null, tasks: ['9.1'] });
    expect(escalations[0].what).toBe('wave paused: usage limit, resets unknown');
  });

  it('a bare null from a worker followed by a null probe pauses the wave with resetText null', async () => {
    const { out, calls, escalations } = await runWave({ 'worker:9.1': null, 'probe:worker:9.1': null });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'probe:worker:9.1']);
    expect(out.gate).toBe('PAUSED');
    expect(out.paused).toEqual({ resetsAt: null, resetText: null, tasks: ['9.1'] });
    expect(escalations).toHaveLength(1);
  });

  it('a bare null from a worker followed by a probe that throws a usage limit pauses the wave', async () => {
    const { out } = await runWave({
      'worker:9.1': null,
      'probe:worker:9.1': () => {
        throw new Error('usage limit reached');
      },
    });
    expect(out.gate).toBe('PAUSED');
    expect(out.state['9.1']).toBe('paused');
  });

  it('the probe is a relay that runs `true`', async () => {
    const { prompts } = await runWave({ 'worker:9.1': null, 'probe:worker:9.1': null });
    expect(prompts['probe:worker:9.1'][0]).toMatch(/^You are a relay/);
    expect(prompts['probe:worker:9.1'][0]).toMatch(/^true$/m);
  });

  it('a bare null from a worker followed by a passing probe does not pause: the task parks as before', async () => {
    const { out, calls, escalations } = await runWave({ 'worker:9.1': null, 'probe:worker:9.1': ran({}) });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'probe:worker:9.1']);
    expect(out.gate).toBe('FAIL');
    expect(out.state['9.1']).toBe('parked');
    expect('paused' in out).toBe(false);
    expect(escalations.map((e) => e.what)).toEqual(['worker agent returned nothing']);
  });

  it('the critic swap stays first: a far-out limit on the first critic swaps to the fallback and does not pause', async () => {
    const critic = (opts: Opts) => {
      if (opts.model === 'claude-fable-5-1') throw new Error(WARDEN_LIMIT);
      return criticMerge;
    };
    const { out, calls } = await runWave({ ...happy, 'critic:9.1 r1': critic });
    expect(calls.filter((c) => c.startsWith('critic:'))).toHaveLength(2);
    expect(out.gate).toBe('PASS');
    expect(out.models.critic).toMatchObject({ model: 'opus' });
    expect('paused' in out).toBe(false);
  });

  it('the wave pauses when the critic fallback also fails on a far-out limit, or returns null', async () => {
    const both = () => {
      throw new Error(WARDEN_LIMIT);
    };
    const limited = await runWave({ ...happy, 'critic:9.1 r1': both });
    expect(limited.calls.filter((c) => c.startsWith('critic:'))).toHaveLength(2);
    expect(limited.out.gate).toBe('PAUSED');
    expect(limited.out.paused.resetText).toBe(RESET_TEXT);
    expect(limited.out.state['9.1']).toBe('paused');
    expect(limited.escalations).toHaveLength(1);

    const nothing = await runWave({ ...happy, 'critic:9.1 r1': null });
    expect(nothing.calls.filter((c) => c.startsWith('critic:'))).toHaveLength(2);
    expect(nothing.out.gate).toBe('PAUSED');
    expect(nothing.out.paused.resetText).toBeNull();
  });

  it('a pause in the preflight relay itself pauses every task before a worker starts', async () => {
    const { out, calls } = await runWave({}, { preflight: () => { throw new Error(WARDEN_LIMIT); }, tasks: [task('9.1'), task('9.2')], tail: task('9.T') });
    expect(calls).toEqual(['preflight:merge']);
    expect(out.gate).toBe('PAUSED');
    expect(out.state).toEqual({ '9.1': 'paused', '9.2': 'paused', '9.T': 'paused' });
  });
});

describe('2.1 (c) project.ciChunkMin sets the length of a CI relay call', () => {
  const timeouts = (prompts: Record<string, string[]>) =>
    Object.entries(prompts)
      .filter(([label]) => label.startsWith('ci:9.1'))
      .map(([, ps]) => ps.map((p) => /--timeout-min ([\d.]+)/.exec(p)![1]))
      .flat();

  it('an unset ciChunkMin keeps 1.5-minute calls', async () => {
    const { prompts, out } = await runWave({ ...happy, 'ci:9.1 r1': ciOf('pending', { elapsedMs: 1000 }), 'ci:9.1 r1 c2': ciOf('pending', { elapsedMs: 1000 }), 'ci:9.1 r1 c3': green });
    expect(out.gate).toBe('PASS');
    expect(timeouts(prompts)).toEqual(['1.5', '1.5', '1.5']);
  });

  it('ciChunkMin 8 makes one relay call per 8 minutes of CI', async () => {
    const fast = await runWave(happy, { project: { ciChunkMin: 8 } });
    expect(fast.calls.filter((c) => c.startsWith('ci:'))).toEqual(['ci:9.1 r1']);
    expect(timeouts(fast.prompts)).toEqual(['8']);

    const slow = await runWave({ ...happy, 'ci:9.1 r1': ciOf('pending', { elapsedMs: 480000 }), 'ci:9.1 r1 c2': green }, { project: { ciChunkMin: 8 } });
    expect(slow.calls.filter((c) => c.startsWith('ci:'))).toEqual(['ci:9.1 r1', 'ci:9.1 r1 c2']);
    // The 9-minute budget (CI_RELAY_MAX_MIN) leaves one minute for the second call.
    expect(timeouts(slow.prompts)).toEqual(['8', '1']);
  });

  it('a value that is not a number above 0 uses the default, and a value above 9 is lowered to 9', async () => {
    for (const bad of ['abc', 0, -3, null, NaN]) {
      const { prompts } = await runWave(happy, { project: { ciChunkMin: bad } });
      expect(timeouts(prompts), String(bad)).toEqual(['1.5']);
    }
    const { prompts } = await runWave(happy, { project: { ciChunkMin: 20 } });
    expect(timeouts(prompts)).toEqual(['9']);
  });

  it('the relay prompt keeps its timeout rule', async () => {
    const { prompts } = await runWave(happy, { project: { ciChunkMin: 8 } });
    expect(prompts['ci:9.1 r1'][0]).toContain('timeout=600000');
  });
});

describe('2.1 (d) the loop version is 2.4.0 everywhere it is stamped', () => {
  it('package.json, wave-loop and chain-loop agree on 2.4.0', () => {
    expect(VERSION).toBe('2.4.0');
    expect(source).toContain("const LOOP_VERSION = '2.4.0'");
    const chain = readFileSync(join(ROOT, 'claude', 'workflows', 'chain-loop.js'), 'utf8');
    expect(chain).toContain("const LOOP_VERSION = '2.4.0'");
  });

  it('the result carries loopVersion 2.4.0', async () => {
    const { out } = await runWave(happy);
    expect(out.loopVersion).toBe('2.4.0');
  });
});

describe('2.1 docs/OPERATING.md documents the new knobs', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'OPERATING.md'), 'utf8');
  it.each(['mergePermission', 'ciChunkMin', 'testGlobs', 'PAUSED', 'H2', '--scorecards'])('mentions %s', (word) => {
    expect(doc).toContain(word);
  });
});
