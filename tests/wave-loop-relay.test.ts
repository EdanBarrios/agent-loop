import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Task 2.1: wave-loop waits for CI and merges through scripts, run by one low-cost relay agent each.
// The workflow script runs with a stubbed agent() that answers by label. A relay stub plays the command: it returns
// the stdout and exit code the script would have printed, and the workflow parses the JSON line in code.
const source = readFileSync(join(import.meta.dirname, '..', 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Opts = { label: string; model?: string; effort?: string; phase?: string };
type Answer = unknown | ((opts: Opts, prompt: string) => unknown | Promise<unknown>);
type Json = Record<string, any>;

type TaskArg = { id: string; title: string; branch: string; deps: string[]; text: string; owns: string; notes: string; lane?: string };
const task = (id: string, extra: Partial<TaskArg> = {}): TaskArg => ({ id, title: 'T', branch: `feat/${id}`, deps: [], text: 'x', owns: 'y', notes: '', ...extra });

async function runWave(answers: Record<string, Answer>, extra: { project?: Json; tasks?: TaskArg[]; withPreflight?: boolean } = {}) {
  const calls: string[] = [];
  const prompts: Record<string, string[]> = {};
  const optsSeen: Opts[] = [];
  const all: Record<string, Answer> = extra.withPreflight === false ? answers : { 'preflight:merge': preflightOk, ...answers };
  const agent = async (prompt: string, opts: Opts) => {
    calls.push(opts.label);
    optsSeen.push(opts);
    (prompts[opts.label] ||= []).push(prompt);
    // Agents take time: yield a macrotask so promise chains settle in label order, not in microtask-depth order.
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
    () => {},
    args,
  );
  const escalations = (out.escalations as Array<{ task: string; what: string; question: string }>) ?? [];
  const labels = (prefix: string) => calls.filter((c) => c.startsWith(prefix));
  return { out, calls, prompts, optsSeen, escalations, labels };
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

const opened = (id: string, pr: number) => ({
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
});
const w1 = opened('9.1', 7);
const w2 = opened('9.2', 8);
const fixed1 = { ...w1 };

const criticMerge = { verdict: 'MERGE', prHeadSha: 'abc', checklist: [], fixItems: [], notes: '' };
const criticFix = { ...criticMerge, verdict: 'FIX', fixItems: [{ n: 1, what: 'rename the helper', provedBy: 'the unit test', cause: 'defect' }], notes: 'one item' };
const criticStop = { ...criticMerge, verdict: 'STOP', stopSection: 'Fixed decisions', notes: 'the spec contradicts itself' };

// What a relay returns: the command's stdout (one JSON line, as the scripts print) and its exit code.
const ran = (line: unknown, exitCode = 0) => ({ status: 'ran', exitCode, stdout: `${JSON.stringify(line)}\n` });
const ciOf = (state: string, over: Json = {}) => ran({ state, failing: [], logTail: '', polls: 2, elapsedMs: 60000, ...over });
const mergeLine = (over: Json = {}) => ({
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
  ciWaitMs: 100,
  mergeMs: 200,
  mainCheckMs: 300,
  revertMs: 0,
  elapsedMs: 600,
  ...over,
});
const mergeRan = (over: Json = {}) => {
  const line = mergeLine(over);
  return ran(line, line.exit);
};
const blocked = (note = 'Permission to run this command was denied.') => ({ status: 'blocked', note });
const preflightOk = ran({ outcome: 'error', exit: 4, mergeSha: null, message: 'could not read PR #0: no pull requests found', loopVersion: '2.3.0' }, 4);

const green = ciOf('green');
// Chunked CI wait: chunk 1 keeps the base label, later chunks add ' c<n>'.
const chunkLabels = (base: string, n: number) => Array.from({ length: n }, (_, i) => (i ? `${base} c${i + 1}` : base));
const pendingChunks = (base: string, n: number, elapsedMs = 90000) => Object.fromEntries(chunkLabels(base, n).map((l) => [l, ciOf('pending', { elapsedMs })]));
const happy = { 'worker:9.1': w1, 'ci:9.1 r1': green, 'critic:9.1 r1': criticMerge, 'merger:9.1': mergeRan() };

describe('2.1 script mode: CI and merge are commands run by relay agents', () => {
  it('runs preflight, worker, the CI relay beside the critic, then one merge relay, and records the v1 merge shape', async () => {
    const { out, calls, prompts, escalations } = await runWave(happy);
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'merger:9.1']);
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    const t = out.tasks['9.1'];
    expect(t.merged).toBe(true);
    expect(t.merge).toMatchObject({ outcome: 'merged', mergeSha: 'm1', mainSha: 'm1', checkOnMainExitCode: 0, details: 'merged' });
    expect(t.merge.script).toMatchObject({ outcome: 'merged', exit: 0, mainCheckMs: 300 });
    expect(t.rounds[0]).toMatchObject({ round: 1, verdict: 'MERGE', ci: 'green' });
    expect(out.timings['9.1']).toEqual({ ciWaitMs: 60000 + 100, mergeMs: 200, mainCheckMs: 300 });
    expect(prompts['preflight:merge'][0]).toContain('/tmp/sim/.claude/scripts/merge-pr.js 0 --repo /tmp/sim --dry-run');
    expect(prompts['ci:9.1 r1'][0]).toContain('/tmp/sim/.claude/scripts/wait-ci.js 7 --repo /tmp/sim');
    expect(prompts['merger:9.1'][0]).toContain('/tmp/sim/.claude/scripts/merge-pr.js 7 --repo /tmp/sim --worktree /tmp/sim-wt/9.1');
  });

  it('the relay prompt runs in the foreground, never ends the turn early, and allows no other command', async () => {
    const { prompts } = await runWave(happy);
    for (const label of ['preflight:merge', 'ci:9.1 r1', 'merger:9.1']) {
      const p = prompts[label][0];
      expect(p, label).toMatch(/Do not set run_in_background/);
      expect(p, label).toContain('timeout=600000');
      expect(p, label).toMatch(/Never end your turn while the command is still running/);
      expect(p, label).not.toContain('run_in_background set to true');
      expect(p, label).toMatch(/no other command/i);
      expect(p, label).toMatch(/never run a second copy/i);
      expect(p, label).toMatch(/blocked/);
      expect(p, label).toMatch(/verbatim/i);
      expect(p, label).not.toMatch(/Do not start background processes/);
    }
  });

  it('the project can point at the loop scripts', async () => {
    const { prompts } = await runWave(happy, { project: { loopScripts: '/opt/loop/scripts' } });
    expect(prompts['preflight:merge'][0]).toContain('node /opt/loop/scripts/merge-pr.js 0 --repo /tmp/sim --dry-run');
    expect(prompts['ci:9.1 r1'][0]).toContain('node /opt/loop/scripts/wait-ci.js 7 --repo /tmp/sim');
  });

  it('relays run on Haiku/low by default, and the result reports it as relay and merger', async () => {
    const { optsSeen, out } = await runWave(happy);
    for (const label of ['preflight:merge', 'ci:9.1 r1', 'merger:9.1']) {
      const o = optsSeen.find((x) => x.label === label)!;
      expect([o.model, o.effort], label).toEqual(['claude-haiku-5-5', 'low']);
    }
    expect(out.models.relay).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(out.models.merger).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
  });

  it('project.models.relay overrides the relay model; project.models.merger does not move it', async () => {
    const { optsSeen } = await runWave(happy, { project: { models: { relay: { model: 'claude-sonnet-5-5', effort: 'low' }, merger: { model: 'opus', effort: 'high' } } } });
    for (const label of ['preflight:merge', 'ci:9.1 r1', 'merger:9.1']) {
      expect(optsSeen.find((x) => x.label === label)!.model, label).toBe('claude-sonnet-5-5');
    }
  });

  it('the critic prompt carries no CI instructions and says CI is supplied by the workflow', async () => {
    const { prompts } = await runWave(happy);
    const p = prompts['critic:9.1 r1'][0];
    expect(p).not.toMatch(/gh pr checks/);
    expect(p).not.toMatch(/--watch/);
    expect(p).not.toMatch(/pending or missing/i);
    expect(p).not.toMatch(/ciState/);
    expect(p).toMatch(/CI result supplied by the workflow/);
  });
});

describe('2.1 the wave 6 regression: pending CI is never a FIX', () => {
  it('a critic that answers MERGE while the CI relay is still waiting does not cause a FIX; the merge waits for green', async () => {
    const ci = deferred();
    const { out, calls, escalations } = await runWave({
      ...happy,
      'ci:9.1 r1': async () => {
        await ci.p;
        return green;
      },
      'critic:9.1 r1': async () => {
        setTimeout(ci.release, 5);
        return criticMerge;
      },
    });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'merger:9.1']);
    expect(calls.some((c) => c.includes('fix'))).toBe(false);
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
  });

  it('CI still pending after the wait-ci timeout escalates, naming the timeout; no FIX round and no merge', async () => {
    const { out, calls, escalations } = await runWave({ ...happy, ...pendingChunks('ci:9.1 r1', 6) });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', ...chunkLabels('ci:9.1 r1', 6).slice(1)]);
    expect(out.gate).toBe('FAIL');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].what).toMatch(/pending/i);
    expect(escalations[0].what).toMatch(/timeout/i);
  });

  it('MERGE with CI missing escalates and never merges or fixes', async () => {
    const { calls, escalations } = await runWave({ ...happy, 'ci:9.1 r1': ciOf('missing'), 'ci:9.1 r1 c2': ciOf('missing') });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'ci:9.1 r1 c2']);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].what).toMatch(/no CI|missing/i);
  });
});

