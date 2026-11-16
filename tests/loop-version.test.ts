import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// The loop stamps its version so a wave can tell which copy of the loop ran. On 2026-11-13 a Warden wave was started
// from a session in ~/dev/agent-loop, whose own .claude/workflows points at an old pinned copy: the wave ran a v1
// wave-loop against v2.1 scripts and nothing said so.
const ROOT = join(import.meta.dirname, '..');
const run = promisify(execFile);
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const source = readFileSync(join(ROOT, 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Opts = { label: string };
const ran = (line: unknown, exitCode = 0) => ({ status: 'ran', exitCode, stdout: `${JSON.stringify(line)}\n` });
const preflight = (extra: Record<string, unknown>) =>
  ran({ outcome: 'error', exit: 4, mergeSha: null, message: 'could not read PR #0: no pull requests found', ...extra }, 4);

async function runWave(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const escalations: { task: string; what: string; question: string }[] = [];
  const agent = async (_prompt: string, opts: Opts) => {
    calls.push(opts.label);
    await new Promise((r) => setTimeout(r, 0));
    return answers[opts.label] ?? null;
  };
  const args = {
    project: { name: 'Sim', repo: '/tmp/sim', github: 'o/r', worktrees: '/tmp/sim-wt', spec: 'docs/spec.md', maxBuilders: 2, maxChains: 4, mainCi: 'check' },
    wave: '9',
    tasks: [{ id: '9.1', title: 'T', branch: 'feat/9.1', deps: [], text: 'x', owns: 'y', notes: '' }],
    tail: null,
  };
  const out = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', source)(
    agent,
    (fns: (() => Promise<unknown>)[]) => Promise.all(fns.map((f) => f())),
    async () => [],
    () => {},
    () => {},
    args,
  );
  return { out, calls, escalations: out.escalations as typeof escalations };
}

describe('loop version stamp', { timeout: 120_000 }, () => {
  it('wave-loop.js carries the package.json version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(source).toContain(`const LOOP_VERSION = '${VERSION}'`);
  });

  it('a preflight that reports another loop version fails the wave before any worker, naming both versions', async () => {
    const { out, calls, escalations } = await runWave({ 'preflight:merge': preflight({ loopVersion: '1.0.0' }) });
    expect(calls).toEqual(['preflight:merge']);
    expect(out.gate).toBe('FAIL');
    expect(out.loopVersion).toBe(VERSION);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].task).toBe('preflight');
    expect(escalations[0].what).toContain(`loop ${VERSION}`);
    expect(escalations[0].what).toContain('loop 1.0.0');
    expect(escalations[0].what).toContain('.claude/workflows');
  });

  it('a preflight that reports no version (scripts older than the stamp) fails the wave the same way', async () => {
    const { out, calls, escalations } = await runWave({ 'preflight:merge': preflight({}) });
    expect(calls).toEqual(['preflight:merge']);
    expect(out.gate).toBe('FAIL');
    expect(escalations[0].what).toContain('no version');
  });

  it('a matching version lets the wave past preflight to the worker', async () => {
    const { calls } = await runWave({ 'preflight:merge': preflight({ loopVersion: VERSION }) });
    expect(calls.slice(0, 2)).toEqual(['preflight:merge', 'worker:9.1']);
  });

  it('merge-pr.js --dry-run prints the loop version from package.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-version-'));
    try {
      mkdirSync(join(dir, 'repo', '.claude'), { recursive: true });
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'repo', '.claude', 'loop.local.json'), '{"name":"X"}');
      // A fake gh: PR 0 does not exist, as in the real preflight.
      writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/sh\necho "no pull requests found" >&2\nexit 1\n');
      chmodSync(join(dir, 'bin', 'gh'), 0o755);
      const res = await run('node', [join(ROOT, 'scripts', 'merge-pr.js'), '0', '--repo', join(dir, 'repo'), '--dry-run'], {
        env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
      }).catch((e: { stdout: string }) => e);
      const line = JSON.parse(String(res.stdout).trim().split('\n').pop() as string);
      expect(line.outcome).toBe('error');
      expect(line.loopVersion).toBe(VERSION);
      expect(line.baseSha).toBeNull(); // not a git repository: no origin to read
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merge-pr.js --dry-run prints origin HEAD as baseSha (the wave base for the integration review)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-base-'));
    const git = (cwd: string, ...a: string[]) => run('git', a, { cwd });
    try {
      mkdirSync(join(dir, 'origin'));
      mkdirSync(join(dir, 'bin'));
      await git(join(dir, 'origin'), 'init', '-q', '-b', 'trunk');
      await git(join(dir, 'origin'), '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'one');
      const head = (await git(join(dir, 'origin'), 'rev-parse', 'HEAD')).stdout.trim();
      await git(dir, 'clone', '-q', join(dir, 'origin'), 'repo');
      mkdirSync(join(dir, 'repo', '.claude'));
      writeFileSync(join(dir, 'repo', '.claude', 'loop.local.json'), '{"name":"X"}');
      writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/sh\necho "no pull requests found" >&2\nexit 1\n');
      chmodSync(join(dir, 'bin', 'gh'), 0o755);
      const res = await run('node', [join(ROOT, 'scripts', 'merge-pr.js'), '0', '--repo', join(dir, 'repo'), '--dry-run'], {
        env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
      }).catch((e: { stdout: string }) => e);
      const line = JSON.parse(String(res.stdout).trim().split('\n').pop() as string);
      expect(line.loopVersion).toBe(VERSION);
      expect(line.baseSha).toBe(head);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
