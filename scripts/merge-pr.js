#!/usr/bin/env node
// Usage: node scripts/merge-pr.js <pr> --repo <path> [--worktree <path>] [--dry-run]
// Merges one approved pull request and verifies the default branch, in this one process, and prints one JSON line:
// { outcome: 'merged'|'refused'|'reverted'|'error', exit, mergeSha, mainSha, ciState, failing, conflictFiles,
//   revertPrUrl, message, logTail, ciWaitMs, mergeMs, mainCheckMs, revertMs, elapsedMs }
// (--dry-run prints outcome 'dry-run' and `wouldRun`: the write calls it did not make).
// The project config is read from <repo>/.claude/loop.local.json (syncPolicy, mainCi, install, check, checkMutates,
// worktrees, maxBuilders, trailer). The caller holds the merge lock: this script assumes it is the only merger.
// Exit codes: 0 merged and the default branch green, 2 refused (CI not green, a sync conflict, or the merge was
// refused), 3 reverted (one revert PR merged, default branch green again), 4 error (including bad usage).
// It never pushes to the default branch, never forces, never uses --admin or --auto, and never retries a refused
// merge another way. Reads or writes: writes-files (merges a pull request; on red opens one revert pull request).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mergePr } from '../claude/lib/merge.js';

const args = process.argv.slice(2);
let pr = null;
let repo = null;
let worktree = null;
let dryRun = false;
let usageProblem = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1] !== undefined) repo = args[++i];
  else if (args[i] === '--worktree' && args[i + 1] !== undefined) worktree = args[++i];
  else if (args[i] === '--dry-run') dryRun = true;
  else if (!args[i].startsWith('--') && pr === null) pr = args[i];
  else usageProblem = true;
}
if (usageProblem || pr === null || !/^\d+$/.test(pr) || repo === null) {
  fail('usage: node scripts/merge-pr.js <pr> --repo <path> [--worktree <path>] [--dry-run]');
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
  { pr, repo, worktree: worktree ? resolve(worktree) : undefined, dryRun, tempDir: tmpdir(), project },
  { run, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now },
);
console.log(JSON.stringify(result));
process.exitCode = result.exit;

function fail(message) {
  console.log(JSON.stringify({ outcome: 'error', exit: 4, mergeSha: null, mainSha: null, ciState: null, failing: [], conflictFiles: [], revertPrUrl: null, message }));
  process.exit(4);
}