describe('2.1 relay results are parsed in code', () => {
  it('a wait-ci result with no JSON line is run once more, then used', async () => {
    const { out, calls } = await runWave({ ...happy, 'ci:9.1 r1': { status: 'ran', exitCode: 0, stdout: 'All checks passed!' }, 'ci:9.1 r1 retry': green });
    expect(calls.filter((c) => c.startsWith('ci:'))).toEqual(['ci:9.1 r1', 'ci:9.1 r1 retry']);
    expect(out.gate).toBe('PASS');
  });

  it('a wait-ci result with no JSON line twice escalates, with no third run and no merge', async () => {
    const bad = { status: 'ran', exitCode: 0, stdout: 'checks look fine to me' };
    const { calls, escalations } = await runWave({ ...happy, 'ci:9.1 r1': bad, 'ci:9.1 r1 retry': bad });
    expect(calls.filter((c) => c.startsWith('ci:'))).toEqual(['ci:9.1 r1', 'ci:9.1 r1 retry']);
    expect(calls).not.toContain('merger:9.1');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].what).toMatch(/wait-ci/);
  });

  it('a relay that only says it merged is not believed: no JSON line from merge-pr.js escalates with the PR state and is not re-run', async () => {
    const { out, calls, escalations } = await runWave({ ...happy, 'merger:9.1': { status: 'ran', exitCode: 0, stdout: 'Merged PR 7 successfully.' } });
    expect(calls.filter((c) => c.startsWith('merger:'))).toEqual(['merger:9.1']);
    expect(out.gate).toBe('FAIL');
    expect(out.tasks['9.1'].merged).toBe(false);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].what).toMatch(/merge-pr/);
    expect(escalations[0].question).toMatch(/PR #7/);
    expect(escalations[0].question).toMatch(/state/i);
  });

  it('the JSON line is found after other output, and the last JSON line wins', async () => {
    const stdout = `npm warn something\n${JSON.stringify(mergeLine({ message: 'first' }))}\nnoise\n${JSON.stringify(mergeLine({ message: 'last' }))}\n`;
    const { out } = await runWave({ ...happy, 'merger:9.1': { status: 'ran', exitCode: 0, stdout } });
    expect(out.tasks['9.1'].merge.details).toBe('last');
  });
});

