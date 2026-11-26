import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = join(import.meta.dirname, '..', 'scripts', 'label-sheet.py');

const scratch = mkdtempSync(join(tmpdir(), 'label-sheet-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function write(name: string, content: unknown): string {
  const path = join(scratch, `${++counter}-${name}`);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

async function sheet(args: string[]): Promise<string> {
  const { stdout } = await run('python3', ['-I', script, ...args]);
  return stdout;
}

// Cells of a Markdown table line; a pipe escaped as \| stays inside its cell.
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (body[i] === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += body[i];
  }
  out.push(cur.trim());
  return out;
}

type Row = Record<string, string>;
function rows(md: string): Row[] {
  const lines = md.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length === 0) return [];
  const header = cells(lines[0]);
  return lines
    .slice(2)
    .map(cells)
    .map((c) => Object.fromEntries(header.map((h, i) => [h, c[i] ?? ''])));
}
const keys = (rs: Row[]) => rs.map((r) => `${r.task}:${r.round}:${r.item}`);

const pr = (n: number) => ({ number: n, url: `https://example.invalid/demo/pull/${n}`, branch: `task/${n}` });
const fix = (n: number, what: string, cause = 'defect') => ({ n, what, provedBy: 'cmd', cause });

// 2.1: FIX with two items (one has a pipe), then MERGE. 2.2: fast-lane MERGE (no critic). 2.3: FIX with one item, then a
// CI-only MERGE (critic skipped). 2.4: STOP. 2.5: MERGE. 2.6: a round with no verdict (no PR).
const fixtureResult = {
  project: 'demo',
  wave: '2',
  gate: 'PASS',
  tasks: {
    '2.1': {
      task: '2.1',
      pr: pr(1),
      rounds: [
        { round: 1, verdict: 'FIX', ci: 'green', fixItems: [fix(1, 'Off by one in the table'), fix(2, 'Handles a | b wrongly')] },
        { round: 2, verdict: 'MERGE', ci: 'green', fixItems: [] },
      ],
    },
    '2.2': { task: '2.2', pr: pr(2), rounds: [{ round: 1, verdict: 'MERGE', ci: 'green', fixItems: [], lane: 'fast' }] },
    '2.3': {
      task: '2.3',
      pr: pr(3),
      rounds: [
        { round: 1, verdict: 'FIX', ci: 'green', fixItems: [fix(1, 'Missing test for the empty case', 'spec_miss')] },
        { round: 2, verdict: 'MERGE', ci: 'green', fixItems: [], criticSkipped: 'ci-only' },
      ],
    },
    '2.4': { task: '2.4', pr: pr(4), rounds: [{ round: 1, verdict: 'STOP', ci: 'green', fixItems: [fix(1, 'Spec is contradictory')] }] },
    '2.5': { task: '2.5', pr: pr(5), rounds: [{ round: 1, verdict: 'MERGE', ci: 'green', fixItems: [] }] },
    '2.6': { task: '2.6', rounds: [{ round: 1, verdict: null, fixItems: [] }] },
  },
};

// Six FIX verdicts of two items each and three MERGE verdicts, for sampling.
function bigResult() {
  const tasks: Record<string, unknown> = {};
  for (let i = 1; i <= 9; i++) {
    const id = `t${i}`;
    const round =
      i <= 6
        ? { round: 1, verdict: 'FIX', fixItems: [fix(1, `first problem of ${id}`), fix(2, `second problem of ${id}`)] }
        : { round: 1, verdict: 'MERGE', fixItems: [] };
    tasks[id] = { task: id, pr: pr(i), rounds: [round] };
  }
  return { tasks };
}

