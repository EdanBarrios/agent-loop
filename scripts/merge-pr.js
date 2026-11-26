#!/usr/bin/env node
// Usage: node scripts/merge-pr.js <pr> --repo <path> [--worktree <path>] [--dry-run] [--defer-main]
//        node scripts/merge-pr.js <pr> --repo <path> --verify-main <mergeSha> [--timeout-min <m>]
//        node scripts/merge-pr.js <pr> --repo <path> --state
// --state (loop 2.3.1) only reads the PR: { outcome: 'state', exit: 0, state: 'OPEN'|'MERGED'|'CLOSED', mergeSha } (outcome
// 'error', exit 4 when gh cannot read it). wave-loop runs it when a merge relay's output was lost (the relay was killed),
// so a PR that did merge is not parked.
// Merges one approved pull request and verifies the default branch, in this one process, and prints one JSON line:
// { outcome: 'merged'|'refused'|'locked'|'reverted'|'error'|'pending', exit, mergeSha, mainSha, ciState, failing, conflictFiles,
//   revertPrUrl, message, logTail, ciWaitMs, mergeMs, mainCheckMs, revertMs, elapsedMs, mainCheck, lockWaitMs, treeReuse }
// (--dry-run prints outcome 'dry-run', `wouldRun`: the write calls it did not make, and `load`: the machine-load
// warning { load1, cores, threshold, high }, threshold = project.loadWarnFactor (default 4) x cores), and `loopVersion`:
// the loop's package.json version, which wave-loop's preflight compares with its own, and `baseSha`: origin's HEAD, the
// wave's base for the integration review, or null), and `permission` (v2.4): claude/lib/permission.js's prediction for
// the command forms the workflow runs, from $HOME/.claude/settings.json and <repo>/.claude/settings{,.local}.json
// (read only; a parser message is never printed).
// --defer-main (only with project.mainCi): merge, then return mainCheck 'deferred' without waiting for main's run; the
// caller releases its merge lock and runs --verify-main <mergeSha>, which waits for that run and reverts once on red.
// --verify-main stops after --timeout-min minutes (default 9) with outcome 'pending', exit 5, so it can be called again.
// The project config is read from <repo>/.claude/loop.local.json (syncPolicy, mainCi, install, check, checkMutates,
// worktrees, maxBuilders, trailer, mergeLockStaleMin, mergeLockWaitMin, reuseTreeCi).
// The merge lock (v2.5) is taken here, not by the caller: a directory <git common dir>/agent-loop-merge.lock holding
// owner.json { pid, host, pr, startedAt }, taken before the PR is read and held through the merge, the check on main when
// it is not deferred, and a revert; a held lock is waited for (5 s polls, mergeLockWaitMin, default 5, at most 8), then
// outcome 'locked', exit 2. --dry-run and --state take no lock; --verify-main takes it only for a revert.
// mainCheck 'skipped:unchanged' now needs project.reuseTreeCi (default false) and a main CI workflow that passes the
// scan in claude/lib/merge.js; the result carries treeReuse { allowed, reason }.
// Exit codes: 0 merged and the default branch green (or skipped:unchanged, or deferred), 2 refused (CI not green, a
// sync conflict, or the merge was refused) or locked (the merge lock is held), 3 reverted (one revert PR merged, default branch green again), 4 error
// (including bad usage), 5 pending (--verify-main only).
// It never pushes to the default branch, never forces, never uses --admin or --auto, and never retries a refused
// merge another way. Reads or writes: writes-files (merges a pull request; on red opens one revert pull request).
import { spawn } from 'node:child_process';
import { readFileSync, writeSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, homedir, hostname, loadavg, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { LOCK_NAME, machineLoad, makeLock, mergePr } from '../claude/lib/merge.js';
import { checkPermission, MANAGED_SETTINGS_PATHS } from '../claude/lib/permission.js';

const USAGE = 'usage: node scripts/merge-pr.js <pr> --repo <path> [--worktree <path>] [--dry-run] [--defer-main] | <pr> --repo <path> --verify-main <sha> [--timeout-min <m>] | <pr> --repo <path> --state';
const args = process.argv.slice(2);
let pr = null;
let repo = null;
let worktree = null;
let dryRun = false;
let deferMain = false;
let verifyMain = null;
let timeoutMin = 9;
let stateOnly = false;
let usageProblem = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1] !== undefined) repo = args[++i];
  else if (args[i] === '--worktree' && args[i + 1] !== undefined) worktree = args[++i];
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--state') stateOnly = true;
  else if (args[i] === '--defer-main') deferMain = true;
  else if (args[i] === '--verify-main' && args[i + 1] !== undefined) verifyMain = args[++i];
  else if (args[i] === '--timeout-min' && args[i + 1] !== undefined) timeoutMin = Number(args[++i]);
  else if (!args[i].startsWith('--') && pr === null) pr = args[i];
  else usageProblem = true;
}
if (verifyMain !== null && (dryRun || deferMain || !/^[0-9a-f]{7,64}$/.test(verifyMain))) usageProblem = true;
if (!(timeoutMin > 0)) usageProblem = true;
if (stateOnly && (dryRun || deferMain || verifyMain !== null || worktree !== null)) usageProblem = true;
if (usageProblem || pr === null || !/^\d+$/.test(pr) || repo === null) {
  fail(USAGE);
}
const repoAsGiven = repo; // the relay types --repo as the workflow gave it; permission rules are matched against that text
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