describe('2.1 combining the critic and CI', () => {
  it('red CI with a MERGE verdict produces one FIX that names the failing check, then merges', async () => {
    const { out, calls, prompts, escalations } = await runWave({
      ...happy,
      'ci:9.1 r1': ciOf('red', { failing: ['lint'], logTail: 'src/a.js: no-unused-vars' }),
      'worker:9.1 fix1': fixed1,
      'ci:9.1 r2': green,
      'critic:9.1 r2': criticMerge,
    });
    expect(calls.filter((c) => c.startsWith('worker:'))).toEqual(['worker:9.1', 'worker:9.1 fix1']);
    expect(prompts['worker:9.1 fix1'][0]).toContain('lint');
    expect(prompts['worker:9.1 fix1'][0]).toContain('no-unused-vars');
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect(out.tasks['9.1'].rounds.map((r: Json) => [r.verdict, r.ci])).toEqual([
      ['MERGE', 'red'],
      ['MERGE', 'green'],
    ]);
  });

  it('a critic FIX and red CI are fixed in one round with both items', async () => {
    const { prompts, calls } = await runWave({
      ...happy,
      'critic:9.1 r1': criticFix,
      'ci:9.1 r1': ciOf('red', { failing: ['check'], logTail: 'boom' }),
      'worker:9.1 fix1': fixed1,
      'ci:9.1 r2': green,
      'critic:9.1 r2': criticMerge,
    });
    expect(calls.filter((c) => c.startsWith('worker:'))).toEqual(['worker:9.1', 'worker:9.1 fix1']);
    expect(prompts['worker:9.1 fix1'][0]).toContain('rename the helper');
    expect(prompts['worker:9.1 fix1'][0]).toContain('CI failed on the PR head: check');
  });

  it('on STOP the workflow does not wait for CI', async () => {
    const never = new Promise(() => {});
    const { out, calls, escalations } = await runWave({ ...happy, 'ci:9.1 r1': () => never, 'critic:9.1 r1': criticStop });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1']);
    expect(out.gate).toBe('FAIL');
    expect(escalations.map((e) => e.what)).toEqual(['critic STOP']);
  });

  it('on FIX with CI still running, the workflow waits at most 5 more minutes (one bounded relay) and then starts the fix round', async () => {
    const never = new Promise(() => {});
    const { out, calls, prompts } = await runWave({
      ...happy,
      'critic:9.1 r1': criticFix,
      'ci:9.1 r1': () => never,
      ...pendingChunks('ci:9.1 r1 fix', 4, 75000),
      'worker:9.1 fix1': fixed1,
      'ci:9.1 r2': green,
      'critic:9.1 r2': criticMerge,
    });
    expect(prompts['ci:9.1 r1 fix'][0]).toContain('wait-ci.js 7 --repo /tmp/sim --timeout-min 1.5');
    expect(prompts['ci:9.1 r1 fix c4'][0]).toContain('wait-ci.js 7 --repo /tmp/sim --timeout-min 0.5');
    expect(calls.filter((c) => c.startsWith('ci:9.1 r1 fix'))).toEqual(chunkLabels('ci:9.1 r1 fix', 4));
    expect(calls.indexOf('worker:9.1 fix1')).toBeGreaterThan(calls.indexOf('ci:9.1 r1 fix c4'));
    expect(out.gate).toBe('PASS');
    expect(out.timings['9.1'].ciWaitMs).toBe(4 * 75000 + 60000 + 100);
  });

  it('on FIX with CI already finished, no bounded relay is started', async () => {
    const { calls } = await runWave({ ...happy, 'critic:9.1 r1': criticFix, 'worker:9.1 fix1': fixed1, 'ci:9.1 r2': green, 'critic:9.1 r2': criticMerge });
    expect(calls.some((c) => c.endsWith(' fix'))).toBe(false);
  });
});

