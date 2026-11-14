import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { combineVerdict, waitForCi } from './ci.js';

const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'scripts', 'wait-ci.js');

const CHECKS_CMD = 'gh pr checks 7 --json name,state,bucket,link,workflow';
const RUN_URL = (id: number) => `https://github.com/example/repo/actions/runs/${id}/job/${id + 1}`;

type Check = { name: string; state: string; bucket: string; link: string; workflow: string };

function check(name: string, bucket: string, run = 1001): Check {
  const state = { pass: 'SUCCESS', fail: 'FAILURE', pending: 'IN_PROGRESS', skipping: 'SKIPPED', cancel: 'CANCELLED' }[bucket] ?? 'UNKNOWN';
  return { name, state, bucket, link: RUN_URL(run), workflow: 'check' };
}

// gh's real exit codes for `gh pr checks`: 0 all passed, 1 a check failed, 8 checks pending.
// stdout carries the JSON in all three cases.
function ghOutput(checks: Check[]) {
  const code = checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel') ? 1 : checks.some((c) => c.bucket === 'pending') ? 8 : 0;
  return { code, stdout: JSON.stringify(checks), stderr: '' };
}

// gh prints this to stderr, nothing to stdout, and exits 1 when a PR has no checks yet.
const NO_CHECKS = { code: 1, stdout: '', stderr: "no checks reported on the 'feat/x' branch\n" };

