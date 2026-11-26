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


// Loop 2.4: Wilson intervals, pooled scorecards, escaped fix commits and checklist counts.
describe('loop-scorecard.py: intervals and pools', { timeout: 120_000 }, () => {
  type T = { id: string; first?: 'MERGE' | 'FIX'; merged?: boolean; reopened?: boolean; started?: boolean; state?: string };
  const agent = (i: number, label: string) => ({ type: 'workflow_agent', index: i, label, agentId: `a${i}`, state: 'done', tokens: 1000, toolCalls: 1, durationMs: 60000, model: 'claude-sonnet-5-5' });

  // A result document with one task per entry. A task that started has a worker record; `first` is its round 1 verdict.
  function runFile(tasks: T[], name = 'run.json') {
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-interval-'));
    const result: Record<string, any> = { project: 'demo', wave: '1', gate: 'PASS', loopVersion: '2.4.0', models: {}, state: {}, tasks: {}, escalations: [], decisions: [], reality: null };
    const agents: any[] = [];
    for (const t of tasks) {
      const started = t.started !== false;
      const merged = t.merged ?? (started && !!t.first);
      result.tasks[t.id] = {
        task: t.id,
        title: `Task ${t.id}`,
        pr: started && t.first ? { number: 1, url: 'https://example.invalid/pr/1', branch: `task/${t.id}` } : null,
        rounds: t.first ? [{ round: 1, verdict: t.first, ci: 'green', fixItems: [], notes: '', checklist: [], findings: [] }] : [],
        merge: merged ? { outcome: 'merged', mergeSha: 'a'.repeat(40) } : null,
        reopened: !!t.reopened,
        merged,
        ...(t.state ? { state: t.state } : {}),
      };
      if (started) agents.push(agent(agents.length + 1, `worker:${t.id}`));
    }
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ result, workflowProgress: agents }));
    return path;
  }
  const many = (n: number, make: (i: number) => Partial<T> = () => ({})): T[] => Array.from({ length: n }, (_, i) => ({ id: `1.${i + 1}`, first: 'MERGE' as const, ...make(i) }));
  function escapedFile(counts: Record<string, number>) {
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-escaped-'));
    const tasks: Record<string, any> = {};
    for (const [id, n] of Object.entries(counts)) {
      tasks[id] = { pr: 1, escaped: n, fixes: Array.from({ length: n }, (_, i) => ({ sha: `${id.replace(/\D/g, '')}${i}`.padEnd(40, 'c'), title: `fix: thing ${id} ${i}`, kind: 'fix', files: ['a.ts'], lines: 1 })) };
    }
    const path = join(dir, 'escaped.json');
    writeFileSync(path, JSON.stringify({ tasks, scanned: 5, note: '' }));
    return path;
  }
  const workerLine = (md: string) => /- Worker first-pass MERGE: (.*)/.exec(md)![1];
  const criticLine = (md: string) => /- Critic miss rate[^:]*: (.*)/.exec(md)![1];

  it('prints Wilson intervals that match hand-computed bounds (0/6, 6/6, 20/30)', async () => {
    const zero = await scorecard(['1', '2026-11-25', runFile(many(6, () => ({ first: 'FIX' as const, merged: false })))]);
    expect(workerLine(zero)).toContain('0/6, 0% (0–39%, n=6)');
    const all = await scorecard(['1', '2026-11-25', runFile(many(6))]);
    expect(workerLine(all)).toContain('6/6, 100% (61–100%, n=6)');
    const mixed = await scorecard(['1', '2026-11-25', runFile(many(30, (i) => ({ first: i < 20 ? ('MERGE' as const) : ('FIX' as const) })))]);
    expect(workerLine(mixed)).toContain('20/30, 67% (49–81%, n=30)');
  });

  it('leaves out only tasks that never started; a worker with no PR is not first-pass; a fast-lane MERGE is', async () => {
    const tasks: T[] = [
      { id: '1.1', first: 'MERGE' },
      { id: '1.2', started: true }, // worker ran, delivered no PR
      { id: '1.3', started: false, merged: false }, // parked for a parked dependency
      { id: '1.4', started: true, merged: false, state: 'paused' }, // worker failed on a usage limit
      { id: '1.T', started: false, merged: false }, // tail not run
    ];
    const md = await scorecard(['1', '2026-11-25', runFile(tasks)]);
    expect(workerLine(md)).toContain('1/2, 50% (9–91%, n=2)');
    expect(md).toMatch(/Left out of the rates \(never started\): 3/);
    // a fast-lane MERGE has a round 1 MERGE verdict with lane 'fast'
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-fast-'));
    const path = runFile([{ id: '1.1', first: 'MERGE' }]);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    doc.result.tasks['1.1'].rounds[0].lane = 'fast';
    const fast = join(dir, 'fast.json');
    writeFileSync(fast, JSON.stringify(doc));
    expect(workerLine(await scorecard(['1', '2026-11-25', fast]))).toContain('1/1, 100%');
  });

  it('fires the critic rule on 4 of 20 merged tasks with a miss (lower bound 8%) and not on 1 of 30', async () => {
    const four = await scorecard(['1', '2026-11-25', runFile(many(20)), '--escaped-from', escapedFile({ '1.1': 1, '1.2': 1, '1.3': 1, '1.4': 1 })]);
    expect(criticLine(four)).toContain('4/20, 20% (8–42%, n=20)');
    expect(four).toContain('Critic up: fires (lower bound 8% is above 5%)');
    const one = await scorecard(['1', '2026-11-25', runFile(many(30)), '--escaped-from', escapedFile({ '1.1': 1 })]);
    expect(criticLine(one)).toContain('1/30, 3% (1–17%, n=30)');
    expect(one).toContain('Critic up: does not fire (lower bound 1% is not above 5%)');
  });

  it('counts a task once however many fix commits it has, and prints a lower bound of 0 as 0', async () => {
    const md = await scorecard(['1', '2026-11-25', runFile(many(6)), '--escaped-from', escapedFile({})]);
    expect(criticLine(md)).toContain('0/6, 0% (0–39%, n=6)');
    const twice = await scorecard(['1', '2026-11-25', runFile(many(6)), '--escaped-from', escapedFile({ '1.1': 3 })]);
    expect(criticLine(twice)).toContain('1/6, 17% (3–56%, n=6)');
    expect(criticLine(twice)).toContain('fix commits: 3');
  });

  it('counts a revert after MERGE as a miss, and with only --escaped <n> counts reverts only', async () => {
    const path = runFile(many(10, (i) => ({ reopened: i === 0 })));
    const md = await scorecard(['1', '2026-11-25', path, '--escaped', '4']);
    expect(criticLine(md)).toContain('1/10, 10% (2–40%, n=10)');
    expect(criticLine(md)).toContain('escaped defects: 4 (no per-task attribution, no interval)');
    const none = await scorecard(['1', '2026-11-25', path]);
    expect(criticLine(none)).toContain('escaped defects not counted');
  });

  it('refuses --escaped together with --escaped-from', async () => {
    await expect(scorecard(['1', '2026-11-25', runFile(many(2)), '--escaped', '1', '--escaped-from', escapedFile({})])).rejects.toMatchObject({
      stderr: expect.stringContaining('--escaped and --escaped-from cannot be used together'),
    });
  });

  it('lists each fix commit of an escaped file and notes the tasks it names that are not in the runs', async () => {
    const md = await scorecard(['1', '2026-11-25', fixture('scorecard-pool-b.json'), '--escaped-from', fixture('scorecard-pool-escaped.json')]);
    const section = md.slice(md.indexOf('## Escaped fix commits'), md.indexOf('## Critic findings'));
    expect(section).toContain('| f2f2f2f | 2.1 | fix(parser): off by one |');
    expect(section).not.toContain('1.2');
    expect(section).not.toContain('f3f3f3f');
    expect(md).toMatch(/2 tasks of the escaped file are not in the given runs and were ignored \(1\.2, 9\.9\)/);
    // 2.1 has one escaped fix, 2.3 was reverted: 2 of the 4 merged tasks have a miss
    expect(criticLine(md)).toContain('2/4, 50%');
    expect(criticLine(md)).toContain('fix commits: 1');
  });

  it('lists two fix commits of one task and each fix commit once per task', async () => {
    const md = await scorecard(['1', '2026-11-25', fixture('scorecard-pool-a.json'), '--escaped-from', fixture('scorecard-pool-escaped.json')]);
    const section = md.slice(md.indexOf('## Escaped fix commits'), md.indexOf('## Critic findings'));
    expect(section).toContain('| f1f1f1f | 1.2 | fix: guard empty input |');
    expect(section).toContain('| f2f2f2f | 1.2 | fix(parser): off by one |');
    expect(section).not.toContain('0101010');
    expect(section.match(/\n\| [0-9a-f]{7} \|/g)).toHaveLength(2);
    expect(criticLine(md)).toContain('1/2, 50% (9–91%, n=2)');
    expect(criticLine(md)).toContain('fix commits: 2');
  });

  it('pools two results into one table: rates with intervals, fix items by cause, tokens per task, no per-task section', async () => {
    const md = await scorecard(['--pool', fixture('scorecard-pool-a.json'), fixture('scorecard-pool-b.json'), '--escaped-from', fixture('scorecard-pool-escaped.json')]);
    expect(md).toContain('# Pooled scorecard');
    expect(md).not.toContain('## Tasks');
    const value = (first: string) => row(md, '## Pooled table', first)?.[1];
    expect(value('Runs')).toBe('2');
    expect(value('Tasks started')).toBe('7');
    expect(value('Worker first-pass MERGE')).toBe('5/7, 71% (36–92%, n=7)');
    expect(value('Critic miss rate')).toContain('3/6, 50% (19–81%, n=6)');
    expect(value('Fix commits')).toBe('2');
    expect(value('Escaped defects')).toBe('3');
    expect(value('Reverts after MERGE')).toBe('1');
    expect(value('Tokens')).toBe('115,000');
    expect(value('Tokens per task')).toBe('16,429');
    expect(row(md, '## Fix items by cause', 'defect')).toEqual(['defect', '1']);
    expect(row(md, '## Fix items by cause', 'spec_miss')).toEqual(['spec_miss', '1']);
    expect(md).toMatch(/1 task of the escaped file is not in the given runs and was ignored \(9\.9\)/);
    expect(md).toContain('Worker: no move (upper bound 92% is not under 50%)');
    expect(md).toContain('Critic up: fires (lower bound 19% is above 5%)');
  });

  it('states the decision rule in terms of intervals, with the thresholds', async () => {
    const md = await scorecard(['1', '2026-11-25', runFile(many(6, () => ({ first: 'FIX' as const, merged: false })))]);
    const rule = md.slice(md.indexOf('## Decision rule'));
    expect(rule).toContain('only when the pooled interval lies wholly on one side of the threshold');
    expect(rule).toContain('upper bound of first-pass MERGE under 50%');
    expect(rule).toContain('lower bound of the share of merged tasks with a miss above 5%');
    expect(rule).toContain('upper bound under 10% with only low findings');
    expect(rule).toContain('Worker: move up (upper bound 39% is under 50%)');
    expect(rule).not.toContain('Two waves in a row');
  });

  it('counts items failed per checklist number from a non-empty critic checklist', async () => {
    const md = await scorecard(['--pool', fixture('scorecard-pool-a.json'), fixture('scorecard-pool-b.json')]);
    const header = row(md, '## Checklist failures', 'Item');
    expect(header).toEqual(['Item', 'Failed', 'Rounds checked']);
    expect(row(md, '## Checklist failures', '1')).toEqual(['1', '0', '3']);
    expect(row(md, '## Checklist failures', '3')).toEqual(['3', '1', '3']);
    expect(row(md, '## Checklist failures', '7')).toEqual(['7', '1', '3']);
    const single = await scorecard(['1', '2026-11-25', fixture('scorecard-pool-a.json')]);
    expect(row(single, '## Checklist failures', '3')).toEqual(['3', '1', '3']);
    const none = await scorecard(['1', '2026-11-25', fixture('scorecard-v2-decisions.json')]);
    expect(none).not.toContain('## Checklist failures');
  });
});