describe('2.1 a relay that answers blocked', () => {
  it('the CI relay: one escalation naming the command, no retry, no merger call', async () => {
    const { calls, escalations } = await runWave({ ...happy, 'ci:9.1 r1': blocked() });
    expect(calls.filter((c) => c.startsWith('ci:'))).toEqual(['ci:9.1 r1']);
    expect(calls).not.toContain('merger:9.1');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].what).toMatch(/blocked/i);
    expect(`${escalations[0].what} ${escalations[0].question}`).toContain('wait-ci.js 7 --repo /tmp/sim');
  });

  it('the merge relay: one escalation naming the command, no retry; later merge relays escalate without running', async () => {
    const { out, calls, escalations, prompts } = await runWave(
      {
        'worker:9.1': w1,
        'ci:9.1 r1': green,
        'critic:9.1 r1': criticMerge,
        'merger:9.1': blocked(),
        'worker:9.2': w2,
        'ci:9.2 r1': green,
        'critic:9.2 r1': criticMerge,
        'merger:9.2': mergeRan(),
      },
      { tasks: [task('9.1'), task('9.2')] },
    );
    expect(calls.filter((c) => c.startsWith('merger:'))).toEqual(['merger:9.1']);
    expect(out.gate).toBe('FAIL');
    expect(out.state['9.1']).toBe('parked');
    expect(out.state['9.2']).toBe('parked');
    expect(escalations).toHaveLength(2);
    expect(`${escalations[0].what} ${escalations[0].question}`).toContain('merge-pr.js 7 --repo /tmp/sim');
    expect(escalations[0].task).toBe('9.1');
    expect(escalations[1].task).toBe('9.2');
    expect(escalations[1].what).toMatch(/blocked earlier|not run/i);
    expect(prompts['merger:9.2']).toBeUndefined();
  });

  it('the preflight relay: the wave fails before any worker starts', async () => {
    const { out, calls, escalations } = await runWave({ 'preflight:merge': blocked('denied by settings'), 'worker:9.1': w1 });
    expect(calls).toEqual(['preflight:merge']);
    expect(out.gate).toBe('FAIL');
    expect(out.tasks).toEqual({});
    expect(escalations).toHaveLength(1);
    expect(escalations[0].task).toBe('preflight');
    expect(`${escalations[0].what} ${escalations[0].question}`).toContain('merge-pr.js 0 --repo /tmp/sim --dry-run');
  });

  it('a missing script (no JSON line, exit 127) fails the wave before any worker starts', async () => {
    const missing = { status: 'ran', exitCode: 127, stdout: '', note: 'cannot find module' };
    const { out, calls, escalations } = await runWave({ 'preflight:merge': missing, 'worker:9.1': w1 });
    expect(calls).toEqual(['preflight:merge', 'preflight:merge retry']);
    expect(out.gate).toBe('FAIL');
    expect(escalations[0].what).toMatch(/preflight/i);
  });

  it('a preflight result with no JSON line is run once more; a good second answer lets the wave go on', async () => {
    const flake = { status: 'ran', exitCode: 4, stdout: 'no JSON line here' };
    const { out, calls, escalations } = await runWave({ ...happy, 'preflight:merge': flake, 'preflight:merge retry': preflightOk });
    expect(calls).toEqual(['preflight:merge', 'preflight:merge retry', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'merger:9.1']);
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
  });

  it('a blocked preflight is not retried', async () => {
    const { calls } = await runWave({ 'preflight:merge': blocked('denied'), 'preflight:merge retry': preflightOk, 'worker:9.1': w1 });
    expect(calls).toEqual(['preflight:merge']);
  });

  it('a preflight that cannot read the project config fails the wave', async () => {
    const { calls, out } = await runWave({ 'preflight:merge': ran({ outcome: 'error', exit: 4, message: 'cannot read /tmp/sim/.claude/loop.local.json: ENOENT' }, 4) });
    expect(calls).toEqual(['preflight:merge']);
    expect(out.gate).toBe('FAIL');
  });
});

