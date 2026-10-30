import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { classify, ledger } from './envelope.js';

// A recommendation that meets every envelope condition; each case changes one thing or a few.
function rec(over: Record<string, unknown> = {}) {
  return {
    id: 'R1',
    text: 'Use the existing parser',
    evidence: 'tests/parser.test.ts passes with the existing parser',
    reverseCost: 'one revert PR',
    wouldBeWrongIf: 'the parser fails on the fixture set',
    reversible: true,
    costCents: 0,
    touches: [] as string[],
    category: 'tooling',
    ...over,
  };
}

type Case = {
  name: string;
  rec: Record<string, unknown>;
  project?: Record<string, unknown>;
  decision: 'accept' | 'ask';
  reasonHas?: string;
};

const cases: Case[] = [
  { name: 'all conditions met accepts', rec: rec(), decision: 'accept' },
  { name: 'no project at all accepts a clean rec', rec: rec(), project: undefined, decision: 'accept' },
  {
    name: 'empty evidence asks even when everything else is met',
    rec: rec({ evidence: '' }),
    decision: 'ask',
    reasonHas: 'evidence',
  },
  {
    name: 'whitespace-only evidence asks (an opinion is not evidence)',
    rec: rec({ evidence: '   \n' }),
    decision: 'ask',
    reasonHas: 'evidence',
  },
  {
    name: 'empty wouldBeWrongIf asks',
    rec: rec({ wouldBeWrongIf: '' }),
    decision: 'ask',
    reasonHas: 'wouldBeWrongIf',
  },
  {
    name: 'irreversible asks',
    rec: rec({ reversible: false }),
    decision: 'ask',
    reasonHas: 'reversible',
  },
  {
    name: 'cost of 1 with the default cap of 0 asks',
    rec: rec({ costCents: 1 }),
    decision: 'ask',
    reasonHas: 'cost',
  },
  {
    name: 'cost exactly at the project cap accepts',
    rec: rec({ costCents: 500 }),
    project: { envelope: { maxCostCents: 500 } },
    decision: 'accept',
  },
  {
    name: 'cost one cent over the project cap asks',
    rec: rec({ costCents: 501 }),
    project: { envelope: { maxCostCents: 500 } },
    decision: 'ask',
    reasonHas: 'cost',
  },
  {
    name: 'zero cost with a cap of 0 accepts',
    rec: rec({ costCents: 0 }),
    project: { envelope: { maxCostCents: 0 } },
    decision: 'accept',
  },
  {
    name: 'touching an invariant asks',
    rec: rec({ touches: ['invariant'] }),
    decision: 'ask',
    reasonHas: 'invariant',
  },
  {
    name: 'touching a fixed decision asks',
    rec: rec({ touches: ['fixed_decision'] }),
    decision: 'ask',
    reasonHas: 'fixed_decision',
  },
  {
    name: 'fixed_decision among other touches still asks',
    rec: rec({ touches: ['docs', 'fixed_decision', 'ci'] }),
    decision: 'ask',
    reasonHas: 'fixed_decision',
  },
  {
    name: 'fixed_decision asks even with a huge cap and a project that lists the category as fine',
    rec: rec({ touches: ['fixed_decision'], costCents: 0 }),
    project: { envelope: { maxCostCents: 1_000_000, humanOnly: [] } },
    decision: 'ask',
    reasonHas: 'fixed_decision',
  },
  {
    name: 'other touches that are not invariants or fixed decisions accept',
    rec: rec({ touches: ['docs', 'ci'] }),
    decision: 'accept',
  },
  {
    name: 'unknown category with every other condition met accepts',
    rec: rec({ category: 'a-category-nobody-listed' }),
    decision: 'accept',
  },
  { name: 'money category asks', rec: rec({ category: 'money' }), decision: 'ask', reasonHas: 'money' },
  { name: 'secret category asks', rec: rec({ category: 'secret' }), decision: 'ask', reasonHas: 'secret' },
  { name: 'account category asks', rec: rec({ category: 'account' }), decision: 'ask', reasonHas: 'account' },
  { name: 'quota category asks', rec: rec({ category: 'quota' }), decision: 'ask', reasonHas: 'quota' },
  {
    name: 'vendor plan category asks',
    rec: rec({ category: 'vendor_plan' }),
    decision: 'ask',
    reasonHas: 'vendor_plan',
  },
  { name: 'legal category asks', rec: rec({ category: 'legal' }), decision: 'ask', reasonHas: 'legal' },
  { name: 'privacy category asks', rec: rec({ category: 'privacy' }), decision: 'ask', reasonHas: 'privacy' },
  {
    name: 'irreversible production category asks',
    rec: rec({ category: 'irreversible_production' }),
    decision: 'ask',
    reasonHas: 'irreversible_production',
  },
  {
    name: 'category match ignores case, surrounding space and hyphens',
    rec: rec({ category: '  Vendor-Plan ' }),
    decision: 'ask',
    reasonHas: 'vendor_plan',
  },
  {
    name: 'project humanOnly adds a category that is otherwise unknown',
    rec: rec({ category: 'brand-voice' }),
    project: { envelope: { humanOnly: ['brand-voice'] } },
    decision: 'ask',
    reasonHas: 'brand_voice',
  },
  {
    name: 'project humanOnly does not remove the built-in categories',
    rec: rec({ category: 'money' }),
    project: { envelope: { humanOnly: ['brand-voice'] } },
    decision: 'ask',
    reasonHas: 'money',
  },
  {
    name: 'a project humanOnly entry for another category leaves this one accepted',
    rec: rec({ category: 'tooling' }),
    project: { envelope: { humanOnly: ['brand-voice'] } },
    decision: 'accept',
  },
  {
    name: 'combination: irreversible and over cap and human-only category asks and names each',
    rec: rec({ reversible: false, costCents: 50, category: 'money' }),
    decision: 'ask',
    reasonHas: 'money',
  },
  {
    name: 'combination: cost at cap but irreversible asks',
    rec: rec({ costCents: 10, reversible: false }),
    project: { envelope: { maxCostCents: 10 } },
    decision: 'ask',
    reasonHas: 'reversible',
  },
  {
    name: 'combination: cost at cap and human-only category asks',
    rec: rec({ costCents: 10, category: 'legal' }),
    project: { envelope: { maxCostCents: 10 } },
    decision: 'ask',
    reasonHas: 'legal',
  },
  {
    name: 'combination: missing evidence and an otherwise fine rec in a project with a cap asks',
    rec: rec({ evidence: '', costCents: 5 }),
    project: { envelope: { maxCostCents: 10 } },
    decision: 'ask',
    reasonHas: 'evidence',
  },
  {
    name: 'a non-integer cost cannot be trusted and asks',
    rec: rec({ costCents: 0.5 }),
    project: { envelope: { maxCostCents: 10 } },
    decision: 'ask',
    reasonHas: 'cost',
  },
  {
    name: 'a missing touches list is treated as touching nothing',
    rec: rec({ touches: undefined }),
    decision: 'accept',
  },
];

