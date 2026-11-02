import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = join(import.meta.dirname, '..', 'scripts', 'loop-scorecard.py');
const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);

async function timings(args: string[]) {
  const { stdout } = await run('python3', ['-I', script, '--timings', ...args]);
  return stdout;
}

const HEADER = '| Task | Build | Local check | Slot wait | Review | CI wait | Merge | Main check | Fix rounds |';

describe('loop-scorecard.py --timings', { timeout: 30_000 }, () => {
  it('prints the exact table for a result with the real record keys and timings', async () => {
    const md = await timings([fixture('timings-full.json')]);
    expect(md).toBe(
      [
        '# Timings',
        '',
        'Minutes per phase. Build, review and fix rounds come from the agent records (build and fix rounds include the worker\'s local check and slot wait); local check, slot wait, CI wait, merge and main check come from result.timings. n/a means no source.',
        '',
        HEADER,
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| 1.1 | 10.0 | 2.0 | 1.0 | 3.0 | 4.0 | 0.5 | 3.5 | 0.0 |',
        '| 1.2 | 12.0 | 3.0 | 0.0 | 6.0 | 5.0 | 1.0 | 4.0 | 6.0 |',
        '| wave | 22.0 | 5.0 | 1.0 | 9.0 | 9.0 | 1.5 | 7.5 | 6.0 |',
        '',
        '- Wall time: 28.0 min',
        '- Idle time (no agent running): 4.0 min',
        '- CI wait share of wall time: 32.1%',
        '',
      ].join('\n'),
    );
  });

  it('still renders an older record with durationMs only: idle time n/a', async () => {
    const md = await timings([fixture('timings-old.json')]);
    expect(md).toContain(HEADER);
    expect(md).toContain('| 1.2 | 12.0 | n/a | n/a | 6.0 | n/a | n/a | n/a | 6.0 |');
    expect(md).toContain('- Wall time: n/a');
    expect(md).toContain('- Idle time (no agent running): n/a');
    expect(md).toContain('- CI wait share of wall time: n/a');
  });

  it('prints n/a for CI data that is absent and exits 0', async () => {
    const md = await timings([fixture('timings-noci.json')]);
    expect(md).toContain('| 1.1 | 10.0 | n/a | n/a | 3.0 | n/a | n/a | n/a | 0.0 |');
    expect(md).toContain('| wave | 22.0 | n/a | n/a | 9.0 | n/a | n/a | n/a | 6.0 |');
    expect(md).toContain('- Idle time (no agent running): 4.0 min');
    expect(md).toContain('- CI wait share of wall time: n/a');
  });

  it('does not change the existing invocation: a normal scorecard has no timings section', async () => {
    const { stdout } = await run('python3', ['-I', script, '1', '2026-11-01', fixture('timings-full.json')]);
    expect(stdout).toContain('# Wave 1 loop scorecard');
    expect(stdout).not.toContain('# Timings');
  });
});