describe('2.1 exit codes of merge-pr.js', () => {
  it('exit 2 with conflict files starts one worker fix round naming the files and the syncConflicts rule', async () => {
    const conflict = mergeRan({ outcome: 'refused', exit: 2, mergeSha: null, mainSha: null, ciState: 'green', conflictFiles: ['ratchet.json', 'src/x.ts'], message: 'sync conflict' });
    const { out, calls, prompts, escalations } = await runWave(
      { ...happy, 'merger:9.1': seq(conflict, mergeRan()), 'worker:9.1 fix1': fixed1, 'ci:9.1 r2': green, 'critic:9.1 r2': criticMerge },
      { project: { syncConflicts: 'ratchet.json, by taking the higher value' } },
    );
    const fixPrompt = prompts['worker:9.1 fix1'][0];
    expect(fixPrompt).toContain('ratchet.json');
    expect(fixPrompt).toContain('src/x.ts');
    expect(fixPrompt).toContain('Resolve conflicts only in ratchet.json, by taking the higher value');
    expect(calls.filter((c) => c.startsWith('worker:'))).toEqual(['worker:9.1', 'worker:9.1 fix1']);
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
  });

  it('a second conflict escalates instead of starting another conflict round', async () => {
    const conflict = mergeRan({ outcome: 'refused', exit: 2, mergeSha: null, conflictFiles: ['ratchet.json'], message: 'sync conflict' });
    const { calls, escalations } = await runWave({ ...happy, 'merger:9.1': conflict, 'worker:9.1 fix1': fixed1, 'ci:9.1 r2': green, 'critic:9.1 r2': criticMerge });
    expect(calls.filter((c) => c.startsWith('worker:'))).toEqual(['worker:9.1', 'worker:9.1 fix1']);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].what).toMatch(/conflict/i);
  });

  it('exit 2 with red CI is a FIX naming the failing check', async () => {
    const red = mergeRan({ outcome: 'refused', exit: 2, mergeSha: null, ciState: 'red', failing: ['unit'], logTail: 'expected 2 to be 3', message: 'CI is red' });
    const { out, prompts } = await runWave({ ...happy, 'merger:9.1': seq(red, mergeRan()), 'worker:9.1 fix1': fixed1, 'ci:9.1 r2': green, 'critic:9.1 r2': criticMerge });
    expect(prompts['worker:9.1 fix1'][0]).toContain('CI failed on the PR head: unit');
    expect(out.gate).toBe('PASS');
  });

  it.each([
    ['pending CI', { outcome: 'refused', exit: 2, ciState: 'pending', message: 'CI still pending after 20 minutes' }, 'CI still pending after 20 minutes'],
    ['missing CI', { outcome: 'refused', exit: 2, ciState: 'missing', message: 'no CI checks were reported' }, 'no CI checks were reported'],
    ['another refusal', { outcome: 'refused', exit: 2, ciState: 'green', message: 'GitHub refused: head changed' }, 'GitHub refused: head changed'],
    ['an error', { outcome: 'error', exit: 4, ciState: 'green', message: 'the revert PR was not green' }, 'the revert PR was not green'],
  ])('%s is failed with an escalation carrying the message', async (_name, over, message) => {
    const { out, calls, escalations } = await runWave({ ...happy, 'merger:9.1': mergeRan(over as Json) });
    expect(out.tasks['9.1'].merge).toMatchObject({ outcome: 'failed', details: message });
    expect(out.tasks['9.1'].merge.script).toMatchObject({ exit: (over as Json).exit });
    expect(calls.filter((c) => c.startsWith('worker:'))).toEqual(['worker:9.1']);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].question).toContain(message);
    expect(out.gate).toBe('FAIL');
  });

  it('pending CI at the merge script names the pending-CI timeout in the escalation', async () => {
    const { escalations } = await runWave({ ...happy, 'merger:9.1': mergeRan({ outcome: 'refused', exit: 2, ciState: 'pending', message: 'x' }) });
    expect(escalations[0].what).toMatch(/pending/i);
    expect(escalations[0].what).toMatch(/timeout/i);
  });

  it('exit 3 is reverted and takes the reopen path: worker, CI relay, critic, merge relay, each labelled reopen', async () => {
    const reverted = mergeRan({ outcome: 'reverted', exit: 3, mainSha: 'm0', revertPrUrl: 'https://example.test/pull/9', message: 'main was red; reverted', logTail: 'FAIL tests/a.test.ts' });
    const { out, calls, prompts, escalations } = await runWave({
      ...happy,
      'merger:9.1': reverted,
      'worker:9.1 reopen': { ...w1, branch: 'feat/9.1-2' },
      'ci:9.1 reopen': green,
      'critic:9.1 reopen': criticMerge,
      'merger:9.1 reopen': mergeRan({ mergeSha: 'm2', mainSha: 'm2' }),
    });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'merger:9.1', 'worker:9.1 reopen', 'ci:9.1 reopen', 'critic:9.1 reopen', 'merger:9.1 reopen']);
    expect(prompts['worker:9.1 reopen'][0]).toContain('FAIL tests/a.test.ts');
    expect(out.tasks['9.1'].reopened).toBe(true);
    expect(out.tasks['9.1'].merged).toBe(true);
    expect(out.tasks['9.1'].merge).toMatchObject({ outcome: 'merged', mergeSha: 'm2', checkOnMainExitCode: 0 });
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect(out.timings['9.1'].mergeMs).toBe(400);
  });

  it('a revert is recorded in the v1 shape', async () => {
    const reverted = mergeRan({ outcome: 'reverted', exit: 3, mainSha: 'm0', revertPrUrl: 'https://example.test/pull/9', message: 'main was red; reverted', logTail: 'FAIL tests/a.test.ts' });
    const { out } = await runWave({ ...happy, 'merger:9.1': reverted });
    expect(out.tasks['9.1'].merge).toMatchObject({ outcome: 'reverted', mergeSha: 'm1', mainSha: 'm0', revertPrUrl: 'https://example.test/pull/9', checkOnMainTail: 'FAIL tests/a.test.ts', details: 'main was red; reverted' });
    expect(out.tasks['9.1'].merge.checkOnMainExitCode).not.toBe(0);
  });

  it('a second revert after the reopen escalates', async () => {
    const reverted = mergeRan({ outcome: 'reverted', exit: 3, revertPrUrl: 'u', message: 'reverted' });
    const { escalations, out } = await runWave({
      ...happy,
      'merger:9.1': reverted,
      'worker:9.1 reopen': w1,
      'ci:9.1 reopen': green,
      'critic:9.1 reopen': criticMerge,
      'merger:9.1 reopen': reverted,
    });
    expect(out.gate).toBe('FAIL');
    expect(escalations.map((e) => e.what)).toEqual(['second red main (or merge failure) after reopen']);
  });
});

describe('2.1 timings come from the script lines', () => {
  it('ciWaitMs sums every review round plus the merge line; mergeMs and mainCheckMs are copied', async () => {
    const { out } = await runWave({
      ...happy,
      'critic:9.1 r1': criticFix,
      'ci:9.1 r1': ciOf('green', { elapsedMs: 1000 }),
      'worker:9.1 fix1': fixed1,
      'ci:9.1 r2': ciOf('green', { elapsedMs: 2000 }),
      'critic:9.1 r2': criticMerge,
      'merger:9.1': mergeRan({ ciWaitMs: 40, mergeMs: 70, mainCheckMs: 90 }),
    });
    expect(out.timings['9.1']).toEqual({ ciWaitMs: 1000 + 2000 + 40, mergeMs: 70, mainCheckMs: 90 });
  });
});

