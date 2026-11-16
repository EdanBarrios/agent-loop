import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = join(import.meta.dirname, '..', 'scripts', 'loop-scorecard.py');
const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);

async function scorecard(args: string[]) {
  const { stdout } = await run('python3', ['-I', script, ...args]);
  return stdout;
}

// Cells of the table row whose first cell is `first`, within the section that starts at `heading`.
function row(md: string, heading: string, first: string): string[] | undefined {
  const start = md.indexOf(heading);
  if (start < 0) return undefined;
  const rest = md.slice(start + heading.length);
  const end = rest.search(/\n## /);
  const section = end < 0 ? rest : rest.slice(0, end);
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim()).slice(1, -1);
    if (cells[0] === first) return cells;
  }
  return undefined;
}

const num = (s: string) => Number(s.replace(/[^0-9.]/g, ''));

describe('loop-scorecard.py', { timeout: 120_000 }, () => {
  it('flags a critic that requested claude-fable-5-1 but was served claude-opus-5-5', async () => {
    const md = await scorecard(['1', '2026-10-30', fixture('scorecard-v2-mismatch.json')]);
    expect(md).toContain('MODEL MISMATCH critic requested claude-fable-5-1 served claude-opus-5-5');
    expect(md).not.toContain('MODEL MISMATCH worker');
    expect(md).not.toContain('MODEL MISMATCH merger');
    const critic = row(md, '## Roles', 'critic');
    expect(critic).toBeDefined();
    expect(critic).toContain('claude-opus-5-5');
  });

  it('gives a non-zero tokens and minutes row for each of three roles', async () => {
    const md = await scorecard(['1', '2026-10-30', fixture('scorecard-v2-mismatch.json')]);
    const header = row(md, '## Roles', 'Role');
    expect(header).toBeDefined();
    const tokens = header!.indexOf('Tokens');
    const minutes = header!.indexOf('Minutes');
    const served = header!.indexOf('Served');
    expect(tokens).toBeGreaterThan(0);
    expect(minutes).toBeGreaterThan(0);
    expect(served).toBeGreaterThan(0);
    for (const role of ['worker', 'critic', 'merger']) {
      const cells = row(md, '## Roles', role);
      expect(cells, role).toBeDefined();
      expect(num(cells![tokens]), `${role} tokens`).toBeGreaterThan(0);
      expect(num(cells![minutes]), `${role} minutes`).toBeGreaterThan(0);
    }
  });

  it('prints "no decisions recorded" and exits 0 when the result has no decisions', async () => {
    const md = await scorecard(['1', '2026-10-30', fixture('scorecard-v2-mismatch.json')]);
    expect(md).toContain('no decisions recorded');
  });

  it('still renders a v1 result: tasks, roles, signals, no false mismatch for aliases', async () => {
    const md = await scorecard(['0', '2026-10-30', fixture('scorecard-v1-wave0.json')]);
    expect(md).toContain('# Wave 0 loop scorecard');
    expect(md).toContain('Gate: **PASS**');
    expect(md).toContain('| 0.1 Check, CI, config | #1 | 1 | MERGE | merged 0123456 |');
    expect(md).toContain('Worker first-pass MERGE: 1/1');
    expect(md).toContain('## Decision rule');
    expect(md).toContain('no decisions recorded');
    // v1 requested the aliases "sonnet" and "fable"; the agent records carry full ids of those families.
    expect(md).not.toContain('MODEL MISMATCH');
    const worker = row(md, '## Roles', 'worker');
    expect(worker).toContain('claude-sonnet-5-5');
    expect(row(md, '## Roles', 'critic')).toContain('claude-fable-5-1');
    expect(md).toContain('Total tokens: 181,975');
  });

  it('prints the decision ledger, reality gaps, fix items and escalations from a v2 result', async () => {
    const md = await scorecard(['2', '2026-10-30', fixture('scorecard-v2-decisions.json')]);
    expect(md).not.toContain('no decisions recorded');
    expect(md).toMatch(/Accepted: 4/);
    expect(md).toMatch(/Asked: 1/);
    expect(md).toMatch(/Reversed: 1/);
    expect(md).toMatch(/Reversal rate: 20%/);
    expect(md).toContain('5 decisions, fewer than 20');
    expect(md).toContain('## Reality gate');
    expect(row(md, '## Reality gate', 'R1')).toEqual(['R1', 'block', 'Table demo_items is missing']);
    expect(row(md, '## Reality gate', 'R2')).toEqual(['R2', 'warn', 'Row count lower than expected']);
    expect(md).toContain('| 2.1 | 1 | defect | Off by one in the table |');
  });

  it('prints unknown for an unrecorded served model and does not flag it', async () => {
    const md = await scorecard(['2', '2026-10-30', fixture('scorecard-v2-decisions.json')]);
    const header = row(md, '## Roles', 'Role')!;
    const worker = row(md, '## Roles', 'worker')!;
    const cell = worker[header.indexOf('Served')];
    expect(cell).toContain('unknown');
    expect(cell).toContain('claude-sonnet-5-5');
    expect(md).not.toContain('MODEL MISMATCH');
    // two worker agents, one without a served model: runs and tokens still add up
    expect(num(worker[header.indexOf('Runs')])).toBe(2);
    expect(num(worker[header.indexOf('Tokens')])).toBe(120000);
  });

  it('flags tokens above twice the median of previous scorecards beside the output path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-'));
    // v2-style scorecards carry a "Total tokens" line; the v1-style one only a Roles table.
    for (const [name, n] of [
      ['2026-10-27-wave-1-loop.md', '100,000'],
      ['2026-10-28-wave-2-loop.md', '90,000'],
    ]) {
      writeFileSync(join(dir, name), `# Wave\n\n- Total tokens: ${n}\n`);
    }
    writeFileSync(
      join(dir, '2026-10-29-wave-3-loop.md'),
      '# Wave 3\n\n## Roles\n\n| Role | Model | Runs | Tokens | Share | Minutes |\n| --- | --- | --- | --- | --- | --- |\n| worker | m | 1 | 80,000 | 80% | 5 |\n| critic | m | 1 | 20,000 | 20% | 1 |\n',
    );
    const out = join(dir, '2026-10-30-wave-4-loop.md');
    const md = await scorecard(['4', '2026-10-30', fixture('scorecard-v2-decisions.json'), '--out', out]);
    // previous: 100,000, 90,000, 100,000 -> median 100,000; this wave 250,000 is 2.5x
    expect(md).toContain('Total tokens: 250,000');
    expect(md).toMatch(/TOKEN FLAG .*250,000.*100,000/);

    const ok = await scorecard(['0', '2026-10-30', fixture('scorecard-v1-wave0.json'), '--out', out]);
    expect(ok).not.toContain('TOKEN FLAG');
    expect(ok).toContain('1.8x the median');
  });

  it('ignores the output file itself and later scorecards, and says so when there are none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-'));
    const out = join(dir, '2026-10-30-wave-4-loop.md');
    writeFileSync(out, '# old copy\n\n- Total tokens: 1\n');
    writeFileSync(join(dir, '2026-11-01-wave-5-loop.md'), '# later\n\n- Total tokens: 1\n');
    const md = await scorecard(['4', '2026-10-30', fixture('scorecard-v2-decisions.json'), '--out', out]);
    expect(md).not.toContain('TOKEN FLAG');
    expect(md).toContain('no previous scorecards');
  });

  it('flags a result with no loopVersion, and prints the version of a result that has one', async () => {
    const old = await scorecard(['1', '2026-10-30', fixture('scorecard-v1-wave0.json')]);
    expect(old).toContain('LOOP VERSION unknown in run 1');
    expect(old).toContain('Loop: unknown.');

    const dir = mkdtempSync(join(tmpdir(), 'scorecard-version-'));
    const doc = JSON.parse(readFileSync(fixture('scorecard-v2-decisions.json'), 'utf8'));
    // The Workflow tool may store the result as a JSON string.
    const result = typeof doc.result === 'string' ? JSON.parse(doc.result) : doc.result;
    doc.result = JSON.stringify({ ...result, loopVersion: '2.2.0' });
    const path = join(dir, 'stamped.json');
    writeFileSync(path, JSON.stringify(doc));
    const stamped = await scorecard(['4', '2026-11-13', path]);
    expect(stamped).toContain('Loop: 2.2.0.');
    expect(stamped).not.toContain('LOOP VERSION');
  });

  it('reads a relay role (ci, preflight) as requesting the merger model, and flags a relay served another one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-relay-'));
    const doc = JSON.parse(readFileSync(fixture('scorecard-v2-mismatch.json'), 'utf8'));
    doc.workflowProgress.push(
      { type: 'workflow_agent', index: 4, label: 'ci:1.1 r1', agentId: 'agent4', state: 'done', tokens: 5000, toolCalls: 2, durationMs: 60000, model: 'claude-haiku-5-5' },
      { type: 'workflow_agent', index: 5, label: 'preflight:merge', agentId: 'agent5', state: 'done', tokens: 3000, toolCalls: 1, durationMs: 10000, model: 'claude-opus-5-5' },
    );
    const path = join(dir, 'relay.json');
    writeFileSync(path, JSON.stringify(doc));
    const md = await scorecard(['1', '2026-11-13', path]);
    const merger = doc.result.models.merger.model;
    expect(row(md, '## Roles', 'ci')?.[1]).toBe(merger);
    expect(row(md, '## Roles', 'preflight')?.[1]).toBe(merger);
    expect(md).toContain(`MODEL MISMATCH preflight requested ${merger} served claude-opus-5-5`);
  });
});

