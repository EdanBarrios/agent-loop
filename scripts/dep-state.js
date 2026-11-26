#!/usr/bin/env node
// Usage: node scripts/dep-state.js --repo <path> --task <id>... [--prefix task/]
// Says, for each task id, whether its PR is merged and its merge commit is on the default branch. Prints one JSON
// line: { tasks: { "<id>": { merged, pr, mergeSha, onDefault, reason } } } (an entry also has `note` when the
// newest-1000 limit of `gh pr list` hides older merges). See claude/lib/deps.js for the exact rules.
// Exit codes: 0 state printed, 1 gh failed (every task prints merged false, reason "gh failed"), 4 bad usage.
// Reads or writes: reads (gh pr list; git fetch updates remote-tracking refs only; git symbolic-ref, git merge-base).
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { depState } from '../claude/lib/deps.js';

const USAGE = 'usage: node scripts/dep-state.js --repo <path> --task <id>... [--prefix task/]';
const args = process.argv.slice(2);
let repo = null;
let prefix = 'task/';
const tasks = [];
let bad = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1] !== undefined) repo = args[++i];
  else if (args[i] === '--prefix' && args[i + 1] !== undefined) prefix = args[++i];
  else if (args[i] === '--task') {
    let n = 0;
    while (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) {
      tasks.push(args[++i]);
      n++;
    }
    if (n === 0) bad = true;
  } else bad = true;
}

function print(report) {
  console.log(JSON.stringify(report));
}

if (bad || repo === null || prefix === '' || tasks.length === 0 || tasks.some((t) => t === '')) {
  print({ tasks: {}, note: USAGE });
  process.exit(4);
}
const cwd = resolve(repo);

function run(file, fileArgs) {
  return new Promise((done) => {
    const child = spawn(file, fileArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => done({ code: 127, stdout, stderr: String(err.message) }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

try {
  const report = await depState({ tasks, prefix }, { run });
  print(report);
  if (Object.values(report.tasks).some((t) => t.reason === 'gh failed')) process.exitCode = 1;
} catch (err) {
  const note = `error: ${err instanceof Error ? err.message : String(err)}`;
  print({ tasks: Object.fromEntries(tasks.map((t) => [t, { merged: false, pr: null, mergeSha: null, onDefault: false, reason: 'gh failed', note }])) });
  process.exitCode = 1;
}