describe('2.1 project.merger = agent restores only the merger agent', () => {
  const agentMode = { project: { merger: 'agent' } };
  const mergedAgent = { outcome: 'merged', details: 'ok', mergeSha: 'm', mainSha: 'm', checkOnMainExitCode: 0 };

  it('makes the v2 label sequence plus the ci: relay labels, with no preflight', async () => {
    const { out, calls } = await runWave({ 'worker:9.1': w1, 'ci:9.1 r1': green, 'critic:9.1 r1': criticMerge, 'merger:9.1': mergedAgent }, { ...agentMode, withPreflight: false });
    expect(calls).toEqual(['worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'merger:9.1']);
    expect(out.gate).toBe('PASS');
    expect(out.tasks['9.1'].merge).toEqual(mergedAgent);
  });

  it('keeps the CI relay and combineVerdict: red CI is still a FIX', async () => {
    const { calls } = await runWave(
      { 'worker:9.1': w1, 'ci:9.1 r1': ciOf('red', { failing: ['check'] }), 'critic:9.1 r1': criticMerge, 'worker:9.1 fix1': fixed1, 'ci:9.1 r2': green, 'critic:9.1 r2': criticMerge, 'merger:9.1': mergedAgent },
      { ...agentMode, withPreflight: false },
    );
    expect(calls).toEqual(['worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'worker:9.1 fix1', 'ci:9.1 r2', 'critic:9.1 r2', 'merger:9.1']);
  });

  it('the merger prompt equals the stored v2 snapshot (main CI configured)', async () => {
    const { prompts } = await runWave({ 'worker:9.1': { ...w1, prUrl: 'u' }, 'ci:9.1 r1': green, 'critic:9.1 r1': criticMerge, 'merger:9.1': mergedAgent }, { project: { merger: 'agent', mainCi: 'check', syncPolicy: 'conflict' }, withPreflight: false });
    expect(prompts['merger:9.1'][0]).toBe(V2_MERGER_MAIN_CI);
  });

  it('the merger prompt equals the stored v2 snapshot (local check, always sync)', async () => {
    const { prompts } = await runWave(
      { 'worker:9.1': { ...w1, prUrl: 'u' }, 'ci:9.1 r1': green, 'critic:9.1 r1': criticMerge, 'merger:9.1': mergedAgent },
      { project: { merger: 'agent', mainCi: '', syncPolicy: 'always', checkMutates: ['ratchet.json'], syncConflicts: 'ratchet.json by taking the higher value' }, withPreflight: false },
    );
    expect(prompts['merger:9.1'][0]).toBe(V2_MERGER_LOCAL);
  });
});

describe('2.1 fast lane: a Lane: fast task skips the critic', () => {
  const FAST = { fastLane: { enabled: true, maxPerWave: 3, testCountCommand: 'npm run -s test-count' } };
  const fastTask = (id: string) => task(id, { lane: 'fast', owns: 'docs/notes/' });
  const facts = (over: Json = {}) => ({
    status: 'ran',
    changedFiles: ['docs/notes/a.md'],
    addedText: 'a synthetic added line',
    decisions: ['D1 | keep the wording | the conventional default | yes'],
    testCountBeforeOut: '40\n',
    testCountAfterOut: '41\n',
    ...over,
  });
  const fastAnswers = (id: string, pr: number, over: Record<string, Answer> = {}) => ({
    [`worker:${id}`]: opened(id, pr),
    [`ci:${id} r1`]: green,
    [`facts:${id} r1`]: facts(),
    [`critic:${id} r1`]: criticMerge,
    [`merger:${id}`]: mergeRan(),
    ...over,
  });

  it('an eligible task makes zero critic calls and goes to the merge relay after the CI result', async () => {
    const { out, calls, prompts, escalations } = await runWave(fastAnswers('9.1', 7), { project: FAST, tasks: [fastTask('9.1')] });
    expect(calls.filter((c) => c.startsWith('critic:'))).toEqual([]);
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'facts:9.1 r1', 'merger:9.1']);
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect(out.tasks['9.1'].rounds[0]).toMatchObject({ verdict: 'MERGE', ci: 'green', lane: 'fast' });
    expect(prompts['facts:9.1 r1'][0]).toContain('npm run -s test-count');
    expect(prompts['facts:9.1 r1'][0]).toContain('gh pr diff 7');
    expect(prompts['facts:9.1 r1'][0]).toContain('/tmp/sim-wt/9.1');
  });

  it('a task whose files fall outside Owns gets the critic after the CI result', async () => {
    const { out, calls } = await runWave(fastAnswers('9.1', 7, { 'facts:9.1 r1': facts({ changedFiles: ['docs/notes/a.md', 'src/other.ts'] }) }), { project: FAST, tasks: [fastTask('9.1')] });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'facts:9.1 r1', 'critic:9.1 r1', 'merger:9.1']);
    expect(out.gate).toBe('PASS');
    expect(out.tasks['9.1'].rounds[0].lane).toBeUndefined();
  });

  it('a fast task with red CI gets exactly one FIX round and no critic', async () => {
    const { out, calls, prompts } = await runWave(
      fastAnswers('9.1', 7, {
        'ci:9.1 r1': ciOf('red', { failing: ['check'], logTail: 'boom' }),
        'worker:9.1 fix1': fixed1,
        'ci:9.1 r2': green,
        'facts:9.1 r2': facts(),
      }),
      { project: FAST, tasks: [fastTask('9.1')] },
    );
    expect(calls.filter((c) => c.startsWith('worker:'))).toEqual(['worker:9.1', 'worker:9.1 fix1']);
    expect(calls.filter((c) => c.startsWith('critic:'))).toEqual([]);
    expect(prompts['worker:9.1 fix1'][0]).toContain('CI failed on the PR head: check');
    expect(out.gate).toBe('PASS');
  });

  it('a fast task whose CI is red again after its one FIX round escalates', async () => {
    const red = ciOf('red', { failing: ['check'] });
    const { calls, escalations } = await runWave(fastAnswers('9.1', 7, { 'ci:9.1 r1': red, 'worker:9.1 fix1': fixed1, 'ci:9.1 r2': red, 'facts:9.1 r2': facts() }), { project: FAST, tasks: [fastTask('9.1')] });
    expect(calls.filter((c) => c.startsWith('worker:'))).toEqual(['worker:9.1', 'worker:9.1 fix1']);
    expect(calls).not.toContain('merger:9.1');
    expect(escalations).toHaveLength(1);
  });

  it('a fourth fast task beyond maxPerWave 3 gets a critic', async () => {
    const ids = ['9.1', '9.2', '9.3', '9.4'];
    const answers: Record<string, Answer> = {};
    ids.forEach((id, i) => Object.assign(answers, fastAnswers(id, 7 + i)));
    const { out, calls } = await runWave(answers, { project: FAST, tasks: ids.map(fastTask) });
    expect(calls.filter((c) => c.startsWith('critic:'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('merger:'))).toHaveLength(4);
    expect(out.gate).toBe('PASS');
  });

  it('a Lane: fast task starts the critic at once when fastLane is not enabled', async () => {
    const { calls } = await runWave({ ...happy }, { project: { fastLane: { enabled: false } }, tasks: [fastTask('9.1')] });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'merger:9.1']);
  });

  it('without a testCountCommand the task is not eligible, so the critic starts at once and no facts relay runs', async () => {
    const { calls } = await runWave({ ...happy }, { project: { fastLane: { enabled: true } }, tasks: [fastTask('9.1')] });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'merger:9.1']);
  });

  it('a test count that fell, or a facts relay that failed, falls back to the critic', async () => {
    const fell = await runWave(fastAnswers('9.1', 7, { 'facts:9.1 r1': facts({ testCountAfterOut: '39\n' }) }), { project: FAST, tasks: [fastTask('9.1')] });
    expect(fell.calls).toContain('critic:9.1 r1');
    const failed = await runWave(fastAnswers('9.1', 7, { 'facts:9.1 r1': blocked() }), { project: FAST, tasks: [fastTask('9.1')] });
    expect(failed.calls).toContain('critic:9.1 r1');
    expect(failed.out.gate).toBe('PASS');
  });

  it('a normal task never uses the fast lane even when it is enabled', async () => {
    const { calls } = await runWave({ ...happy }, { project: FAST });
    expect(calls).toEqual(['preflight:merge', 'worker:9.1', 'ci:9.1 r1', 'critic:9.1 r1', 'merger:9.1']);
  });
});

