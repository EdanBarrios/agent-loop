import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { runReality } from './reality.js';

const cfg = { command: 'node scripts/reality.js', readOnly: true, timeoutSec: 30 };

type Result = { code: number; stdout: string; timedOut?: boolean };

function fakeExec(result: Result | Error) {
  const calls: Array<[string, number]> = [];
  const exec = async (command: string, timeoutSec: number) => {
    calls.push([command, timeoutSec]);
    if (result instanceof Error) throw result;
    return result;
  };
  return { exec, calls };
}

const gapBlock = { id: 'R1', severity: 'block', what: 'Table missing' };
const gapWarn = { id: 'R2', severity: 'warn', what: 'Stale cache' };

describe('runReality', () => {
  it('outcome 1: refuses (throws) when the check is not declared read-only', async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: '{"gaps":[]}' });
    await expect(runReality({ ...cfg, readOnly: false }, exec)).rejects.toThrow(/readOnly/);
    await expect(runReality({ command: cfg.command }, exec)).rejects.toThrow(/readOnly/);
    await expect(runReality({ ...cfg, readOnly: 'true' }, exec)).rejects.toThrow(/readOnly/);
    expect(calls).toHaveLength(0);
  });

  it('outcome 2: valid contract JSON gives ok, gaps and the blocking subset', async () => {
    const { exec, calls } = fakeExec({
      code: 0,
      stdout: JSON.stringify({ gaps: [gapWarn, gapBlock] }) + '\n',
    });
    const r = await runReality(cfg, exec);
    expect(r).toEqual({ ok: true, gaps: [gapWarn, gapBlock], blocking: [gapBlock] });
    expect(calls).toEqual([[cfg.command, 30]]);
  });

  it('an empty gap list is ok with nothing blocking', async () => {
    const { exec } = fakeExec({ code: 0, stdout: '{"gaps":[]}' });
    expect(await runReality(cfg, exec)).toEqual({ ok: true, gaps: [], blocking: [] });
  });

  it('outcome 3: a non-zero exit is not ok, even if stdout is valid JSON', async () => {
    const { exec } = fakeExec({ code: 2, stdout: JSON.stringify({ gaps: [] }) });
    const r = await runReality(cfg, exec);
    expect(r.ok).toBe(false);
    expect(r.gaps).toEqual([]);
    expect(r.error).toMatch(/exit/);
    expect(r.error).toContain('2');
  });

  it('outcome 4: a timeout is not ok', async () => {
    const { exec } = fakeExec({ code: 0, stdout: '', timedOut: true });
    const r = await runReality(cfg, exec);
    expect(r.ok).toBe(false);
    expect(r.gaps).toEqual([]);
    expect(r.error).toMatch(/timed out/);
    expect(r.error).toContain('30');
  });

  it('outcome 5: invalid JSON is not ok', async () => {
    const { exec } = fakeExec({ code: 0, stdout: 'not json' });
    const r = await runReality(cfg, exec);
    expect(r.ok).toBe(false);
    expect(r.gaps).toEqual([]);
    expect(r.error).toMatch(/JSON/);
  });

  it('extra text before the JSON is invalid', async () => {
    const { exec } = fakeExec({ code: 0, stdout: 'checking...\n{"gaps":[]}' });
    const r = await runReality(cfg, exec);
    expect(r.ok).toBe(false);
    expect(r.gaps).toEqual([]);
    expect(r.error).toMatch(/JSON/);
  });

  it('extra text after the JSON is invalid', async () => {
    const { exec } = fakeExec({ code: 0, stdout: '{"gaps":[]}\ndone' });
    expect((await runReality(cfg, exec)).ok).toBe(false);
  });

  it('JSON that breaks the contract is not ok', async () => {
    const bad = [
      '[]',
      'null',
      '{}',
      '{"gaps":"none"}',
      '{"gaps":[null]}',
      '{"gaps":[{"id":"R1","severity":"fatal","what":"x"}]}',
      '{"gaps":[{"id":"R1","severity":"block"}]}',
      '{"gaps":[{"id":1,"severity":"warn","what":"x"}]}',
    ];
    for (const stdout of bad) {
      const { exec } = fakeExec({ code: 0, stdout });
      const r = await runReality(cfg, exec);
      expect(r.ok, stdout).toBe(false);
      expect(r.gaps).toEqual([]);
      expect(typeof r.error).toBe('string');
    }
  });

  it('an exec that throws is not ok, and the error names the failure', async () => {
    const { exec } = fakeExec(new Error('spawn failed'));
    const r = await runReality(cfg, exec);
    expect(r.ok).toBe(false);
    expect(r.gaps).toEqual([]);
    expect(r.error).toContain('spawn failed');
  });

  it('uses a default timeout when the config gives none', async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: '{"gaps":[]}' });
    await runReality({ command: cfg.command, readOnly: true }, exec);
    expect(calls[0][1]).toBeGreaterThan(0);
  });
});
