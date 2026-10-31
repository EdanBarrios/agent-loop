import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { loadGates } from './gates.js';
// @ts-expect-error plain JavaScript module with JSDoc
import { runSpecReview, scanTasks, combine } from './review.js';

// Everything is stubbed: the agent() calls, the clock (date is passed in) and the writer (a temp dir).
const tmp = mkdtempSync(join(tmpdir(), 'review-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Any = Record<string, any>;
type Call = { label: string; prompt: string; opts: Any };

function rec(id: string, over: Any = {}): Any {
  return {
    id,
    kind: 'defect',
    text: `Fix ${id}`,
    evidence: `spec line quoted for ${id}`,
    reverseCost: 'one revert PR',
    wouldBeWrongIf: 'the fixture disagrees',
    reversible: true,
    costCents: 0,
    touches: [],
    category: 'spec',
    ...over,
  };
}

function reviewerOut(recs: Any[], over: Any = {}): Any {
  return { recs, externalFacts: [], gates: [], ...over };
}

/** Answers are looked up by label; a function answer sees the prompt; an Error is thrown. */
function stub(answers: Record<string, any>) {
  const calls: Call[] = [];
  const agent = async (prompt: string, opts: Any) => {
    calls.push({ label: opts.label, prompt, opts });
    const a = answers[opts.label];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(prompt) : (a ?? null);
  };
  const reviewerCalls = () => calls.filter((c) => c.label.startsWith('reviewer'));
  return { agent, calls, reviewerCalls };
}

const project = { name: 'Pilot' };
const base = { project, specPath: 'docs/spec/tasks.md', wave: '3', date: '2026-10-30' };
const write = async (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const run = (s: ReturnType<typeof stub>, over: Any = {}) =>
  runSpecReview({ ...base, agent: s.agent, write, outDir: tmp, ...over });

const agree = (...ids: string[]) => ({ verdicts: ids.map((id) => ({ id, verdict: 'agree', evidence: 'fixture ok', reason: '' })) });

describe('runSpecReview: combining the envelope and the adversary', () => {
  it('accepts everything when the adversary agrees and every rec is in the envelope', async () => {
    const s = stub({ 'reviewer r1': reviewerOut([rec('D1'), rec('D2')]), adversary: agree('D1', 'D2') });
    const out = await run(s);
    expect(out.accepted.map((r: Any) => r.id)).toEqual(['D1', 'D2']);
    expect(out.asked).toEqual([]);
    expect(out.needsSecondRound).toBe(false);
    expect(s.calls.map((c) => c.label)).toEqual(['reviewer r1', 'adversary']);
    expect(out.accepted[0].reason).toMatch(/inside the envelope/);
  });

  it('moves one disagree to asked and leaves the others accepted', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1'), rec('D2')]),
      adversary: {
        verdicts: [
          { id: 'D1', verdict: 'agree', evidence: 'ok', reason: '' },
          { id: 'D2', verdict: 'disagree', evidence: 'tests/x.test.ts fails with it', reason: 'breaks x' },
        ],
      },
    });
    const out = await run(s);
    expect(out.accepted.map((r: Any) => r.id)).toEqual(['D1']);
    expect(out.asked.map((r: Any) => r.id)).toEqual(['D2']);
    expect(out.asked[0].reason).toMatch(/adversary/);
    expect(out.asked[0].reason).toMatch(/breaks x/);
    expect(out.needsSecondRound).toBe(false);
    expect(s.reviewerCalls()).toHaveLength(1);
  });

  it('asks a rec outside the envelope even when the adversary agrees', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1', { costCents: 500 }), rec('D2', { category: 'money' }), rec('D3', { touches: ['fixed_decision'] })]),
      adversary: agree('D1', 'D2', 'D3'),
    });
    const out = await run(s);
    expect(out.accepted).toEqual([]);
    expect(out.asked.map((r: Any) => r.id)).toEqual(['D1', 'D2', 'D3']);
  });

  it('asks a rec the adversary did not rule on', async () => {
    const s = stub({ 'reviewer r1': reviewerOut([rec('D1'), rec('D2')]), adversary: agree('D1') });
    const out = await run(s);
    expect(out.asked.map((r: Any) => r.id)).toEqual(['D2']);
    expect(out.asked[0].reason).toMatch(/no adversary verdict/);
  });

  it('asks everything when the adversary returns nothing', async () => {
    const s = stub({ 'reviewer r1': reviewerOut([rec('D1')]) });
    const out = await run(s);
    expect(out.accepted).toEqual([]);
    expect(out.asked.map((r: Any) => r.id)).toEqual(['D1']);
  });

  it('applies the project envelope cap', async () => {
    const s = stub({ 'reviewer r1': reviewerOut([rec('D1', { costCents: 300 })]), adversary: agree('D1') });
    const out = await run(s, { project: { name: 'Pilot', envelope: { maxCostCents: 300 } } });
    expect(out.accepted.map((r: Any) => r.id)).toEqual(['D1']);
  });

  it('puts only accepted recs\' spec edits in specEdits', async () => {
    const edit = (n: string) => ({ file: 'docs/spec/tasks.md', find: `old ${n}`, replace: `new ${n}` });
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1', { edits: [edit('1')] }), rec('D2', { edits: [edit('2')] })]),
      adversary: { verdicts: [...agree('D1').verdicts, { id: 'D2', verdict: 'disagree', evidence: 'e', reason: 'r' }] },
    });
    const out = await run(s);
    expect(out.specEdits).toEqual([{ file: 'docs/spec/tasks.md', find: 'old 1', replace: 'new 1', recId: 'D1' }]);
    expect(out.asked[0].edits).toEqual([edit('2')]);
  });
});