// Loop 2.3.0: critic findings, the integration review and escaped defects.
describe('loop-scorecard.py: findings, integration, escaped defects', { timeout: 120_000 }, () => {
  async function withResult(extra: (r: Record<string, any>) => Record<string, any>, args: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-findings-'));
    const doc = JSON.parse(readFileSync(fixture('scorecard-v2-decisions.json'), 'utf8'));
    const result = typeof doc.result === 'string' ? JSON.parse(doc.result) : doc.result;
    doc.result = JSON.stringify(extra(result));
    const path = join(dir, 'result.json');
    writeFileSync(path, JSON.stringify(doc));
    return scorecard(['3', '2026-11-16', path, ...args]);
  }
  const finding = (severity: string, what: string, where: string) => ({ severity, what, where });
  const withFindings = (r: Record<string, any>) => {
    const tasks = JSON.parse(JSON.stringify(r.tasks));
    const [first] = Object.keys(tasks);
    tasks[first].rounds = [
      { round: 1, verdict: 'FIX', ci: 'green', fixItems: [], notes: '', checklist: [], findings: [finding('high', 'connection without TLS', 'src/db.ts:12'), finding('low', 'typo in a comment', 'src/db.ts:3')] },
      { round: 2, verdict: 'MERGE', ci: 'green', fixItems: [], notes: '', checklist: [], findings: [finding('medium', 'helper duplicated', 'src/a.ts:40'), finding('high', 'connection without TLS', 'src/db.ts:12')] },
    ];
    return { ...r, tasks, loopVersion: '2.3.0' };
  };

  it('lists every high and medium critic finding once, high first, and leaves low ones out', async () => {
    const md = await withResult(withFindings);
    const section = md.slice(md.indexOf('## Critic findings'), md.indexOf('## Integration review'));
    expect(section).toContain('| high | connection without TLS | src/db.ts:12 |');
    expect(section).toContain('| medium | helper duplicated | src/a.ts:40 |');
    expect(section).not.toContain('typo in a comment');
    expect(section.match(/connection without TLS/g)).toHaveLength(1);
    expect(section.indexOf('| high |')).toBeLessThan(section.indexOf('| medium |'));
  });

  it('says so when there are no high or medium findings, and when no integration review ran', async () => {
    const md = await withResult((r) => r);
    expect(md).toContain('## Critic findings\n\nNone at high or medium severity.');
    expect(md).toContain('## Integration review\n\nNot run (a loop older than 2.3.0, or project.integrationReview is false).');
  });

  it('prints the integration review: summary, high and medium findings with area, and a count of low ones', async () => {
    const integration = {
      ran: true,
      baseSha: 'a'.repeat(40),
      summary: 'Two tasks wrote the same fetch helper.',
      findings: [
        { severity: 'medium', area: 'duplication', what: 'fetch helper written twice', where: 'src/a.ts:10' },
        { severity: 'high', area: 'security', what: 'service role used for reads', where: 'src/b.ts:5' },
        { severity: 'low', area: 'dead_code', what: 'unused export', where: 'src/c.ts:1' },
      ],
    };
    const md = await withResult((r) => ({ ...r, integration }));
    const section = md.slice(md.indexOf('## Integration review'), md.indexOf('## Roles'));
    expect(section).toContain('Two tasks wrote the same fetch helper.');
    expect(section).toContain('| high | security | service role used for reads | src/b.ts:5 |');
    expect(section).toContain('| medium | duplication | fetch helper written twice | src/a.ts:10 |');
    expect(section.indexOf('| high |')).toBeLessThan(section.indexOf('| medium |'));
    expect(section).not.toContain('unused export');
    expect(section).toContain('Low findings not listed: 1.');
  });

  it('prints why an integration review did not run', async () => {
    const md = await withResult((r) => ({ ...r, integration: { ran: false, baseSha: null, findings: [], summary: '', skipped: 'no task merged' } }));
    expect(md).toContain('## Integration review\n\nNot run: no task merged.');
  });

  it('adds --escaped to the critic misses, and says when escaped defects were not counted', async () => {
    const without = await withResult((r) => r);
    expect(without).toMatch(/- Critic misses: \d+ \(reverts after MERGE \d+; escaped defects not counted, pass --escaped\)/);
    const counted = await withResult((r) => r, ['--escaped', '3']);
    const m = /- Critic misses: (\d+) \(reverts after MERGE (\d+), escaped defects 3\)/.exec(counted);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(Number(m![2]) + 3);
    expect(await withResult((r) => r, ['--escaped=2'])).toMatch(/escaped defects 2\)/);
    expect(counted).toMatch(/Critic: a miss is a revert after MERGE or an escaped defect/);
  });

  it('refuses an --escaped that is not a whole number', async () => {
    await expect(withResult((r) => r, ['--escaped', 'x'])).rejects.toMatchObject({ stderr: expect.stringContaining('--escaped needs a whole number') });
  });
});