// The v2 merger prompts, captured from the v2 wave-loop.js (origin/main before task 2.1) for the project and task above.
const V2_MERGER_MAIN_CI = "You are the merger for the Sim repository. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nMerge PR #7 (u, branch feat/9.1, worktree /tmp/sim-wt/9.1) for task 9.1: T. The critic returned MERGE at PR head abc. You hold the merge lock: no other merge is running.\nSteps:\n1. cd /tmp/sim && git pull --ff-only (the checkout is on main). Run gh pr view 7 --json mergeable -q .mergeable. If it prints MERGEABLE, skip to step 3: the branch need not contain the latest main, the check on main after the merge is the test of the combination.\n2. If it prints CONFLICTING (or UNKNOWN after three tries 10 s apart): cd into the worktree, git pull --ff-only, then git merge main (no rebase; force pushes are denied). Any conflict: stop, report it in the PR body, and return outcome \"failed\" with the file list. Commit the merge with the message \"Sync branch with upstream before merge\" plus the trailer line (do not name the default branch in the commit command; the hook blocks it), push with a plain git push, then wait for CI: gh pr checks 7 --watch --fail-fast (up to 15 minutes).\n3. Confirm CI is green: gh pr checks 7. If not green, outcome \"failed\" with details; do not merge.\n4. gh pr merge 7 --merge --delete-branch. If GitHub refuses, outcome \"failed\" with the exact message. (Exit code 1 only because the local branch is checked out in a worktree is fine; confirm with gh pr view --json state.)\n5. cd /tmp/sim && git pull --ff-only; record the merge sha (git rev-parse HEAD). Do not run npm run check locally. Wait for the \"check\" workflow run on main for that sha: gh run list --branch main --workflow check --commit <mergeSha> --json databaseId,status,conclusion (retry every 20 s until the run appears, up to 3 minutes), then gh run watch <databaseId> --exit-status (up to 15 minutes). checkOnMainExitCode is 0 when the conclusion is success, else 1 with the last 40 lines of gh run view <databaseId> --log-failed as checkOnMainTail.\n6. If the check on main is red: git worktree add /tmp/sim-wt/revert-9.1 -b revert/9.1 main, git revert -m 1 <mergeSha> there, push, open a PR titled \"Revert 9.1: T (check red on main)\" with the failing output in the body, merge it the same way, pull main, and return outcome \"reverted\" with revertPrUrl and the failure tail. Never push to main directly.\n7. Otherwise return outcome \"merged\" with mergeSha, mainSha and checkOnMainExitCode 0.\nFinally remove the task worktree: cd /tmp/sim && git worktree remove --force /tmp/sim-wt/9.1 && git worktree prune && git branch -D feat/9.1 (ignore errors). Leave /tmp/sim on main. Do not edit source files.";
const V2_MERGER_LOCAL = "You are the merger for the Sim repository. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nMerge PR #7 (u, branch feat/9.1, worktree /tmp/sim-wt/9.1) for task 9.1: T. The critic returned MERGE at PR head abc. You hold the merge lock: no other merge is running.\nSteps:\n1. cd /tmp/sim && git pull --ff-only (the checkout is on main). Check whether main has moved past the branch: git merge-base --is-ancestor main feat/9.1. If it has NOT moved, skip to step 3.\n2. If main moved: cd into the worktree, git pull --ff-only, then git merge main (no rebase; force pushes are denied). Resolve conflicts only in ratchet.json by taking the higher value. Any other conflict: stop, report it in the PR body, and return outcome \"failed\" with the file list. Commit the merge with the message \"Sync branch with upstream before merge\" plus the trailer line (do not name the default branch in the commit command; the hook blocks it), push with a plain git push, then wait for CI: gh pr checks 7 --watch --fail-fast (up to 15 minutes).\n3. Confirm CI is green: gh pr checks 7. If not green, outcome \"failed\" with details; do not merge.\n4. gh pr merge 7 --merge --delete-branch. If GitHub refuses, outcome \"failed\" with the exact message. (Exit code 1 only because the local branch is checked out in a worktree is fine; confirm with gh pr view --json state.)\n5. cd /tmp/sim && git pull --ff-only; record the merge sha (git rev-parse HEAD). Run SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm ci && SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm run check once in /tmp/sim; record the exit code and the last 40 lines. If check rewrote ratchet.json on main, run git checkout -- ratchet.json.\n6. If the check on main is red: git worktree add /tmp/sim-wt/revert-9.1 -b revert/9.1 main, git revert -m 1 <mergeSha> there, push, open a PR titled \"Revert 9.1: T (check red on main)\" with the failing output in the body, merge it the same way, pull main, and return outcome \"reverted\" with revertPrUrl and the failure tail. Never push to main directly.\n7. Otherwise return outcome \"merged\" with mergeSha, mainSha and checkOnMainExitCode 0.\nFinally remove the task worktree: cd /tmp/sim && git worktree remove --force /tmp/sim-wt/9.1 && git worktree prune && git branch -D feat/9.1 (ignore errors). Leave /tmp/sim on main. Do not edit source files.";