describe('runSpecReview: the second round', () => {
  it('a block sets needsSecondRound and runs exactly one more reviewer pass', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1'), rec('D2')]),
      adversary: {
        verdicts: [
          { id: 'D1', verdict: 'agree', evidence: 'ok', reason: '' },
          { id: 'D2', verdict: 'block', evidence: 'cmd output: exit 1', reason: 'unsafe' },
        ],
      },
      'reviewer r3': reviewerOut([rec('D2', { text: 'Fix D2 differently' })]),
    });
    const out = await run(s);
    expect(out.needsSecondRound).toBe(true);
    expect(s.reviewerCalls().map((c) => c.label)).toEqual(['reviewer r1', 'reviewer r3']);
    expect(s.calls.filter((c) => c.label === 'adversary')).toHaveLength(1);
    expect(out.accepted.map((r: Any) => r.id)).toEqual(['D1']);
    expect(out.asked.map((r: Any) => r.id)).toEqual(['D2']);
    // The revised proposal rides along for the human; it is not auto-accepted.
    expect(out.asked[0].revision.text).toBe('Fix D2 differently');
    // The revision pass is told what was blocked and why.
    expect(s.reviewerCalls()[1].prompt).toMatch(/unsafe/);
  });

  it('never runs a third reviewer pass, even when the revision pass is empty', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1')]),
      adversary: { verdicts: [{ id: 'D1', verdict: 'block', evidence: 'e', reason: 'r' }] },
    });
    const out = await run(s);
    expect(out.needsSecondRound).toBe(true);
    expect(s.reviewerCalls()).toHaveLength(2);
    expect(out.asked.map((r: Any) => r.id)).toEqual(['D1']);
    expect(out.asked[0].revision).toBeNull();
  });

  it('counts the spike re-run and the block round as separate single passes', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1')], { externalFacts: [{ id: 'F1', fact: 'plan limit' }] }),
      'spike:F1': { fact: 'plan limit', answer: '100/day', source: 'https://example.test/docs', retrieved: '2026-10-30' },
      'reviewer r2': reviewerOut([rec('D1')]),
      adversary: { verdicts: [{ id: 'D1', verdict: 'block', evidence: 'e', reason: 'r' }] },
      'reviewer r3': reviewerOut([rec('D1', { text: 'Other' })]),
    });
    const out = await run(s);
    expect(s.reviewerCalls().map((c) => c.label)).toEqual(['reviewer r1', 'reviewer r2', 'reviewer r3']);
    expect(out.needsSecondRound).toBe(true);
  });
});

