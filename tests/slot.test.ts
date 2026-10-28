import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const slot = join(import.meta.dirname, '..', 'scripts', 'slot.sh');

function env(dir: string, max: string) {
  return { ...process.env, SLOT_MAX: max, SLOT_DIR: join(dir, 'slots'), SLOT_POLL: '0.2' };
}

describe('slot.sh', () => {
  it('runs at most SLOT_MAX commands at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-'));
    const log = join(dir, 'log');
    const script = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'start '+Date.now()+'\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},'end '+Date.now()+'\\n'),300)`;
    await Promise.all([0, 1, 2, 3].map(() => run(slot, ['node', '-e', script], { env: env(dir, '2') })));
    const events = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' '))
      .map(([kind, t]) => ({ kind, t: Number(t) }))
      .sort((a, b) => a.t - b.t || (a.kind === 'end' ? -1 : 1));
    expect(events).toHaveLength(8);
    let now = 0;
    let max = 0;
    for (const e of events) {
      now += e.kind === 'start' ? 1 : -1;
      max = Math.max(max, now);
    }
    expect(max).toBe(2);
  }, 20000);

  it('passes the exit code through and frees the slot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-'));
    await expect(run(slot, ['sh', '-c', 'exit 3'], { env: env(dir, '1') })).rejects.toMatchObject({ code: 3 });
    const { stdout } = await run(slot, ['echo', 'ok'], { env: env(dir, '1') });
    expect(stdout.trim()).toBe('ok');
  }, 20000);
});