describe('classify', () => {
  it('has at least 12 table cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });

  for (const c of cases) {
    it(c.name, () => {
      const out = c.project === undefined ? classify(c.rec) : classify(c.rec, c.project);
      expect(out.decision).toBe(c.decision);
      expect(typeof out.reason).toBe('string');
      expect(out.reason.length).toBeGreaterThan(0);
      if (c.reasonHas) expect(out.reason).toContain(c.reasonHas);
    });
  }

  it('names every failed rule in the reason of a combined ask', () => {
    const out = classify(rec({ reversible: false, costCents: 50, category: 'money', touches: ['invariant'] }));
    expect(out.decision).toBe('ask');
    for (const word of ['reversible', 'cost', 'money', 'invariant']) expect(out.reason).toContain(word);
  });

  it('returns only decision and reason', () => {
    expect(Object.keys(classify(rec())).sort()).toEqual(['decision', 'reason']);
  });

  it('does not mutate the rec or the project', () => {
    const r = rec({ touches: ['docs'] });
    const p = { envelope: { maxCostCents: 3, humanOnly: ['x'] } };
    const rs = JSON.stringify(r);
    const ps = JSON.stringify(p);
    classify(r, p);
    expect(JSON.stringify(r)).toBe(rs);
    expect(JSON.stringify(p)).toBe(ps);
  });

  it('asks rather than throws for a rec that is not an object', () => {
    expect(classify(null).decision).toBe('ask');
    expect(classify(undefined).decision).toBe('ask');
  });
});

describe('ledger', () => {
  it('for 0 decisions is all zeros and the rate is 0, not NaN', () => {
    const out = ledger([]);
    expect(out).toEqual({ accepted: 0, asked: 0, reversed: 0, failures: 0, reversalRate: 0 });
    expect(Number.isNaN(out.reversalRate)).toBe(false);
  });

  it('counts accepted, asked and reversed', () => {
    const out = ledger([
      { id: 'a', decision: 'accept' },
      { id: 'b', decision: 'accept', reversedBy: 'PR #9' },
      { id: 'c', decision: 'ask' },
      { id: 'd', decision: 'accept' },
    ]);
    expect(out.accepted).toBe(3);
    expect(out.asked).toBe(1);
    expect(out.reversed).toBe(1);
    expect(out.reversalRate).toBe(0.25);
  });

  it('an empty or missing reversedBy does not count as reversed', () => {
    const out = ledger([
      { id: 'a', decision: 'accept', reversedBy: '' },
      { id: 'b', decision: 'accept', reversedBy: null },
      { id: 'c', decision: 'accept' },
    ]);
    expect(out.reversed).toBe(0);
    expect(out.reversalRate).toBe(0);
  });

  it('reversalRate is 1 when every decision is reversed', () => {
    expect(ledger([{ id: 'a', decision: 'accept', reversedBy: 'x' }]).reversalRate).toBe(1);
  });

  it('counts entries with failed: true as failures', () => {
    const out = ledger([
      { id: 'a', decision: 'accept', failed: true },
      { id: 'a', decision: 'accept', failed: true },
      { id: 'b', decision: 'accept', failed: false },
      { id: 'c', decision: 'ask' },
    ]);
    expect(out.failures).toBe(2);
  });

  it('a reversed decision that also failed counts in both', () => {
    const out = ledger([{ id: 'a', decision: 'accept', reversedBy: 'PR #2', failed: true }]);
    expect(out.reversed).toBe(1);
    expect(out.failures).toBe(1);
  });

  it('throws a TypeError for input that is not an array', () => {
    expect(() => ledger(undefined)).toThrow(TypeError);
    expect(() => ledger({})).toThrow(TypeError);
  });
});