describe('runSpecReview: spikes', () => {
  const facts = { externalFacts: [{ id: 'F1', fact: 'Does vendor X allow 10 req/s?' }, { id: 'F2', fact: 'Is the API free?' }] };

  it('runs one low-effort haiku spike per fact and gives the answers to the re-run', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1')], facts),
      'spike:F1': { fact: 'Does vendor X allow 10 req/s?', answer: 'yes, 20 req/s', source: 'https://example.test/limits', retrieved: '2026-10-30' },
      'spike:F2': { fact: 'Is the API free?', answer: 'free tier 1000/mo', source: 'https://example.test/pricing', retrieved: '2026-10-30' },
      'reviewer r2': reviewerOut([rec('D1', { text: 'Revised D1' })]),
      adversary: agree('D1'),
    });
    const out = await run(s);
    const spikes = s.calls.filter((c) => c.label.startsWith('spike:'));
    expect(spikes).toHaveLength(2);
    for (const c of spikes) {
      expect(c.opts.model).toBe('haiku');
      expect(c.opts.effort).toBe('low');
      expect(c.opts.schema).toBeTruthy();
      expect(c.prompt).toMatch(/never a recommendation/i);
    }
    expect(s.calls.find((c) => c.label === 'reviewer r2')!.prompt).toMatch(/20 req\/s/);
    expect(out.spikes.map((x: Any) => [x.id, x.status])).toEqual([['F1', 'answered'], ['F2', 'answered']]);
    // The re-run supersedes the first pass.
    expect(out.accepted[0].text).toBe('Revised D1');
  });

  it('reports a failing spike as an open fact and does not retry it', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1', { dependsOn: ['F1'] }), rec('D2')], facts),
      'spike:F1': new Error('network down'),
      'spike:F2': null,
      adversary: agree('D1', 'D2'),
    });
    const out = await run(s);
    expect(s.calls.filter((c) => c.label === 'spike:F1')).toHaveLength(1);
    expect(s.calls.filter((c) => c.label === 'spike:F2')).toHaveLength(1);
    expect(out.spikes.map((x: Any) => [x.id, x.status])).toEqual([['F1', 'open'], ['F2', 'open']]);
    expect(out.spikes[0].error).toMatch(/network down/);
    // A rec that hangs on an open fact is asked; one that does not is still accepted.
    expect(out.asked.map((r: Any) => r.id)).toEqual(['D1']);
    expect(out.asked[0].reason).toMatch(/F1/);
    expect(out.accepted.map((r: Any) => r.id)).toEqual(['D2']);
  });

  it('treats an answer with no recorded source as an open fact', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1')], { externalFacts: [{ id: 'F1', fact: 'f' }] }),
      'spike:F1': { fact: 'f', answer: 'probably', source: '', retrieved: '' },
      adversary: agree('D1'),
    });
    const out = await run(s);
    expect(out.spikes[0].status).toBe('open');
    expect(out.spikes[0].error).toMatch(/source/);
  });
});

describe('runSpecReview: the adversary sees only the spec and the recommendations', () => {
  it('omits the first reviewer\'s reasoning and uses the strongest model', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1', { reasoning: 'SECRET-REASONING-TEXT', notes: 'SECRET-NOTES' })]),
      adversary: agree('D1'),
    });
    await run(s);
    const adv = s.calls.find((c) => c.label === 'adversary')!;
    expect(adv.prompt).not.toMatch(/SECRET-REASONING-TEXT|SECRET-NOTES/);
    expect(adv.prompt).toMatch(/Fix D1/);
    expect(adv.prompt).toMatch(/docs\/spec\/tasks\.md/);
    expect(adv.prompt).toMatch(/evidence over argument/i);
    expect(adv.opts.model).toBe('fable');
  });

  it('lets project.models override the roles', async () => {
    const s = stub({ 'reviewer r1': reviewerOut([rec('D1')]), adversary: agree('D1') });
    await run(s, { project: { name: 'Pilot', models: { adversary: { model: 'opus', effort: 'max' }, reviewer: { model: 'opus', effort: 'high' } } } });
    expect(s.calls[0].opts).toMatchObject({ model: 'opus', effort: 'high' });
    expect(s.calls[1].opts).toMatchObject({ model: 'opus', effort: 'max' });
  });
});

