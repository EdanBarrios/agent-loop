import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { classify, ledger } from '../claude/lib/envelope.js';
// @ts-expect-error plain JavaScript module with JSDoc
import { loadGates, openBefore } from '../claude/lib/gates.js';
// @ts-expect-error plain JavaScript module with JSDoc
import { runReality } from '../claude/lib/reality.js';

const root = join(import.meta.dirname, '..');
const gateFile = join(root, 'docs', 'agent-loop-v2', 'gates.json');
const scorecardScript = join(root, 'scripts', 'loop-scorecard.py');

type Rec = {
  id: string;
  text: string;
  evidence: string;
  reverseCost: string;
  wouldBeWrongIf: string;
  reversible: boolean;
  costCents: number;
  touches: string[];
  category: string;
};

function rec(over: Partial<Rec> = {}): Rec {
  return {
    id: 'r',
    text: 'Use the existing retry helper',
    evidence: 'claude/lib/retry.js already exports withRetry and has tests',
    reverseCost: 'one revert PR',
    wouldBeWrongIf: 'withRetry swallows errors the caller needs',
    reversible: true,
    costCents: 0,
    touches: [],
    category: 'tooling',
    ...over,
  };
}

// One recommendation per outcome: accept, ask, and ask because the evidence is empty.
const accepted = rec({ id: 'rec-accept' });
const asked = rec({
  id: 'rec-ask',
  text: 'Raise the vendor plan to the next tier',
  category: 'vendor_plan',
  reversible: false,
  costCents: 5000,
});
const noEvidence = rec({ id: 'rec-no-evidence', text: 'Rename the helper, it feels cleaner', evidence: '   ' });

const FABLE = 'claude-fable-5-1';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';
const OPUS = 'claude-opus-5-5';

function agent(label: string, tokens: number, durationMs: number, model?: string) {
  return { type: 'workflow_agent', label, agentId: label, state: 'done', tokens, toolCalls: 3, durationMs, ...(model ? { model } : {}) };
}