if (stateOnly) {
  const v = await run(`gh pr view ${pr} --json state,mergeCommit`, { cwd: repo });
  let view = null;
  try {
    view = v.code === 0 ? JSON.parse(v.stdout) : null;
  } catch {
    view = null;
  }
  if (!view || typeof view.state !== 'string') fail(`could not read PR #${pr}: ${(v.stderr || v.stdout).trim().slice(0, 300) || `exit ${v.code}`}`);
  // Written synchronously: process.exit right after console.log can drop the line when stdout is a pipe.
  writeSync(1, `${JSON.stringify({ outcome: 'state', exit: 0, state: view.state, mergeSha: (view.mergeCommit && view.mergeCommit.oid) || null })}\n`);
  process.exit(0);
}

// The merge lock, over the real file system. The directory is <git common dir>/agent-loop-merge.lock, so every worktree of
// the repository shares it; git is asked for the directory only when a lock is first needed (a dry run never asks).
async function lockPath() {
  const r = await run('git rev-parse --git-common-dir', { cwd: repo });
  const out = r.stdout.trim();
  if (r.code !== 0 || !out) throw new Error(`cannot find the git common directory: ${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}`);
  return resolve(repo, out, LOCK_NAME);
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
const lockFs = {
  mkdir: (path) => mkdir(path),
  writeFile: (path, text) => writeFile(path, text),
  rename: (from, to) => rename(from, to),
  readFile: (path) => readFile(path, 'utf8'),
  rm: (path) => rm(path, { recursive: true, force: true }),
  mtimeMs: async (path) => (await stat(path)).mtimeMs,
};
const lock = makeLock({ fs: lockFs, lockPath, pid: process.pid, host: hostname(), now: Date.now, alive: pidAlive });

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
  { run, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, lock },
);
if (dryRun) {
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
  result.load = machineLoad(loadavg()[0], cores, project.loadWarnFactor);
  result.loopVersion = loopVersion();
  result.baseSha = await remoteHead(repo);
  result.permission = permissionFor();
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

// The command forms the workflow runs (wave-loop's merge, --verify-main and --state relays), typed the way the relay types
// them: `<scripts dir>` is the directory of process.argv[1] as given (a link's path, never its target) and `<repo>` is the
// --repo value as given. `<n>` stands for any number, so each form is checked with two. Placeholders stand for the
// worktree path and the merge sha.
function commandForms() {
  const script = `${dirname(process.argv[1])}/merge-pr.js`;
  const wt = worktree ?? `${project.worktrees || `${repoAsGiven}-worktrees`}/task`;
  const forms = [];
  for (const n of ['1', '23']) {
    const head = `node ${script} ${n} --repo ${repoAsGiven}`;
    forms.push(`${head} --worktree ${wt}${project.mainCi ? ' --defer-main' : ''}`, `${head} --verify-main ${'0'.repeat(40)} --timeout-min 9`, `${head} --state`);
  }
  return forms;
}

// One settings file as { path, json }: json is the file's text, or null when it cannot be read (a missing file).
function settingsDoc(path) {
  try {
    return { path, json: readFileSync(path, 'utf8') };
  } catch {
    return { path, json: null };
  }
}

// checkPermission over every command form: allowed only when every form is, and rule, source, denied and ask come from the
// first form that is not (the first form when all are).
function permissionFor() {
  const docs = [
    settingsDoc(resolve(process.env.HOME || homedir(), '.claude', 'settings.json')),
    settingsDoc(resolve(repo, '.claude', 'settings.json')),
    settingsDoc(resolve(repo, '.claude', 'settings.local.json')),
  ];
  // Managed settings are read only when present: their deny and ask rules apply to every project.
  for (const path of MANAGED_SETTINGS_PATHS) {
    const doc = settingsDoc(path);
    if (doc.json !== null) docs.push(doc);
  }
  const results = commandForms().map((command) => checkPermission(command, docs));
  const first = results.find((r) => !r.allowed) ?? results[0];
  return {
    allowed: results.every((r) => r.allowed),
    rule: first.rule,
    source: first.source,
    denied: first.denied,
    ask: first.ask,
    broad: [...new Set(results.flatMap((r) => r.broad))],
    autoModeRules: first.autoModeRules,
    checked: first.checked,
  };
}
