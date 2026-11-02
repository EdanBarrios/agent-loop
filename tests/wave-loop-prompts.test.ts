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
