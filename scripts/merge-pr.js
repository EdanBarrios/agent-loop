#!/usr/bin/env node
// Usage: node scripts/merge-pr.js <pr> --repo <path> [--worktree <path>] [--dry-run] [--defer-main]
//        node scripts/merge-pr.js <pr> --repo <path> --verify-main <mergeSha> [--timeout-min <m>]
// Merges one approved pull request and verifies the default branch, in this one process, and prints one JSON line:
// { outcome: 'merged'|'refused'|'reverted'|'error'|'pending', exit, mergeSha, mainSha, ciState, failing, conflictFiles,
//   revertPrUrl, message, logTail, ciWaitMs, mergeMs, mainCheckMs, revertMs, elapsedMs, mainCheck }
// (--dry-run prints outcome 'dry-run', `wouldRun`: the write calls it did not make, and `load`: the machine-load
// warning { load1, cores, threshold, high }, threshold = project.loadWarnFactor (default 4) x cores), and `loopVersion`:
// the loop's package.json version, which wave-loop's preflight compares with its own, and `baseSha`: origin's HEAD, the
// wave's base for the integration review, or null).
// mainCheck 'skipped:unchanged': the merged tree is the tree CI checked, so main's check is not waited for.
// --defer-main (only with project.mainCi): merge, then return mainCheck 'deferred' without waiting for main's run; the
// caller releases its merge lock and runs --verify-main <mergeSha>, which waits for that run and reverts once on red.
// --verify-main stops after --timeout-min minutes (default 9) with outcome 'pending', exit 5, so it can be called again.
// The project config is read from <repo>/.claude/loop.local.json (syncPolicy, mainCi, install, check, checkMutates,
// worktrees, maxBuilders, trailer). The caller holds the merge lock: this script assumes it is the only merger.
// Exit codes: 0 merged and the default branch green (or skipped:unchanged, or deferred), 2 refused (CI not green, a
// sync conflict, or the merge was refused), 3 reverted (one revert PR merged, default branch green again), 4 error
// (including bad usage), 5 pending (--verify-main only).
// It never pushes to the default branch, never forces, never uses --admin or --auto, and never retries a refused
// merge another way. Reads or writes: writes-files (merges a pull request; on red opens one revert pull request).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { machineLoad, mergePr } from '../claude/lib/merge.js';

const USAGE = 'usage: node scripts/merge-pr.js <pr> --repo <path> [--worktree <path>] [--dry-run] [--defer-main] | <pr> --repo <path> --verify-main <sha> [--timeout-min <m>]';
const args = process.argv.slice(2);
let pr = null;
let repo = null;
let worktree = null;
let dryRun = false;
let deferMain = false;
let verifyMain = null;
let timeoutMin = 9;
let usageProblem = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1] !== undefined) repo = args[++i];
  else if (args[i] === '--worktree' && args[i + 1] !== undefined) worktree = args[++i];
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--defer-main') deferMain = true;
  else if (args[i] === '--verify-main' && args[i + 1] !== undefined) verifyMain = args[++i];
  else if (args[i] === '--timeout-min' && args[i + 1] !== undefined) timeoutMin = Number(args[++i]);
  else if (!args[i].startsWith('--') && pr === null) pr = args[i];
  else usageProblem = true;
}
if (verifyMain !== null && (dryRun || deferMain || !/^[0-9a-f]{7,64}$/.test(verifyMain))) usageProblem = true;
if (!(timeoutMin > 0)) usageProblem = true;
if (usageProblem || pr === null || !/^\d+$/.test(pr) || repo === null) {
  fail(USAGE);
}
repo = resolve(repo);

let project;
try {
  project = JSON.parse(readFileSync(resolve(repo, '.claude', 'loop.local.json'), 'utf8'));
} catch (err) {
  fail(`cannot read ${resolve(repo, '.claude', 'loop.local.json')}: ${err.message}`);
}

/** Run one shell command in `cwd`; resolves with its exit code and output and never rejects on a non-zero exit. */
function run(command, { cwd }) {
  return new Promise((done) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => done({ code: 127, stdout, stderr: String(err.message) }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

const result = await mergePr(
  {
    pr,
    repo,
    worktree: worktree ? resolve(worktree) : undefined,
    dryRun,
    deferMain,
    verifyMain: verifyMain || undefined,
    mainWaitMs: Math.round(timeoutMin * 60 * 1000),
    tempDir: tmpdir(),
    project,
  },
  { run, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now },
);
if (dryRun) {
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
  result.load = machineLoad(loadavg()[0], cores, project.loadWarnFactor);
  result.loopVersion = loopVersion();
  result.baseSha = await remoteHead(repo);
}
console.log(JSON.stringify(result));
process.exitCode = result.exit;

function fail(message) {
  console.log(JSON.stringify({ outcome: 'error', exit: 4, mergeSha: null, mainSha: null, ciState: null, failing: [], conflictFiles: [], revertPrUrl: null, message }));
  process.exit(4);
}

// The default branch's head on origin (git ls-remote origin HEAD), read only; wave-loop records it as the wave's base for
// the integration review. null when it cannot be read.
async function remoteHead(cwd) {
  const r = await run('git ls-remote origin HEAD', { cwd });
  const m = r.code === 0 ? /^([0-9a-f]{40,64})\s+HEAD$/m.exec(r.stdout) : null;
  return m ? m[1] : null;
}

// The loop's version from its package.json, beside this script's real path (a linked scripts directory resolves to the
// loop repo). null when it cannot be read; wave-loop's preflight treats that as a mismatch.
function loopVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}
