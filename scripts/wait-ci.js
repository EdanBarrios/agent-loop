#!/usr/bin/env node
// Usage: node scripts/wait-ci.js <pr> [--repo <path>] [--timeout-min <n>]
// Polls the pull request's checks until none is pending (or the timeout) in this one process and prints the
// result as one JSON line: { state: 'green'|'red'|'pending'|'missing', failing, logTail, polls, elapsedMs }.
// --repo is the local checkout gh runs in (default: the current directory); --timeout-min defaults to 20.
// Exit codes: 0 a result was printed (read `state`), 2 bad usage.
// Reads or writes: reads (runs `gh pr checks` and `gh run view`; changes nothing).
import { spawn } from 'node:child_process';
import { waitForCi } from '../claude/lib/ci.js';

const args = process.argv.slice(2);
let pr = null;
let repo = process.cwd();
let timeoutMin = 20;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1] !== undefined) repo = args[++i];
  else if (args[i] === '--timeout-min' && args[i + 1] !== undefined) timeoutMin = Number(args[++i]);
  else if (!args[i].startsWith('--') && pr === null) pr = args[i];
  else usage();
}
if (pr === null || !/^\d+$/.test(pr)) usage();
if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) usage();

/** Run one shell command in the repo and resolve with its exit code and output; never rejects on a non-zero exit. */
function exec(command) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: String(err.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const started = Date.now();
const result = await waitForCi(Number(pr), exec, {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs: timeoutMin * 60 * 1000,
  now: Date.now,
});
console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - started }));

function usage() {
  console.error('usage: node scripts/wait-ci.js <pr> [--repo <path>] [--timeout-min <n>]');
  process.exit(2);
}
