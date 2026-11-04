import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Task 4.2: prompt snapshot tests. The wave-loop script runs with stubbed agents that record every prompt by label,
// so the tests assert on the exact text each role is given. No network, no real agent.
const root = join(import.meta.dirname, '..');
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

  it('has 8 items in order and item 8 checks the PR Decisions against the envelope', async () => {
    const { prompts } = await runWave(allRoles);
    const list = items(prompts['critic:9.1 r1']);
    expect(list.map((l) => Number(l.split('.')[0]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
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
  });

  it('still has 8 items when the project adds critic checks, which stay under item 7 in order', async () => {
    const { prompts } = await runWave(allRoles, { criticChecks: ['Evidence rule holds.', 'Ledger is reserved.'] });
    const prompt = prompts['critic:9.1 r1'];
    expect(items(prompt)).toHaveLength(8);
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

  it('critic.md has 8 numbered items in order, item 8 about Decisions', () => {
    const nums = body('critic.md')
      .split('\n')
      .filter((l) => /^\d+\. /.test(l));
    expect(nums.map((l) => Number(l.split('.')[0]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(nums[7]).toContain('Decisions:');
    expect(nums[7]).toMatch(/FIX/);
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

// Regenerated for the loop perf fixes (3 Nov 2026): the ownership sentence follows the project's rule on edits outside
// owned files, and the quick check runs through the slot wrapper. Everything else is unchanged.
// The v2 worker, finish, fix and reopen prompts, captured from wave-loop.js on origin/main before task 2.2 for the project in runCycle.
const V2_WORKER = "You are a worker on the Sim repository. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask 9.1: T.\nTask text (verbatim from the spec): x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body.\nTask notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\n\nWorktree: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 -b feat/9.1 origin/main. Then work ONLY inside /tmp/sim-wt/9.1 (cd there; run SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm ci there first). Never run git checkout in /tmp/sim.\nOrder: (1) write the acceptance test exactly as specified and commit it first, confirming it fails for the right reason before the implementation exists; (2) implement; (3) run SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm run check once in the worktree and keep the output (the slot wrapper waits for a free check slot on this machine, so the command can take up to 15 minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy; If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked.); (4) commit in small steps; (5) Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. (6) git push -u origin feat/9.1 and open a PR with gh pr create titled \"9.1: T\" whose body lists files changed, the exact test command and its output tail, a \"Decisions\" list for every default you took where the spec left a detail open, and open questions.\nWhere the spec leaves a detail open, take the conventional default and list it under Decisions. Stop (status: blocked) if two readings of the spec would lead to materially different work or if a choice falls outside the envelope; then list the question and still open the PR as a draft with what you have.\nReturn the structured result with worktree set to /tmp/sim-wt/9.1. Leave the branch pushed and the worktree in place; do not merge.";
const V2_FINISH = "You are a worker on the Sim repository finishing task 9.1: T (finish attempt 1 of 2). \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nThe previous worker on this task returned before npm run check had finished, so nothing has been reviewed. Branch feat/9.1, worktree /tmp/sim-wt/9.1; cd there (if the worktree is missing: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1). Your PR: #7 u; if it is a draft, mark it ready with gh pr ready 7 once the check passes.\nIts open questions were: none. Answer each by taking the conventional default and listing it under Decisions, unless two readings of the spec would lead to materially different work.\nSteps: (1) make sure every change is committed; (2) run SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm run check once and wait for it to finish: with the slot wait it can take 15 minutes; use the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output; you may not return while it runs; (3) if it fails, fix the cause inside the files you own and run it again, at most twice; (4) Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Push, and if no PR exists open it with gh pr create titled \"9.1: T\", its body listing files changed, the check command and output tail, Decisions and open questions.\nReturn the structured result with the real exit code of the last check. Set status blocked for a genuine ambiguity in the spec or a choice outside the envelope, and for nothing else, never for a slow or unfinished check.";
const V2_FIX = "You are a worker on the Sim repository continuing task 9.1: T, fix round 1 of 3. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nYour PR: #7 u on branch feat/9.1. Your worktree is /tmp/sim-wt/9.1; cd there and git pull --ff-only. If the worktree is missing, recreate it: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1.\nThe critic returned FIX with these numbered items; fix every one and nothing else:\n1. x (proved by: y)\nCritic notes: n\nRun SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm run check once after the fixes (up to 15 minutes including the slot wait; maximum Bash timeout, and if the tool moves it to the background wait for its notification; If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked.), commit in small steps. Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.";
const V2_REOPEN = "You are a worker on the Sim repository continuing task 9.1: T, fix round reopen of 3. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nYour PR: #7 u on branch feat/9.1. Your worktree is /tmp/sim-wt/9.1; cd there and git pull --ff-only. If the worktree is missing, recreate it: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1.\nThe critic returned FIX with these numbered items; fix every one and nothing else:\n1. npm run check failed on main after merge: boom (proved by: npm run check on main)\nCritic notes: Main went red after merging PR #7; it was reverted (rv). Reproduce with SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm ci && SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm run check and fix the cause. The original PR is merged and reverted on main; open a NEW PR from a new branch feat/9.1-2 that re-applies your work on top of current main (git fetch; git worktree add /tmp/sim-wt/9.1-2 -b feat/9.1-2 origin/main; git merge feat/9.1), titled \"9.1: T (reopen)\".\nRun SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm run check once after the fixes (up to 15 minutes including the slot wait; maximum Bash timeout, and if the tool moves it to the background wait for its notification; If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked.), commit in small steps. Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.";

// The quickCheck prompts for the same cycle with project.quickCheck = QUICK, reviewed by hand when task 2.2 was written.
const QUICK_WORKER = "You are a worker on the Sim repository. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask 9.1: T.\nTask text (verbatim from the spec): x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body.\nTask notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\n\nWorktree: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 -b feat/9.1 origin/main. Then work ONLY inside /tmp/sim-wt/9.1 (cd there; run SLOT_MAX=2 /tmp/sim/.claude/slot.sh npm ci there first). Never run git checkout in /tmp/sim.\nOrder: (1) write the acceptance test exactly as specified and commit it first, confirming it fails for the right reason before the implementation exists; (2) implement; (3) run the quick check once in the worktree and keep the output. The quick check is: npx vitest related --run {files} && npm run typecheck ({files} is replaced by you with the files you changed, space separated, relative to the worktree). Run it in the worktree through the machine-wide slot wrapper, so its tests count against the check slots every session on this machine shares: SLOT_MAX=2 /tmp/sim/.claude/slot.sh sh -c '<the quick check, files filled in>' (write any single quote inside it as '\\''). The wrapper waits for a free slot, so the command can take several minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy. Do not run the full check (npm run check) yourself. CI runs the full check on the PR and that satisfies a project rule such as 'a change is done when `npm run check` exits 0'. Time the quick check (slot wait included) with date +%s before and after and set localCheckMs in your result to the elapsed milliseconds (an integer). Set checkCommand to the quick check as you ran it (files filled in) and checkExitCode to its exit code. If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked. (4) commit in small steps; (5) Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. (6) git push -u origin feat/9.1 and open a PR with gh pr create titled \"9.1: T\" whose body lists files changed, the exact test command and its output tail, a \"Decisions\" list for every default you took where the spec left a detail open, and open questions.\nWhere the spec leaves a detail open, take the conventional default and list it under Decisions. Stop (status: blocked) if two readings of the spec would lead to materially different work or if a choice falls outside the envelope; then list the question and still open the PR as a draft with what you have.\nReturn the structured result with worktree set to /tmp/sim-wt/9.1. Leave the branch pushed and the worktree in place; do not merge.";
const QUICK_FINISH = "You are a worker on the Sim repository finishing task 9.1: T (finish attempt 1 of 2). \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nThe previous worker on this task returned before the quick check had finished, so nothing has been reviewed. Branch feat/9.1, worktree /tmp/sim-wt/9.1; cd there (if the worktree is missing: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1). Your PR: #7 u; if it is a draft, mark it ready with gh pr ready 7 once the check passes.\nIts open questions were: none. Answer each by taking the conventional default and listing it under Decisions, unless two readings of the spec would lead to materially different work.\nSteps: (1) make sure every change is committed; (2) run the quick check once and wait for it to finish. The quick check is: npx vitest related --run {files} && npm run typecheck ({files} is replaced by you with the files you changed, space separated, relative to the worktree). Run it in the worktree through the machine-wide slot wrapper, so its tests count against the check slots every session on this machine shares: SLOT_MAX=2 /tmp/sim/.claude/slot.sh sh -c '<the quick check, files filled in>' (write any single quote inside it as '\\''). The wrapper waits for a free slot, so the command can take several minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy. Do not run the full check (npm run check) yourself. CI runs the full check on the PR and that satisfies a project rule such as 'a change is done when `npm run check` exits 0'. Time the quick check (slot wait included) with date +%s before and after and set localCheckMs in your result to the elapsed milliseconds (an integer). Set checkCommand to the quick check as you ran it (files filled in) and checkExitCode to its exit code. If the Bash tool moves it to the background, wait for its completion notification and read its output; you may not return while it runs; (3) if it fails, fix the cause inside the files you own and run it again, at most twice; (4) Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Push, and if no PR exists open it with gh pr create titled \"9.1: T\", its body listing files changed, the check command and output tail, Decisions and open questions.\nReturn the structured result with the real exit code of the last check. Set status blocked for a genuine ambiguity in the spec or a choice outside the envelope, and for nothing else, never for a slow or unfinished check.";
const QUICK_FIX = "You are a worker on the Sim repository continuing task 9.1: T, fix round 1 of 3. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nYour PR: #7 u on branch feat/9.1. Your worktree is /tmp/sim-wt/9.1; cd there and git pull --ff-only. If the worktree is missing, recreate it: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1.\nThe critic returned FIX with these numbered items; fix every one and nothing else:\n1. x (proved by: y)\nCritic notes: n\nRun the quick check once after the fixes. The quick check is: npx vitest related --run {files} && npm run typecheck ({files} is replaced by you with the files you changed, space separated, relative to the worktree). Run it in the worktree through the machine-wide slot wrapper, so its tests count against the check slots every session on this machine shares: SLOT_MAX=2 /tmp/sim/.claude/slot.sh sh -c '<the quick check, files filled in>' (write any single quote inside it as '\\''). The wrapper waits for a free slot, so the command can take several minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy. Do not run the full check (npm run check) yourself. CI runs the full check on the PR and that satisfies a project rule such as 'a change is done when `npm run check` exits 0'. Time the quick check (slot wait included) with date +%s before and after and set localCheckMs in your result to the elapsed milliseconds (an integer). Set checkCommand to the quick check as you ran it (files filled in) and checkExitCode to its exit code. If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked. Commit in small steps. Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.";
const QUICK_REOPEN = "You are a worker on the Sim repository continuing task 9.1: T, fix round reopen of 3. \nRepository: /tmp/sim (GitHub o/r, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in /tmp/sim.\nRead first: CLAUDE.md; then the wave 9 section of docs/spec.md and anything your task names.\nHard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.\nNo generated files are expected to change beyond what the task touches.\nCommit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>\nThe commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message \"Sync branch with upstream before merge\" and never write the default branch's name in a git commit or git push command.\n\n\nTask text: x\nYou own only: y. Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under \"Edits outside owned files\" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body. Task notes: none\n\nAutonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of docs/spec.md if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.\nInside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).\nWrite each decision in the PR body under `Decisions:`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no \"|\" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.\nWhen you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.\nA decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.\nYou may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.\nYour PR: #7 u on branch feat/9.1. Your worktree is /tmp/sim-wt/9.1; cd there and git pull --ff-only. If the worktree is missing, recreate it: cd /tmp/sim && git fetch origin && git worktree add /tmp/sim-wt/9.1 feat/9.1.\nThe critic returned FIX with these numbered items; fix every one and nothing else:\n1. npm run check failed on main after merge: boom (proved by: npm run check on main)\nCritic notes: Main went red after merging PR #7; it was reverted (rv). Reproduce the failure from the output in the item below, using the quick check where it covers it (CI runs the full check on the new PR), and fix the cause. The original PR is merged and reverted on main; open a NEW PR from a new branch feat/9.1-2 that re-applies your work on top of current main (git fetch; git worktree add /tmp/sim-wt/9.1-2 -b feat/9.1-2 origin/main; git merge feat/9.1), titled \"9.1: T (reopen)\".\nRun the quick check once after the fixes. The quick check is: npx vitest related --run {files} && npm run typecheck ({files} is replaced by you with the files you changed, space separated, relative to the worktree). Run it in the worktree through the machine-wide slot wrapper, so its tests count against the check slots every session on this machine shares: SLOT_MAX=2 /tmp/sim/.claude/slot.sh sh -c '<the quick check, files filled in>' (write any single quote inside it as '\\''). The wrapper waits for a free slot, so the command can take several minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy. Do not run the full check (npm run check) yourself. CI runs the full check on the PR and that satisfies a project rule such as 'a change is done when `npm run check` exits 0'. Time the quick check (slot wait included) with date +%s before and after and set localCheckMs in your result to the elapsed milliseconds (an integer). Set checkCommand to the quick check as you ran it (files filled in) and checkExitCode to its exit code. If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked. Commit in small steps. Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m \"Sync branch with upstream before merge\". Any conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push. Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.";