describe('relay timeouts: chunked CI wait and the foreground-timeout prompt', () => {
  it('the CI wait is chunks of --timeout-min 1.5; pending re-calls until green', async () => {
    const { out, calls, prompts, escalations } = await runWave({ ...happy, 'ci:9.1 r1': ciOf('pending'), 'ci:9.1 r1 c2': ciOf('pending'), 'ci:9.1 r1 c3': green });
    expect(calls.filter((c) => c.startsWith('ci:'))).toEqual(['ci:9.1 r1', 'ci:9.1 r1 c2', 'ci:9.1 r1 c3']);
    for (const l of ['ci:9.1 r1', 'ci:9.1 r1 c2', 'ci:9.1 r1 c3']) expect(prompts[l][0]).toContain('wait-ci.js 7 --repo /tmp/sim --timeout-min 1.5');
    expect(out.gate).toBe('PASS');
    expect(escalations).toEqual([]);
    expect(out.tasks['9.1'].rounds[0]).toMatchObject({ ci: 'green' });
  });

  it('the 9 minute budget is 6 chunks of 1.5; still pending then is the pending-CI timeout', async () => {
    const { calls, escalations } = await runWave({ ...happy, ...pendingChunks('ci:9.1 r1', 7) });
    expect(calls.filter((c) => c.startsWith('ci:'))).toEqual(chunkLabels('ci:9.1 r1', 6));
    expect(escalations[0].what).toMatch(/pending-CI timeout/);
  });

  it('a red chunk stops the wait; a blocked chunk escalates without more chunks', async () => {
    const red = await runWave({ ...happy, 'ci:9.1 r1': ciOf('pending'), 'ci:9.1 r1 c2': ciOf('red', { failing: ['check'] }), 'worker:9.1 fix1': fixed1, 'ci:9.1 r2': green, 'critic:9.1 r2': criticMerge, 'critic:9.1 r1': criticMerge });
    expect(red.calls.filter((c) => c.startsWith('ci:9.1 r1'))).toEqual(['ci:9.1 r1', 'ci:9.1 r1 c2']);
    const b = await runWave({ ...happy, 'ci:9.1 r1': ciOf('pending'), 'ci:9.1 r1 c2': blocked() });
    expect(b.calls.filter((c) => c.startsWith('ci:'))).toEqual(['ci:9.1 r1', 'ci:9.1 r1 c2']);
    expect(b.escalations[0].what).toMatch(/CI relay blocked/);
  });

  it('a missing from a chunk shorter than the 2 minute window is not final', async () => {
    const { calls, escalations } = await runWave({ ...happy, 'ci:9.1 r1': ciOf('missing'), 'ci:9.1 r1 c2': green });
    expect(calls.filter((c) => c.startsWith('ci:'))).toEqual(['ci:9.1 r1', 'ci:9.1 r1 c2']);
    expect(escalations).toEqual([]);
  });

  it('a chunk with no JSON line is retried once with the same chunk number', async () => {
    const bad = { status: 'ran', exitCode: 0, stdout: 'nope' };
    const { calls } = await runWave({ ...happy, 'ci:9.1 r1': ciOf('pending'), 'ci:9.1 r1 c2': bad, 'ci:9.1 r1 c2 retry': green });
    expect(calls.filter((c) => c.startsWith('ci:'))).toEqual(['ci:9.1 r1', 'ci:9.1 r1 c2', 'ci:9.1 r1 c2 retry']);
  });

  it('prompt snapshot: the preflight, CI and merge relay prompts all open with the timeout=600000 rule and the moved-to-background recovery', async () => {
    const { prompts } = await runWave(happy);
    for (const label of ['preflight:merge', 'ci:9.1 r1', 'merger:9.1']) {
      const p = prompts[label][0];
      expect(p, label).toContain('FIRST RULE: the Bash tool call that runs the command MUST include the parameter timeout=600000');
      expect(p, label).toContain('moved to the background after 120 seconds and the task fails');
      expect(p, label).toContain('If you see "moved to the background" anyway: do not end your turn and do not run the command again.');
      expect(p, label).toContain('Read the output file the tool reported with the Read tool');
      expect(p, label).toContain('at most 30 reads');
      expect(p.indexOf('timeout=600000'), label).toBeLessThan(p.indexOf('Run exactly this command'));
    }
  });
});
