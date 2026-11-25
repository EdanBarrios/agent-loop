import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = join(import.meta.dirname, '..', 'scripts', 'wave-timeline.py');
const fixture = join(import.meta.dirname, 'fixtures', 'timings-full.json');

async function timeline(args: string[]) {
  const { stdout } = await run('python3', ['-I', script, ...args]);
  return stdout;
}

const count = (svg: string, cls: string) => (svg.match(new RegExp(`<rect class="${cls}"`, 'g')) ?? []).length;
const MIN = 60_000;
const agent = (label: string, startMin: number, durMin: number) => ({
  type: 'workflow_agent',
  label,
  startedAt: 1_700_000_000_000 + startMin * MIN,
  durationMs: durMin * MIN,
});

function writeRun(doc: unknown) {
  const path = join(mkdtempSync(join(tmpdir(), 'timeline-')), 'run.json');
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

describe('wave-timeline.py', { timeout: 60_000 }, () => {
  it('draws one bar per worker and critic agent of a run whose result is a JSON string', async () => {
    const svg = await timeline([fixture]);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(count(svg, 'worker')).toBe(3 + 1); // three worker agents plus the legend swatch
    expect(count(svg, 'critic')).toBe(3 + 1);
    expect(svg).toContain('>1.1</text>');
    expect(svg).toContain('>1.2</text>');
    expect(svg.match(/>merged<\/text>/g)).toHaveLength(2);
    expect(svg).toContain('Wave 1: 2 tasks');
  });

  it('draws CI waits as a band, merges as bars, an empty row for a task with no agent, and shades a usage-limit pause', async () => {
    const path = writeRun({
      result: {
        wave: '3',
        state: { '3.1': 'merged', '3.2': 'parked', '3.10': 'parked' },
        tasks: { '3.1': { title: 'Process catalog' }, '3.2': { title: 'A <title> with markup & more' } },
      },
      workflowProgress: [
        agent('preflight:merge', 0, 0.1),
        agent('worker:3.1', 0, 10),
        agent('ci:3.1 r1', 10, 2),
        agent('critic:3.1 r1', 10, 3),
        agent('worker:3.2', 0, 12),
        agent('merger:3.1 (after usage limit)', 40, 1),
      ],
    });
    const svg = await timeline([path, '--titles']);
    expect(count(svg, 'ci')).toBe(1 + 1);
    expect(count(svg, 'merger')).toBe(1 + 1);
    expect(svg).toContain('not started: parked');
    expect(svg).toContain('paused: usage limit');
    expect(count(svg, 'gap')).toBe(1);
    expect(svg).toContain('Process catalog');
    expect(svg).toContain('A &lt;title&gt; with markup &amp; m…');
    expect(svg).not.toContain('<title> with');
    // Started tasks come first by start time, then the idle ones in task order (3.10 after 3.2, not before).
    const rows = [...svg.matchAll(/class="t id"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(rows).toEqual(['3.1', '3.2', '3.10']);
  });

  it('labels an idle stretch without a usage limit as no agent running, and takes --title', async () => {
    const path = writeRun({
      result: { wave: '2', state: {} },
      workflowProgress: [agent('worker:2.1', 0, 5), agent('worker:2.2', 30, 5)],
    });
    const svg = await timeline([path, '--title', 'Custom & title']);
    expect(svg).toContain('no agent running');
    expect(svg).toContain('Custom &amp; title');
  });

  it('fails with a message when the input has no agent records', async () => {
    const path = writeRun({ result: { wave: '1' }, workflowProgress: [] });
    await expect(timeline([path])).rejects.toThrow(/no agent records/);
  });
});