function fake(polls: Array<{ code: number; stdout: string; stderr: string }>, logs: Record<string, string> = {}) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let polled = 0;
  const exec = async (command: string) => {
    calls.push(command);
    if (command === CHECKS_CMD) {
      const r = polls[Math.min(polled, polls.length - 1)];
      polled++;
      return r;
    }
    const m = command.match(/^gh run view (\d+) --log-failed$/);
    if (m && logs[m[1]] !== undefined) return { code: 0, stdout: logs[m[1]], stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected command: ${command}` };
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { exec, sleep, calls, sleeps, polls: () => polled };
}

describe('waitForCi', () => {
  it('green: every check passes on the first poll, no sleep', async () => {
    const f = fake([ghOutput([check('check', 'pass')])]);
    const r = await waitForCi(7, f.exec, { sleep: f.sleep });
    expect(r).toMatchObject({ state: 'green', failing: [], logTail: '' });
    expect(f.sleeps).toEqual([]);
    expect(f.calls).toEqual([CHECKS_CMD]);
  });

  it('red: returns the failing check name and the tail of its log', async () => {
    const log = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\nAssertionError: expected 1 to be 2\n';
    const f = fake([ghOutput([check('lint', 'pass', 2001), check('check', 'fail', 3001)])], { '3001': log });
    const r = await waitForCi(7, f.exec, { sleep: f.sleep, logTailChars: 500 });
    expect(r.state).toBe('red');
    expect(r.failing).toEqual(['check']);
    expect(r.logTail).toContain('AssertionError: expected 1 to be 2');
    expect(r.logTail).not.toContain('line 0\n');
    expect(r.logTail.length).toBeLessThanOrEqual(600);
    expect(f.calls).toContain('gh run view 3001 --log-failed');
    expect(f.calls).not.toContain('gh run view 2001 --log-failed');
  });

  it('red: a log fetch that fails still returns red with the failing name', async () => {
    const f = fake([ghOutput([check('check', 'fail', 3001)])]);
    const r = await waitForCi(7, f.exec, { sleep: f.sleep });
    expect(r.state).toBe('red');
    expect(r.failing).toEqual(['check']);
    expect(r.logTail).toMatch(/log unavailable/);
  });

  it('a skipping check is ignored', async () => {
    const f = fake([ghOutput([check('check', 'pass'), check('deploy', 'skipping', 4001)])]);
    const r = await waitForCi(7, f.exec, { sleep: f.sleep });
    expect(r).toMatchObject({ state: 'green', failing: [] });
  });

  it('a cancel check is read as red', async () => {
    const f = fake([ghOutput([check('check', 'cancel', 5001)])], { '5001': 'The run was canceled\n' });
    const r = await waitForCi(7, f.exec, { sleep: f.sleep });
    expect(r.state).toBe('red');
    expect(r.failing).toEqual(['check']);
  });

  it('pending then green after three polls: sleeps 20 s between polls', async () => {
    const pending = ghOutput([check('check', 'pending')]);
    const green = ghOutput([check('check', 'pass')]);
    const f = fake([pending, pending, pending, green]);
    const r = await waitForCi(7, f.exec, { sleep: f.sleep });
    expect(r.state).toBe('green');
    expect(f.polls()).toBe(4);
    expect(f.sleeps).toEqual([20000, 20000, 20000]);
  });

  it('pending until timeout returns pending (default timeout 20 min)', async () => {
    const f = fake([ghOutput([check('check', 'pending')])]);
    const r = await waitForCi(7, f.exec, { sleep: f.sleep });
    expect(r.state).toBe('pending');
    expect(f.sleeps.reduce((a, b) => a + b, 0)).toBe(20 * 60 * 1000);
    expect(f.polls()).toBe(61);
  });

  it('pending until a custom timeout', async () => {
    const f = fake([ghOutput([check('check', 'pending')])]);
    const r = await waitForCi(7, f.exec, { sleep: f.sleep, timeoutMs: 60000 });
    expect(r.state).toBe('pending');
    expect(f.polls()).toBe(4);
  });

  it('no checks reported for 2 minutes is missing, not pending', async () => {
    const f = fake([NO_CHECKS]);
    const r = await waitForCi(7, f.exec, { sleep: f.sleep });
    expect(r).toMatchObject({ state: 'missing', failing: [] });
    expect(f.sleeps.reduce((a, b) => a + b, 0)).toBe(120000);
  });

  it('checks that appear within 2 minutes are followed to green', async () => {
    const f = fake([NO_CHECKS, NO_CHECKS, ghOutput([check('check', 'pending')]), ghOutput([check('check', 'pass')])]);
    const r = await waitForCi(7, f.exec, { sleep: f.sleep });
    expect(r.state).toBe('green');
  });

  it('only skipping checks is missing: nothing real ran', async () => {
    const f = fake([ghOutput([check('deploy', 'skipping')])]);
    const r = await waitForCi(7, f.exec, { sleep: f.sleep });
    expect(r.state).toBe('missing');
  });

  it('parses stdout whatever the exit code (8 pending, 1 failing)', async () => {
    const f = fake([{ code: 8, stdout: JSON.stringify([check('check', 'pending')]), stderr: '' }, { code: 0, stdout: JSON.stringify([check('check', 'pass')]), stderr: '' }]);
    expect((await waitForCi(7, f.exec, { sleep: f.sleep })).state).toBe('green');
  });

  it('a check with an unknown bucket is never green', async () => {
    const f = fake([{ code: 0, stdout: JSON.stringify([{ ...check('check', 'pass'), bucket: 'weird' }]), stderr: '' }]);
    const r = await waitForCi(7, f.exec, { sleep: f.sleep, timeoutMs: 40000 });
    expect(r.state).toBe('pending');
  });

  it('never issues a command that changes anything', async () => {
    const f = fake([ghOutput([check('check', 'fail', 3001)])], { '3001': 'boom\n' });
    await waitForCi(7, f.exec, { sleep: f.sleep });
    for (const c of f.calls) expect(c).toMatch(/^gh (pr checks|run view) /);
  });
});

describe('combineVerdict', () => {
  const items = [{ n: 1, what: 'Missing test for X', provedBy: 'npm run check', cause: 'spec_miss' }];
  const green = { state: 'green', failing: [], logTail: '' };
  const red = { state: 'red', failing: ['check'], logTail: 'AssertionError: nope' };
  const pending = { state: 'pending', failing: [], logTail: '' };
  const missing = { state: 'missing', failing: [], logTail: '' };

  it('MERGE + green merges', () => {
    const r = combineVerdict({ verdict: 'MERGE', fixItems: [] }, green);
    expect(r.action).toBe('merge');
    expect(r.fixItems).toEqual([]);
    expect(r.reason).toEqual(expect.any(String));
  });

  it('MERGE + missing escalates, never merges and is never FIX', () => {
    const r = combineVerdict({ verdict: 'MERGE', fixItems: [] }, missing);
    expect(r.action).toBe('escalate');
    expect(r.fixItems).toEqual([]);
  });

  it('MERGE + pending escalates and is never FIX', () => {
    const r = combineVerdict({ verdict: 'MERGE', fixItems: [] }, pending);
    expect(r.action).toBe('escalate');
    expect(r.fixItems).toEqual([]);
    expect(r.reason).toMatch(/pending/i);
  });

  it('MERGE + red is FIX with the failing check as a defect item', () => {
    const r = combineVerdict({ verdict: 'MERGE', fixItems: [] }, red);
    expect(r.action).toBe('fix');
    expect(r.fixItems).toHaveLength(1);
    expect(r.fixItems[0]).toMatchObject({ n: 1, cause: 'defect' });
    expect(r.fixItems[0].what).toContain('check');
    expect(r.fixItems[0].what).toContain('AssertionError: nope');
    expect(r.fixItems[0].provedBy).toEqual(expect.any(String));
  });

  it('FIX + red keeps the critic items and appends the failing check', () => {
    const r = combineVerdict({ verdict: 'FIX', fixItems: items }, red);
    expect(r.action).toBe('fix');
    expect(r.fixItems).toHaveLength(2);
    expect(r.fixItems[0]).toEqual(items[0]);
    expect(r.fixItems[1]).toMatchObject({ n: 2, cause: 'defect' });
    expect(r.fixItems[1].what).toContain('AssertionError: nope');
  });

  it('FIX + green stays FIX with the critic items', () => {
    const r = combineVerdict({ verdict: 'FIX', fixItems: items }, green);
    expect(r.action).toBe('fix');
    expect(r.fixItems).toEqual(items);
  });

  it('FIX + pending or missing stays FIX with the critic items only', () => {
    for (const ci of [pending, missing]) {
      const r = combineVerdict({ verdict: 'FIX', fixItems: items }, ci);
      expect(r.action).toBe('fix');
      expect(r.fixItems).toEqual(items);
    }
  });

  it('STOP stays STOP whatever CI says', () => {
    for (const ci of [green, red, pending, missing]) {
      const r = combineVerdict({ verdict: 'STOP', fixItems: [] }, ci);
      expect(r.action).toBe('stop');
      expect(r.fixItems).toEqual([]);
    }
  });

  it('accepts a bare verdict string', () => {
    expect(combineVerdict('MERGE', green).action).toBe('merge');
    expect(combineVerdict('STOP', red).action).toBe('stop');
  });

  it('an unknown verdict never merges', () => {
    expect(combineVerdict({ verdict: 'MAYBE', fixItems: [] }, green).action).toBe('escalate');
  });

  it('does not mutate the critic items', () => {
    const copy = JSON.parse(JSON.stringify(items));
    combineVerdict({ verdict: 'FIX', fixItems: items }, red);
    expect(items).toEqual(copy);
  });
});

describe('scripts/wait-ci.js', () => {
  function run(args: string[], ghScript: string) {
    const dir = mkdtempSync(join(tmpdir(), 'wait-ci-'));
    const bin = join(dir, 'bin');
    const gh = join(bin, 'gh');
    mkdirSync(bin);
    writeFileSync(gh, `#!/bin/sh\n${ghScript}\n`);
    chmodSync(gh, 0o755);
    return spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  }

  it('prints one JSON line with the result and exits 0', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wait-ci-repo-'));
    const out = JSON.stringify([check('check', 'pass')]);
    const r = run(['7', '--repo', repo], `echo '${out}'`);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const j = JSON.parse(lines[0]);
    expect(j).toMatchObject({ state: 'green', failing: [] });
    expect(typeof j.elapsedMs).toBe('number');
  }, 120_000);

  it('exits 2 with usage on a missing or bad pull request number', () => {
    expect(run([], 'exit 0').status).toBe(2);
    expect(run(['abc'], 'exit 0').status).toBe(2);
    expect(run(['7', '--timeout-min', 'x'], 'exit 0').status).toBe(2);
  }, 120_000);
});
