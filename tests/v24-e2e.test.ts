import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { checkPermission } from '../claude/lib/permission.js';

// Task 2.T (v2.4): the wave 2 tail. One stubbed four-task wave runs through the real wave-loop script, and its result
// feeds the real scorecard and the real labelling sheet; the real escaped.js over a temp repo (with a fake gh) feeds the
// scorecard's --escaped-from. Nothing here uses the network or a real agent.
//
//   9.1  clean task: the impact relay's test list reaches the worker prompt, the critic merges in round 1
//   9.2  its branch changes an assertion with no `Test edits:` section: the critic says MERGE, the gate says FIX, round 2 merges
//   9.3  its worker fails on a far-out usage limit: the wave pauses
//   9.4  depends on 9.3: paused, never started
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const waveSource = readFileSync(join(ROOT, 'claude', 'workflows', 'wave-loop.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Json = Record<string, any>;
type Opts = { label: string; model?: string; effort?: string };
type Answer = unknown | ((opts: Opts, prompt: string) => unknown | Promise<unknown>);

const scratch = mkdtempSync(join(tmpdir(), 'v24-e2e-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------------------------------
// The stubbed wave
// ---------------------------------------------------------------------------------------------------------------------
const REPO = '/tmp/sim';
const SCRIPTS = `${REPO}/.claude/scripts`;
const RULE = `Bash(node ${SCRIPTS}/merge-pr.js *)`;
const WARDEN_LIMIT = "failed: usage limit; resets Nov 19 at 12pm (America/Los_Angeles), too far out to wait for: You've hit your weekly limit · resets Nov 19 at 12pm (America/Los_Angeles)";
const RESET_TEXT = 'Nov 19 at 12pm (America/Los_Angeles)';

const ran = (line: unknown, exitCode = 0) => ({ status: 'ran', exitCode, stdout: `${JSON.stringify(line)}\n` });

// What merge-pr.js --dry-run prints as `permission`: checkPermission over the command forms the workflow runs, with the
// settings files replaced by fake ones (the same call the script makes with the real files).
function permissionFor(settings: Json | null) {
  const docs = [
    { path: '/fake/home/.claude/settings.json', json: settings === null ? null : JSON.stringify(settings) },
    { path: `${REPO}/.claude/settings.json`, json: null },
    { path: `${REPO}/.claude/settings.local.json`, json: null },
  ];
  const head = `node ${SCRIPTS}/merge-pr.js 23 --repo ${REPO}`;
  const forms = [`${head} --worktree /tmp/sim-wt/task --defer-main`, `${head} --verify-main ${'0'.repeat(40)} --timeout-min 9`, `${head} --state`];
  const results = forms.map((c) => checkPermission(c, docs));
  const first = results.find((r: Json) => !r.allowed) ?? results[0];
  return { allowed: results.every((r: Json) => r.allowed), rule: first.rule, source: first.source, denied: first.denied, ask: first.ask, broad: [...new Set(results.flatMap((r: Json) => r.broad))], autoModeRules: first.autoModeRules, checked: first.checked };
}
const preflightFor = (settings: Json | null) =>
  ran({ outcome: 'error', exit: 4, mergeSha: null, message: 'could not read PR #0: no pull requests found', loopVersion: VERSION, permission: permissionFor(settings) }, 4);

const opened = (id: string, pr: number) => ({
  status: 'opened',
  branch: `task/${id}-slug`,
  worktree: `/tmp/sim-wt/${id}`,
  filesChanged: ['a'],
  checkCommand: 'c',
  checkExitCode: 0,
  decisions: [],
  questions: [],
  prNumber: pr,
  prUrl: `https://example.test/pull/${pr}`,
});
const criticMerge = { verdict: 'MERGE', prHeadSha: 'abc1234', checklist: [], fixItems: [], findings: [], notes: '' };
const green = ran({ state: 'green', failing: [], logTail: '', polls: 1, elapsedMs: 1000 });
const mergeRan = (sha: string) => ran({ outcome: 'merged', exit: 0, mergeSha: sha, mainSha: sha, ciState: 'green', failing: [], conflictFiles: [], revertPrUrl: null, message: 'merged', logTail: '', ciWaitMs: 1, mergeMs: 1, mainCheckMs: 1 });
const teReport = (over: Json = {}) => ({ testFirstCommit: 'abc1234', files: [], assertionsRemoved: 0, assertionsChanged: 0, bodySection: false, note: null, ...over });
const changedReport = (over: Json = {}) =>
  teReport({ files: [{ path: 'tests/b.test.ts', removed: [], changed: [{ before: 'expect(x).toBe(3)', after: 'expect(x).toBeGreaterThan(0)' }] }], assertionsChanged: 1, ...over });

const task = (id: string, extra: Json = {}) => ({ id, title: `Task ${id}`, branch: `task/${id}-slug`, deps: [] as string[], text: 'x', owns: 'y', notes: '', ...extra });
const TASKS = [
  task('9.1', { owns: '`src/a.ts`, `tests/a.test.ts`' }),
  task('9.2'),
  task('9.3'),
  task('9.4', { deps: ['9.3'] }),
];

async function runWave(preflight: unknown) {
  const calls: string[] = [];
  const prompts: Record<string, string[]> = {};
  const logs: string[] = [];
  const merged = new Set<string>();
  let release!: () => void;
  const bothMerged = new Promise<void>((r) => (release = r));
  const afterMerge = (id: string, sha: string) => () => {
    merged.add(id);
    if (merged.size === 2) release();
    return mergeRan(sha);
  };
  const answers: Record<string, Answer> = {
    'preflight:merge': preflight,
    'impact:9.1': ran({ tests: [{ path: 'tests/a.test.ts', via: null, owner: '9.1' }, { path: 'tests/shared.test.ts', via: 'name', owner: null }] }),
    'worker:9.1': opened('9.1', 1),
    'worker:9.2': opened('9.2', 2),
    // The usage limit hits once the other two tasks have merged, so the wave has two merged tasks and two paused ones.
    'worker:9.3': async () => {
      await bothMerged;
      throw new Error(WARDEN_LIMIT);
    },
    'test-edits:9.1 r1': ran(teReport()),
    'test-edits:9.2 r1': ran(changedReport()),
    'test-edits:9.2 r2': ran(changedReport({ bodySection: true })),
    'critic:9.1 r1': criticMerge,
    'critic:9.2 r1': criticMerge,
    'critic:9.2 r2': criticMerge,
    'worker:9.2 fix1': opened('9.2', 2),
    'merger:9.1': afterMerge('9.1', 'm1'),
    'merger:9.2': afterMerge('9.2', 'm2'),
  };
  const agent = async (prompt: string, opts: Opts) => {
    calls.push(opts.label);
    (prompts[opts.label] ||= []).push(prompt);
    await new Promise((r) => setTimeout(r, 0));
    if (opts.label.startsWith('ci:')) return green;
    const a = answers[opts.label];
    const v = typeof a === 'function' ? await (a as (o: Opts, p: string) => unknown)(opts, prompt) : a;
    return v === undefined ? null : v;
  };
  const args = {
    project: { name: 'Sim', repo: REPO, github: 'o/r', worktrees: '/tmp/sim-wt', spec: 'docs/spec.md', maxBuilders: 4, maxChains: 4, mainCi: 'check', syncPolicy: 'conflict' },
    wave: '9',
    tasks: TASKS,
    tail: null,
  };
  const out = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', waveSource)(
    agent,
    async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
    async () => [],
    () => {},
    (line: string) => logs.push(String(line)),
    args,
  );
  return { out, calls, prompts, logs, escalations: (out.escalations ?? []) as Array<{ task: string; what: string; question: string }> };
}

const withRule = { permissions: { allow: [RULE] } };
const broadOnly = { permissions: { allow: ['Bash(node *)', 'Bash'] } };

describe('the stubbed four-task wave', () => {
  let wave: Awaited<ReturnType<typeof runWave>>;
  beforeAll(async () => {
    wave = await runWave(preflightFor(withRule));
  });

  it('preflight fails when the fake settings lack the rule, and names it', async () => {
    for (const settings of [null, {}, broadOnly]) {
      const r = await runWave(preflightFor(settings));
      expect(r.calls).toEqual(['preflight:merge']);
      expect(r.out.gate).toBe('FAIL');
      expect(r.escalations).toHaveLength(1);
      expect(r.escalations[0].task).toBe('preflight');
      expect(`${r.escalations[0].what} ${r.escalations[0].question}`).toContain(RULE);
    }
    const broad = await runWave(preflightFor(broadOnly));
    expect(`${broad.escalations[0].what} ${broad.escalations[0].question}`).toContain('Bash(node *)');
  });

  it('with the rule in the settings, preflight passes and the wave starts workers', () => {
    expect(wave.calls[0]).toBe('preflight:merge');
    expect(wave.calls).toContain('worker:9.1');
    expect(wave.out.loopVersion).toBe('2.4.0');
    expect(wave.out.loopVersion).toBe(VERSION);
  });

  it('the impact relay lists the tests that exercise the owned files in the worker prompt', () => {
    expect(wave.calls.indexOf('impact:9.1')).toBeLessThan(wave.calls.indexOf('worker:9.1'));
    expect(wave.prompts['impact:9.1'][0].split('\n')).toContain(`node ${SCRIPTS}/impact.js --repo ${REPO} --owns src/a.ts tests/a.test.ts --spec ${REPO}/docs/spec.md`);
    expect(wave.prompts['worker:9.1'][0]).toContain('tests/a.test.ts');
    expect(wave.prompts['worker:9.1'][0]).toContain('tests/shared.test.ts');
    expect(wave.calls).not.toContain('impact:9.2');
  });

  it('a task whose branch changes an assertion without Test edits: gets FIX though the critic said MERGE', () => {
    const rounds = wave.out.tasks['9.2'].rounds as Json[];
    expect(rounds.map((r) => r.verdict)).toEqual(['FIX', 'MERGE']);
    expect(rounds[0].fixItems).toHaveLength(1);
    expect(rounds[0].fixItems[0]).toMatchObject({ n: 1, what: 'restore the assertion or justify it under Test edits:', cause: 'defect' });
    expect(rounds[0].testEdits).toMatchObject({ assertionsChanged: 1, bodySection: false });
    expect(rounds[1].testEdits).toMatchObject({ assertionsChanged: 1, bodySection: true });
    expect(wave.calls.indexOf('worker:9.2 fix1')).toBeGreaterThan(wave.calls.indexOf('critic:9.2 r1'));
    expect(wave.prompts['worker:9.2 fix1'][0]).toContain('restore the assertion or justify it under Test edits:');
    expect(wave.out.tasks['9.2'].merged).toBe(true);
    // The task with no assertion edits merges in round 1.
    expect((wave.out.tasks['9.1'].rounds as Json[]).map((r) => r.verdict)).toEqual(['MERGE']);
    expect(wave.out.tasks['9.1'].merged).toBe(true);
  });

  it('a far-out usage limit pauses the rest: one escalation, PAUSED gate, paused tasks have no rounds', () => {
    expect(wave.out.gate).toBe('PAUSED');
    expect(wave.out.state).toEqual({ '9.1': 'merged', '9.2': 'merged', '9.3': 'paused', '9.4': 'paused' });
    expect(wave.out.paused).toEqual({ resetsAt: null, resetText: RESET_TEXT, tasks: ['9.3', '9.4'] });
    for (const id of ['9.3', '9.4']) expect(wave.out.tasks[id], id).toMatchObject({ rounds: [], merged: false });
    expect(wave.escalations).toHaveLength(1);
    expect(wave.escalations[0].what).toBe(`wave paused: usage limit, resets ${RESET_TEXT}`);
    expect(wave.calls.filter((c) => c.endsWith(':9.4') || c.startsWith('worker:9.4'))).toEqual([]);
    expect(wave.calls).not.toContain('integration:wave');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// escaped.js over a temp repo, then the scorecard and the labelling sheet over the wave's result
// ---------------------------------------------------------------------------------------------------------------------
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A fake `gh` on PATH that answers only the two calls escaped.js makes.
const ghBin = join(scratch, 'bin');
const ghDir = join(scratch, 'ghdata');
const repo = join(scratch, 'repo');

function taskPr(number: number, id: string, file: string, lines: string[]) {
  const branch = `task/${id}-slug`;
  git(repo, 'checkout', '-q', '-b', branch, 'main');
  writeFileSync(join(repo, file), lines.join('\n') + '\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `feat: ${file}`);
  const oid = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${number} from owner/${branch}`, '-m', `feat: ${file}`, branch);
  writeFileSync(join(ghDir, `view-${number}.json`), JSON.stringify({ commits: [{ oid }] }));
  return { number, headRefName: branch, mergedAt: `2026-11-2${number}T12:00:00Z` };
}

let escapedFile = '';
let escaped: Json = {};
let resultFile = '';
let resultFile2 = '';

beforeAll(async () => {
  mkdirSync(ghBin);
  mkdirSync(ghDir);
  writeFileSync(
    join(ghBin, 'gh'),
    [
      '#!/bin/sh',
      'if [ "$*" = "pr list --state merged --limit 1000 --json number,headRefName,mergedAt" ]; then cat "$GH_DIR/list.json"; exit 0; fi',
      'if [ "$1 $2 $4 $5" = "pr view --json commits" ] && [ -f "$GH_DIR/view-$3.json" ]; then cat "$GH_DIR/view-$3.json"; exit 0; fi',
      'echo "unexpected gh $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(join(ghBin, 'gh'), 0o755);

  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const listed = [taskPr(1, '9.1', 'alpha.txt', ['a1', 'a2', 'a3']), taskPr(2, '9.2', 'beta.txt', ['b1', 'b2'])];
  // A fix pushed straight to the default branch that changes a line task 9.1 introduced.
  writeFileSync(join(repo, 'alpha.txt'), ['a1', 'a2 fixed', 'a3'].join('\n') + '\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fix: alpha off by one');
  writeFileSync(join(ghDir, 'list.json'), JSON.stringify(listed));

  const { stdout } = await run('node', [join(ROOT, 'scripts', 'escaped.js'), '--repo', repo], {
    env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}`, GH_DIR: ghDir },
  });
  escapedFile = join(scratch, 'escaped.json');
  writeFileSync(escapedFile, stdout);
  escaped = JSON.parse(stdout.trim().split('\n').pop()!);

  // Each agent is served the model its role requested, so the scorecard has no MODEL MISMATCH flag to print.
  const servedModel = (label: string, models: Json) => (label.startsWith('worker:') ? models.worker.model : label.startsWith('critic:') ? models.critic.model : models.relay.model);
  // The wave's result as the Workflow tool writes it: the script's return value and one record per agent.
  const w = await runWave(preflightFor(withRule));
  const progress = w.calls.map((label, i) => ({ type: 'workflow_agent', index: i + 1, label, agentId: `a${i + 1}`, state: 'done', tokens: 1000, toolCalls: 3, durationMs: 60000, model: servedModel(label, w.out.models) }));
  const doc = { summary: 'One wave of spec tasks', agentCount: progress.length, logs: w.logs, result: w.out, workflowProgress: progress };
  resultFile = join(scratch, 'wave-9.json');
  writeFileSync(resultFile, JSON.stringify(doc));
  resultFile2 = join(scratch, 'wave-10.json');
  writeFileSync(resultFile2, JSON.stringify({ ...doc, result: { ...w.out, wave: '10' } }));
});

const py = async (script: string, args: string[]) => (await run('python3', ['-I', join(ROOT, 'scripts', script), ...args])).stdout;
const INTERVAL = /\d+% \(\d+–\d+%, n=\d+\)/;

describe('escaped.js feeds the scorecard', () => {
  it('traces the fix commit back to task 9.1 only', () => {
    expect(escaped.tasks['9.1']).toMatchObject({ pr: 1, escaped: 1 });
    expect(escaped.tasks['9.1'].fixes).toHaveLength(1);
    expect(escaped.tasks['9.1'].fixes[0]).toMatchObject({ title: 'fix: alpha off by one', kind: 'fix', files: ['alpha.txt'] });
    expect(escaped.tasks['9.2']).toMatchObject({ pr: 2, escaped: 0, fixes: [] });
  });

  it('the scorecard prints the rates with intervals, counts the escaped fix as a miss and lists it', async () => {
    const md = await py('loop-scorecard.py', ['9', '2026-11-25', resultFile, '--escaped-from', escapedFile]);
    expect(md).toContain('Gate: **PAUSED**');
    expect(md).toContain('Loop: 2.4.0');
    // 9.1 and 9.2 started; 9.2 needed a FIX round, so first-pass MERGE is 1 of 2. 9.3 and 9.4 never finished a worker: 9.4 never started.
    const worker = /- Worker first-pass MERGE[^:]*: (.*)/.exec(md)![1];
    expect(worker).toMatch(INTERVAL);
    expect(worker).toContain('n=');
    // One of the two merged tasks has a miss (9.1's escaped fix): 1/2.
    const critic = /- Critic miss rate[^:]*: (.*)/.exec(md)![1];
    expect(critic).toContain('1/2');
    expect(critic).toMatch(INTERVAL);
    expect(md).toContain('fix: alpha off by one');
    expect(md).toMatch(/\| [0-9a-f]{7} \| 9\.1 \| fix: alpha off by one \|/);
    expect(md).not.toContain('MODEL MISMATCH');
    // The test-edits gate's FIX item is a defect-cause item.
    expect(md).toContain('restore the assertion or justify it under Test edits:');
  });

  it('the scorecard refuses --escaped together with --escaped-from', async () => {
    await expect(run('python3', ['-I', join(ROOT, 'scripts', 'loop-scorecard.py'), '9', '2026-11-25', resultFile, '--escaped', '1', '--escaped-from', escapedFile])).rejects.toBeTruthy();
  });

  it('--pool prints one pooled table across two runs, with intervals and no per-task section', async () => {
    const md = await py('loop-scorecard.py', ['--pool', resultFile, resultFile2, '--escaped-from', escapedFile]);
    expect(md).toMatch(INTERVAL);
    expect(md).not.toMatch(/^## Tasks$/m);
    // Each run left out its two paused tasks; the escaped fix counts once, against the run that merged 9.1 last.
    expect(md).toMatch(/\| Left out \(never started\) \| 4 \|/);
    expect(md).toMatch(/\| Critic miss rate \| 1\/4, 25% \(\d+–\d+%, n=4\) \|/);
    expect(md).toMatch(/\| defect \| 2 \|/);
  });
});

describe('the labelling sheet', () => {
  it('has one row per fix item of a FIX verdict and one per MERGE verdict, keyed by task, round and item', async () => {
    const sheet = await py('label-sheet.py', [resultFile]);
    const rows = sheet.split('\n').filter((l) => /^\|\s*9\.\d/.test(l));
    const keys = rows.map((l) => l.split('|').map((c) => c.trim()).slice(1, 4).join(' '));
    expect(keys).toEqual(['9.1 1 merge', '9.2 1 1', '9.2 2 merge']);
    const fixRow = rows.find((l) => l.includes('restore the assertion'))!;
    expect(fixRow).toContain('FIX');
    expect(fixRow).toContain('https://example.test/pull/2');
    // The paused tasks ran no critic and have no row.
    expect(sheet).not.toMatch(/^\|\s*9\.[34]\s*\|/m);
  });

  it('a filled sheet gives the precision with intervals and counts the unlabelled rows', async () => {
    const sheet = await py('label-sheet.py', [resultFile]);
    const header = sheet.split('\n').find((l) => l.startsWith('| task'))!;
    const cols = header.split('|').map((c) => c.trim()).slice(1, -1);
    const realAt = cols.indexOf('real? (y/n)');
    const correctAt = cols.indexOf('correct? (y/n)');
    const filled = sheet
      .split('\n')
      .map((line) => {
        const m = /^\|\s*(9\.\d)\s*\|\s*(\d)\s*\|\s*(\w+)\s*\|/.exec(line);
        if (!m) return line;
        const cells = line.split('|').map((c) => c.trim()).slice(1, -1);
        if (m[3] === 'merge' && m[1] === '9.1') cells[correctAt] = 'y';
        if (m[3] === '1' && m[1] === '9.2') cells[realAt] = 'y';
        // 9.2 round 2 MERGE stays unlabelled.
        return `| ${cells.join(' | ')} |`;
      })
      .join('\n');
    const path = join(scratch, 'filled.md');
    writeFileSync(path, filled);
    const out = await py('label-sheet.py', ['--read', path]);
    expect(out).toMatch(/100% \(\d+–100%, n=1\)/);
    expect(out).toMatch(/unlabelled\D*1/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// docs/OPERATING.md is the manual for what the wave above exercised
// ---------------------------------------------------------------------------------------------------------------------
describe('docs/OPERATING.md documents the wave 2 tools', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'OPERATING.md'), 'utf8');
  it.each([
    'impact.js',
    'test-edits.js',
    'Test edits:',
    'escaped.js',
    '--escaped-from',
    '--pool',
    'label-sheet.py',
    '--sample',
    '--read',
  ])('mentions %s', (word) => {
    expect(doc).toContain(word);
  });

  it('has a section for the impact and test-edits relays, for escaped.js and for the labelling sheet', () => {
    const headings = doc.split('\n').filter((l) => /^#{2,3} /.test(l));
    expect(headings.some((h) => /impact/i.test(h) && /test-edits|test edits/i.test(h))).toBe(true);
    expect(headings.some((h) => /escaped/i.test(h))).toBe(true);
    expect(headings.some((h) => /label/i.test(h))).toBe(true);
  });

  it('shows the scorecard command with --escaped-from, not only --escaped <n>', () => {
    expect(doc).toMatch(/loop-scorecard\.py[^\n]*--escaped-from/);
  });
});