function renderScorecard(wave: string, resultFile: string) {
  const res = spawnSync('python3', ['-I', scorecardScript, wave, '2026-10-30', resultFile], { encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('wave 1 integration', () => {
  it('chains the gate file, the envelope, the reality runner and the scorecard', async () => {
    // 1. Gate file of this spec: loads, and nothing blocks waves 0 or 1.
    const gates = loadGates(readFileSync(gateFile, 'utf8'));
    expect(gates.length).toBeGreaterThan(0);
    expect(openBefore(gates, '0')).toEqual([]);
    expect(openBefore(gates, '1')).toEqual([]);
    // The real file changes as gates are done, so prove the empty results are not vacuous with a synthetic open item.
    const withOpen = [
      ...gates,
      { id: 'HX', what: 'x', why: 'y', owner: 'human', before: '2', leadTime: 'days', status: 'open', evidence: '' },
    ];
    const open = openBefore(loadGates(withOpen), '2');
    expect(open.map((g: { id: string }) => g.id)).toEqual(['HX']);
    expect(openBefore(loadGates(withOpen), '1')).toEqual([]);

    // 2. Three sample recommendations, one per outcome.
    const project = { envelope: { maxCostCents: 0, humanOnly: [] as string[] } };
    const a = classify(accepted, project);
    const b = classify(asked, project);
    const c = classify(noEvidence, project);
    expect(a.decision).toBe('accept');
    expect(b.decision).toBe('ask');
    expect(b.reason).toContain('human-only');
    expect(b.reason).not.toContain('evidence is empty');
    expect(c.decision).toBe('ask');
    expect(c.reason).toContain('evidence is empty');
    // Every other condition holds for the third one: the empty evidence alone makes it an ask.
    expect(classify({ ...noEvidence, evidence: 'a quoted source' }, project).decision).toBe('accept');

    const decisions = [
      { id: accepted.id, decision: a.decision, reason: a.reason },
      { id: asked.id, decision: b.decision, reason: b.reason },
      { id: noEvidence.id, decision: c.decision, reason: c.reason, reversedBy: 'rec-later' },
    ];
    expect(ledger(decisions)).toMatchObject({ accepted: 1, asked: 2, reversed: 1 });

    // 3. Reality runner with a fake exec: one blocking gap, one warning.
    const reality = { gaps: [
      { id: 'R1', severity: 'block', what: 'Table demo_items is missing' },
      { id: 'R2', severity: 'warn', what: 'Row count lower than expected' },
    ] };
    const calls: Array<[string, number]> = [];
    const exec = async (command: string, timeoutSec: number) => {
      calls.push([command, timeoutSec]);
      return { code: 0, stdout: JSON.stringify(reality) };
    };
    const cfg = { command: 'node scripts/reality.js', readOnly: true, timeoutSec: 30 };
    const result = await runReality(cfg, exec);
    expect(calls).toEqual([['node scripts/reality.js', 30]]);
    expect(result.ok).toBe(true);
    expect(result.gaps).toHaveLength(2);
    expect(result.blocking.map((g: { id: string }) => g.id)).toEqual(['R1']);
    await expect(runReality({ ...cfg, readOnly: false }, exec)).rejects.toThrow(/readOnly/);
    expect(calls).toHaveLength(1);

    // 4. Scorecard on a combined fixture: open gates, ledger decisions and reality result in one wave result.
    const workflowResult = {
      project: 'demo',
      wave: '1',
      gate: 'PASS',
      models: {
        worker: { model: SONNET, effort: 'high' },
        critic: { model: FABLE, effort: 'high' },
        merger: { model: HAIKU, effort: 'low' },
      },
      state: { '1.1': 'merged' },
      tasks: {
        '1.1': {
          task: '1.1',
          title: 'Decision envelope',
          pr: { number: 9, url: 'https://example.invalid/demo/pull/9', branch: 'feat/1-1' },
          rounds: [{ round: 1, verdict: 'MERGE', ci: 'green', fixItems: [], notes: 'ok' }],
          merge: { outcome: 'merged', mergeSha: '0123456789abcdef0123456789abcdef01234567' },
          reopened: false,
          merged: true,
        },
      },
      escalations: [],
      reality: result,
      decisions,
    };
    const dir = mkdtempSync(join(tmpdir(), 'wave1-integration-'));
    const file = join(dir, 'combined.json');
    writeFileSync(
      file,
      JSON.stringify({
        result: JSON.stringify(workflowResult),
        workflowProgress: [
          agent('worker:1.1', 100000, 600000, SONNET),
          agent('critic:1.1 r1', 40000, 300000, OPUS),
          agent('merger:1.1', 10000, 120000, HAIKU),
        ],
      }),
    );
    const card = renderScorecard('1', file);
    expect(card.code, card.stderr).toBe(0);
    const md = card.stdout;
    expect(md).toContain('# Wave 1 loop scorecard');
    expect(md).toContain('Gate: **PASS**');
    // decision ledger agrees with envelope.ledger() on the same decisions
    expect(md).not.toContain('no decisions recorded');
    expect(md).toMatch(/Accepted: 1/);
    expect(md).toMatch(/Asked: 2/);
    expect(md).toMatch(/Reversed: 1/);
    expect(md).toMatch(/Reversal rate: 33%/);
    // reality gaps from the runner
    expect(md).toContain('## Reality gate');
    expect(md).toContain('| R1 | block | Table demo_items is missing |');
    expect(md).toContain('| R2 | warn | Row count lower than expected |');
    // served-model check on the same fixture
    expect(md).toContain(`MODEL MISMATCH critic requested ${FABLE} served ${OPUS}`);
    expect(md).not.toContain('MODEL MISMATCH worker');
    expect(md).not.toContain('MODEL MISMATCH merger');
    expect(md).toContain('Total tokens: 150,000');
  });
});
