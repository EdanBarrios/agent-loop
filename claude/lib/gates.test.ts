import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { compareWaves, loadGates, openBefore } from './gates.js';

const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'scripts', 'gates.js');

function gate(over: Record<string, unknown> = {}) {
  return {
    id: 'G1',
    what: 'Do a thing',
    why: 'Because',
    owner: 'human',
    before: '1',
    leadTime: 'minutes',
    status: 'open',
    evidence: '',
    ...over,
  };
}

describe('loadGates', () => {
  it('accepts a valid array, given as an object or a JSON string', () => {
    const list = [gate(), gate({ id: 'G2', status: 'done', evidence: 'link' })];
    expect(loadGates(list)).toHaveLength(2);
    expect(loadGates(JSON.stringify(list))).toHaveLength(2);
  });

  it('accepts the real gate file of the v2 spec', () => {
    const real = readFileSync(join(root, 'docs', 'agent-loop-v2', 'gates.json'), 'utf8');
    expect(loadGates(real).length).toBeGreaterThan(0);
  });

  it('throws on a missing field and names the id and the field', () => {
    const bad: Record<string, unknown> = gate({ id: 'H9' });
    delete bad.why;
    expect(() => loadGates([bad])).toThrow(/H9.*why/);
  });

  it('throws on a bad status and names the id', () => {
    expect(() => loadGates([gate({ id: 'H7', status: 'pending' })])).toThrow(/H7.*status/);
  });

  it('throws on a bad leadTime, a bad owner and an empty before, naming the id', () => {
    expect(() => loadGates([gate({ id: 'A1', leadTime: 'weeks' })])).toThrow(/A1.*leadTime/);
    expect(() => loadGates([gate({ id: 'A2', owner: 'robot' })])).toThrow(/A2.*owner/);
    expect(() => loadGates([gate({ id: 'A3', before: '' })])).toThrow(/A3.*before/);
  });

  it('throws on a duplicate id and names it', () => {
    expect(() => loadGates([gate({ id: 'D1' }), gate({ id: 'D1' })])).toThrow(/D1.*duplicate|duplicate.*D1/i);
  });

  it('throws when the input is not an array or not JSON', () => {
    expect(() => loadGates({})).toThrow(/array/);
    expect(() => loadGates('{nope')).toThrow(/JSON/);
  });
});

describe('compareWaves', () => {
  it('orders 0 < 0a < 0b < 1 < 2 < 10', () => {
    const shuffled = ['10', '2', '0b', '1', '0', '0a'];
    expect([...shuffled].sort(compareWaves)).toEqual(['0', '0a', '0b', '1', '2', '10']);
  });
});

describe('openBefore', () => {
  const gates = loadGates([
    gate({ id: 'W0', before: '0' }),
    gate({ id: 'W0a', before: '0a' }),
    gate({ id: 'W1', before: '1' }),
    gate({ id: 'W2', before: '2' }),
    gate({ id: 'W10', before: '10' }),
  ]);

  it('returns open items whose before is at or before the wave', () => {
    expect(openBefore(gates, '0').map((g: { id: string }) => g.id)).toEqual(['W0']);
    expect(openBefore(gates, '0a').map((g: { id: string }) => g.id)).toEqual(['W0', 'W0a']);
    expect(openBefore(gates, '2').map((g: { id: string }) => g.id)).toEqual(['W0', 'W0a', 'W1', 'W2']);
    expect(openBefore(gates, '10')).toHaveLength(5);
  });

  it('does not treat 10 as before 2', () => {
    expect(openBefore(gates, '2').map((g: { id: string }) => g.id)).not.toContain('W10');
  });

  it('does not block on done or waived items', () => {
    const list = loadGates([
      gate({ id: 'X1', status: 'done', evidence: 'e' }),
      gate({ id: 'X2', status: 'waived', evidence: 'not needed' }),
      gate({ id: 'X3' }),
    ]);
    expect(openBefore(list, '5').map((g: { id: string }) => g.id)).toEqual(['X3']);
  });

  it('lists leadTime days first, then hours, then minutes', () => {
    const list = loadGates([
      gate({ id: 'M', leadTime: 'minutes', before: '1' }),
      gate({ id: 'D', leadTime: 'days', before: '3' }),
      gate({ id: 'H', leadTime: 'hours', before: '2' }),
    ]);
    expect(openBefore(list, '3').map((g: { id: string }) => g.id)).toEqual(['D', 'H', 'M']);
  });
});

describe('scripts/gates.js', () => {
  function run(list: unknown, ...args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'gates-'));
    const file = join(dir, 'gates.json');
    writeFileSync(file, typeof list === 'string' ? list : JSON.stringify(list));
    return spawnSync('node', [cli, file, ...args], { encoding: 'utf8' });
  }

  const list = [
    gate({ id: 'C1', before: '1' }),
    gate({ id: 'C2', before: '3', leadTime: 'days' }),
    gate({ id: 'C3', before: '1', status: 'waived', evidence: 'skip' }),
  ];

  it('prints open items and exits 1 when any is open', () => {
    const r = run(list);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('C1');
    expect(r.stdout).toContain('C2');
    expect(r.stdout).not.toContain('C3');
    expect(r.stdout.indexOf('C2')).toBeLessThan(r.stdout.indexOf('C1'));
  });

  it('with --before limits to items at or before that wave', () => {
    const r = run(list, '--before', '2');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('C1');
    expect(r.stdout).not.toContain('C2');
  });

  it('exits 0 when nothing is open before the wave', () => {
    const r = run(list, '--before', '0');
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('C1');
  });

  it('exits 2 with a message naming the id on an invalid file', () => {
    const r = run([gate({ id: 'Z9', status: 'nope' })]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Z9');
  });

  it('exits 2 on a missing file and on missing arguments', () => {
    expect(spawnSync('node', [cli, '/nonexistent/gates.json'], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync('node', [cli], { encoding: 'utf8' }).status).toBe(2);
    expect(run(list, '--before').status).toBe(2);
  });
});
