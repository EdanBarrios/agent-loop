import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Loop 2.3.1: spec-review no longer has a Haiku agent retype the review file; the session writes it from the run's
// output file with scripts/write-review.js, which writes exactly what the writer agent wrote.
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'write-review.js');
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, line: JSON.parse(r.stdout.trim().split('\n').pop() || '{}') };
};

const reviewResult = (reviewPath: string) => ({
  project: 'Sim',
  wave: '3',
  accepted: [{ id: 'D1', text: 'x' }],
  asked: [],
  spikes: [],
  gates: [],
  specEdits: [],
  needsSecondRound: false,
  skipped: false,
  skipReason: '',
  reviewPath,
});

describe('scripts/write-review.js', () => {
  it('writes the result from a runtime output file, as pretty JSON plus a newline, without writeBy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-review-'));
    const target = join(dir, 'docs', 'sim', '2026-11-16-wave-3-review.json');
    const result = { ...reviewResult(target), writeBy: 'session' };
    const output = join(dir, 'run.output');
    writeFileSync(output, JSON.stringify({ summary: 's', agentCount: 3, logs: [], result, totalTokens: 1 }));
    const { code, line } = run(output);
    expect(code).toBe(0);
    expect(line).toMatchObject({ outcome: 'written', path: target });
    const { writeBy: _drop, ...expected } = result;
    void _drop;
    const text = readFileSync(target, 'utf8');
    // Byte for byte what the old writer agent was told to write: JSON.stringify({ ...out, reviewPath }, null, 2) + '\n'.
    expect(text).toBe(JSON.stringify(expected, null, 2) + '\n');
    expect(line.bytes).toBe(Buffer.byteLength(text));
  });

  it('also takes a file holding the result itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-review-'));
    const target = join(dir, '2026-11-16-wave-3b-review.json');
    const input = join(dir, 'result.json');
    writeFileSync(input, JSON.stringify(reviewResult(target)));
    expect(run(input).code).toBe(0);
    expect(JSON.parse(readFileSync(target, 'utf8')).accepted[0].id).toBe('D1');
  });

  it.each([
    ['no argument', []],
    ['a missing file', ['/nonexistent/run.output']],
  ])('refuses %s with exit 4 and one error line', (_name, args) => {
    const { code, line } = run(...(args as string[]));
    expect(code).toBe(4);
    expect(line.outcome).toBe('error');
  });

  it('refuses a result without a reviewPath, and a path that is not a review file name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-review-'));
    const noPath = join(dir, 'a.json');
    writeFileSync(noPath, JSON.stringify({ result: { ...reviewResult(''), reviewPath: null } }));
    expect(run(noPath)).toMatchObject({ code: 4, line: { outcome: 'error' } });
    const badName = join(dir, 'b.json');
    const target = join(dir, 'package.json');
    writeFileSync(badName, JSON.stringify({ result: reviewResult(target) }));
    const r = run(badName);
    expect(r.code).toBe(4);
    expect(r.line.message).toMatch(/not a review file name/);
    expect(existsSync(target)).toBe(false);
  });
});