describe('label-sheet.py', { timeout: 60_000 }, () => {
  it('prints one row per fix item of a FIX verdict and one per MERGE verdict of a round whose critic ran', async () => {
    const md = await sheet([write('result.json', fixtureResult)]);
    const rs = rows(md);
    expect(keys(rs)).toEqual(['2.1:1:1', '2.1:1:2', '2.1:2:merge', '2.3:1:1', '2.5:1:merge']);
    expect(rs.map((r) => r.verdict)).toEqual(['FIX', 'FIX', 'MERGE', 'FIX', 'MERGE']);
    expect(rs[0].what).toBe('Off by one in the table');
    expect(rs[1].what).toBe('Handles a | b wrongly');
    expect(rs[0].PR).toContain('https://example.invalid/demo/pull/1');
    expect(rs[3].PR).toContain('https://example.invalid/demo/pull/3');
    expect(rs[4].PR).toContain('https://example.invalid/demo/pull/5');
    expect(Object.keys(rs[0])).toContain('real? (y/n)');
    expect(Object.keys(rs[0])).toContain('correct? (y/n)');
    // The label column that applies is empty; the other one is marked not applicable.
    expect(rs[0]['real? (y/n)']).toBe('');
    expect(rs[0]['correct? (y/n)']).toBe('n/a');
    expect(rs[2]['correct? (y/n)']).toBe('');
    expect(rs[2]['real? (y/n)']).toBe('n/a');
  });

  it('prints no row for STOP, fast-lane, CI-only or verdictless rounds', async () => {
    const md = await sheet([write('result.json', fixtureResult)]);
    const ids = rows(md).map((r) => r.task);
    for (const skipped of ['2.2', '2.4', '2.6']) expect(ids).not.toContain(skipped);
    expect(keys(rows(md))).not.toContain('2.3:2:merge');
  });

  it('reads a result wrapped the way the workflow output file stores it', async () => {
    const wrapped = { result: JSON.stringify(fixtureResult), workflowProgress: [] };
    const md = await sheet([write('output.json', wrapped)]);
    expect(rows(md)).toHaveLength(5);
  });

  it('keeps rows unique when two result files carry the same task and round', async () => {
    const a = write('a.json', { tasks: { x: { pr: pr(1), rounds: [{ round: 1, verdict: 'MERGE', fixItems: [] }] } } });
    const b = write('b.json', { tasks: { x: { pr: pr(1), rounds: [{ round: 1, verdict: 'MERGE', fixItems: [] }] } } });
    const ks = keys(rows(await sheet([a, b])));
    expect(ks).toHaveLength(2);
    expect(new Set(ks).size).toBe(2);
  });

  it('gives the same sample for the same seed', async () => {
    const file = write('big.json', bigResult());
    const a = await sheet([file, '--sample', '4', '--seed', 'abc']);
    const b = await sheet([file, '--sample', '4', '--seed', 'abc']);
    expect(a).toBe(b);
    const seen = new Set<string>();
    for (const seed of ['1', '2', '3', '4', '5', '6', '7', '8']) {
      seen.add(keys(rows(await sheet([file, '--sample', '4', '--seed', seed]))).join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('draws FIX and MERGE verdicts in their observed proportion and keeps all rows of a drawn FIX', async () => {
    const file = write('big.json', bigResult());
    const rs = rows(await sheet([file, '--sample', '3', '--seed', 'x']));
    const fixTasks = [...new Set(rs.filter((r) => r.verdict === 'FIX').map((r) => r.task))];
    const mergeTasks = rs.filter((r) => r.verdict === 'MERGE');
    expect(fixTasks).toHaveLength(2);
    expect(mergeTasks).toHaveLength(1);
    expect(rs.filter((r) => r.verdict === 'FIX')).toHaveLength(4);
    for (const t of fixTasks) expect(rs.filter((r) => r.task === t).map((r) => r.item)).toEqual(['1', '2']);

    const six = rows(await sheet([file, '--sample', '6', '--seed', 'x']));
    expect(new Set(six.filter((r) => r.verdict === 'FIX').map((r) => r.task)).size).toBe(4);
    expect(six.filter((r) => r.verdict === 'MERGE')).toHaveLength(2);
  });

  it('prints every verdict when the sample is not smaller than the population', async () => {
    const file = write('big.json', bigResult());
    expect(rows(await sheet([file, '--sample', '50']))).toHaveLength(6 * 2 + 3);
  });

  describe('--read', () => {
    // Fill the printed sheet: labels[i] is the label of row i of the sheet.
    async function filled(labels: string[]): Promise<string> {
      const md = await sheet([write('result.json', fixtureResult)]);
      let i = 0;
      const out = md.split('\n').map((line) => {
        if (!line.trim().startsWith('|')) return line;
        const c = cells(line);
        if (c[0] === 'task' || /^-+$/.test(c[0].replace(/[:\s]/g, ''))) return line;
        const label = labels[i++] ?? '';
        const col = c[3] === 'FIX' ? 6 : 7;
        const parts = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
        parts[col] = ` ${label} `;
        return `|${parts.join('|')}|`;
      });
      return write('filled.md', out.join('\n'));
    }

    it('prints precision with Wilson intervals', async () => {
      // FIX items: y y y n (3 of 4 real). MERGEs: y n (1 of 2 correct). Order of rows: fix fix merge fix merge.
      const path = await filled(['y', 'y', 'y', 'n', 'n']);
      const out = await sheet(['--read', path]);
      // Wilson 95%: 3 of 4 is 30% to 95%; 1 of 2 is 9% to 91%.
      expect(out).toContain('FIX items real: 75% (30–95%, n=4)');
      expect(out).toContain('MERGEs correct: 50% (9–91%, n=2)');
      expect(out).toContain('Unlabelled: 0');
    });

    it('prints a zero lower bound as 0 and an upper bound of 100', async () => {
      const path = await filled(['n', 'n', 'y', 'n', 'y']);
      const out = await sheet(['--read', path]);
      expect(out).toContain('FIX items real: 0% (0–56%, n=3)');
      expect(out).toContain('MERGEs correct: 100% (34–100%, n=2)');
    });

    it('counts unlabelled rows and does not guess them', async () => {
      const path = await filled(['y', '', 'yes', 'maybe', 'n']);
      const out = await sheet(['--read', path]);
      // FIX rows: y, '', maybe -> one labelled. MERGE rows: yes, n -> two labelled.
      expect(out).toContain('FIX items real: 100% (21–100%, n=1)');
      expect(out).toContain('MERGEs correct: 50% (9–91%, n=2)');
      expect(out).toContain('Unlabelled: 2 (FIX items 2, MERGEs 0)');
    });

    it('reports no precision when nothing is labelled', async () => {
      const path = await filled([]);
      const out = await sheet(['--read', path]);
      expect(out).toContain('FIX items real: n/a (n=0)');
      expect(out).toContain('MERGEs correct: n/a (n=0)');
      expect(out).toContain('Unlabelled: 5 (FIX items 3, MERGEs 2)');
    });
  });
});
