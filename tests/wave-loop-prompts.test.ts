import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Task 4.2: prompt snapshot tests. The wave-loop script runs with stubbed agents that record every prompt by label,
// so the tests assert on the exact text each role is given. No network, no real agent.
const root = join(import.meta.dirname, '..');
// The stubbed dry run reports the version of the loop under test (package.json), so a version bump needs no edit here.
const VERSION: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
// Task 2.1: the project uses the merger agent here and the CI relay answers green by default; the critic prompt has no
// CI instructions (item 5 is supplied by the workflow). Relay prompts are covered in tests/wave-loop-relay.test.ts.
const source = readFileSync(join(root, 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Result = Record<string, unknown>;

async function runWave(answers: Record<string, Result>, projectExtra: Record<string, unknown> = {}) {
  const prompts: Record<string, string> = {};
  const agent = async (prompt: string, opts: { label: string }) => {
    prompts[opts.label] = prompt;
    await new Promise((r) => setTimeout(r, 0)); // agents take time: the CI relay and the critic settle in start order
    if (opts.label.startsWith('ci:') && !(opts.label in answers)) return greenCi;
    return answers[opts.label] ?? null;
  };
  const args = {
    project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 'docs/spec.md', maxBuilders: 2, maxChains: 2, mainCi: 'check', syncPolicy: 'conflict', merger: 'agent', ...projectExtra },
    wave: '9',
    tasks: [{ id: '9.1', title: 'T', branch: 'feat/9.1', deps: [], text: 'x', owns: 'y', notes: '' }],
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
  return { out, prompts };
}

const base = { branch: 'feat/9.1', worktree: '/tmp/sim-wt/9.1', filesChanged: ['a'], checkCommand: 'c', decisions: [], questions: [] };
const opened = { ...base, status: 'opened', checkExitCode: 0, prNumber: 7, prUrl: 'u' };
const unfinished = { ...base, status: 'opened', checkExitCode: -1, prNumber: 7, prUrl: 'u' };
const greenCi = { status: 'ran', exitCode: 0, stdout: `${JSON.stringify({ state: 'green', failing: [], logTail: '', polls: 1, elapsedMs: 1000 })}\n` };
const merge = { verdict: 'MERGE', prHeadSha: 'abc', checklist: [], fixItems: [], notes: '' };
const fix = { ...merge, verdict: 'FIX', fixItems: [{ n: 1, what: 'x', provedBy: 'y', cause: 'defect' }] };
const merged = { outcome: 'merged', details: 'ok', mergeSha: 'm', mainSha: 'm', checkOnMainExitCode: 0 };

// One run that exercises every worker prompt (build, fix, finish) and the critic prompt.
const allRoles = {
  'worker:9.1': unfinished,
  'worker:9.1 finish1': opened,
  'critic:9.1 r1': fix,
  'worker:9.1 fix1': opened,
  'critic:9.1 r2': merge,
  'merger:9.1': merged,
};

const HEADER_SENTENCE = `READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md`;
const DECISION_FORMAT = 'id | choice | reason | reversible';

describe('4.2 worker prompts', () => {
  it('every worker prompt carries the three spec headers, the Decisions format and the escalation rule', async () => {
    const { prompts } = await runWave(allRoles);
    for (const label of ['worker:9.1', 'worker:9.1 finish1', 'worker:9.1 fix1']) {
      const p = prompts[label];
      expect(p, label).toBeTruthy();
      expect(p, label).toContain(HEADER_SENTENCE);
      expect(p, label).toContain('before starting');
      expect(p, label).toContain('Decisions:');
      expect(p, label).toContain(DECISION_FORMAT);
      expect(p, label).toMatch(/inside the (decision )?envelope, decide/i);
      expect(p, label).toMatch(/outside it, stop and ask/i);
      expect(p, label).toMatch(/read-only research or spike subagents?/i);
      expect(p, label).toMatch(/name the envelope rule/i);
      expect(p, label).toMatch(/not decided a third time/i);
      expect(p, label).toMatch(/failed twice/i);
      expect(p, label).not.toMatch(/only if two readings/i);
      expect(p, label).not.toMatch(/only for a genuine ambiguity/i);
    }
  });

  it('names every human-only category in the escalation rule so a stop cites one rule', async () => {
    const { prompts } = await runWave(allRoles);
    const p = prompts['worker:9.1'];
    for (const rule of ['reversible', 'cost', 'invariant', 'fixed decision', 'human-only']) {
      expect(p.toLowerCase(), rule).toContain(rule);
    }
  });

  it('keeps the v1 prompt text: a spec without the header sections still works', async () => {
    const { prompts, out } = await runWave(allRoles);
    const p = prompts['worker:9.1'];
    expect(p).toContain('if present');
    expect(p).toContain('Where the spec leaves a detail open, take the conventional default');
    expect(p).toContain('a "Decisions" list for every default you took');
    expect(out.gate).toBe('PASS');
  });

  it('tells the worker the Decisions block is written to the PR body as one line per decision', async () => {
    const { prompts } = await runWave(allRoles);
    const p = prompts['worker:9.1'];
    expect(p).toMatch(/PR body under `?Decisions:`?/);
    expect(p).toMatch(/one line per decision/i);
    expect(p).toMatch(/decisions.*(structured result|result)/i);
  });
});

describe('4.2 critic checklist', () => {
  function items(prompt: string): string[] {
    return prompt.split('\n').filter((l) => /^\d+\. /.test(l));
  }

  it('has 9 items in order, item 8 checks the PR Decisions against the envelope and item 9 is security', async () => {
    const { prompts } = await runWave(allRoles);
    const list = items(prompts['critic:9.1 r1']);
    expect(list.map((l) => Number(l.split('.')[0]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(list[0]).toMatch(/acceptance test/i);
    expect(list[1]).toMatch(/owned paths/i);
    expect(list[2]).toMatch(/network or a paid API/i);
    expect(list[3]).toMatch(/street address/i);
    expect(list[4]).toMatch(/CI result supplied by the workflow; n\/a/i);
    expect(list[5]).toMatch(/acceptance criteria/i);
    expect(list[6]).toMatch(/criticChecks|critic checks|project's own/i);
    expect(list[7]).toContain('Decisions:');
    expect(list[7]).toMatch(/inside the (decision )?envelope/i);
    expect(list[7]).toMatch(/FIX/);
    expect(list[8]).toMatch(/^9\. Security, when the task's owned paths or its diff touch the network, a database, environment variables, auth or secrets/);
    for (const rule of [/TLS on every connection/, /least-privilege roles/, /no secret in a log line, error message or URL/, /SQL is parameterized/, /allowlist is checked before any fetch/, /FIX item/, /n\/a when the task touches none/]) {
      expect(list[8]).toMatch(rule);
    }
  });

  it('still has 9 items when the project adds critic checks, which stay under item 7 in order', async () => {
    const { prompts } = await runWave(allRoles, { criticChecks: ['Evidence rule holds.', 'Ledger is reserved.'] });
    const prompt = prompts['critic:9.1 r1'];
    expect(items(prompt)).toHaveLength(9);
    expect(prompt.indexOf('Evidence rule holds.')).toBeGreaterThan(prompt.indexOf('7. '));
    expect(prompt.indexOf('Evidence rule holds.')).toBeLessThan(prompt.indexOf('Ledger is reserved.'));
    expect(prompt.indexOf('Ledger is reserved.')).toBeLessThan(prompt.indexOf('8. '));
  });
});

describe('2.1 critic prompt and schema', () => {
  it('has no CI instructions and no ciState field in the result schema', async () => {
    const { prompts } = await runWave(allRoles);
    const p = prompts['critic:9.1 r1'];
    expect(p).not.toMatch(/--watch/);
    expect(p).not.toMatch(/gh pr checks/);
    expect(p).not.toMatch(/pending or missing/i);
    expect(p).not.toMatch(/CI is green/);
    expect(p).toMatch(/the workflow waits for CI itself/);
  });

  it('passes a critic schema without ciState', async () => {
    const schemas: Record<string, any> = {};
    const agent = async (_p: string, o: { label: string; schema?: any }) => {
      schemas[o.label] = o.schema;
      if (o.label.startsWith('ci:')) return greenCi;
      return allRoles[o.label as keyof typeof allRoles] ?? null;
    };
    await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)(agent, async () => [], async () => [], () => {}, () => {}, {
      project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 'docs/spec.md', mainCi: 'check', syncPolicy: 'conflict', merger: 'agent' },
      wave: '9',
      tasks: [{ id: '9.1', title: 'T', branch: 'feat/9.1', deps: [], text: 'x', owns: 'y', notes: '' }],
      tail: null,
    });
    const s = schemas['critic:9.1 r1'];
    expect(Object.keys(s.properties)).not.toContain('ciState');
    expect(s.required).not.toContain('ciState');
  });
});

describe('4.2 agent files', () => {
  function frontMatter(file: string): Record<string, string> {
    const text = readFileSync(join(root, 'claude', 'agents', file), 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    expect(m, file).toBeTruthy();
    return Object.fromEntries(
      m![1].split('\n').map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
    );
  }
  const body = (file: string) => readFileSync(join(root, 'claude', 'agents', file), 'utf8');

  it('producer and merger still carry their tool lists', () => {
    expect(frontMatter('producer.md').tools).toBe('Read, Write, Edit, Bash, Glob, Grep');
    expect(frontMatter('merger.md').tools).toBe('Read, Bash, Glob, Grep');
    expect(frontMatter('critic.md').tools).toBe('Read, Bash, Glob, Grep');
  });

  it('critic.md has 9 numbered items in order, item 8 about Decisions and item 9 about security', () => {
    const nums = body('critic.md')
      .split('\n')
      .filter((l) => /^\d+\. /.test(l));
    expect(nums.map((l) => Number(l.split('.')[0]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(nums[7]).toContain('Decisions:');
    expect(nums[7]).toMatch(/FIX/);
    expect(nums[8]).toMatch(/^9\. Security/);
    expect(nums[8]).toMatch(/TLS on every connection/);
    expect(nums[8]).toMatch(/SQL is parameterized/);
  });

  it('critic.md names the critic model the workflow uses (Fable) and asks for findings', () => {
    expect(frontMatter('critic.md').model).toBe('fable');
    const c = body('critic.md');
    expect(c).toMatch(/`findings`/);
    expect(c).toMatch(/every high finding is also a FIX item/);
    expect(c).toMatch(/positive control/);
  });

  it('critic.md has no CI wait, no pending-means-FIX sentence, and item 5 is supplied by the workflow', () => {
    const c = body('critic.md');
    const nums = c.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(nums[4]).toMatch(/CI result supplied by the workflow; n\/a/);
    expect(c).not.toMatch(/--watch/);
    expect(c).not.toMatch(/CI is green/);
    expect(c).not.toMatch(/pending or missing/i);
    expect(c).not.toMatch(/ciState/);
  });

  it('producer.md carries the autonomy rule and the Decisions format', () => {
    const p = body('producer.md');
    expect(p).toContain(DECISION_FORMAT);
    expect(p).toContain('Decisions:');
    expect(p).toMatch(/outside it, stop and ask/i);
    expect(p).toMatch(/read-only research or spike subagents?/i);
    expect(p).toMatch(/name the envelope rule/i);
    expect(p).toMatch(/not decided a third time/i);
    expect(p).toMatch(/failed twice/i);
    expect(p).toContain(`'End goal', 'Budget' and 'Decision envelope'`);
  });
});

// Task 2.2: project.quickCheck. One cycle exercises the build, finish, fix and reopen prompts: the first worker returns
// before its check finished, the critic asks for one fix, and the merge reverts once so the task reopens.
const QUICK = 'npx vitest related --run {files} && npm run typecheck';
const cycleAnswers = (over: Record<string, Result> = {}): Record<string, Result> => ({
  'worker:9.1': unfinished,
  'worker:9.1 finish1': opened,
  'critic:9.1 r1': fix,
  'worker:9.1 fix1': opened,
  'critic:9.1 r2': merge,
  'merger:9.1': { outcome: 'reverted', details: 'red', mergeSha: 'm', mainSha: 'm', checkOnMainExitCode: 1, checkOnMainTail: 'boom', revertPrUrl: 'rv' },
  'worker:9.1 reopen': opened,
  'critic:9.1 reopen': merge,
  'merger:9.1 reopen': merged,
  ...over,
});
const fixWithNotes = { ...fix, notes: 'n' };
async function runCycle(projectExtra: Record<string, unknown> = {}, over: Record<string, Result> = {}) {
  return runWave(cycleAnswers({ 'critic:9.1 r1': fixWithNotes, ...over }), projectExtra);
}
const CYCLE_LABELS = ['worker:9.1', 'worker:9.1 finish1', 'worker:9.1 fix1', 'worker:9.1 reopen'];

describe('2.2 prompts without quickCheck equal v2', () => {
  it('the worker, finish, fix and reopen prompts equal the stored v2 snapshots', async () => {
    const { prompts, out } = await runCycle();
    expect(out.tasks['9.1'].reopened).toBe(true);
    expect(prompts['worker:9.1']).toBe(V2_WORKER);
    expect(prompts['worker:9.1 finish1']).toBe(V2_FINISH);
    expect(prompts['worker:9.1 fix1']).toBe(V2_FIX);
    expect(prompts['worker:9.1 reopen']).toBe(V2_REOPEN);
  });

  it('an empty quickCheck string is the same as none', async () => {
    const { prompts } = await runCycle({ quickCheck: '  ' });
    expect(prompts['worker:9.1']).toBe(V2_WORKER);
    expect(prompts['worker:9.1 reopen']).toBe(V2_REOPEN);
  });

  it('no v2 prompt mentions quickCheck, localCheckMs or {files}', () => {
    for (const p of [V2_WORKER, V2_FINISH, V2_FIX, V2_REOPEN]) expect(p).not.toMatch(/quick|localCheckMs|\{files\}/i);
  });
});

describe('2.2 prompts with quickCheck', () => {
  it('every worker prompt gives the quick check, with {files}, through the slot wrapper, no full local check and the CI rule', async () => {
    const { prompts } = await runCycle({ quickCheck: QUICK });
    for (const label of CYCLE_LABELS) {
      const p = prompts[label];
      expect(p, label).toContain(QUICK);
      expect(p, label).toMatch(/\{files\}.*(replace|files you changed)/s);
      // Loop perf change 1: the quick check's tests count against the machine-wide check slots.
      expect(p, label).toContain("SLOT_MAX=2 /tmp/sim/.claude/slot.sh sh -c '<the quick check, files filled in>'");
      expect(p, label).not.toMatch(/no slot wait/i);
      expect(p, label).not.toMatch(/do not run it through the slot wrapper/);
      expect(p, label).not.toContain('.claude/slot.sh npm run check');
      expect(p, label).toMatch(/CI (runs|satisfies)/);
      expect(p, label).toMatch(/a change is done when `npm run check` exits 0/);
      expect(p, label).toContain('localCheckMs');
      expect(p, label).toContain('date +%s');
      expect(p, label).toMatch(/checkCommand.*quick check/is);
      expect(p, label).toMatch(/checkExitCode/);
    }
  });

  it('the four prompts equal the stored quickCheck snapshots', async () => {
    const { prompts } = await runCycle({ quickCheck: QUICK });
    expect(prompts['worker:9.1']).toBe(QUICK_WORKER);
    expect(prompts['worker:9.1 finish1']).toBe(QUICK_FINISH);
    expect(prompts['worker:9.1 fix1']).toBe(QUICK_FIX);
    expect(prompts['worker:9.1 reopen']).toBe(QUICK_REOPEN);
  });

  it('the build and finish prompts still install through the slot wrapper', async () => {
    const { prompts } = await runCycle({ quickCheck: QUICK });
    expect(prompts['worker:9.1']).toContain('/tmp/sim/.claude/slot.sh npm ci');
  });

  it('keeps the autonomy rules and the unfinished-check rule', async () => {
    const { prompts } = await runCycle({ quickCheck: QUICK });
    for (const label of CYCLE_LABELS) {
      expect(prompts[label], label).toContain(DECISION_FORMAT);
      expect(prompts[label], label).toContain(HEADER_SENTENCE);
    }
    expect(prompts['worker:9.1']).toContain('set checkExitCode to -1');
  });

  it('only the check lines differ: the rest of each prompt is the v2 text', async () => {
    const { prompts } = await runCycle({ quickCheck: QUICK });
    const lines = (s: string) => s.split('\n');
    for (const [label, v2] of [['worker:9.1', V2_WORKER], ['worker:9.1 finish1', V2_FINISH], ['worker:9.1 fix1', V2_FIX], ['worker:9.1 reopen', V2_REOPEN]] as const) {
      const same = lines(v2).filter((l) => lines(prompts[label]).includes(l)).length;
      expect(same, label).toBeGreaterThanOrEqual(lines(v2).length - 3);
    }
  });

  it('the resume prompt uses the quick check too', async () => {
    const prompts: Record<string, string> = {};
    const agent = async (p: string, o: { label: string }) => {
      prompts[o.label] = p;
      if (o.label.startsWith('ci:')) return greenCi;
      return { 'worker:9.1 resume': opened, 'critic:9.1 r1': merge, 'merger:9.1': merged }[o.label] ?? null;
    };
    await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)(agent, async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())), async () => [], () => {}, () => {}, {
      project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 'docs/spec.md', mainCi: 'check', syncPolicy: 'conflict', merger: 'agent', quickCheck: QUICK },
      wave: '9',
      tasks: [{ id: '9.1', title: 'T', branch: 'feat/9.1', deps: [], text: 'x', owns: 'y', notes: '', resume: { prNumber: 7, prUrl: 'u', worktree: '/tmp/sim-wt/9.1', items: ['finish it'], notes: 'n' } }],
      tail: null,
    });
    expect(prompts['worker:9.1 resume']).toContain(QUICK);
    expect(prompts['worker:9.1 resume']).not.toContain('.claude/slot.sh npm run check');
  });
});

// Loop perf changes 2 and 5 (3 Nov 2026).
describe('edits outside owned files', () => {
  it('every worker prompt follows the project rule, lists such edits in the PR body, and keeps the escalation path', async () => {
    const { prompts } = await runCycle({ quickCheck: QUICK });
    for (const label of CYCLE_LABELS) {
      const p = prompts[label];
      expect(p, label).toContain("follow the project's own rule");
      expect(p, label).toContain('"Edits outside owned files" in the PR body');
      expect(p, label).toMatch(/no assertion removed or weakened/);
      expect(p, label).toMatch(/instead of stopping/);
      expect(p, label).toMatch(/ownership question: do not edit it; stop \(status blocked\)/);
    }
  });

  it('critic item 2 checks the listed edits: mechanical, within the limit, no weakened assertion; anything else fails', async () => {
    const { prompts } = await runWave(allRoles);
    const item2 = prompts['critic:9.1 r1'].split('\n').find((l) => l.startsWith('2. '))!;
    expect(item2).toMatch(/owned paths/);
    expect(item2).toContain('"Edits outside owned files"');
    expect(item2).toMatch(/mechanical/);
    expect(item2).toMatch(/within the project's limit/);
    expect(item2).toMatch(/removes or weakens no assertion/);
    expect(item2).toMatch(/any other changed file outside the owned paths, fails this item/);
  });

  it('critic.md and producer.md say the same', () => {
    const critic = readFileSync(join(root, 'claude', 'agents', 'critic.md'), 'utf8');
    const producer = readFileSync(join(root, 'claude', 'agents', 'producer.md'), 'utf8');
    expect(critic).toContain('Edits outside owned files');
    expect(critic).toMatch(/weaken no assertion/);
    expect(producer).toContain('Edits outside owned files');
    expect(producer).toMatch(/slot wrapper/);
  });
});

describe('readFirst sections', () => {
  it('plain entries are read as written, so a project without sections sees the same text', async () => {
    const { prompts } = await runWave(allRoles, { readFirst: ['CLAUDE.md', 'docs/spec.md section "Fixed decisions"'] });
    expect(prompts['worker:9.1']).toContain('Read first: CLAUDE.md; docs/spec.md section "Fixed decisions"; then the wave 9 section');
  });

  it('an entry that names sections is read only there plus the task sections, in every role', async () => {
    const { prompts } = await runWave(allRoles, { readFirst: ['CLAUDE.md', 'CONTRACT.md#Owner map', { path: 'docs/ref.md', sections: ['Schema', 'Enums'] }] });
    for (const label of ['worker:9.1', 'worker:9.1 fix1', 'critic:9.1 r1', 'merger:9.1']) {
      const p = prompts[label];
      expect(p, label).toContain(`Read first: CLAUDE.md; CONTRACT.md (only the sections "Owner map" and the sections your task names; find them with grep -n '^#' CONTRACT.md and read just those line ranges, never the whole file); docs/ref.md (only the sections "Schema", "Enums" and the sections your task names;`);
    }
  });
});

describe('2.2 localCheckMs', () => {
  it('the worker schema has an optional integer localCheckMs', async () => {
    const schemas: Record<string, any> = {};
    const agent = async (_p: string, o: { label: string; schema?: any }) => {
      schemas[o.label] = o.schema;
      if (o.label.startsWith('ci:')) return greenCi;
      return allRoles[o.label as keyof typeof allRoles] ?? null;
    };
    await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)(agent, async () => [], async () => [], () => {}, () => {}, {
      project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 'docs/spec.md', mainCi: 'check', syncPolicy: 'conflict', merger: 'agent' },
      wave: '9',
      tasks: [{ id: '9.1', title: 'T', branch: 'feat/9.1', deps: [], text: 'x', owns: 'y', notes: '' }],
      tail: null,
    });
    const s = schemas['worker:9.1'];
    expect(s.properties.localCheckMs).toEqual({ type: 'integer' });
    expect(s.required).not.toContain('localCheckMs');
  });

  it('is copied into timings[taskId], summed over the worker rounds, and slotWaitMs has no source', async () => {
    const { out } = await runCycle({ quickCheck: QUICK }, {
      'worker:9.1': { ...unfinished, localCheckMs: 100 },
      'worker:9.1 finish1': { ...opened, localCheckMs: 2000 },
      'worker:9.1 fix1': { ...opened, localCheckMs: 300 },
      'worker:9.1 reopen': { ...opened, localCheckMs: 4000 },
    });
    expect(out.timings['9.1'].localCheckMs).toBe(100 + 2000 + 300 + 4000);
    expect(out.timings['9.1']).not.toHaveProperty('slotWaitMs');
  });

  it('is absent when no worker reports it, and a non-integer or negative value is ignored', async () => {
    const none = await runCycle();
    expect(none.out.timings['9.1']).not.toHaveProperty('localCheckMs');
    const bad = await runCycle({}, { 'worker:9.1 finish1': { ...opened, localCheckMs: -5 }, 'worker:9.1 fix1': { ...opened, localCheckMs: 'x' } });
    expect(bad.out.timings['9.1']).not.toHaveProperty('localCheckMs');
  });
});

describe('2.2 producer.md', () => {
  it('step 3 uses the quick check when the task prompt gives one, times it and reports localCheckMs', () => {
    const p = readFileSync(join(root, 'claude', 'agents', 'producer.md'), 'utf8');
    expect(p).toMatch(/quick check/i);
    expect(p).toContain('localCheckMs');
    expect(p).toContain('date +%s');
    expect(p).toMatch(/CI (runs|satisfies)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 2.2 (v2.4): the impact relay before the worker, the test-edits relay and gate before each critic round, relays
// that run their command alone, and the completeness check of the critic's checklist.
// ---------------------------------------------------------------------------------------------------------------------
type Opts22 = { label: string; model?: string; effort?: string };
type Answer22 = unknown | ((opts: Opts22, prompt: string) => unknown | Promise<unknown>);
type Json22 = Record<string, any>;

const IMPACT_OWNS = '`src/a.ts`, `tests/a.test.ts`';
const IMPACT_COMMAND = 'node /tmp/sim/.claude/scripts/impact.js --repo /tmp/sim --owns src/a.ts tests/a.test.ts --spec /tmp/sim/docs/spec.md';
const TE_COMMAND = (n = 7) => `node /tmp/sim/.claude/scripts/test-edits.js ${n} --repo /tmp/sim`;
const relayRan = (line: unknown, exitCode = 0) => ({ status: 'ran', exitCode, stdout: `${JSON.stringify(line)}\n` });
const relayBlocked = { status: 'blocked', note: 'Permission to run this command was denied.' };
const probeOk22 = { status: 'ran', exitCode: 0, stdout: '' };
const taskOf = (extra: Json22 = {}) => ({ id: '9.1', title: 'T', branch: 'feat/9.1', deps: [], text: 'x', owns: IMPACT_OWNS, notes: '', ...extra });
const FULL_CHECKLIST = Array.from({ length: 9 }, (_, i) => ({ item: i + 1, pass: true, evidence: `evidence ${i + 1}` }));
const without = (...missing: number[]) => FULL_CHECKLIST.filter((c) => !missing.includes(c.item));
const mergeFull = { ...merge, checklist: FULL_CHECKLIST, findings: [] };
const fixFull = { ...fix, checklist: FULL_CHECKLIST, findings: [] };
const SHA40 = 'ab'.repeat(20);

async function run22(answers: Record<string, Answer22>, o: { project?: Json22; tasks?: Json22[] } = {}) {
  const calls: string[] = [];
  const prompts: Record<string, string[]> = {};
  const optsSeen: Opts22[] = [];
  const logs: string[] = [];
  const agent = async (prompt: string, opts: Opts22) => {
    calls.push(opts.label);
    optsSeen.push(opts);
    (prompts[opts.label] ||= []).push(prompt);
    await new Promise((r) => setTimeout(r, 0));
    if (opts.label.startsWith('ci:') && !(opts.label in answers)) return greenCi;
    const a = answers[opts.label];
    const v = typeof a === 'function' ? await (a as (x: Opts22, p: string) => unknown)(opts, prompt) : a;
    return v === undefined ? null : v;
  };
  const args = {
    project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 'docs/spec.md', maxBuilders: 2, maxChains: 2, mainCi: 'check', syncPolicy: 'conflict', merger: 'agent', ...(o.project || {}) },
    wave: '9',
    tasks: o.tasks ?? [taskOf()],
    tail: null,
  };
  const out = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)(
    agent,
    async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
    async () => [],
    () => {},
    (line: string) => logs.push(String(line)),
    args,
  );
  return { out, calls, prompts, optsSeen, logs, rounds: (out.tasks?.['9.1']?.rounds ?? []) as Json22[] };
}

const seq22 = (...items: unknown[]) => {
  let i = 0;
  return () => items[Math.min(i++, items.length - 1)];
};
const teReport = (over: Json22 = {}) => ({ testFirstCommit: 'abc1234', files: [], assertionsRemoved: 0, assertionsChanged: 0, bodySection: false, note: null, ...over });
const changedReport = (over: Json22 = {}) =>
  teReport({
    files: [{ path: 'tests/a.test.ts', removed: [], changed: [{ before: 'expect(x).toBe(3)', after: 'expect(x).toBeGreaterThan(0)' }] }],
    assertionsChanged: 1,
    ...over,
  });
const happy22: Record<string, Answer22> = { 'worker:9.1': opened, 'critic:9.1 r1': mergeFull, 'merger:9.1': merged };

describe('2.2 (a) the impact relay before the worker', () => {
  const testsLine = {
    tests: [
      { path: 'tests/a.test.ts', via: null, owner: '9.2' },
      { path: 'tests/b.test.ts', via: 'src/mid.ts', owner: null },
      { path: 'tests/c.test.ts', via: 'name', owner: '9.1' },
    ],
  };

  it('runs impact.js once, alone, for the owned paths with --spec, before the worker starts', async () => {
    const { calls, prompts, optsSeen } = await run22({ ...happy22, 'impact:9.1': relayRan(testsLine) });
    expect(calls.slice(0, 2)).toEqual(['impact:9.1', 'worker:9.1']);
    expect(calls.filter((c) => c.startsWith('impact:'))).toEqual(['impact:9.1']);
    expect(prompts['impact:9.1'][0].split('\n')).toContain(IMPACT_COMMAND);
    expect(optsSeen.find((x) => x.label === 'impact:9.1')?.model).toBe('claude-haiku-5-5');
  });

  it('quotes a path with a glob character, so the shell does not expand it', async () => {
    const { prompts } = await run22({ ...happy22 }, { tasks: [taskOf({ owns: '`src/a.ts`, `tests/fixtures/pool-*.json`' })] });
    expect(prompts['impact:9.1'][0].split('\n')).toContain("node /tmp/sim/.claude/scripts/impact.js --repo /tmp/sim --owns src/a.ts 'tests/fixtures/pool-*.json' --spec /tmp/sim/docs/spec.md");
  });

  it('passes an absolute spec path as it is', async () => {
    const { prompts } = await run22({ ...happy22 }, { project: { spec: '/specs/s.md' } });
    expect(prompts['impact:9.1'][0]).toContain('--owns src/a.ts tests/a.test.ts --spec /specs/s.md');
  });

  it('runs no relay for an Owns text that names no path, and none for a resumed task', async () => {
    const none = await run22({ ...happy22 }, { tasks: [taskOf({ owns: 'y' })] });
    expect(none.calls.some((c) => c.startsWith('impact:'))).toBe(false);
    const resumed = await run22(
      { 'worker:9.1 resume': opened, 'critic:9.1 r1': mergeFull, 'merger:9.1': merged },
      { tasks: [taskOf({ resume: { prNumber: 7, prUrl: 'u', worktree: '/tmp/sim-wt/9.1', items: ['finish it'], notes: 'n' } })] },
    );
    expect(resumed.calls.some((c) => c.startsWith('impact:'))).toBe(false);
  });

  it('the worker prompt lists the tests with how they reach an owned file and their owners, and says to run them and when to stop', async () => {
    const { prompts } = await run22({ ...happy22, 'impact:9.1': relayRan(testsLine) });
    const p = prompts['worker:9.1'][0];
    expect(p).toContain('Existing tests that import or name the files you own');
    expect(p).toContain('- tests/a.test.ts (imports an owned file; owner 9.2)');
    expect(p).toContain('- tests/b.test.ts (through src/mid.ts; owner none)');
    expect(p).toContain('- tests/c.test.ts (names an owned file in a string; owner 9.1)');
    expect(p).toContain('Run these test files before you open the PR.');
    expect(p).toContain('When a change of yours breaks a test that another task owns (an owner other than 9.1 in this list), do not edit it: stop (status: blocked) and ask, naming the test and its owner.');
    expect(p).toContain('the ownership rule above, now with the list');
    // the list comes before the order of work, so the worker reads it first
    expect(p.indexOf('Existing tests that import or name')).toBeLessThan(p.indexOf('Order: (1)'));
  });

  it('a relay that is blocked, returns nothing, prints no JSON, errors or lists no test leaves the prompt as before and logs it', async () => {
    const baseline = await run22({ ...happy22, 'impact:9.1': relayRan({ tests: [] }) });
    const bad: Record<string, Answer22> = {
      blocked: relayBlocked,
      nothing: null,
      'no JSON': { status: 'ran', exitCode: 0, stdout: 'it ran\n' },
      'error line': relayRan({ tests: [], note: 'error: git ls-files failed' }, 1),
    };
    expect(baseline.prompts['worker:9.1'][0]).not.toContain('Existing tests');
    for (const [what, answer] of Object.entries(bad)) {
      const r = await run22({ ...happy22, 'impact:9.1': answer });
      expect(r.prompts['worker:9.1'][0], what).toBe(baseline.prompts['worker:9.1'][0]);
      expect(r.logs.some((l) => /impact/.test(l) && /9\.1/.test(l)), what).toBe(true);
      expect(r.out.gate, what).toBe('PASS');
    }
    expect(baseline.logs.some((l) => /impact/.test(l))).toBe(true);
  });
});

describe('2.2 relays run their command alone', () => {
  it('no relay prompt tells the relay to change directory, and each command is a line of its own with nothing joined to it', async () => {
    const r = await run22({
      ...happy22,
      'impact:9.1': relayRan({ tests: [] }),
      'test-edits:9.1 r1': relayRan(teReport()),
      'delta:9.1 r2': null,
    });
    const relays: Array<[string, string]> = [
      ['impact:9.1', IMPACT_COMMAND],
      ['test-edits:9.1 r1', TE_COMMAND()],
      ['ci:9.1 r1', 'node /tmp/sim/.claude/scripts/wait-ci.js 7 --repo /tmp/sim --timeout-min 1.5'],
    ];
    for (const [label, command] of relays) {
      const p = r.prompts[label][0];
      expect(p, label).not.toMatch(/\bcd\b/);
      expect(p.split('\n'), label).toContain(command);
      expect(command, label).not.toMatch(/&&|;|\|/);
      expect(p, label).toMatch(/alone/);
      expect(p, label).toContain('timeout=600000');
      expect(p, label).toMatch(/permission system denies/);
    }
  });

  it('the probe relay and the merge-script relays are alone too', async () => {
    const probed = await run22({ 'worker:9.1': null, 'probe:worker:9.1': probeOk22 }, { tasks: [taskOf({ owns: 'y' })] });
    expect(probed.prompts['probe:worker:9.1'][0]).not.toMatch(/\bcd\b/);
    expect(probed.prompts['probe:worker:9.1'][0].split('\n')).toContain('true');
    const script = await run22(
      { ...happy22, 'preflight:merge': relayRan({ outcome: 'error', exit: 4, message: 'no pull requests found', loopVersion: VERSION }, 4), 'merger:9.1': relayRan({ outcome: 'merged', exit: 0, mergeSha: 'm', mainSha: 'm', ciState: 'green', failing: [], conflictFiles: [], revertPrUrl: null, message: 'merged', logTail: '', mainCheck: 'green' }) },
      { project: { merger: 'script' } },
    );
    for (const label of ['preflight:merge', 'merger:9.1']) {
      const p = script.prompts[label][0];
      expect(p, label).not.toMatch(/\bcd\b/);
      const commandLine = p.split('\n').find((l) => l.startsWith('node /tmp/sim/.claude/scripts/merge-pr.js'));
      expect(commandLine, label).toBeTruthy();
      expect(commandLine, label).toContain('--repo /tmp/sim');
      expect(commandLine, label).not.toMatch(/&&|;/);
    }
  });
});

describe('2.2 (b) the test-edits relay, its report in the critic prompt and its gate', () => {
  it('runs test-edits.js alone before each critic round, beside the CI relay', async () => {
    const { calls, prompts } = await run22({ ...happy22, 'test-edits:9.1 r1': relayRan(teReport()) });
    expect(calls.indexOf('test-edits:9.1 r1')).toBeGreaterThan(calls.indexOf('ci:9.1 r1'));
    expect(calls.indexOf('test-edits:9.1 r1')).toBeLessThan(calls.indexOf('critic:9.1 r1'));
    expect(calls.filter((c) => c.startsWith('test-edits:'))).toEqual(['test-edits:9.1 r1']);
    expect(prompts['test-edits:9.1 r1'][0].split('\n')).toContain(TE_COMMAND());
  });

  it('the critic prompt carries the report under "Test edits after the test-first commit", and item 3 names the Test edits: section', async () => {
    const report = changedReport({ bodySection: true });
    const { prompts, rounds } = await run22({ ...happy22, 'test-edits:9.1 r1': relayRan(report) });
    const p = prompts['critic:9.1 r1'][0];
    expect(p).toContain('Test edits after the test-first commit');
    expect(p).toContain('"assertionsChanged":1');
    expect(p).toContain('"before":"expect(x).toBe(3)"');
    expect(p).toContain('"bodySection":true');
    expect(p).toMatch(/^3\. .*an assertion removed or changed after the test-first commit is a FIX item unless the PR body's `Test edits:` section justifies each one and the justification holds/m);
    expect(rounds[0].testEdits).toMatchObject({ assertionsChanged: 1, assertionsRemoved: 0, bodySection: true, testFirstCommit: 'abc1234' });
  });

  it('a relay that is blocked, empty or error-exited records "unavailable", tells the critic to run git diff itself, and logs it', async () => {
    const cases: Record<string, Answer22> = {
      blocked: relayBlocked,
      nothing: null,
      'error exit': relayRan({ testFirstCommit: null, files: [], assertionsRemoved: 0, assertionsChanged: 0, bodySection: false, note: 'error: gh pr view failed' }, 1),
    };
    for (const [what, answer] of Object.entries(cases)) {
      const r = await run22({ ...happy22, 'test-edits:9.1 r1': answer });
      expect(r.rounds[0].testEdits, what).toBe('unavailable');
      const p = r.prompts['critic:9.1 r1'][0];
      expect(p, what).toContain('Test edits after the test-first commit');
      expect(p, what).toMatch(/not available/);
      expect(p, what).toMatch(/run git diff over the test files yourself/);
      expect(r.logs.some((l) => /test-edits/.test(l) && /unavailable/.test(l)), what).toBe(true);
      expect(r.out.gate, what).toBe('PASS');
      expect(r.calls.filter((c) => c.startsWith('test-edits:')), what).toEqual(['test-edits:9.1 r1']);
    }
  });

  it('a relay that prints no JSON line is run once more, and the second answer is used', async () => {
    const noJson = { status: 'ran', exitCode: 0, stdout: 'done\n' };
    const ok = await run22({ ...happy22, 'test-edits:9.1 r1': noJson, 'test-edits:9.1 r1 retry': relayRan(teReport({ assertionsRemoved: 2, bodySection: true })) });
    expect(ok.calls.filter((c) => c.startsWith('test-edits:'))).toEqual(['test-edits:9.1 r1', 'test-edits:9.1 r1 retry']);
    expect(ok.rounds[0].testEdits).toMatchObject({ assertionsRemoved: 2, bodySection: true });
    const twice = await run22({ ...happy22, 'test-edits:9.1 r1': noJson, 'test-edits:9.1 r1 retry': noJson });
    expect(twice.calls.filter((c) => c.startsWith('test-edits:'))).toEqual(['test-edits:9.1 r1', 'test-edits:9.1 r1 retry']);
    expect(twice.rounds[0].testEdits).toBe('unavailable');
  });

  it('the gate turns a MERGE into FIX when an assertion changed and the PR body has no Test edits: section', async () => {
    const { out, calls, prompts, rounds } = await run22({
      ...happy22,
      'test-edits:9.1 r1': relayRan(changedReport()),
      'worker:9.1 fix1': opened,
      'critic:9.1 r2': mergeFull,
      'test-edits:9.1 r2': relayRan(changedReport({ bodySection: true })),
    });
    expect(rounds[0].verdict).toBe('FIX');
    expect(rounds[0].fixItems).toHaveLength(1);
    expect(rounds[0].fixItems[0]).toMatchObject({ n: 1, what: 'restore the assertion or justify it under Test edits:', cause: 'defect' });
    expect(rounds[0].fixItems[0].provedBy).toMatch(/test-edits\.js/);
    expect(calls.indexOf('worker:9.1 fix1')).toBeGreaterThan(calls.indexOf('critic:9.1 r1'));
    expect(calls.indexOf('merger:9.1')).toBeGreaterThan(calls.indexOf('critic:9.1 r2'));
    expect(prompts['worker:9.1 fix1'][0]).toContain('restore the assertion or justify it under Test edits:');
    expect(rounds[1]).toMatchObject({ verdict: 'MERGE', ci: 'green' });
    expect(out.gate).toBe('PASS');
  });

  it('the gate counts removed assertions too, and leaves a STOP alone', async () => {
    const removed = await run22({ ...happy22, 'test-edits:9.1 r1': relayRan(teReport({ assertionsRemoved: 2 })), 'worker:9.1 fix1': null, 'probe:worker:9.1 fix1': probeOk22 });
    expect(removed.rounds[0].verdict).toBe('FIX');
    const stop = await run22({ ...happy22, 'critic:9.1 r1': { ...mergeFull, verdict: 'STOP', stopSection: 'Fixed decisions' }, 'test-edits:9.1 r1': relayRan(changedReport()) });
    expect(stop.rounds[0].verdict).toBe('STOP');
    expect(stop.calls).not.toContain('worker:9.1 fix1');
  });

  it('a FIX the critic already returned gets the gate item added once, after its own items', async () => {
    const own = { ...fixFull, fixItems: [{ n: 1, what: 'rename the helper', provedBy: 'the unit test', cause: 'defect' }] };
    const r = await run22({ ...happy22, 'critic:9.1 r1': own, 'test-edits:9.1 r1': relayRan(changedReport()), 'worker:9.1 fix1': null, 'probe:worker:9.1 fix1': probeOk22 });
    expect(r.rounds[0].fixItems.map((i: Json22) => [i.n, i.what])).toEqual([
      [1, 'rename the helper'],
      [2, 'restore the assertion or justify it under Test edits:'],
    ]);
  });

  it('no gate when the counts are zero or the body has the section', async () => {
    for (const report of [teReport(), changedReport({ bodySection: true }), teReport({ assertionsRemoved: 3, bodySection: true })]) {
      const r = await run22({ ...happy22, 'test-edits:9.1 r1': relayRan(report) });
      expect(r.rounds[0].verdict).toBe('MERGE');
      expect(r.out.gate).toBe('PASS');
    }
  });

  it('a round whose critic is skipped as CI-only reuses the report of the round it follows and runs no relay', async () => {
    const report = changedReport({ bodySection: true });
    const { calls, rounds, out } = await run22({
      'worker:9.1': opened,
      'ci:9.1 r1': relayRan({ state: 'red', failing: ['prettier'], logTail: 'style', polls: 1, elapsedMs: 1 }),
      'critic:9.1 r1': { ...mergeFull, prHeadSha: SHA40 },
      'test-edits:9.1 r1': relayRan(report),
      'worker:9.1 fix1': opened,
      'delta:9.1 r2': relayRan({ ciOnly: true, since: SHA40, head: 'cd'.repeat(20), reason: '1 formatting-only commit', commits: 1, files: [] }),
      'merger:9.1': merged,
    });
    expect(calls.filter((c) => c.startsWith('test-edits:'))).toEqual(['test-edits:9.1 r1']);
    expect(calls.filter((c) => c.startsWith('critic:'))).toEqual(['critic:9.1 r1']);
    expect(rounds[1]).toMatchObject({ criticSkipped: 'ci-only', verdict: 'MERGE' });
    expect(rounds[1].testEdits).toEqual(rounds[0].testEdits);
    expect(rounds[1].testEdits).toMatchObject({ assertionsChanged: 1, bodySection: true });
    expect(out.gate).toBe('PASS');
  });

  describe('in the fast lane', () => {
    const FAST = { fastLane: { enabled: true, maxPerWave: 3, testCountCommand: 'npm run -s test-count' } };
    const fastTask = taskOf({ lane: 'fast', owns: 'docs/notes/' });
    const facts = { status: 'ran', changedFiles: ['docs/notes/a.md'], addedText: 'a synthetic added line', decisions: ['D1 | keep the wording | the conventional default | yes'], testCountBeforeOut: '40\n', testCountAfterOut: '41\n' };
    const fastAnswers = (over: Record<string, Answer22> = {}): Record<string, Answer22> => ({ 'worker:9.1': opened, 'facts:9.1 r1': facts, 'critic:9.1 r1': mergeFull, 'merger:9.1': merged, ...over });

    it('a non-zero count with no Test edits: section makes the task not eligible: the critic reviews it, with the report', async () => {
      const { calls, prompts, rounds, logs } = await run22(fastAnswers({ 'test-edits:9.1 r1': relayRan(changedReport()), 'worker:9.1 fix1': null, 'probe:worker:9.1 fix1': probeOk22 }), { project: FAST, tasks: [fastTask] });
      expect(calls).toContain('critic:9.1 r1');
      expect(calls.indexOf('test-edits:9.1 r1')).toBeLessThan(calls.indexOf('critic:9.1 r1'));
      expect(prompts['critic:9.1 r1'][0]).toContain('"assertionsChanged":1');
      expect(rounds[0].lane).toBeUndefined();
      expect(rounds[0].verdict).toBe('FIX');
      expect(logs.some((l) => /not fast lane/.test(l) && /Test edits/.test(l))).toBe(true);
    });

    it('with the section, or with zero counts, the task stays eligible: no critic, and the round records the report', async () => {
      for (const report of [changedReport({ bodySection: true }), teReport()]) {
        const { calls, rounds, out } = await run22(fastAnswers({ 'test-edits:9.1 r1': relayRan(report) }), { project: FAST, tasks: [fastTask] });
        expect(calls.filter((c) => c.startsWith('critic:'))).toEqual([]);
        expect(rounds[0]).toMatchObject({ verdict: 'MERGE', lane: 'fast' });
        expect(rounds[0].testEdits).toMatchObject({ assertionsChanged: report.assertionsChanged });
        expect(out.gate).toBe('PASS');
      }
    });

    it('a red CI runs no test-edits relay; an unavailable report leaves the task eligible', async () => {
      const red = await run22(fastAnswers({ 'ci:9.1 r1': relayRan({ state: 'red', failing: ['check'], logTail: '', polls: 1, elapsedMs: 1 }), 'worker:9.1 fix1': null, 'probe:worker:9.1 fix1': probeOk22 }), { project: FAST, tasks: [fastTask] });
      expect(red.calls.some((c) => c.startsWith('test-edits:'))).toBe(false);
      const unavailable = await run22(fastAnswers({ 'test-edits:9.1 r1': relayBlocked }), { project: FAST, tasks: [fastTask] });
      expect(unavailable.calls.filter((c) => c.startsWith('critic:'))).toEqual([]);
      expect(unavailable.rounds[0].testEdits).toBe('unavailable');
    });
  });
});

describe('2.2 the worker prompt and the agent files describe the Test edits: section', () => {
  it('the worker prompt says what the section is, when it is needed and that the merge is blocked without it', async () => {
    const { prompts } = await run22({ ...happy22 });
    const p = prompts['worker:9.1'][0];
    expect(p).toContain('Test edits: if you remove or change an assertion in a test file after your test-first commit');
    expect(p).toContain('a line that starts with `Test edits:`');
    expect(p).toMatch(/one line per removed or changed assertion/);
    expect(p).toMatch(/blocks the merge/);
    expect(p).toMatch(/leave the section out when you edited no assertion/i);
  });

  it('producer.md and critic.md carry the same rule', () => {
    const producer = readFileSync(join(root, 'claude', 'agents', 'producer.md'), 'utf8');
    expect(producer).toContain('`Test edits:`');
    expect(producer).toMatch(/removes? or changes? an assertion/);
    expect(producer).toMatch(/one line per/);
    const critic = readFileSync(join(root, 'claude', 'agents', 'critic.md'), 'utf8');
    expect(critic).toContain('Test edits after the test-first commit');
    expect(critic).toMatch(/^3\. .*Test edits:/m);
    expect(critic).toMatch(/one entry per checklist item/);
  });
});

describe('2.2 (c) the critic checklist is checked for completeness', () => {
  it('a complete checklist makes one critic call and no checklistEmpty', async () => {
    const { calls, rounds, logs } = await run22({ ...happy22 });
    expect(calls.filter((c) => c.startsWith('critic:'))).toEqual(['critic:9.1 r1']);
    expect(rounds[0]).not.toHaveProperty('checklistEmpty');
    expect(logs.some((l) => /checklist/i.test(l))).toBe(false);
  });

  it('a result missing item 9 gets one more call on the same model naming the item; models.critic is unchanged; the second result is used', async () => {
    const { out, calls, prompts, optsSeen, rounds, logs } = await run22({ ...happy22, 'critic:9.1 r1': seq22({ ...mergeFull, checklist: without(9) }), 'critic:9.1 r1 retry': mergeFull });
    expect(calls.filter((c) => c.startsWith('critic:'))).toEqual(['critic:9.1 r1', 'critic:9.1 r1 retry']);
    const retry = prompts['critic:9.1 r1 retry'][0];
    expect(retry.startsWith(prompts['critic:9.1 r1'][0])).toBe(true);
    expect(retry).toMatch(/no checklist entry for item 9\b/);
    expect(retry).toMatch(/one checklist entry for each of items 1 to 9/);
    const criticOpts = optsSeen.filter((x) => x.label.startsWith('critic:'));
    expect(criticOpts[1].model).toBe(criticOpts[0].model);
    expect(criticOpts[1].effort).toBe(criticOpts[0].effort);
    expect(criticOpts[0].model).toBe('claude-fable-5-1');
    expect(out.models.critic).toEqual({ model: 'claude-fable-5-1', effort: 'high' });
    expect(rounds[0].checklist).toHaveLength(9);
    expect(logs.some((l) => /no entry for item 9/.test(l))).toBe(true);
    expect(out.gate).toBe('PASS');
  });

  it('names every missing number', async () => {
    const { prompts } = await run22({ ...happy22, 'critic:9.1 r1': { ...mergeFull, checklist: without(3, 9) }, 'critic:9.1 r1 retry': mergeFull });
    expect(prompts['critic:9.1 r1 retry'][0]).toMatch(/no checklist entry for items 3, 9\b/);
  });

  it('a second miss is recorded as is and logged, with no third call', async () => {
    const { calls, rounds, logs, out } = await run22({ ...happy22, 'critic:9.1 r1': { ...mergeFull, checklist: without(9) }, 'critic:9.1 r1 retry': { ...mergeFull, checklist: without(8, 9) } }, { project: { integrationGate: 'off' } });
    expect(calls.filter((c) => c.startsWith('critic:'))).toHaveLength(2);
    expect(rounds[0].checklist).toHaveLength(7);
    expect(logs.some((l) => /still no entry for items 8, 9/.test(l))).toBe(true);
    expect(logs.some((l) => l.startsWith('WARNING'))).toBe(false);
    expect(out.gate).toBe('PASS');
  });

  it('the extra call never swaps to the fallback model: a retry that throws or returns nothing keeps the first result', async () => {
    for (const retry of [null, () => { throw new Error('boom'); }]) {
      const { calls, rounds, logs, out } = await run22({ ...happy22, 'critic:9.1 r1': { ...mergeFull, checklist: without(9) }, 'critic:9.1 r1 retry': retry as Answer22 });
      expect(calls.filter((c) => c.startsWith('critic:'))).toEqual(['critic:9.1 r1', 'critic:9.1 r1 retry']);
      expect(rounds[0].checklist).toHaveLength(8);
      expect(out.models.critic).toEqual({ model: 'claude-fable-5-1', effort: 'high' });
      expect(logs.some((l) => /no entry for item 9/.test(l))).toBe(true);
    }
  });

  it('an empty checklist is not retried; the round records checklistEmpty and a note: line is logged, never a WARNING', async () => {
    const { calls, rounds, logs } = await run22({ ...happy22, 'critic:9.1 r1': { ...merge, findings: [] } }, { project: { integrationGate: 'off' } });
    expect(calls.filter((c) => c.startsWith('critic:'))).toEqual(['critic:9.1 r1']);
    expect(rounds[0].checklistEmpty).toBe(true);
    const noteLines = logs.filter((l) => /checklist/i.test(l));
    expect(noteLines).toHaveLength(1);
    expect(noteLines[0].startsWith('note:')).toBe(true);
    expect(logs.some((l) => l.startsWith('WARNING'))).toBe(false);
  });

  it('fast-lane and CI-only rounds are not checked and record no checklistEmpty', async () => {
    const FAST = { fastLane: { enabled: true, maxPerWave: 3, testCountCommand: 'npm run -s test-count' } };
    const facts = { status: 'ran', changedFiles: ['docs/notes/a.md'], addedText: 'a synthetic added line', decisions: ['D1 | keep the wording | the conventional default | yes'], testCountBeforeOut: '40\n', testCountAfterOut: '41\n' };
    const fast = await run22({ 'worker:9.1': opened, 'facts:9.1 r1': facts, 'merger:9.1': merged }, { project: FAST, tasks: [taskOf({ lane: 'fast', owns: 'docs/notes/' })] });
    expect(fast.rounds[0]).toMatchObject({ lane: 'fast' });
    expect(fast.rounds[0]).not.toHaveProperty('checklistEmpty');
    expect(fast.logs.some((l) => /checklist/i.test(l))).toBe(false);

    const ciOnly = await run22({
      'worker:9.1': opened,
      'ci:9.1 r1': relayRan({ state: 'red', failing: ['prettier'], logTail: 'style', polls: 1, elapsedMs: 1 }),
      'critic:9.1 r1': { ...mergeFull, prHeadSha: SHA40 },
      'worker:9.1 fix1': opened,
      'delta:9.1 r2': relayRan({ ciOnly: true, since: SHA40, head: 'cd'.repeat(20), reason: 'formatting', commits: 1, files: [] }),
      'merger:9.1': merged,
    });
    expect(ciOnly.rounds[1]).toMatchObject({ criticSkipped: 'ci-only' });
    expect(ciOnly.rounds[1]).not.toHaveProperty('checklistEmpty');
    expect(ciOnly.calls.filter((c) => c.startsWith('critic:'))).toEqual(['critic:9.1 r1']);
  });

  it('the schema describes the checklist entries: one per item, evidence a quote, a file:line or a command output', async () => {
    const schemas: Record<string, any> = {};
    const agent = async (_p: string, o: { label: string; schema?: any }) => {
      schemas[o.label] = o.schema;
      if (o.label.startsWith('ci:')) return greenCi;
      return allRoles[o.label as keyof typeof allRoles] ?? null;
    };
    await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)(agent, async () => [], async () => [], () => {}, () => {}, {
      project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 'docs/spec.md', mainCi: 'check', syncPolicy: 'conflict', merger: 'agent' },
      wave: '9',
      tasks: [{ id: '9.1', title: 'T', branch: 'feat/9.1', deps: [], text: 'x', owns: 'y', notes: '' }],
      tail: null,
    });
    const items = schemas['critic:9.1 r1'].properties.checklist.items;
    expect(items.required).toEqual(['item', 'pass', 'evidence']);
    expect(items.properties.item.description).toMatch(/checklist number/);
    expect(items.properties.evidence.description).toMatch(/quote from the diff, a file:line or a command output/);
  });
});

// Regenerated for the loop perf fixes (3 Nov 2026): the ownership sentence follows the project's rule on edits outside
// owned files, and the quick check runs through the slot wrapper. Everything else is unchanged.
// The v2 worker, finish, fix and reopen prompts, captured from wave-loop.js on origin/main before task 2.2 for the project in runCycle.
const V2_WORKER = "You are a worker on the Sim repository. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask 9.1: T.\nTask text (verbatim from the spec): x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body.\nTask notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\n\nWorktree: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 -b feat/9.1 origin/main. Then work ONLY inside /tmp/sim-wt/9.1 (cd there; run SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm ci there first). Never run git checkout in /tmp/sim.\nOrder: (1) write the acceptance test exactly as specified and commit it first, confirming it fails for the right reason before the implementation exists; (2) implement; (3) run SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm run check once in the worktree and keep the output (the slot wrapper waits for a free check slot on this machine, so the command can take up to 15 minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy; If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked.); (4) commit in small steps; (5) Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\" -m \"Co-Authored-By: Claude <noreply@anthropic.com>\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. (6) git push -u origin feat/9.1 and open a PR with gh pr create titled \"9.1: T\" whose body lists files changed, the exact test command and its output tail, a \"Decisions\" list for every default you took where the spec left a detail open, and open questions.\nWhere the spec leaves a detail open, take the conventional default and list it under Decisions. Stop (status: blocked) if two readings of the spec would lead to materially different work or if a choice falls outside the envelope; then list the question and still open the PR as a draft with what you have.\nTest edits: if you remove or change an assertion in a test file after your test-first commit, add a line that starts with `Test edits:` to the PR body, then one line per removed or changed assertion (the file, the old and the new assertion, and why the change is right). The critic treats an unjustified removal or change as a FIX item, and the workflow blocks the merge when the PR body has no such line. Leave the section out when you edited no assertion.\nReturn the structured result with worktree set to /tmp/sim-wt/9.1. Leave the branch pushed and the worktree in place; do not merge.";
const V2_FINISH = "You are a worker on the Sim repository finishing task 9.1: T (finish attempt 1 of 2). \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nThe previous worker on this task returned before npm run check had finished, so nothing has been reviewed. Branch feat/9.1, worktree /tmp/sim-wt/9.1; cd there (if the worktree is missing: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1). Your PR: #7 u; if it is a draft, mark it ready with gh pr ready 7 once the check passes.\nIts open questions were: none. Answer each by taking the conventional default and listing it under Decisions, unless two readings of the spec would lead to materially different work.\nSteps: (1) make sure every change is committed; (2) run SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm run check once and wait for it to finish: with the slot wait it can take 15 minutes; use the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output; you may not return while it runs; (3) if it fails, fix the cause inside the files you own and run it again, at most twice; (4) Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\" -m \"Co-Authored-By: Claude <noreply@anthropic.com>\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Push, and if no PR exists open it with gh pr create titled \"9.1: T\", its body listing files changed, the check command and output tail, Decisions and open questions.\nReturn the structured result with the real exit code of the last check. Set status blocked for a genuine ambiguity in the spec or a choice outside the envelope, and for nothing else, never for a slow or unfinished check.";
const V2_FIX = "You are a worker on the Sim repository continuing task 9.1: T, fix round 1 of 3. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nYour PR: #7 u on branch feat/9.1. Your worktree is /tmp/sim-wt/9.1; cd there and git pull --ff-only. If the worktree is missing, recreate it: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1.\nThe critic returned FIX with these numbered items; fix every one and nothing else:\n1. x (proved by: y)\nCritic notes: n\nRun SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm run check once after the fixes (up to 15 minutes including the slot wait; maximum Bash timeout, and if the tool moves it to the background wait for its notification; If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked.), commit in small steps. Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\" -m \"Co-Authored-By: Claude <noreply@anthropic.com>\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.";
const V2_REOPEN = "You are a worker on the Sim repository continuing task 9.1: T, fix round reopen of 3. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nYour PR: #7 u on branch feat/9.1. Your worktree is /tmp/sim-wt/9.1; cd there and git pull --ff-only. If the worktree is missing, recreate it: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1.\nThe critic returned FIX with these numbered items; fix every one and nothing else:\n1. npm run check failed on main after merge: boom (proved by: npm run check on main)\nCritic notes: Main went red after merging PR #7; it was reverted (rv). Reproduce with SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm ci && SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm run check and fix the cause. The original PR is merged and reverted on main; open a NEW PR from a new branch feat/9.1-2 that re-applies your work on top of current main (git fetch; git worktree add /tmp/sim-wt/9.1-2 -b feat/9.1-2 origin/main; git merge feat/9.1), titled \"9.1: T (reopen)\".\nRun SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm run check once after the fixes (up to 15 minutes including the slot wait; maximum Bash timeout, and if the tool moves it to the background wait for its notification; If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked.), commit in small steps. Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\" -m \"Co-Authored-By: Claude <noreply@anthropic.com>\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.";

// The quickCheck prompts for the same cycle with project.quickCheck = QUICK, reviewed by hand when task 2.2 was written.
const QUICK_WORKER = "You are a worker on the Sim repository. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask 9.1: T.\nTask text (verbatim from the spec): x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body.\nTask notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\n\nWorktree: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 -b feat/9.1 origin/main. Then work ONLY inside /tmp/sim-wt/9.1 (cd there; run SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm ci there first). Never run git checkout in /tmp/sim.\nOrder: (1) write the acceptance test exactly as specified and commit it first, confirming it fails for the right reason before the implementation exists; (2) implement; (3) run the quick check once in the worktree and keep the output. The quick check is: npx vitest related --run {files} && npm run typecheck ({files} is replaced by you with the files you changed, space separated, relative to the worktree). Run it in the worktree through the machine-wide slot wrapper, so its tests count against the check slots every session on this machine shares: SLOT_MAX=2 /tmp/sim/.claude/slot.sh sh -c '<the quick check, files filled in>' (write any single quote inside it as '\\''). The wrapper waits for a free slot, so the command can take several minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy. Do not run the full check (npm run check) yourself. CI runs the full check on the PR and that satisfies a project rule such as 'a change is done when `npm run check` exits 0'. Time the quick check (slot wait included) with date +%s before and after and set localCheckMs in your result to the elapsed milliseconds (an integer). Set checkCommand to the quick check as you ran it (files filled in) and checkExitCode to its exit code. If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked. (4) commit in small steps; (5) Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\" -m \"Co-Authored-By: Claude <noreply@anthropic.com>\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. (6) git push -u origin feat/9.1 and open a PR with gh pr create titled \"9.1: T\" whose body lists files changed, the exact test command and its output tail, a \"Decisions\" list for every default you took where the spec left a detail open, and open questions.\nWhere the spec leaves a detail open, take the conventional default and list it under Decisions. Stop (status: blocked) if two readings of the spec would lead to materially different work or if a choice falls outside the envelope; then list the question and still open the PR as a draft with what you have.\nTest edits: if you remove or change an assertion in a test file after your test-first commit, add a line that starts with `Test edits:` to the PR body, then one line per removed or changed assertion (the file, the old and the new assertion, and why the change is right). The critic treats an unjustified removal or change as a FIX item, and the workflow blocks the merge when the PR body has no such line. Leave the section out when you edited no assertion.\nReturn the structured result with worktree set to /tmp/sim-wt/9.1. Leave the branch pushed and the worktree in place; do not merge.";
const QUICK_FINISH = "You are a worker on the Sim repository finishing task 9.1: T (finish attempt 1 of 2). \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nThe previous worker on this task returned before the quick check had finished, so nothing has been reviewed. Branch feat/9.1, worktree /tmp/sim-wt/9.1; cd there (if the worktree is missing: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1). Your PR: #7 u; if it is a draft, mark it ready with gh pr ready 7 once the check passes.\nIts open questions were: none. Answer each by taking the conventional default and listing it under Decisions, unless two readings of the spec would lead to materially different work.\nSteps: (1) make sure every change is committed; (2) run the quick check once and wait for it to finish. The quick check is: npx vitest related --run {files} && npm run typecheck ({files} is replaced by you with the files you changed, space separated, relative to the worktree). Run it in the worktree through the machine-wide slot wrapper, so its tests count against the check slots every session on this machine shares: SLOT_MAX=2 /tmp/sim/.claude/slot.sh sh -c '<the quick check, files filled in>' (write any single quote inside it as '\\''). The wrapper waits for a free slot, so the command can take several minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy. Do not run the full check (npm run check) yourself. CI runs the full check on the PR and that satisfies a project rule such as 'a change is done when `npm run check` exits 0'. Time the quick check (slot wait included) with date +%s before and after and set localCheckMs in your result to the elapsed milliseconds (an integer). Set checkCommand to the quick check as you ran it (files filled in) and checkExitCode to its exit code. If the Bash tool moves it to the background, wait for its completion notification and read its output; you may not return while it runs; (3) if it fails, fix the cause inside the files you own and run it again, at most twice; (4) Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\" -m \"Co-Authored-By: Claude <noreply@anthropic.com>\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Push, and if no PR exists open it with gh pr create titled \"9.1: T\", its body listing files changed, the check command and output tail, Decisions and open questions.\nReturn the structured result with the real exit code of the last check. Set status blocked for a genuine ambiguity in the spec or a choice outside the envelope, and for nothing else, never for a slow or unfinished check.";
const QUICK_FIX = "You are a worker on the Sim repository continuing task 9.1: T, fix round 1 of 3. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nYour PR: #7 u on branch feat/9.1. Your worktree is /tmp/sim-wt/9.1; cd there and git pull --ff-only. If the worktree is missing, recreate it: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1.\nThe critic returned FIX with these numbered items; fix every one and nothing else:\n1. x (proved by: y)\nCritic notes: n\nRun the quick check once after the fixes. The quick check is: npx vitest related --run {files} && npm run typecheck ({files} is replaced by you with the files you changed, space separated, relative to the worktree). Run it in the worktree through the machine-wide slot wrapper, so its tests count against the check slots every session on this machine shares: SLOT_MAX=2 /tmp/sim/.claude/slot.sh sh -c '<the quick check, files filled in>' (write any single quote inside it as '\\''). The wrapper waits for a free slot, so the command can take several minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy. Do not run the full check (npm run check) yourself. CI runs the full check on the PR and that satisfies a project rule such as 'a change is done when `npm run check` exits 0'. Time the quick check (slot wait included) with date +%s before and after and set localCheckMs in your result to the elapsed milliseconds (an integer). Set checkCommand to the quick check as you ran it (files filled in) and checkExitCode to its exit code. If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked. Commit in small steps. Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\" -m \"Co-Authored-By: Claude <noreply@anthropic.com>\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.";
const QUICK_REOPEN = "You are a worker on the Sim repository continuing task 9.1: T, fix round reopen of 3. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nYour PR: #7 u on branch feat/9.1. Your worktree is /tmp/sim-wt/9.1; cd there and git pull --ff-only. If the worktree is missing, recreate it: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1.\nThe critic returned FIX with these numbered items; fix every one and nothing else:\n1. npm run check failed on main after merge: boom (proved by: npm run check on main)\nCritic notes: Main went red after merging PR #7; it was reverted (rv). Reproduce the failure from the output in the item below, using the quick check where it covers it (CI runs the full check on the new PR), and fix the cause. The original PR is merged and reverted on main; open a NEW PR from a new branch feat/9.1-2 that re-applies your work on top of current main (git fetch; git worktree add /tmp/sim-wt/9.1-2 -b feat/9.1-2 origin/main; git merge feat/9.1), titled \"9.1: T (reopen)\".\nRun the quick check once after the fixes. The quick check is: npx vitest related --run {files} && npm run typecheck ({files} is replaced by you with the files you changed, space separated, relative to the worktree). Run it in the worktree through the machine-wide slot wrapper, so its tests count against the check slots every session on this machine shares: SLOT_MAX=2 /tmp/sim/.claude/slot.sh sh -c '<the quick check, files filled in>' (write any single quote inside it as '\\''). The wrapper waits for a free slot, so the command can take several minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy. Do not run the full check (npm run check) yourself. CI runs the full check on the PR and that satisfies a project rule such as 'a change is done when `npm run check` exits 0'. Time the quick check (slot wait included) with date +%s before and after and set localCheckMs in your result to the elapsed milliseconds (an integer). Set checkCommand to the quick check as you ran it (files filled in) and checkExitCode to its exit code. If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked. Commit in small steps. Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\" -m \"Co-Authored-By: Claude <noreply@anthropic.com>\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.";