describe('gate items', () => {
  const tasks = [
    { id: '3.2', wave: '3', text: 'Add the enrichment step. Needs the Apollo API key in the environment.' },
    { id: '4.1', wave: '4', text: 'Submit the Vertex quota request; Google takes about 3 business days to answer.' },
    { id: '4.2', wave: '4', text: 'Pure parser with a table test.' },
  ];

  it('a task that mentions a vendor key yields a gate before that task\'s wave', () => {
    const gates = scanTasks(tasks);
    const key = gates.find((g: Any) => g.id.startsWith('G-3.2'));
    expect(key).toBeTruthy();
    expect(key.before).toBe('3');
    expect(key.owner).toBe('human');
    expect(key.status).toBe('open');
  });

  it('a days-long quota yields leadTime days', () => {
    const quota = scanTasks(tasks).find((g: Any) => g.id.startsWith('G-4.1'));
    expect(quota.leadTime).toBe('days');
    expect(quota.before).toBe('4');
  });

  it('a task with nothing to flag yields no gate', () => {
    expect(scanTasks(tasks).filter((g: Any) => g.id.startsWith('G-4.2'))).toEqual([]);
  });

  it('runSpecReview merges scanned and reviewer gates into a valid checklist, longest lead first', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1')], {
        gates: [
          { what: 'Create the privacy page', why: 'legal wording', before: '5', leadTime: 'hours', task: '5.1', kind: 'legal' },
          { what: 'Open a Hunter plan', why: 'plan needed by task 4.3' },
        ],
      }),
      adversary: agree('D1'),
    });
    const out = await run(s, { tasks });
    expect(() => loadGates(out.gates)).not.toThrow();
    const lead = out.gates.map((g: Any) => g.leadTime);
    expect(lead[0]).toBe('days');
    expect(out.gates.find((g: Any) => g.what === 'Open a Hunter plan').before).toBe('3'); // defaults to the reviewed wave
    expect(out.gates.find((g: Any) => g.what === 'Create the privacy page').before).toBe('5');
    expect(new Set(out.gates.map((g: Any) => g.id)).size).toBe(out.gates.length);
  });

  it('a reviewer gate for a task and kind replaces the scanned one', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1')], {
        gates: [{ what: 'Get the Apollo key', why: 'enrichment', before: '3', leadTime: 'hours', task: '3.2', kind: 'secret' }],
      }),
      adversary: agree('D1'),
    });
    const out = await run(s, { tasks });
    const forTask = out.gates.filter((g: Any) => /3\.2|Apollo/.test(g.id + g.what));
    expect(forTask).toHaveLength(1);
    expect(forTask[0].what).toBe('Get the Apollo key');
  });
});

describe('the review file', () => {
  it('is written to <outDir>/<project>/<date>-wave-<n>-review.json and holds the output', async () => {
    const s = stub({
      'reviewer r1': reviewerOut([rec('D1'), rec('D2')]),
      adversary: { verdicts: [...agree('D1').verdicts, { id: 'D2', verdict: 'disagree', evidence: 'e', reason: 'r' }] },
    });
    const out = await run(s);
    const path = join(tmp, 'pilot', '2026-10-30-wave-3-review.json');
    expect(out.reviewPath).toBe(path);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.accepted.map((r: Any) => r.id)).toEqual(['D1']);
    expect(onDisk.asked.map((r: Any) => r.id)).toEqual(['D2']);
    for (const key of ['accepted', 'asked', 'spikes', 'gates', 'specEdits']) expect(Array.isArray(onDisk[key])).toBe(true);
  });

  it('is not written, and says so, when no date is given', async () => {
    const s = stub({ 'reviewer r1': reviewerOut([rec('D1')]), adversary: agree('D1') });
    const out = await run(s, { date: undefined });
    expect(out.reviewPath).toBeNull();
  });
});

describe('combine', () => {
  it('is pure: it does not mutate its inputs', () => {
    const recs = [rec('D1')];
    const verdicts = [{ id: 'D1', verdict: 'disagree', evidence: 'e', reason: 'r' }];
    const before = JSON.stringify({ recs, verdicts });
    combine({ recs, verdicts, spikes: [], project });
    expect(JSON.stringify({ recs, verdicts })).toBe(before);
  });
});
